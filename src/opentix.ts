import { OPENTIX_SOURCE, OPENTIX_TIME_ZONE, NORMALIZED_SCHEMA_VERSION, type LifecycleState, type NormalizedEvent, type NormalizedPerformance } from "./types.js";

export const PARSER_VERSION = "opentix-jsonld-v1";
export const MAX_RESPONSE_BYTES = 2_000_000;
export const MIN_INTERVAL_MS = 30 * 60 * 1000;

export interface FetchResult { status: number; body?: string; etag?: string; lastModified?: string; retryAfterMs?: number; }
export interface PollResult { kind: "success" | "not-modified" | "retryable" | "failure"; status: number; observation?: NormalizedEvent; retryAfterMs?: number; errorCategory?: string; validators?: { etag?: string; lastModified?: string }; }
export interface FetchOptions { now?: Date; timeoutMs?: number; etag?: string; lastModified?: string; fetchImpl?: typeof fetch; }

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function decode(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">" ).replace(/&#x2F;/gi, "/");
}
function isoTaipei(value: unknown): string | undefined {
  const raw = text(value); if (!raw) return undefined;
  if (/Z|[+-]\d\d:\d\d$/.test(raw)) return raw;
  const normalized = raw.replace(/\//g, "-").replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/, "$1-$2-$3T00:00:00");
  return /^\d{4}-\d{1,2}-\d{1,2}T\d{2}:\d{2}(?::\d{2})?$/.test(normalized) ? `${normalized.length === 16 ? `${normalized}:00` : normalized}+08:00` : undefined;
}
function idFor(eventId: string, startsAt: string, index: number, upstreamIds: string[]): string {
  return upstreamIds[index] ?? `${eventId}-${startsAt.replace(/[^0-9]/g, "").slice(0, 12)}-${index + 1}`;
}
function upstreamIds(html: string): string[] {
  return [...html.matchAll(/(?:events:\[\{|\},\{)id:"(\d+)"/g)].map((match) => match[1]!).slice(0, 50);
}
function lifecycle(now: Date, startsAt: string, open?: string, close?: string): LifecycleState {
  const time = now.getTime(); const start = open ? Date.parse(open) : Number.NaN; const end = close ? Date.parse(close) : Number.NaN;
  if (Number.isFinite(end) && time > end) return "ended";
  if (Number.isFinite(start) && time < start) return "pre-sale";
  if (Number.isFinite(start)) return "on-sale";
  if (time > Date.parse(startsAt)) return "ended";
  return "unknown";
}
function jsonLd(html: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    try { const value: unknown = JSON.parse(decode(match[1] ?? "")); if (value && typeof value === "object") result.push(...(Array.isArray(value) ? value : [value]) as Record<string, unknown>[]); } catch { /* malformed JSON-LD is ignored; other bounded fields may still validate */ }
  }
  return result;
}
function meta(html: string, name: string): string | undefined {
  const re = new RegExp(`<meta\\b[^>]*(?:name|property)=["']${escapeRegex(name)}["'][^>]*content=["']([^"']*)["'][^>]*>`, "i");
  return re.exec(html)?.[1] ? decode(re.exec(html)?.[1] ?? "") : undefined;
}
function remainingFor(html: string, startsAt: string, index: number): number | null {
  const visible = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\\u[0-9a-f]{4}/gi, " ");
  const date = startsAt.slice(0, 16).replace("T", "[ T]").replace(/-/g, "[\\/-]");
  const segment = new RegExp(`${date}[\\s\\S]{0,900}?(?:剩|remaining)\\s*[：:]?\\s*(\\d+)`, "i").exec(visible)?.[1];
  if (segment) return Number(segment);
  const literal = /remainingQuantity\s*[:=]\s*(\d+)/g;
  const values = [...html.matchAll(literal)].map((m) => Number(m[1])).filter(Number.isFinite);
  return Number.isFinite(values[index] ?? NaN) ? values[index]! : null;
}

export function parseOpentixHtml(html: string, observedAt = new Date().toISOString(), now = new Date()): NormalizedEvent {
  if (typeof html !== "string" || html.length === 0 || html.length > MAX_RESPONSE_BYTES) throw new Error("parse-failure: response-size");
  if (/<(?:title|h1)[^>]*>[^<]*(?:登入|login|captcha|challenge|access denied)/i.test(html)) throw new Error("parse-failure: challenge-or-login");
  const docs = jsonLd(html).filter((item) => item["@type"] === "Event" || item["@type"] === "MusicEvent");
  const eventId = /\/event\/(\d+)/.exec(html)?.[1] ?? OPENTIX_SOURCE.match(/event\/(\d+)/)?.[1];
  const first = docs[0];
  const title = text(first?.name) || meta(html, "og:title")?.replace(/\s*[—-]\s*OPENTIX.*$/i, "") || "";
  const location = (first?.location && typeof first.location === "object" ? first.location : {}) as Record<string, unknown>;
  const address = location.address && typeof location.address === "object" ? location.address as Record<string, unknown> : {};
  const venueName = text(location.name) || meta(html, "description")?.match(/地點:([^,]+)/)?.[1]?.trim() || "";
  if (!eventId || !title || !venueName || docs.length === 0) throw new Error("parse-failure: required-fields");
  const venue = { name: venueName, ...(text(address.streetAddress) ? { address: text(address.streetAddress) } : {}), timeZone: OPENTIX_TIME_ZONE as typeof OPENTIX_TIME_ZONE };
  const performances: NormalizedPerformance[] = []; const stableIds = upstreamIds(html);
  for (const [index, item] of docs.entries()) {
    const startsAt = isoTaipei(item.startDate); if (!startsAt) continue;
    const endsAt = isoTaipei(item.endDate);
    const offers = item.offers && typeof item.offers === "object" ? item.offers as Record<string, unknown> : {};
    const min = Number(offers.lowPrice); const max = Number(offers.highPrice);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) continue;
    const saleOpenAt = isoTaipei(offers.validFrom ?? offers.availabilityStarts);
    const saleCloseAt = isoTaipei(offers.availabilityEnds);
    performances.push({ schemaVersion: NORMALIZED_SCHEMA_VERSION, source: OPENTIX_SOURCE, eventId, performanceId: idFor(eventId, startsAt, index, stableIds), startsAt, ...(endsAt ? { endsAt } : {}), venue, lifecycle: lifecycle(now, startsAt, saleOpenAt, saleCloseAt), ...(saleOpenAt ? { saleOpenAt } : {}), ...(saleCloseAt ? { saleCloseAt } : {}), price: { currency: "TWD", min, max }, remaining: remainingFor(html, startsAt, index) });
  }
  if (performances.length === 0) throw new Error("parse-failure: no-performances");
  const remainingTotal = performances.some((item) => item.remaining === null) ? null : performances.reduce((sum, item) => sum + (item.remaining ?? 0), 0);
  return { schemaVersion: NORMALIZED_SCHEMA_VERSION, source: OPENTIX_SOURCE, eventId, title, venue, performances, remainingTotal, observedAt, parserVersion: PARSER_VERSION };
}

