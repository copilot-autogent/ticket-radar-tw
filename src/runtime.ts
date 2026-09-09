import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OPENTIX_SOURCE, NORMALIZED_SCHEMA_VERSION, MULTI_SOURCE_SCHEMA_VERSION, UDN_EVENT_ID, UDN_PROVIDER, TICKET_PLUS_SOURCE, TICKET_PLUS_ORDINARY_ACTIVITY, TICKET_PLUS_ORDINARY_EVENT, TICKET_PLUS_LOTTERY_ACTIVITY, type HealthCategory, type NormalizedEvent, type NormalizedPerformance, type UdnObservation, type TicketPlusRuntimeState, type TicketPlusOrdinaryObservation, type TicketPlusLotteryObservation } from "./types.js";
import { backoffMs, isEligible, nextEligibleAt, MIN_INTERVAL_MS, type PollResult } from "./opentix.js";
import { writeJsonAtomic } from "./pipeline.js";

export const MAX_HISTORY = 200;
export const MAX_OUTBOX = 100;
export interface TransitionRecord { key: string; kind: "new-performance" | "sale-open" | "became-available" | "threshold"; performanceId: string; from: number | string | null; to: number | string | null; observedAt: string; }
export interface RuntimeState {
  schemaVersion: typeof NORMALIZED_SCHEMA_VERSION; source: typeof OPENTIX_SOURCE; snapshot: NormalizedEvent | null; retainedDataAt: string | null;
  history: Array<{ observedAt: string; performanceCount: number; totalRemaining: number | null }>;
  transitions: TransitionRecord[]; health: { category: HealthCategory; error?: string; lastAttemptAt: string | null; lastSuccessfulAt: string | null; nextEligibleAt: string | null };
  cache: { etag?: string; lastModified?: string }; outbox: TransitionRecord[]; ledger: Record<string, { status: "pending" | "sent"; updatedAt: string }>;
  lastAttemptAt: string | null; lastSuccessfulAt: string | null; nextEligibleAt: string | null;
}
export function emptyState(): RuntimeState { return { schemaVersion: NORMALIZED_SCHEMA_VERSION, source: OPENTIX_SOURCE, snapshot: null, retainedDataAt: null, history: [], transitions: [], health: { category: "not-run", lastAttemptAt: null, lastSuccessfulAt: null, nextEligibleAt: null }, cache: {}, outbox: [], ledger: {}, lastAttemptAt: null, lastSuccessfulAt: null, nextEligibleAt: null }; }
function total(event: NormalizedEvent): number | null { const values = event.performances.map((item) => item.remaining); return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0); }
function validPerformance(item: NormalizedPerformance): boolean { return item.schemaVersion === NORMALIZED_SCHEMA_VERSION && item.source === OPENTIX_SOURCE && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?[+-]\d\d:\d\d$/.test(item.startsAt) && (item.remaining === null || Number.isInteger(item.remaining) && (item.remaining as number) >= 0); }
export function validateNormalizedEvent(event: unknown): NormalizedEvent {
  if (!event || typeof event !== "object") throw new Error("validation: event-object"); const value = event as NormalizedEvent;
  if (value.schemaVersion !== NORMALIZED_SCHEMA_VERSION || value.source !== OPENTIX_SOURCE || !value.eventId || !value.title || !value.venue?.name || value.venue.timeZone !== "Asia/Taipei" || !Array.isArray(value.performances) || value.performances.length === 0 || (value.remainingTotal !== null && (!Number.isInteger(value.remainingTotal) || value.remainingTotal < 0))) throw new Error("validation: event-contract");
  if (value.performances.some((item) => !validPerformance(item) || item.eventId !== value.eventId || item.venue.name !== value.venue.name || item.price.currency !== "TWD" || item.price.min < 0 || item.price.max < item.price.min)) throw new Error("validation: performance-contract");
  const hasUnknownRemaining = value.performances.some((item) => item.remaining === null);
  const expectedRemainingTotal = hasUnknownRemaining ? null : value.performances.reduce((sum, item) => sum + (item.remaining ?? 0), 0);
  if (value.remainingTotal !== expectedRemainingTotal) throw new Error("validation: remaining-total");
  return value;
}
function transition(key: string, kind: TransitionRecord["kind"], performanceId: string, from: TransitionRecord["from"], to: TransitionRecord["to"], observedAt: string): TransitionRecord { return { key, kind, performanceId, from, to, observedAt }; }
export function validateThreshold(threshold: number): number {
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error("validation: threshold");
  return threshold;
}
function transitionsFor(previous: NormalizedEvent | null, current: NormalizedEvent, threshold: number): TransitionRecord[] {
  const result: TransitionRecord[] = []; const old = new Map(previous?.performances.map((item) => [item.performanceId, item]) ?? []);
  for (const item of current.performances) {
    const before = old.get(item.performanceId);
    if (!before) { if (item.remaining !== null && item.remaining >= threshold) result.push(transition(`${item.performanceId}:new`, "new-performance", item.performanceId, null, item.remaining, current.observedAt)); continue; }
    if (before.lifecycle !== "on-sale" && item.lifecycle === "on-sale") result.push(transition(`${item.performanceId}:sale-open`, "sale-open", item.performanceId, before.lifecycle, item.lifecycle, current.observedAt));
    if (before.remaining !== null && item.remaining !== null && before.remaining < threshold && item.remaining >= threshold && !(threshold === 1 && before.remaining === 0 && item.remaining > 0)) result.push(transition(`${item.performanceId}:threshold:${threshold}`, "threshold", item.performanceId, before.remaining, item.remaining, current.observedAt));
    if (before.remaining === 0 && item.remaining !== null && item.remaining > 0) result.push(transition(`${item.performanceId}:available`, "became-available", item.performanceId, before.remaining, item.remaining, current.observedAt));
  }
  return result;
}
function capOutbox(state: RuntimeState): void {
  const pending = state.outbox.filter((item) => state.ledger[item.key]?.status !== "sent");
  const sent = state.outbox.filter((item) => state.ledger[item.key]?.status === "sent");
  state.outbox = [...sent.slice(-Math.max(0, MAX_OUTBOX - pending.length)), ...pending];
}
export function applyPoll(input: RuntimeState, result: PollResult, now = new Date(), threshold = 1): RuntimeState {
  const validatedThreshold = validateThreshold(threshold); const state = structuredClone(input); const attempt = now.toISOString(); state.lastAttemptAt = attempt; state.health.lastAttemptAt = attempt;
  if (result.kind === "success" && result.observation) {
    const observation = validateNormalizedEvent(result.observation); const transitions = state.snapshot ? transitionsFor(state.snapshot, observation, validatedThreshold) : [];
    state.snapshot = observation; state.retainedDataAt = observation.observedAt; state.lastSuccessfulAt = attempt; state.health.lastSuccessfulAt = attempt; state.health.category = "ok"; delete state.health.error; state.cache = result.validators ?? {};
    state.lastAttemptAt = attempt; state.nextEligibleAt = new Date(now.getTime() + MIN_INTERVAL_MS).toISOString(); state.health.nextEligibleAt = state.nextEligibleAt;
    state.history.push({ observedAt: observation.observedAt, performanceCount: observation.performances.length, totalRemaining: total(observation) }); state.history = state.history.slice(-MAX_HISTORY);
    for (const item of transitions) { if (!state.transitions.some((old) => old.key === item.key)) state.transitions.push(item); if (!state.ledger[item.key]) { state.ledger[item.key] = { status: "pending", updatedAt: attempt }; state.outbox.push(item); } }
    state.transitions = state.transitions.slice(-MAX_HISTORY); capOutbox(state); return state;
  }
  if (result.kind === "not-modified") { state.health.category = state.snapshot ? "ok" : "stale"; delete state.health.error; state.cache = { ...state.cache, ...result.validators }; state.nextEligibleAt = new Date(now.getTime() + MIN_INTERVAL_MS).toISOString(); state.health.nextEligibleAt = state.nextEligibleAt; return state; }
  state.health.category = state.snapshot ? "stale" : "error"; state.health.error = result.errorCategory ?? `http-${result.status}`; const delay = backoffMs(1, result.retryAfterMs); state.nextEligibleAt = nextEligibleAt(attempt, delay); state.health.nextEligibleAt = state.nextEligibleAt; return state;
}
export async function loadState(path: string): Promise<RuntimeState> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as RuntimeState;
    validateState(value);
    return value;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyState();
    throw error;
  }
}
export function validateState(value: unknown): asserts value is RuntimeState { if (!value || typeof value !== "object") throw new Error("validation: state"); const state = value as RuntimeState; if (state.schemaVersion !== NORMALIZED_SCHEMA_VERSION || state.source !== OPENTIX_SOURCE || !state.health || !Array.isArray(state.history) || !Array.isArray(state.transitions) || !Array.isArray(state.outbox) || !state.ledger) throw new Error("validation: state-contract"); if (state.snapshot) validateNormalizedEvent(state.snapshot); }
export async function saveState(path: string, state: RuntimeState): Promise<void> { validateState(state); await writeJsonAtomic(resolve(path), state); }

