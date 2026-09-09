import {
  TICKET_PLUS_LOTTERY_ACTIVITY,
  TICKET_PLUS_ORDINARY_ACTIVITY,
  TICKET_PLUS_ORDINARY_EVENT,
  TICKET_PLUS_SOURCE,
  type TicketPlusLotteryObservation,
  type TicketPlusLotteryRound,
  type TicketPlusLotteryState,
  type TicketPlusOrdinaryLifecycle,
  type TicketPlusOrdinaryObservation,
  type TicketPlusSession
} from "./types.js";

export const TICKET_PLUS_ORDINARY_URL = `https://ticketplus.com.tw/activity/${TICKET_PLUS_ORDINARY_ACTIVITY}`;
export const TICKET_PLUS_LOTTERY_URL = `https://ticketplus.com.tw/activity/${TICKET_PLUS_LOTTERY_ACTIVITY}`;
export const TICKET_PLUS_PARSER_VERSION = "ticket-plus-lifecycle-v1";
export const MAX_TICKET_PLUS_RESPONSE_BYTES = 2_000_000;
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;

function clean(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function timestamp(value: unknown): string | undefined {
  const raw = clean(value).replace(/\//g, "-").replace(/\s+/g, " ");
  if (!raw) return undefined;
  const match = /^(\d{4}-\d{1,2}-\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  const dateParts = match?.[1]?.split("-") ?? [];
  const candidate = match ? `${dateParts[0]}-${dateParts[1]!.padStart(2, "0")}-${dateParts[2]!.padStart(2, "0")}T${match[2]!.padStart(2, "0")}:${match[3]}:${match[4] ?? "00"}+08:00` : raw;
  return iso.test(candidate) && !Number.isNaN(Date.parse(candidate)) ? candidate : undefined;
}
function lifecycle(status: string, saleStart?: string, saleEnd?: string, sessionStart?: string, sessionEnd?: string, now = Date.now()): TicketPlusOrdinaryLifecycle {
  const normalized = status.toLowerCase().replace(/[-_\s]/g, "");
  if (["ended", "finished", "completed", "past"].includes(normalized)) return "ended";
  if (sessionEnd && Date.parse(sessionEnd) <= now) return "ended";
  if (saleEnd && Date.parse(saleEnd) <= now) return "sale-closed";
  if (saleStart && Date.parse(saleStart) > now) return "sale-scheduled";
  if (normalized === "onsale") return "on-sale";
  if (saleStart) return "on-sale";
  return status ? "announced" : "unknown";
}
function values(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>);
  return [];
}
function findAll(value: unknown, predicate: (item: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const walk = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    if (!Array.isArray(item) && predicate(item as Record<string, unknown>)) result.push(item as Record<string, unknown>);
    for (const child of values(item)) walk(child);
  };
  walk(value);
  return result;
}
function jsonDocuments(body: string): unknown[] {
  const docs: unknown[] = [];
  for (const match of body.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { docs.push(JSON.parse(match[1] ?? "")); } catch { throw new Error("ticket-plus-parse-failure: malformed-json"); }
  }
  try { if (body.trim().startsWith("{") || body.trim().startsWith("[")) docs.push(JSON.parse(body)); } catch { throw new Error("ticket-plus-parse-failure: malformed-json"); }
  return docs;
}
function ensureSize(body: string): void {
  if (!body || body.length > MAX_TICKET_PLUS_RESPONSE_BYTES) throw new Error("ticket-plus-parse-failure: response-size");
}

export function parseTicketPlusOrdinaryJson(body: string, observedAt = new Date().toISOString(), now = new Date()): TicketPlusOrdinaryObservation {
  ensureSize(body);
  const docs = jsonDocuments(body);
  const records = docs.flatMap((doc) => findAll(doc, (item) => clean(item.id ?? item.eventId) === TICKET_PLUS_ORDINARY_EVENT || clean(item.eventId) === TICKET_PLUS_ORDINARY_EVENT));
  const root = records[0] ?? (docs[0] && typeof docs[0] === "object" ? docs[0] as Record<string, unknown> : {});
  const sessions = docs.flatMap((doc) => findAll(doc, (item) => Boolean(clean(item.sessionId ?? item.id)) && (clean(item.eventId) === TICKET_PLUS_ORDINARY_ACTIVITY || clean(item.event_id) === TICKET_PLUS_ORDINARY_ACTIVITY || /^s\d+$/i.test(clean(item.sessionId ?? item.id)) || clean(item.sessionId ?? item.id).length > 12)));
  const parsed: TicketPlusSession[] = sessions.map((item) => {
    const sessionId = clean(item.id ?? item.sessionId);
    const status = clean(item.status ?? item.saleStatus ?? item.state) || "unknown";
    const saleStartAt = timestamp(item.saleStart ?? item.saleStartsAt ?? item.sale_start);
    const saleEndAt = timestamp(item.saleEnd ?? item.saleEndsAt ?? item.sale_end);
    const startsAt = timestamp(item.startAt ?? item.startsAt ?? item.performanceDate);
    const exposureStartAt = timestamp(item.exposureStart ?? item.exposureStartAt);
    const exposureEndAt = timestamp(item.exposureEnd ?? item.exposureEndAt);
    const endsAt = timestamp(item.endAt ?? item.endsAt);
    return {
      activityId: TICKET_PLUS_ORDINARY_ACTIVITY, eventId: TICKET_PLUS_ORDINARY_EVENT, sessionId, status,
      lifecycle: lifecycle(status, saleStartAt, saleEndAt, startsAt, endsAt, now.getTime()),
      ...(exposureStartAt ? { exposureStartAt } : {}), ...(exposureEndAt ? { exposureEndAt } : {}),
      ...(saleStartAt ? { saleStartAt } : {}), ...(saleEndAt ? { saleEndAt } : {}),
      ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}),
      ...(clean(item.venue) ? { venue: clean(item.venue) } : {}),
      sourceUrl: TICKET_PLUS_ORDINARY_URL
    };
  }).filter((item) => item.sessionId);
  if (!parsed.length) throw new Error("ticket-plus-parse-failure: missing-sessions");
  const title = clean(root.title ?? root.name) || "Ticket Plus ordinary sale";
  return { source: TICKET_PLUS_SOURCE, activityId: TICKET_PLUS_ORDINARY_ACTIVITY, eventId: TICKET_PLUS_ORDINARY_EVENT, title, sessions: parsed, observedAt, parserVersion: TICKET_PLUS_PARSER_VERSION, sourceUrl: TICKET_PLUS_ORDINARY_URL };
}