export function isEligible(lastAttemptAt: string | undefined, now = Date.now(), minimumMs = MIN_INTERVAL_MS): boolean {
  return !lastAttemptAt || now - Date.parse(lastAttemptAt) >= minimumMs;
}
export function nextEligibleAt(lastAttemptAt: string, jitterMs = 0): string { return new Date(Date.parse(lastAttemptAt) + MIN_INTERVAL_MS + Math.max(0, jitterMs)).toISOString(); }
export function backoffMs(attempt: number, retryAfterMs?: number, capMs = 6 * 60 * 60 * 1000): number { return Math.min(capMs, Math.max(0, retryAfterMs ?? 30_000) * 2 ** Math.max(0, attempt - 1)); }

export async function fetchOpentix(url = OPENTIX_SOURCE, options: FetchOptions = {}): Promise<PollResult> {
  const fetchImpl = options.fetchImpl ?? fetch; const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const headers: Record<string, string> = { accept: "text/html,application/xhtml+xml" }; if (options.etag) headers["if-none-match"] = options.etag; if (options.lastModified) headers["if-modified-since"] = options.lastModified;
    const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "follow" });
    const retry = Number(response.headers.get("retry-after")); const retryAfterMs = Number.isFinite(retry) ? retry * 1000 : undefined;
    const validators = { ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}), ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}) };
    if (response.status === 304) return { kind: "not-modified", status: 304, validators };
    if (response.status === 429 || response.status >= 500) return { kind: "retryable", status: response.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), validators, errorCategory: response.status === 429 ? "rate-limited" : "upstream-5xx" };
    if (!response.ok) return { kind: "failure", status: response.status, validators, errorCategory: `http-${response.status}` };
    const body = await response.text(); if (body.length > MAX_RESPONSE_BYTES) return { kind: "failure", status: response.status, validators, errorCategory: "response-size" };
    return { kind: "success", status: response.status, validators, observation: parseOpentixHtml(body, (options.now ?? new Date()).toISOString(), options.now ?? new Date()) };
  } catch (error) { return { kind: "retryable", status: 0, errorCategory: error instanceof Error && error.name === "AbortError" ? "timeout" : "network" }; }
  finally { clearTimeout(timeout); }
}
