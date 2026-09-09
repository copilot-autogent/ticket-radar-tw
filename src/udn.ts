import { UDN_EVENT_ID, UDN_EVENT_SOURCE, UDN_PROVIDER, type UdnAvailabilityKind, type UdnObservation, type UdnTier } from "./types.js";

export const UDN_PARSER_VERSION = "udn-utk0204-table-v1";
export const UDN_HOST = "tickets.udnfunlife.com";
export const UDN_PERFORMANCE_PATH = "/Application/UTK02/UTK0204_.aspx";
export const MAX_UDN_RESPONSE_BYTES = 2_000_000;

function decode(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function text(value: string): string {
  return decode(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}
function fail(reason: string): never { throw new Error(`udn-parse-failure: ${reason}`); }
function expectedUrl(url: string, performanceId?: string): URL {
  const parsed = new URL(url);
  if (parsed.hostname !== UDN_HOST || !/^\/Application\/UTK02\/UTK0204_(?:000)?\.aspx$/i.test(parsed.pathname)) fail("unexpected-host-or-path");
  if (parsed.searchParams.get("PRODUCT_ID") !== UDN_EVENT_ID) fail("event-identity");
  const actual = parsed.searchParams.get("PERFORMANCE_ID");
  if (!actual || (performanceId && actual !== performanceId)) fail("performance-identity");
  return parsed;
}
function availability(value: string): { kind: UdnAvailabilityKind; count: number | null } {
  const normalized = value.replace(/,/g, "").trim();
  if (/^\d+$/.test(normalized)) return { kind: "exact", count: Number(normalized) };
  if (/售罄|售完|sold\s*out/i.test(normalized)) return { kind: "sold-out", count: null };
  if (/熱賣|暢銷|hot\s*sell/i.test(normalized)) return { kind: "hot-selling-unknown", count: null };
  return { kind: "unknown", count: null };
}
function tierId(label: string, price: number): string {
  return `${label.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()}|${price}`;
}

export function parseUdnPerformanceHtml(html: string, url: string, observedAt = new Date().toISOString(), performanceId?: string): UdnObservation {
  if (typeof html !== "string" || html.length === 0 || html.length > MAX_UDN_RESPONSE_BYTES) fail("response-size");
  const parsedUrl = expectedUrl(url, performanceId);
  if (/<(?:title|h1)[^>]*>[^<]*(?:登入|login|captcha|challenge|access denied)/i.test(html)) fail("challenge-or-login");
  const title = text(/<meta[^>]+(?:property|name)=["'](?:og:title|title)["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ?? "");
  const rows = [...html.matchAll(/<tr\b[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)]
    .map((match) => ({ label: text(match[1] ?? ""), priceText: text(match[2] ?? ""), stateText: text(match[3] ?? "") }))
    .filter((row) => row.label && row.priceText && row.stateText && /\d/.test(row.priceText));
  if (!title || rows.length === 0) fail("missing-tier-rows");
  const tiers: UdnTier[] = [];
  const seen = new Map<string, string>();
  for (const row of rows) {
    const priceMatch = row.priceText.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    if (!priceMatch) fail("tier-price");
    const priceTwd = Number(priceMatch[0]);
    const id = tierId(row.label, priceTwd);
    const semantic = `${id}|${row.stateText.replace(/\s+/g, " ").trim()}`;
    const previous = seen.get(id);
    if (previous && previous !== semantic) fail("conflicting-duplicate-tier");
    if (previous) continue;
    seen.set(id, semantic);
    const parsed = availability(row.stateText);
    tiers.push({ provider: UDN_PROVIDER, eventId: UDN_EVENT_ID, performanceId: parsedUrl.searchParams.get("PERFORMANCE_ID")!, tierId: id, label: row.label, priceTwd, sourceUrl: parsedUrl.toString(), availability: parsed.kind, exactCount: parsed.count });
  }
  if (tiers.length === 0 || tiers.some((tier) => tier.availability === "unknown")) fail("unknown-tier-state");
  return { provider: UDN_PROVIDER, eventId: UDN_EVENT_ID, performanceId: tiers[0]!.performanceId, title, sourceUrl: parsedUrl.toString(), observedAt, parserVersion: UDN_PARSER_VERSION, tiers };
}

export interface UdnFetchResult { kind: "success" | "failure" | "retryable"; status: number; observation?: UdnObservation; errorCategory?: string; finalUrl?: string; }
export async function fetchUdnPerformance(performanceUrl: string, options: { fetchImpl?: typeof fetch; now?: Date; timeoutMs?: number } = {}): Promise<UdnFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const expected = expectedUrl(performanceUrl);
    const response = await fetchImpl(expected.toString(), { headers: { accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal: controller.signal });
    if (response.status === 429 || response.status >= 500) return { kind: "retryable", status: response.status, errorCategory: "upstream-retryable", finalUrl: response.url };
    if (!response.ok) return { kind: "failure", status: response.status, errorCategory: `http-${response.status}`, finalUrl: response.url };
    const body = await response.text();
    const observation = parseUdnPerformanceHtml(body, response.url, (options.now ?? new Date()).toISOString(), expected.searchParams.get("PERFORMANCE_ID")!);
    return { kind: "success", status: response.status, observation, finalUrl: response.url };
  } catch (error) {
    return { kind: "failure", status: 0, errorCategory: error instanceof Error ? error.message.startsWith("udn-parse-failure") ? "parse-failure" : error.name === "AbortError" ? "timeout" : "network" : "unknown" };
  } finally { clearTimeout(timeout); }
}

export async function discoverUdnPerformance(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(UDN_EVENT_SOURCE, { redirect: "follow", headers: { accept: "text/html,application/xhtml+xml" } });
  if (!response.ok || new URL(response.url).hostname !== UDN_HOST) fail("event-page-redirect");
  let html = await response.text();
  let match = /UTK0204_\.aspx\?PERFORMANCE_ID=([A-Z0-9]+)\s*&amp;\s*PRODUCT_ID=P1AEBJG5/i.exec(html) ?? /UTK0204_\.aspx\?PERFORMANCE_ID=([A-Z0-9]+)\s*&\s*PRODUCT_ID=P1AEBJG5/i.exec(html);
  if (!match) {
    const performanceList = await fetchImpl(`${new URL(UDN_EVENT_SOURCE).origin}/Application/UTK02/UTK0203_.aspx?PRODUCT_ID=${UDN_EVENT_ID}`, { redirect: "follow", headers: { accept: "text/html,application/xhtml+xml" } });
    if (!performanceList.ok || new URL(performanceList.url).hostname !== UDN_HOST) fail("performance-page-redirect");
    html = await performanceList.text();
    match = /UTK0204_\.aspx\?PERFORMANCE_ID=([A-Z0-9]+)\s*&\s*PRODUCT_ID=P1AEBJG5/i.exec(html);
  }
  if (!match) fail("missing-performance-link");
  return `https://${UDN_HOST}${UDN_PERFORMANCE_PATH}?PERFORMANCE_ID=${match[1]}&PRODUCT_ID=${UDN_EVENT_ID}`;
}