function evidence(label: string, value: string): string {
  let hash = 2166136261;
  for (const char of value.replace(/\s+/g, " ").trim().slice(0, 500)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${label}:fp-${(hash >>> 0).toString(16)}`;
}
function windowFrom(text: string, kind: TicketPlusLotteryRound["windows"][number]["kind"], label: RegExp): { kind: TicketPlusLotteryRound["windows"][number]["kind"]; startAt?: string; endAt?: string; evidenceId: string } | undefined {
  const match = label.exec(text);
  if (!match) return undefined;
  const segment = text.slice(match.index, match.index + 500);
  const dates = [...segment.matchAll(/(?:20\d{2}\s*(?:年|\/|-)\s*)?\d{1,2}\s*(?:月|\/|-)\s*\d{1,2}\s*日?\s*(?:\([^)]*\)|（[^）]*）)?\s*\d{1,2}[:：]\d{2}/g)].map((m) => timestamp((m[0]!.match(/^20\d{2}/) ? m[0]! : `2026/${m[0]!}`).replace(/[年月]/g, "-").replace(/日/g, " ").replace(/[()（）][^()（）]*[)）]/g, "")));
  if (!dates.length) return undefined;
  return { kind, ...(dates[0] ? { startAt: dates[0] } : {}), ...(dates[1] ? { endAt: dates[1] } : {}), evidenceId: evidence(kind, match[0] ?? "") };
}
function roundSections(text: string): Array<{ roundId: string; kind: TicketPlusLotteryRound["kind"]; text: string }> {
  const headings = [...text.matchAll(/(?:第\s*(\d+|一|二|三|四)\s*(?:輪|回|次)|初始輪)/gi)];
  if (!headings.length) return [{ roundId: "initial", kind: "initial", text }];
  const ordinal = (value: string | undefined): number => value === "一" ? 1 : value === "二" ? 2 : value === "三" ? 3 : value === "四" ? 4 : Number(value ?? 1);
  const sections = headings.map((heading, index) => {
    const number = heading[1] ? ordinal(heading[1]) : 1;
    const kind: TicketPlusLotteryRound["kind"] = number === 1 ? "initial" : number === 2 ? "second" : "other";
    return { roundId: number === 1 ? "initial" : number === 2 ? "second" : `round-${number}`, kind, text: text.slice(heading.index, headings[index + 1]?.index ?? text.length) };
  });
  const prefix = text.slice(0, headings[0]!.index);
  return prefix.trim() ? [{ roundId: "initial", kind: "initial", text: prefix }, ...sections] : sections;
}
function deriveLotteryState(rounds: TicketPlusLotteryRound[], text: string, now: Date): TicketPlusLotteryState {
  const windows = rounds.flatMap((round) => round.windows);
  const at = now.getTime();
  const active = (window: TicketPlusLotteryRound["windows"][number]) => window.startAt && window.endAt && Date.parse(window.startAt) <= at && at < Date.parse(window.endAt);
  if (windows.some((window) => window.kind === "payment" && active(window))) return "payment-window";
  if (windows.some((window) => window.kind === "registration" && active(window))) return "registration-open";
  if (windows.some((window) => window.kind === "registration" && window.startAt && Date.parse(window.startAt) > at)) return "registration-scheduled";
  if (windows.some((window) => window.kind === "results" && window.startAt && Date.parse(window.startAt) > at)) return "results-pending";
  if (windows.some((window) => window.kind === "payment" && window.startAt && Date.parse(window.startAt) > at)) return "results-pending";
  if (windows.some((window) => window.kind === "general-sale" && window.startAt && Date.parse(window.startAt) > at)) return "general-sale-scheduled";
  const knownEnds = windows.map((window) => window.endAt ?? window.startAt).filter((value): value is string => Boolean(value));
  if (knownEnds.length && knownEnds.every((value) => Date.parse(value) <= at)) return "ended";
  if (text.includes("登記截止")) return "registration-closed";
  if (text.includes("付款")) return "payment-window";
  if (text.includes("一般販售")) return "general-sale-scheduled";
  return "unknown";
}
export function parseTicketPlusLotteryHtml(body: string, observedAt = new Date().toISOString(), now = new Date()): TicketPlusLotteryObservation {
  ensureSize(body);
  let source = body;
  try {
    const parsed = JSON.parse(body) as unknown;
    source = findAll(parsed, () => true).flatMap((item) => Object.values(item).filter((value): value is string => typeof value === "string")).join(" ");
  } catch { /* official activity pages are HTML; JSON config pages are also supported */ }
  const text = source.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const rounds: TicketPlusLotteryRound[] = roundSections(text).map(({ roundId, kind, text: section }) => {
    const windows = [
      windowFrom(section, "registration", /(?:登記時間|報名時間|登記抽選[：:])[^；。]{0,180}/i),
      windowFrom(section, "results", /(?:結果公布|中選結果|抽選結果)[^；。]{0,180}/i),
      windowFrom(section, "payment", /(?:繳費期限|付款期限|付款)[^；。]{0,180}/i),
      windowFrom(section, "general-sale", /(?:一般販售|一般發售|條件一般)[^；。]{0,180}/i)
    ].filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => ({ ...item, version: 1 }));
    return { roundId, kind, windows, version: 1, state: "unknown" as const };
  });
  if (!rounds.length) throw new Error("ticket-plus-parse-failure: missing-lottery-windows");
  if (!rounds.some((round) => round.windows.length)) {
    if (!roundSections(text).some((round) => round.roundId !== "initial")) throw new Error("ticket-plus-parse-failure: missing-lottery-windows");
  }
  const state = deriveLotteryState(rounds, text, now);
  for (const round of rounds) round.state = deriveLotteryState([round], "", now);
  return { source: TICKET_PLUS_SOURCE, activityId: TICKET_PLUS_LOTTERY_ACTIVITY, title: "Vaundy ASIA ARENA TOUR 2026", rounds, currentState: state, parseVersion: TICKET_PLUS_PARSER_VERSION, evidenceIds: rounds.flatMap((round) => round.windows.map((item) => item.evidenceId)).slice(0, 40), observedAt, sourceUrl: TICKET_PLUS_LOTTERY_URL };
}
export function pairTicketPlus(ordinary: TicketPlusOrdinaryObservation | null, lottery: TicketPlusLotteryObservation | null) {
  if (!ordinary || !lottery) return [];
  const evidenceItems = [ordinary.title.toLowerCase().includes("r1an") ? "title-artist" : "", ordinary.sessions.some((s) => s.venue) ? "venue" : ""].filter(Boolean);
  return [{ lotteryActivityId: lottery.activityId, ordinaryActivityId: ordinary.activityId, confidence: evidenceItems.length > 1 ? "medium" as const : "low" as const, evidence: evidenceItems, automationEligible: false }];
}
export async function fetchTicketPlus(fetchImpl: typeof fetch = fetch, now = new Date()): Promise<{ ordinary?: TicketPlusOrdinaryObservation; lottery?: TicketPlusLotteryObservation; errors: string[] }> {
  const errors: string[] = []; const result: { ordinary?: TicketPlusOrdinaryObservation; lottery?: TicketPlusLotteryObservation; errors: string[] } = { errors };
  const ordinaryUrl = process.env.TICKET_PLUS_ORDINARY_API_URL ?? "https://apis.ticketplus.com.tw/config/api/v1/get?eventId=e000001508&sessionId=s000002229,s000002230";
  const lotteryUrl = process.env.TICKET_PLUS_LOTTERY_URL ?? `https://apis.ticketplus.com.tw/config/api/v1/getS3?path=event/${TICKET_PLUS_LOTTERY_ACTIVITY}/event.json`;
  for (const [kind, url] of [["ordinary", ordinaryUrl], ["lottery", lotteryUrl] as const]) {
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json,text/html" }, redirect: "follow" });
      if (!response.ok) throw new Error(`http-${response.status}`);
      const body = await response.text(); ensureSize(body);
      if (kind === "ordinary") result.ordinary = parseTicketPlusOrdinaryJson(body, now.toISOString(), now);
      else result.lottery = parseTicketPlusLotteryHtml(body, now.toISOString(), now);
    } catch (error) { errors.push(`${kind}:${error instanceof Error ? error.message : "unknown"}`); }
  }
  return result;
}