export interface NotificationOptions { token?: string; repository?: string; issueNumber?: number; fetchImpl?: typeof fetch; }
export async function reconcileNotifications(state: RuntimeState, options: NotificationOptions = {}): Promise<RuntimeState> {
  if (!options.token || !options.repository || !options.issueNumber) return state;
  const fetchImpl = options.fetchImpl ?? fetch; const endpoint = `https://api.github.com/repos/${options.repository}/issues/${options.issueNumber}/comments`; const headers = { authorization: `Bearer ${options.token}`, accept: "application/vnd.github+json", "content-type": "application/json" };
  const comments: Array<{ body?: string }> = []; try {
    let nextUrl: string | undefined = endpoint + "?per_page=100&page=1";
    while (nextUrl) {
      const response: Response = await fetchImpl(nextUrl, { headers });
      if (!response.ok) return state;
      const page = await response.json() as unknown;
      if (!Array.isArray(page)) return state;
      comments.push(...page as Array<{ body?: string }>);
      const link: string = response.headers.get("link") ?? "";
      nextUrl = /<([^>]+)>;\s*rel="next"/i.exec(link)?.[1];
    }
  } catch { return state; }
  const next = structuredClone(state); for (const item of next.outbox) { if (next.ledger[item.key]?.status === "sent") continue; const marker = `<!-- ticket-radar-transition:${item.key} -->`; if (comments.some((comment) => comment.body?.includes(marker))) { next.ledger[item.key] = { status: "sent", updatedAt: new Date().toISOString() }; continue; } const body = `${marker}\nOPENTIX availability transition for performance \`${item.performanceId}\`: ${String(item.from)} → ${String(item.to)}.`; try { const response = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify({ body }) }); if (response.ok) next.ledger[item.key] = { status: "sent", updatedAt: new Date().toISOString() }; } catch { /* leave pending for the next run */ } }
  return next;
}
export function eligibleToPoll(state: RuntimeState, now = Date.now()): boolean {
  const nextEligible = state.nextEligibleAt ? Date.parse(state.nextEligibleAt) : Number.NaN;
  return Number.isFinite(nextEligible) ? now >= nextEligible : isEligible(state.lastAttemptAt ?? undefined, now);
}

