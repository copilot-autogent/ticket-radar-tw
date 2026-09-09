import { parseOpentixHtml } from "./opentix.js";

export const CATALOG_SCHEMA_VERSION = 1 as const;
export const CATALOG_SITEMAP_CAP = 500;
export const CATALOG_PAGE_SIZE = 20;
export const CATALOG_EVENT_CAP = 100;
export const CATALOG_PAGE_CAP = 5;
export const CATALOG_DETAIL_CAP = 20;

export type CatalogSource = "opentix" | "udn";
export type ClassificationReason = "source-category" | "title-keyword-fallback" | "unknown";
export type ClassificationConfidence = "high" | "medium" | "low";
export type CatalogDetailStatus = "discovered-summary" | "detail-enriched";
export type CatalogCompletenessStatus = "complete" | "truncated" | "stale";

export interface CatalogProvenance { source: CatalogSource; sourceUrl: string; retrievedAt: string; discoveryMethod: "structured-summary" | "detail"; parserVersion: string; }
export interface CatalogPerformance {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION; source: CatalogSource; eventId: string; performanceId: string; sourceUrl: string;
  startsAt?: string | undefined; endsAt?: string | undefined; venue?: string | undefined; city?: string | undefined; cancelled: boolean; saleStart?: string | undefined; saleEnd?: string | undefined;
  minPrice: number | null; maxPrice: number | null; currency: "TWD";
}
export interface CatalogSummary {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION; source: CatalogSource; eventId: string; sourceUrl: string; title: string; artist?: string | undefined;
  venue?: string | undefined; city?: string | undefined; sourceCategory?: string | undefined; category: "musical" | "concert" | "other" | "unknown";
  classificationReason: ClassificationReason; classificationConfidence: ClassificationConfidence; firstSeenAt: string;
  catalogFetchedAt: string; detailStatus: CatalogDetailStatus; provenance: CatalogProvenance;
}
export interface CatalogEvent extends CatalogSummary { performances: CatalogPerformance[]; }
export interface CatalogCoverage { summariesDiscovered: number; detailEnriched: number; performancesDiscovered: number; pricesKnown: number; categoriesKnown: number; }
export interface CatalogCompleteness {
  source: CatalogSource; fetchedAt: string; eventCount: number; pageCount: number; detailCount: number;
  stopReason: "normal-exhaustion" | "cap" | "partial" | "backoff" | "error"; status: CatalogCompletenessStatus;
  health: "ok" | "stale" | "error" | "not-run"; error?: string;
}
export interface CatalogState { schemaVersion: typeof CATALOG_SCHEMA_VERSION; generatedAt: string; summaries: CatalogSummary[]; events: CatalogEvent[]; completeness: CatalogCompleteness; coverage: CatalogCoverage; }
const sourceParserVersion = "catalog-structured-v2";

