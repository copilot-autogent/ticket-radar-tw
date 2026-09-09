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
function lifecycle(status: string, start?: string, end?: string, sessionStart?: string, now = Date.now()): TicketPlusOrdinaryLifecycle {
  if (sessionStart && Date.parse(sessionStart) <= now && (!end || Date.parse(end) > now)) return "ended";
  if (end && Date.parse(end) < now) return "sale-closed";
  if (status.toLowerCase() === "onsale") return "on-sale";
  if (start) return Date.parse(start) > now ? "sale-scheduled" : "on-sale";
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
      lifecycle: lifecycle(status, saleStartAt, saleEndAt, startsAt, now.getTime()),
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
  const dates = [...value.matchAll(/(?:20\d{2}[年/-])?\d{1,2}[月/-]\d{1,2}\s*(?:日\s*)?(?:\([^)]*\)|（[^）]*）)?\s*\d{1,2}[:：]\d{2}/g)].map((match) => match[0]!.replace(/\s+/g, ""));
  return `${label}:${dates.slice(0, 2).join(",") || "label-present"}`;
}
function windowFrom(text: string, kind: TicketPlusLotteryRound["windows"][number]["kind"], label: RegExp): { kind: TicketPlusLotteryRound["windows"][number]["kind"]; startAt?: string; endAt?: string; evidenceId: string } | undefined {
  const match = label.exec(text);
  if (!match) return undefined;
  const segment = text.slice(match.index, match.index + 500);
  const dates = [...segment.matchAll(/(?:20\d{2}\s*(?:年|\/|-)\s*)?\d{1,2}\s*(?:月|\/|-)\s*\d{1,2}\s*日?\s*(?:\([^)]*\)|（[^）]*）)?\s*\d{1,2}[:：]\d{2}/g)].map((m) => timestamp((m[0]!.match(/^20\d{2}/) ? m[0]! : `2026/${m[0]!}`).replace(/[年月]/g, "-").replace(/日/g, " ").replace(/[()（）][^()（）]*[)）]/g, "")));
  if (!dates.length) return undefined;
  return { kind, ...(dates[0] ? { startAt: dates[0] } : {}), ...(dates[1] ? { endAt: dates[1] } : {}), evidenceId: evidence(kind, match[0] ?? "") };
}
export function parseTicketPlusLotteryHtml(body: string, observedAt = new Date().toISOString(), now = new Date()): TicketPlusLotteryObservation {
  ensureSize(body);
  void now;
  let source = body;
  try {
    const parsed = JSON.parse(body) as unknown;
    source = findAll(parsed, () => true).flatMap((item) => Object.values(item).filter((value): value is string => typeof value === "string")).join(" ");
  } catch { /* official activity pages are HTML; JSON config pages are also supported */ }
  const text = source.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const rounds: TicketPlusLotteryRound[] = [];
  const initialWindows = [
    windowFrom(text, "registration", /(?:登記時間|報名時間|登記抽選[：:])[^；。]{0,180}/i),
    windowFrom(text, "results", /(?:結果公布|中選結果|抽選結果)[^；。]{0,180}/i),
    windowFrom(text, "payment", /(?:繳費期限|付款期限|付款)[^；。]{0,180}/i),
    windowFrom(text, "general-sale", /(?:一般販售|一般發售|條件一般)[^；。]{0,180}/i)
  ].filter((item): item is NonNullable<typeof item> => Boolean(item)).map((item) => ({ ...item, version: 1 }));
  if (initialWindows.length) rounds.push({ roundId: "initial", kind: "initial", windows: initialWindows, version: 1, state: text.includes("登記截止") || text.includes("登記截止") ? "registration-closed" : "unknown" });
  const second = /第二(?:次|輪|回)[\s\S]{0,500}/i.test(text);
  if (second) rounds.push({ roundId: "second", kind: "second", windows: initialWindows.map((item) => ({ ...item, version: 1 })), version: 1, state: "unknown" });
  if (!rounds.length) throw new Error("ticket-plus-parse-failure: missing-lottery-windows");
  const state: TicketPlusLotteryState = text.includes("登記截止") ? "registration-closed" : text.includes("付款") ? "payment-window" : text.includes("一般販售") ? "general-sale-scheduled" : "unknown";
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