export interface UdnRuntimeState {
  provider: typeof UDN_PROVIDER;
  eventId: typeof UDN_EVENT_ID;
  snapshot: UdnObservation | null;
  history: UdnObservation[];
  health: { category: HealthCategory; error?: string; lastAttemptAt: string | null; lastSuccessfulAt: string | null };
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
}
export interface MultiSourceRuntimeState {
  schemaVersion: typeof MULTI_SOURCE_SCHEMA_VERSION;
  sources: { opentix: RuntimeState; udn: UdnRuntimeState; ticketPlus: TicketPlusRuntimeState };
}
export function emptyUdnState(): UdnRuntimeState {
  return { provider: UDN_PROVIDER, eventId: UDN_EVENT_ID, snapshot: null, history: [], health: { category: "not-run", lastAttemptAt: null, lastSuccessfulAt: null }, lastAttemptAt: null, lastSuccessfulAt: null };
}
export function emptyTicketPlusState(): TicketPlusRuntimeState {
  return { source: TICKET_PLUS_SOURCE, ordinary: null, lottery: null, pairings: [], conflicts: [], history: [], health: { category: "not-run", lastAttemptAt: null, lastSuccessfulAt: null }, lastAttemptAt: null, lastSuccessfulAt: null };
}
export function migrateRuntimeState(legacy: RuntimeState): MultiSourceRuntimeState {
  validateState(legacy);
  return { schemaVersion: MULTI_SOURCE_SCHEMA_VERSION, sources: { opentix: structuredClone(legacy), udn: emptyUdnState(), ticketPlus: emptyTicketPlusState() } };
}
export function validateMultiSourceState(value: unknown): asserts value is MultiSourceRuntimeState {
  if (!value || typeof value !== "object") throw new Error("validation: multi-source-state");
  const state = value as MultiSourceRuntimeState;
  if (state.schemaVersion !== MULTI_SOURCE_SCHEMA_VERSION || !state.sources?.opentix || !state.sources?.udn || !state.sources?.ticketPlus) throw new Error("validation: multi-source-schema-version");
  validateState(state.sources.opentix);
  if (state.sources.udn.provider !== UDN_PROVIDER || state.sources.udn.eventId !== UDN_EVENT_ID || !state.sources.udn.health || !Array.isArray(state.sources.udn.history)) throw new Error("validation: udn-state");
  if (state.sources.udn.snapshot) validateUdnObservation(state.sources.udn.snapshot);
  if (state.sources.ticketPlus.source !== TICKET_PLUS_SOURCE || !state.sources.ticketPlus.health || !Array.isArray(state.sources.ticketPlus.history) || !Array.isArray(state.sources.ticketPlus.pairings) || !Array.isArray(state.sources.ticketPlus.conflicts)) throw new Error("validation: ticket-plus-state");
  validateTicketPlusHealth(state.sources.ticketPlus.health);
  for (const item of state.sources.ticketPlus.history) {
    if (!item || typeof item !== "object" || !isIso(item.observedAt) || typeof item.ordinary !== "boolean" || typeof item.lottery !== "boolean") throw new Error("validation: ticket-plus-history");
  }
  if (state.sources.ticketPlus.ordinary) validateTicketPlusOrdinary(state.sources.ticketPlus.ordinary);
  if (state.sources.ticketPlus.lottery) validateTicketPlusLottery(state.sources.ticketPlus.lottery);
  for (const pairing of state.sources.ticketPlus.pairings) {
    if (!pairing || typeof pairing !== "object" || pairing.lotteryActivityId !== TICKET_PLUS_LOTTERY_ACTIVITY || pairing.ordinaryActivityId !== TICKET_PLUS_ORDINARY_ACTIVITY || !["high", "medium", "low"].includes(pairing.confidence) || !Array.isArray(pairing.evidence) || pairing.evidence.some((item) => typeof item !== "string" || !item.trim()) || typeof pairing.automationEligible !== "boolean") throw new Error("validation: ticket-plus-pairing");
  }
  for (const conflict of state.sources.ticketPlus.conflicts) {
    if (!conflict || typeof conflict !== "object" || !conflict.id || !conflict.field || typeof conflict.previous !== "string" || typeof conflict.current !== "string" || !conflict.evidenceId || typeof conflict.correction !== "boolean" || !isIso(conflict.observedAt)) throw new Error("validation: ticket-plus-conflict");
  }
}