export function classifyEvent(title: string, sourceCategory: string | undefined): Pick<CatalogSummary, "category" | "classificationReason" | "classificationConfidence"> {
  const category = sourceCategory?.trim().toLowerCase();
  if (category) {
    if (/音樂劇|musical/.test(category)) return { category: "musical", classificationReason: "source-category", classificationConfidence: "high" };
    if (/演唱|concert|音樂會/.test(category)) return { category: "concert", classificationReason: "source-category", classificationConfidence: "high" };
    return { category: "other", classificationReason: "source-category", classificationConfidence: "high" };
  }
  if (/音樂劇|musical/i.test(title)) return { category: "musical", classificationReason: "title-keyword-fallback", classificationConfidence: "medium" };
  if (/演唱會|音樂會|concert/i.test(title)) return { category: "concert", classificationReason: "title-keyword-fallback", classificationConfidence: "medium" };
  return { category: "unknown", classificationReason: "unknown", classificationConfidence: "low" };
}
function sourceUrl(source: CatalogSource, id: string): string { return source === "opentix" ? `https://www.opentix.life/event/${id}` : `https://tickets.udnfunlife.com/Application/UTK02/UTK0201_.aspx?PRODUCT_ID=${id}`; }
function eventIdFromUrl(url: string): string { return /\/event\/(\d+)/.exec(url)?.[1] ?? new URL(url).searchParams.get("PRODUCT_ID") ?? url; }
function decode(value: string): string { return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/gi, " "); }
function plainText(value: string): string { return decode(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }
function htmlTitle(html: string): string { return plainText(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html)?.[1] ?? /<title[^>]*>([^<]+)/i.exec(html)?.[1] ?? ""); }
function htmlArtist(html: string): string | undefined { const value = /<meta[^>]+(?:property|name)=["'](?:music:musician|event:performer|artist)["'][^>]+content=["']([^"']+)/i.exec(html)?.[1]; return value ? decode(value).trim() || undefined : undefined; }
function cityFromAddress(value: string | undefined): string | undefined { return value?.match(/台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣/)?.[0]; }
function isoDate(value: string): string | undefined {
  const match = value.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/); if (!match) return undefined;
  const [, year, month = "01", day = "01", hour = "00", minute = "00"] = match; return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:00+08:00`;
}
function parseUdnDate(value: string): string | undefined { return isoDate(value.replace(/年/g, "/").replace(/月/g, "/").replace(/日/g, "").replace(/\([^)]*\)/g, " ")); }
function priceNumbers(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return [value]; if (typeof value !== "string") return [];
  return [...value.replace(/,/g, "").matchAll(/(?:NT\$|TWD|票價|價格|票)\s*(\d{2,6})/gi)].map((match) => Number(match[1])).filter((item) => Number.isFinite(item) && item >= 0);
}
function priceRange(value: string): { minPrice: number | null; maxPrice: number | null } { const prices = priceNumbers(value); return prices.length ? { minPrice: Math.min(...prices), maxPrice: Math.max(...prices) } : { minPrice: null, maxPrice: null }; }
function jsonLd(html: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (item["@type"] === "Event" || item["@type"] === "TheaterEvent" || item["@type"] === "MusicEvent" || item["@type"] === "Concert") values.push(item);
    if (item["@graph"]) visit(item["@graph"]);
    if (item.itemListElement) visit(item.itemListElement);
    if (item.item) visit(item.item);
  };
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { visit(JSON.parse(decode(match[1] ?? ""))); } catch { /* optional structured block */ } }
  return values;
}
function eventLinks(html: string, source: CatalogSource): string[] {
  const links = source === "opentix" ? [...html.matchAll(/(?:https?:\/\/www\.opentix\.life)?\/event\/(\d+)/gi)].map((match) => sourceUrl(source, match[1]!)) : [...html.matchAll(/(?:https?:\/\/tickets\.udnfunlife\.com)?\/Application\/UTK02\/UTK0201_\.aspx\?[^"' <]+/gi)].map((match) => new URL(decode(match[0]!), "https://tickets.udnfunlife.com").toString());
  return [...new Map(links.map((url) => [`${source}:${eventIdFromUrl(url)}`, url])).values()];
}
function summaryFromStructured(item: Record<string, unknown>, source: CatalogSource, now: string): CatalogSummary | null {
  const type = item["@type"]; if (!(type === "Event" || type === "TheaterEvent" || type === "MusicEvent" || type === "Concert")) return null;
  const rawUrl = typeof item.url === "string" ? item.url : typeof item["@id"] === "string" ? item["@id"] : ""; const id = rawUrl ? eventIdFromUrl(rawUrl) : typeof item.identifier === "string" ? item.identifier : ""; const title = typeof item.name === "string" ? item.name.trim() : ""; if (!id || !title) return null;
  const location = item.location && typeof item.location === "object" ? item.location as Record<string, unknown> : {}; const address = location.address && typeof location.address === "object" ? location.address as Record<string, unknown> : {};
  const addressText = typeof location.address === "string" ? location.address : typeof address.streetAddress === "string" ? address.streetAddress : undefined; const sourceCategory = typeof item.genre === "string" ? item.genre : typeof item.category === "string" ? item.category : undefined; const classification = classifyEvent(title, sourceCategory); const url = sourceUrl(source, id);
  return { schemaVersion: CATALOG_SCHEMA_VERSION, source, eventId: id, sourceUrl: url, title, ...(typeof item.performer === "string" ? { artist: item.performer } : {}), ...(typeof location.name === "string" ? { venue: location.name } : {}), ...(addressText && cityFromAddress(addressText) ? { city: cityFromAddress(addressText) } : {}), ...(sourceCategory ? { sourceCategory } : {}), ...classification, firstSeenAt: now, catalogFetchedAt: now, detailStatus: "discovered-summary", provenance: { source, sourceUrl: url, retrievedAt: now, discoveryMethod: "structured-summary", parserVersion: sourceParserVersion } };
}
export function parseCatalogSummaries(html: string, source: CatalogSource, now = new Date()): CatalogSummary[] {
  const timestamp = now.toISOString(); const structured = jsonLd(html).map((item) => summaryFromStructured(item, source, timestamp)).filter((item): item is CatalogSummary => item !== null);
  const linked = eventLinks(html, source).map((url): CatalogSummary => { const title = `${source.toUpperCase()} event ${eventIdFromUrl(url)}`; return { schemaVersion: CATALOG_SCHEMA_VERSION, source, eventId: eventIdFromUrl(url), sourceUrl: url, title, ...classifyEvent(title, undefined), firstSeenAt: timestamp, catalogFetchedAt: timestamp, detailStatus: "discovered-summary", provenance: { source, sourceUrl: url, retrievedAt: timestamp, discoveryMethod: "structured-summary", parserVersion: sourceParserVersion } }; });
  return [...new Map([...linked, ...structured].map((item) => [`${source}:${item.eventId}`, item])).values()];
}
function performanceFromOpentix(item: ReturnType<typeof parseOpentixHtml>["performances"][number], eventId: string, url: string): CatalogPerformance { return { schemaVersion: CATALOG_SCHEMA_VERSION, source: "opentix", eventId, performanceId: item.performanceId, sourceUrl: url, startsAt: item.startsAt, ...(item.endsAt ? { endsAt: item.endsAt } : {}), cancelled: false, ...(item.saleOpenAt ? { saleStart: item.saleOpenAt } : {}), ...(item.saleCloseAt ? { saleEnd: item.saleCloseAt } : {}), minPrice: item.price.min, maxPrice: item.price.max, currency: "TWD" }; }
export function parseUdnCatalogDetailHtml(html: string, eventUrl: string, _now = new Date()): { title: string; performances: CatalogPerformance[] } {
  const eventId = eventIdFromUrl(eventUrl); const title = htmlTitle(html).replace(/\s*[|｜]\s*udn.*$/i, "").trim(); const structured = jsonLd(html).filter((item) => item["@type"] === "TheaterEvent" || item["@type"] === "Event");
  const structuredPerformances = structured.map((item, index) => { const location = item.location && typeof item.location === "object" ? item.location as Record<string, unknown> : {}; const address = typeof location.address === "string" ? location.address : undefined; const offers = Array.isArray(item.offers) ? item.offers : item.offers ? [item.offers] : []; const prices = offers.flatMap((offer) => offer && typeof offer === "object" ? [...priceNumbers((offer as Record<string, unknown>).price), ...priceNumbers((offer as Record<string, unknown>).lowPrice), ...priceNumbers((offer as Record<string, unknown>).highPrice)] : []); const startsAt = typeof item.startDate === "string" ? parseUdnDate(item.startDate) : undefined; return { schemaVersion: CATALOG_SCHEMA_VERSION, source: "udn" as const, eventId, performanceId: typeof item.identifier === "string" ? item.identifier : `${eventId}-performance-${index + 1}`, sourceUrl: eventUrl, ...(startsAt ? { startsAt } : {}), cancelled: typeof item.eventStatus === "string" && /cancel/i.test(item.eventStatus), ...(typeof location.name === "string" ? { venue: location.name } : {}), ...(address && cityFromAddress(address) ? { city: cityFromAddress(address) } : {}), minPrice: prices.length ? Math.min(...prices) : null, maxPrice: prices.length ? Math.max(...prices) : null, currency: "TWD" as const }; });
  if (structuredPerformances.length > 0) return { title: title || (typeof structured[0]?.name === "string" ? structured[0]!.name as string : ""), performances: structuredPerformances };
  const links = [...html.matchAll(/(?:https?:\/\/tickets\.udnfunlife\.com)?\/Application\/UTK02\/UTK0204_(?:000)?\.aspx\?[^"' <]+/gi)].map((match) => new URL(decode(match[0]!), "https://tickets.udnfunlife.com").toString()); const uniqueLinks = [...new Map(links.map((url) => [new URL(url).searchParams.get("PERFORMANCE_ID") ?? url, url])).values()]; const blocks = [...html.matchAll(/<(?:tr|li|div)\b[^>]*>([\s\S]*?)<\/(?:tr|li|div)>/gi)].map((match) => plainText(match[1] ?? "")); const sourceBlocks = blocks.filter((block) => isoDate(block) || /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(block));
  const performances = Array.from({ length: Math.max(uniqueLinks.length, sourceBlocks.length) }, (_, index) => { const block = sourceBlocks[index] ?? ""; const startsAt = isoDate(block); const id = new URL(uniqueLinks[index] ?? eventUrl).searchParams.get("PERFORMANCE_ID") ?? `${eventId}-performance-${index + 1}`; const prices = priceRange(block); const venueMatch = block.match(/(?:場館|場地|地點|venue)\s*[:：]\s*([^|｜,，;；]+)/i); const cityMatch = block.match(/(?:城市|縣市|city)\s*[:：]\s*([^|｜,，;；]+)/i); const saleStart = isoDate(block.match(/(?:開賣|售票|sale)\s*[:：]?\s*([^\s|｜]+)/i)?.[1] ?? ""); return { schemaVersion: CATALOG_SCHEMA_VERSION, source: "udn" as const, eventId, performanceId: id, sourceUrl: uniqueLinks[index] ?? eventUrl, ...(startsAt ? { startsAt } : {}), cancelled: /取消|cancel/i.test(block), ...(venueMatch?.[1] ? { venue: venueMatch[1].trim() } : {}), ...(cityMatch?.[1] ? { city: cityMatch[1].replace(/\s+NT\$.*$/i, "").trim() } : {}), ...(saleStart ? { saleStart } : {}), ...prices, currency: "TWD" as const }; });
  return { title, performances };
}
function mergeSummary(old: CatalogSummary | undefined, next: CatalogSummary): CatalogSummary { return { ...old, ...next, firstSeenAt: old?.firstSeenAt ?? next.firstSeenAt, ...(old?.detailStatus === "detail-enriched" && next.detailStatus === "discovered-summary" ? { detailStatus: old.detailStatus, provenance: old.provenance, catalogFetchedAt: old.catalogFetchedAt } : {}), ...(next.title ? { title: next.title } : old?.title ? { title: old.title } : {}), ...(next.artist || old?.artist ? { artist: next.artist ?? old?.artist } : {}), ...(next.venue || old?.venue ? { venue: next.venue ?? old?.venue } : {}), ...(next.city || old?.city ? { city: next.city ?? old?.city } : {}), ...(next.sourceCategory || old?.sourceCategory ? { sourceCategory: next.sourceCategory ?? old?.sourceCategory } : {}) }; }
function coverage(events: CatalogEvent[]): CatalogCoverage { return { summariesDiscovered: events.length, detailEnriched: events.filter((event) => event.detailStatus === "detail-enriched").length, performancesDiscovered: events.reduce((sum, event) => sum + event.performances.length, 0), pricesKnown: events.reduce((sum, event) => sum + event.performances.filter((item) => item.minPrice !== null && item.maxPrice !== null).length, 0), categoriesKnown: events.filter((event) => event.category !== "unknown").length }; }
function normalizeEvent(event: CatalogEvent, source: CatalogSource, now: string): CatalogEvent {
  const performances = event.performances ?? [];
  const eventSourceUrl = event.sourceUrl || sourceUrl(source, event.eventId);
  return {
    ...event,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source,
    sourceUrl: eventSourceUrl,
    title: event.title || `${source.toUpperCase()} event ${event.eventId}`,
    detailStatus: event.detailStatus ?? (performances.length ? "detail-enriched" : "discovered-summary"),
    provenance: event.provenance ?? { source, sourceUrl: eventSourceUrl, retrievedAt: event.catalogFetchedAt || now, discoveryMethod: "legacy-migration", parserVersion: "legacy-state" },
    performances
  };
}
export function catalogStateMateriallyEqual(a: CatalogState | null, b: CatalogState): boolean { if (!a) return false; const comparable = (state: CatalogState) => ({ ...state, generatedAt: "", completeness: { ...state.completeness, fetchedAt: "" }, events: state.events.map((event) => ({ ...event, catalogFetchedAt: "" })), summaries: (state.summaries ?? state.events.map(({ performances: _performances, ...summary }) => summary)).map((summary) => ({ ...summary, catalogFetchedAt: "" })) }); return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b)); }
export function mergeCatalogState(previous: CatalogState | null, incoming: CatalogState): CatalogState {
  const normalizedIncoming = { ...incoming, events: incoming.events.map((event) => normalizeEvent(event, incoming.completeness.source, incoming.generatedAt)) };
  if (!previous) return { ...normalizedIncoming, summaries: normalizedIncoming.events.map(({ performances: _performances, ...summary }) => summary), completeness: { ...normalizedIncoming.completeness, eventCount: normalizedIncoming.events.length }, coverage: coverage(normalizedIncoming.events) };
  const oldByKey = new Map(previous.events.map((event) => { const normalized = normalizeEvent(event, previous.completeness.source, previous.generatedAt); return [`${normalized.source}:${normalized.eventId}`, normalized]; }));
  const incomingByKey = new Map(normalizedIncoming.events.map((event) => [`${event.source}:${event.eventId}`, event]));
  const keys = [...new Set([...oldByKey.keys(), ...incomingByKey.keys()])].slice(0, CATALOG_EVENT_CAP);
  const events = keys.map((key) => { const old = oldByKey.get(key); const next = incomingByKey.get(key); if (!next) return old!; const merged = mergeSummary(old, next); return { ...merged, performances: next.performances.length ? next.performances : old?.performances ?? [], detailStatus: next.performances.length ? "detail-enriched" : old?.detailStatus ?? "discovered-summary" } as CatalogEvent; }); const stale = normalizedIncoming.completeness.health !== "ok"; const completeness = { ...normalizedIncoming.completeness, eventCount: events.length, status: stale ? "stale" as const : normalizedIncoming.completeness.status }; return { ...normalizedIncoming, events, summaries: events.map(({ performances: _performances, ...summary }) => summary), completeness, coverage: coverage(events) };
}
export async function discoverCatalog(source: CatalogSource, options: { now?: Date; fetchImpl?: typeof fetch; indexUrls?: string[]; watchedIds?: string[]; interestTerms?: string[]; } = {}): Promise<CatalogState> {
  const fetchImpl = options.fetchImpl ?? fetch; const now = options.now ?? new Date(); const timestamp = now.toISOString(); const configuredUrls = options.indexUrls ?? Array.from({ length: CATALOG_PAGE_CAP }, (_, index) => source === "opentix" ? `https://www.opentix.life/?page=${index + 1}` : `https://tickets.udnfunlife.com/?page=${index + 1}`); const summaries = new Map<string, CatalogSummary>(); let pageCount = 0; let detailCount = 0; let pageError: string | undefined;
  try { for (const index of configuredUrls.slice(0, CATALOG_PAGE_CAP)) { const response = await fetchImpl(index, { headers: { accept: "text/html,application/xhtml+xml,application/ld+json" }, redirect: "follow" }); pageCount++; if (!response.ok) { pageError = `http-${response.status}`; break; } for (const summary of parseCatalogSummaries(await response.text(), source, now)) { if (summaries.size < CATALOG_EVENT_CAP || summaries.has(`${source}:${summary.eventId}`)) summaries.set(`${source}:${summary.eventId}`, summary); } if (summaries.size >= CATALOG_EVENT_CAP) break; } } catch (error) { pageError = error instanceof Error ? error.message : "discovery-failure"; }
  const allSummaries = [...summaries.values()].slice(0, CATALOG_EVENT_CAP); const watched = new Set(options.watchedIds ?? []); const terms = (options.interestTerms ?? []).map((value) => value.toLocaleLowerCase()); const prioritized = [...allSummaries].sort((a, b) => { const watchedRank = Number(watched.has(`${b.source}:${b.eventId}`)) - Number(watched.has(`${a.source}:${a.eventId}`)); const interestRank = Number(terms.some((term) => `${b.title} ${b.artist ?? ""}`.toLocaleLowerCase().includes(term))) - Number(terms.some((term) => `${a.title} ${a.artist ?? ""}`.toLocaleLowerCase().includes(term))); return watchedRank || interestRank || a.title.localeCompare(b.title) || a.eventId.localeCompare(b.eventId); }).slice(0, CATALOG_DETAIL_CAP);
  const byKey = new Map(allSummaries.map((item) => [`${source}:${item.eventId}`, { ...item, performances: [] as CatalogPerformance[] }]));
  for (const summary of prioritized) { detailCount++; try { const response = await fetchImpl(summary.sourceUrl, { headers: { accept: "text/html,application/xhtml+xml,application/ld+json" }, redirect: "follow" }); if (!response.ok) continue; const html = await response.text(); let title = summary.title; let performances: CatalogPerformance[] = []; if (source === "opentix") { try { const parsed = parseOpentixHtml(html, timestamp, now); title = parsed.title; performances = parsed.performances.map((item) => performanceFromOpentix(item, summary.eventId, summary.sourceUrl)); } catch { performances = []; } } else { const parsed = parseUdnCatalogDetailHtml(html, summary.sourceUrl, now); title = parsed.title || title; performances = parsed.performances; } const old = byKey.get(`${source}:${summary.eventId}`)!; byKey.set(`${source}:${summary.eventId}`, { ...old, title, detailStatus: "detail-enriched", ...(htmlArtist(html) ? { artist: htmlArtist(html) } : {}), ...classifyEvent(title, old.sourceCategory), catalogFetchedAt: timestamp, provenance: { ...old.provenance, retrievedAt: timestamp, discoveryMethod: "detail", parserVersion: sourceParserVersion }, performances }); } catch { /* retain summary */ } }
  const events = [...byKey.values()] as CatalogEvent[]; const truncated = pageCount >= CATALOG_PAGE_CAP || summaries.size >= CATALOG_EVENT_CAP; const status: CatalogCompletenessStatus = pageError ? "stale" : truncated ? "truncated" : "complete"; const completeness: CatalogCompleteness = { source, fetchedAt: timestamp, eventCount: events.length, pageCount, detailCount, stopReason: pageError ? "partial" : truncated ? "cap" : "normal-exhaustion", status, health: pageError && events.length === 0 ? "error" : pageError ? "stale" : "ok", ...(pageError ? { error: pageError } : {}) }; return { schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt: timestamp, summaries: events.map(({ performances: _performances, ...summary }) => summary), events, completeness, coverage: coverage(events) };

}

export function isUdnPurchasable(tier: { availability: string; exactCount: number | null }): boolean {
  return (tier.availability === "exact" && (tier.exactCount ?? 0) > 0) || tier.availability === "hot-selling-unknown";
}
export function selectUdnTiers<T extends { availability: string; exactCount: number | null }>(tiers: T[], includeUnavailable = false): T[] {
  return includeUnavailable ? tiers : tiers.filter(isUdnPurchasable);
}
export function cheapestUdnExactPositive<T extends { availability: string; exactCount: number | null; priceTwd: number }>(tiers: T[]): T | null {
  return tiers.filter((tier) => tier.availability === "exact" && (tier.exactCount ?? 0) > 0 && !/(access|companion|student|member|package|lottery|wheelchair|accessibility|身份|會員|陪同|套票|抽籤|輪椅|無障礙)/i.test((tier as T & { label?: string }).label ?? "")).sort((a, b) => a.priceTwd - b.priceTwd)[0] ?? null;
}