const ticketPlusStates = ["announced", "sale-scheduled", "on-sale", "sale-closed", "ended", "unknown"] as const;
const lotteryStates = ["registration-scheduled", "registration-open", "registration-closed", "results-pending", "payment-window", "general-sale-scheduled", "ended", "unknown"] as const;
const lotteryKinds = ["registration", "results", "payment", "general-sale"] as const;
function isIso(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)); }
function isUrl(value: unknown): value is string { return typeof value === "string" && /^https:\/\//.test(value); }
function validateTicketPlusHealth(value: unknown): void {
  if (!value || typeof value !== "object") throw new Error("validation: ticket-plus-health");
  const health = value as TicketPlusRuntimeState["health"];
  if (!["ok", "stale", "error", "not-run"].includes(health.category) || (health.error !== undefined && (typeof health.error !== "string" || health.error.length > 500)) || (health.lastAttemptAt !== null && !isIso(health.lastAttemptAt)) || (health.lastSuccessfulAt !== null && !isIso(health.lastSuccessfulAt))) throw new Error("validation: ticket-plus-health");
}
function validateTicketPlusOrdinary(value: unknown): asserts value is TicketPlusOrdinaryObservation {
  if (!value || typeof value !== "object") throw new Error("validation: ticket-plus-ordinary");
  const observation = value as TicketPlusOrdinaryObservation;
  if (observation.source !== TICKET_PLUS_SOURCE || observation.activityId !== TICKET_PLUS_ORDINARY_ACTIVITY || observation.eventId !== TICKET_PLUS_ORDINARY_EVENT || !observation.title || !isIso(observation.observedAt) || !observation.parserVersion || !isUrl(observation.sourceUrl) || !Array.isArray(observation.sessions) || observation.sessions.length === 0) throw new Error("validation: ticket-plus-ordinary");
  for (const session of observation.sessions) {
    if (!session || typeof session !== "object" || session.activityId !== TICKET_PLUS_ORDINARY_ACTIVITY || session.eventId !== TICKET_PLUS_ORDINARY_EVENT || !session.sessionId || typeof session.status !== "string" || !ticketPlusStates.includes(session.lifecycle) || !isUrl(session.sourceUrl)) throw new Error("validation: ticket-plus-session");
    const dates = [session.exposureStartAt, session.exposureEndAt, session.saleStartAt, session.saleEndAt, session.startsAt, session.endsAt];
    if (dates.some((date) => date !== undefined && !isIso(date))) throw new Error("validation: ticket-plus-session-date");
    if (session.saleStartAt && session.saleEndAt && Date.parse(session.saleStartAt) > Date.parse(session.saleEndAt)) throw new Error("validation: ticket-plus-session-window");
  }
}
function validateTicketPlusLottery(value: unknown): asserts value is TicketPlusLotteryObservation {
  if (!value || typeof value !== "object") throw new Error("validation: ticket-plus-lottery");
  const observation = value as TicketPlusLotteryObservation;
  if (observation.source !== TICKET_PLUS_SOURCE || observation.activityId !== TICKET_PLUS_LOTTERY_ACTIVITY || !observation.title || !isIso(observation.observedAt) || !observation.parseVersion || !isUrl(observation.sourceUrl) || !lotteryStates.includes(observation.currentState) || !Array.isArray(observation.rounds) || observation.rounds.length === 0 || !Array.isArray(observation.evidenceIds) || observation.evidenceIds.some((item) => typeof item !== "string" || !item.trim())) throw new Error("validation: ticket-plus-lottery");
  for (const round of observation.rounds) {
    if (!round || typeof round !== "object" || !round.roundId || !["initial", "second", "other"].includes(round.kind) || !lotteryStates.includes(round.state) || !Number.isInteger(round.version) || round.version < 1 || !Array.isArray(round.windows)) throw new Error("validation: ticket-plus-round");
    for (const window of round.windows) {
      if (!window || typeof window !== "object" || !lotteryKinds.includes(window.kind) || !Number.isInteger(window.version) || window.version < 1 || !window.evidenceId || typeof window.evidenceId !== "string" || (window.startAt === undefined && window.endAt === undefined) || (window.startAt !== undefined && !isIso(window.startAt)) || (window.endAt !== undefined && !isIso(window.endAt)) || (window.startAt && window.endAt && Date.parse(window.startAt) > Date.parse(window.endAt))) throw new Error("validation: ticket-plus-window");
    }
  }
}
export function applyTicketPlusPoll(input: TicketPlusRuntimeState, result: { ordinary?: TicketPlusOrdinaryObservation; lottery?: TicketPlusLotteryObservation; errors: string[] }, now = new Date()): TicketPlusRuntimeState {
  const state = structuredClone(input); const attempt = now.toISOString(); state.lastAttemptAt = attempt; state.health.lastAttemptAt = attempt;
  if (result.ordinary || result.lottery) {
    if (result.ordinary) state.ordinary = result.ordinary;
    if (result.lottery) state.lottery = result.lottery;
    state.pairings = (state.ordinary && state.lottery) ? [{ lotteryActivityId: state.lottery.activityId, ordinaryActivityId: state.ordinary.activityId, confidence: "low", evidence: ["conservative-unverified"], automationEligible: false }] : [];
    state.history = [...state.history, { observedAt: attempt, ordinary: Boolean(result.ordinary), lottery: Boolean(result.lottery) }].slice(-MAX_HISTORY);
    state.lastSuccessfulAt = attempt; state.health.lastSuccessfulAt = attempt; state.health.category = result.errors.length ? "stale" : "ok";
    if (result.errors.length) state.health.error = result.errors.join(";").slice(0, 500); else delete state.health.error;
  } else { state.health.category = state.lastSuccessfulAt ? "stale" : "error"; state.health.error = result.errors.join(";").slice(0, 500) || "poll-failure"; }
  return state;
}
export function validateUdnObservation(value: unknown): asserts value is UdnObservation {
  if (!value || typeof value !== "object") throw new Error("validation: udn-observation");
  const observation = value as UdnObservation;
  if (observation.provider !== UDN_PROVIDER || observation.eventId !== UDN_EVENT_ID || !observation.performanceId || !observation.title || !observation.sourceUrl || !Array.isArray(observation.tiers) || observation.tiers.length === 0) throw new Error("validation: udn-contract");
  const ids = new Set<string>();
  for (const tier of observation.tiers) {
    if (tier.provider !== UDN_PROVIDER || tier.eventId !== UDN_EVENT_ID || tier.performanceId !== observation.performanceId || !tier.tierId || !tier.label || !Number.isFinite(tier.priceTwd) || tier.priceTwd < 0 || !["exact", "sold-out", "hot-selling-unknown", "unknown"].includes(tier.availability)) throw new Error("validation: udn-tier");
    if (tier.availability === "exact" && (!Number.isInteger(tier.exactCount) || tier.exactCount! < 0)) throw new Error("validation: udn-exact-count");
    if (tier.availability !== "exact" && tier.exactCount !== null) throw new Error("validation: udn-unknown-count");
    if (ids.has(tier.tierId)) throw new Error("validation: udn-duplicate-tier");
    ids.add(tier.tierId);
  }
}
export function applyUdnPoll(input: UdnRuntimeState, result: { kind: "success" | "failure" | "retryable"; observation?: UdnObservation; errorCategory?: string }, now = new Date()): UdnRuntimeState {
  const state = structuredClone(input); const attempt = now.toISOString(); state.lastAttemptAt = attempt; state.health.lastAttemptAt = attempt;
  if (result.kind === "success" && result.observation) {
    validateUdnObservation(result.observation);
    state.snapshot = result.observation; state.history = [...state.history, result.observation].slice(-MAX_HISTORY); state.lastSuccessfulAt = attempt; state.health.lastSuccessfulAt = attempt; state.health.category = "ok"; delete state.health.error; return state;
  }
  state.health.category = state.snapshot ? "stale" : "error"; state.health.error = result.errorCategory ?? "poll-failure"; return state;
}
