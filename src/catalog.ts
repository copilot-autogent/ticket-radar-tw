import { parseOpentixHtml } from "./opentix.js";

export const CATALOG_SCHEMA_VERSION = 1 as const;
export const CATALOG_EVENT_CAP = 100;
export const CATALOG_PAGE_CAP = 5;
export const CATALOG_DETAIL_CAP = 20;
export const CATALOG_SITEMAP_CAP = 500;
export const CATALOG_PAGE_SIZE = 20;
export const CATALOG_MAX_RESPONSE_BYTES = 1_048_576;

export type CatalogSource = "opentix" | "udn";
export type ClassificationReason = "source-category" | "title-keyword-fallback" | "unknown";
export type ClassificationConfidence = "high" | "medium" | "low";

export interface CatalogPerformance {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  source: CatalogSource;
  eventId: string;
  performanceId: string;
  sourceUrl: string;
  startsAt?: string;
  endsAt?: string;
  venue?: string;
  city?: string;
  cancelled: boolean;
  saleStart?: string;
  saleEnd?: string;
  minPrice: number | null;
  maxPrice: number | null;
  currency: "TWD";
}

export interface CatalogEvent {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  source: CatalogSource;
  eventId: string;
  sourceUrl: string;
  title: string;
  artist?: string;
  venue?: string;
  city?: string;
  sourceCategory?: string;
  category: "musical" | "concert" | "other" | "unknown";
  classificationReason: ClassificationReason;
  classificationConfidence: ClassificationConfidence;
  firstSeenAt: string;
  catalogFetchedAt: string;
  performances: CatalogPerformance[];
  detailEnrichedAt?: string;
  provenance?: "official-listing-summary" | "official-detail-enrichment" | "unknown";
}

export interface CatalogCompleteness {
  source: CatalogSource;
  fetchedAt: string;
  eventCount: number;
  pageCount: number;
  detailCount: number;
  stopReason: "normal-exhaustion" | "cap" | "partial" | "backoff" | "error";
  health: "ok" | "stale" | "error" | "not-run";
  scanState?: "complete" | "truncated" | "stale";
  summaryCount?: number;
  knownPriceCount?: number;
  knownCategoryCount?: number;
  error?: string;
}

export interface CatalogState {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  generatedAt: string;
  events: CatalogEvent[];
  completeness: CatalogCompleteness;
}

export function classifyEvent(title: string, sourceCategory: string | undefined): Pick<CatalogEvent, "category" | "classificationReason" | "classificationConfidence"> {
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

export function sourceUrl(source: CatalogSource, id: string): string {
  return source === "opentix" ? `https://www.opentix.life/event/${id}` : `https://tickets.udnfunlife.com/Application/UTK02/UTK0201_.aspx?PRODUCT_ID=${id}`;
}

function eventLinks(html: string, source: CatalogSource): string[] {
  const re = source === "opentix"
    ? /(?:https?:\/\/www\.opentix\.life)?\/event\/(\d+)/gi
    : /(?:https?:\/\/tickets\.udnfunlife\.com)?\/Application\/UTK02\/UTK0201_\.aspx\?[^"' <]*/gi;
  return [...html.matchAll(re)].map((match) => source === "opentix" ? sourceUrl(source, match[1]!) : new URL(match[0]!, "https://tickets.udnfunlife.com").toString());
}

function htmlTitle(html: string): string {
  return (/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)/i.exec(html)?.[1]
    ?? /<title[^>]*>([^<]+)/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
}
function htmlArtist(html: string): string | undefined {
  return /<meta[^>]+(?:property|name)=["'](?:music:musician|event:performer|artist)["'][^>]+content=["']([^"']+)/i.exec(html)?.[1]?.trim() || undefined;
}

function deduplicateLinks(links: string[], source: CatalogSource): string[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${source}:${eventIdFromUrl(link)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function eventIdFromUrl(url: string): string {
  return /\/event\/(\d+)/.exec(url)?.[1] ?? new URL(url).searchParams.get("PRODUCT_ID") ?? url;
}

function plainText(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function isoDate(value: string): string | undefined {
  const match = value.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!match) return undefined;
  const [, year, month = "01", day = "01", hour = "00", minute = "00"] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:00+08:00`;
}

function priceRange(value: string): { minPrice: number | null; maxPrice: number | null } {
  const prices = [...value.replace(/,/g, "").matchAll(/(?:NT\$|TWD|票價|價格|票)\s*(\d{2,6})/gi)].map((match) => Number(match[1]));
  return prices.length ? { minPrice: Math.min(...prices), maxPrice: Math.max(...prices) } : { minPrice: null, maxPrice: null };
}
function cityFromAddress(value: string | undefined): string | undefined {
  return value?.match(/台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣/)?.[0];
}

function parseUdnDate(value: string): string | undefined {
  return isoDate(value.replace(/年/g, "/").replace(/月/g, "/").replace(/日/g, "").replace(/\([^)]*\)/g, " "));
}

/** Extracts only source-visible schedule facts; absent facts remain null/undefined. */
export function parseUdnCatalogDetailHtml(html: string, eventUrl: string, _now = new Date()): { title: string; performances: CatalogPerformance[] } {
  const eventId = eventIdFromUrl(eventUrl);
  const title = htmlTitle(html).replace(/\s*[|｜]\s*udn.*$/i, "").trim();
  const structured = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .flatMap((match) => {
      try {
        const value = JSON.parse(match[1] ?? "") as Record<string, unknown>;
        return value["@type"] === "TheaterEvent" || value["@type"] === "Event" ? [value] : [];
      } catch {
        return [];
      }
    });
  const structuredPerformances = structured.flatMap((item, index) => {
    const location = item.location && typeof item.location === "object" ? item.location as Record<string, unknown> : {};
    const address = typeof location.address === "string" ? location.address : undefined;
    const city = address ? cityFromAddress(address) : undefined;
    const startsAt = typeof item.startDate === "string" ? parseUdnDate(item.startDate) : undefined;
    const offers = Array.isArray(item.offers) ? item.offers : item.offers ? [item.offers] : [];
    const prices = offers
      .map((offer) => offer && typeof offer === "object" ? Number((offer as Record<string, unknown>).price) : NaN)
      .filter((price) => Number.isFinite(price) && price >= 0);
    return [{
      schemaVersion: CATALOG_SCHEMA_VERSION, source: "udn" as const, eventId,
      performanceId: `${eventId}-performance-${index + 1}`, sourceUrl: eventUrl,
      ...(startsAt ? { startsAt } : {}), cancelled: typeof item.eventStatus === "string" && /cancel/i.test(item.eventStatus),
      ...(typeof location.name === "string" ? { venue: location.name } : {}),
      ...(city ? { city } : {}),
      minPrice: prices.length ? Math.min(...prices) : null, maxPrice: prices.length ? Math.max(...prices) : null, currency: "TWD" as const
    }];
  });
  if (structuredPerformances.length > 0) {
    return { title: title || (typeof structured[0]?.name === "string" ? structured[0].name : ""), performances: structuredPerformances };
  }
  const links = [...html.matchAll(/(?:https?:\/\/tickets\.udnfunlife\.com)?\/Application\/UTK02\/UTK0204_(?:000)?\.aspx\?[^"' <]+/gi)]
    .map((match) => new URL(match[0]!.replace(/&amp;/g, "&"), "https://tickets.udnfunlife.com").toString());
  const uniqueLinks = [...new Map(links.map((url) => [new URL(url).searchParams.get("PERFORMANCE_ID") ?? url, url])).values()];
  const blocks = [...html.matchAll(/<(?:tr|li|div)\b[^>]*>([\s\S]*?)<\/(?:tr|li|div)>/gi)].map((match) => plainText(match[1] ?? ""));
  const sourceBlocks = blocks.filter((block) => isoDate(block) || /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(block));
  const performanceCount = Math.max(uniqueLinks.length, sourceBlocks.length);
  const performances = Array.from({ length: performanceCount }, (_, index) => {
    const block = sourceBlocks[index] ?? "";
    const startsAt = isoDate(block);
    const id = new URL(uniqueLinks[index] ?? eventUrl).searchParams.get("PERFORMANCE_ID") ?? `${eventId}-performance-${index + 1}`;
    const prices = priceRange(block);
    const venueMatch = block.match(/(?:場館|場地|地點|venue)\s*[:：]\s*([^|｜,，;；]+)/i);
    const cityMatch = block.match(/(?:城市|縣市|city)\s*[:：]\s*([^|｜,，;；]+)/i);
    const saleStart = isoDate((block.match(/(?:開賣|售票|sale)\s*[:：]?\s*([^\s|｜]+)/i)?.[1] ?? ""));
    return {
      schemaVersion: CATALOG_SCHEMA_VERSION, source: "udn" as const, eventId, performanceId: id,
      sourceUrl: uniqueLinks[index] ?? eventUrl, ...(startsAt ? { startsAt } : {}), cancelled: /取消|cancel/i.test(block),
      ...(venueMatch?.[1] ? { venue: venueMatch[1].trim() } : {}),
      ...(cityMatch?.[1] ? { city: cityMatch[1].replace(/\s+NT\$.*$/i, "").trim() } : {}),
      ...(saleStart ? { saleStart } : {}), ...prices, currency: "TWD" as const
    };
  });
  return { title, performances };
}

export function catalogStateMateriallyEqual(a: CatalogState | null, b: CatalogState): boolean {
  if (!a) return false;
  const comparable = (state: CatalogState) => ({
    ...state,
    generatedAt: "",
    completeness: { ...state.completeness, fetchedAt: "" },
    events: state.events.map((event) => ({ ...event, catalogFetchedAt: "" }))
  });
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

export function mergeCatalogState(previous: CatalogState | null, current: CatalogState): CatalogState {
  if (!previous || current.completeness.scanState === "stale" || current.completeness.health !== "ok") return previous ?? current;
  const byId = new Map(previous.events.map((event) => [`${event.source}:${event.eventId}`, event]));
  for (const observed of current.events) {
    const key = `${observed.source}:${observed.eventId}`;
    const prior = byId.get(key);
    const detailEnrichedAt = observed.detailEnrichedAt ?? prior?.detailEnrichedAt;
    byId.set(key, {
      ...(prior ?? observed),
      ...observed,
      firstSeenAt: prior?.firstSeenAt ?? observed.firstSeenAt,
      performances: observed.performances.length ? observed.performances : (prior?.performances ?? []),
      ...(detailEnrichedAt ? { detailEnrichedAt } : {}),
      provenance: observed.provenance ?? prior?.provenance ?? "official-listing-summary"
    });
  }
  return { ...current, events: [...byId.values()], completeness: { ...current.completeness, eventCount: byId.size } };
}

function structuredSummaryLinks(value: unknown, source: CatalogSource): string[] {
  const items = Array.isArray(value) ? value : value && typeof value === "object"
    ? Object.values(value as Record<string, unknown>).find(Array.isArray) ?? [] : [];
  return (items as unknown[]).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? row.eventId ?? row.productId ?? row.PRODUCT_ID ?? "").trim();
    const url = typeof row.url === "string" ? row.url : typeof row.sourceUrl === "string" ? row.sourceUrl : "";
    if (id) return [sourceUrl(source, id)];
    if (url && /^https?:\/\//.test(url)) return [url];
    return [];
  });
}

function jsonValue(textValue: string): unknown {
  try { return JSON.parse(textValue) as unknown; } catch { return null; }
}

export async function discoverCatalog(source: CatalogSource, options: {
  now?: Date;
  fetchImpl?: typeof fetch;
  indexUrls?: string[];
} = {}): Promise<CatalogState> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const indexUrls = options.indexUrls ?? (source === "opentix"
    ? ["https://www.opentix.life/api/events?sort=upcoming&page=1&pageSize=20"]
    : ["https://tickets.udnfunlife.com/api/events?sort=upcoming&page=1&pageSize=20"]);
  const links = new Set<string>();
  let pageCount = 0;
  try {
    for (const index of indexUrls.slice(0, CATALOG_PAGE_CAP)) {
      const response = await fetchImpl(index, { headers: { accept: "text/html,application/xhtml+xml" }, redirect: "follow" });
      pageCount++;
      if (!response.ok) throw new Error(`http-${response.status}`);
      const body = await response.text();
      if (body.length > CATALOG_MAX_RESPONSE_BYTES) throw new Error("response-size");
      const structured = structuredSummaryLinks(jsonValue(body), source);
      for (const link of (structured.length ? structured : eventLinks(body, source))) links.add(link);
      if (links.size >= CATALOG_EVENT_CAP) break;
    }
    const urls = deduplicateLinks([...links], source).slice(0, CATALOG_EVENT_CAP);
    const events: CatalogEvent[] = urls.map((url) => ({
      schemaVersion: CATALOG_SCHEMA_VERSION, source, eventId: eventIdFromUrl(url), sourceUrl: url,
      title: "Summary-only event", category: "unknown", classificationReason: "unknown", classificationConfidence: "low",
      firstSeenAt: now.toISOString(), catalogFetchedAt: now.toISOString(), performances: [],
      provenance: "official-listing-summary"
    }));
    let detailCount = 0;
    for (const url of urls.slice(0, CATALOG_DETAIL_CAP)) {
      const response = await fetchImpl(url, { headers: { accept: "text/html,application/xhtml+xml" }, redirect: "follow" });
      detailCount++;
      if (!response.ok) continue;
      const html = await response.text();
      if (source === "opentix") {
        let parsed;
        try { parsed = parseOpentixHtml(html, now.toISOString(), now); } catch {
          const title = htmlTitle(html).replace(/\s*[—-]\s*OPENTIX.*$/i, "").trim();
          if (!title) continue;
          const classification = classifyEvent(title, undefined);
          const event = events.find((item) => item.eventId === eventIdFromUrl(url))!;
          Object.assign(event, { title, ...classification, detailEnrichedAt: now.toISOString(), provenance: "official-detail-enrichment" });
          continue;
        }
        const classification = classifyEvent(parsed.title, undefined);
        const artist = htmlArtist(html);
        const city = cityFromAddress(parsed.venue.address);
        const event = events.find((item) => item.eventId === eventIdFromUrl(url))!;
        Object.assign(event, {
          schemaVersion: CATALOG_SCHEMA_VERSION, source, eventId: eventIdFromUrl(url), sourceUrl: url,
          title: parsed.title, ...(artist ? { artist } : {}), venue: parsed.venue.name, ...(city ? { city } : {}),
          ...classification, firstSeenAt: now.toISOString(), catalogFetchedAt: now.toISOString(),
          performances: parsed.performances.map((item) => ({
            schemaVersion: CATALOG_SCHEMA_VERSION, source, eventId: eventIdFromUrl(url), performanceId: item.performanceId,
            sourceUrl: url, startsAt: item.startsAt, ...(item.endsAt ? { endsAt: item.endsAt } : {}),
            cancelled: false, ...(item.saleOpenAt ? { saleStart: item.saleOpenAt } : {}), ...(item.saleCloseAt ? { saleEnd: item.saleCloseAt } : {}),
            minPrice: item.price.min, maxPrice: item.price.max, currency: "TWD"
          })), detailEnrichedAt: now.toISOString(), provenance: "official-detail-enrichment"
        });
      } else {
        const title = htmlTitle(html);
        if (!title) continue;
        const classification = classifyEvent(title, undefined);
        const artist = htmlArtist(html);
        const remainingDetailCap = Math.max(0, CATALOG_DETAIL_CAP - detailCount);
        const scheduleLinks = [...new Set([...html.matchAll(/(?:https?:\/\/tickets\.udnfunlife\.com)?\/Application\/UTK02\/UTK0204_(?:000)?\.aspx\?[^"' <]+/gi)].map((match) => new URL(match[0]!.replace(/&amp;/g, "&"), "https://tickets.udnfunlife.com").toString()))].slice(0, remainingDetailCap);
        const schedulePages: Array<{ url: string; html: string }> = [];
        for (const scheduleUrl of scheduleLinks) {
          const scheduleResponse = await fetchImpl(scheduleUrl, { headers: { accept: "text/html,application/xhtml+xml" }, redirect: "follow" });
          detailCount++;
          if (scheduleResponse.ok) schedulePages.push({ url: scheduleUrl, html: await scheduleResponse.text() });
        }
        const parsedPages = schedulePages.map((page) => parseUdnCatalogDetailHtml(page.html, page.url, now));
        const parsed = schedulePages.length ? { title, performances: parsedPages.flatMap((page) => page.performances) } : parseUdnCatalogDetailHtml(html, url, now);
        const event = events.find((item) => item.eventId === eventIdFromUrl(url))!;
        Object.assign(event, { title: parsed.title || title, ...(artist ? { artist } : {}), ...classification, performances: parsed.performances, detailEnrichedAt: now.toISOString(), provenance: "official-detail-enrichment" });
      }
    }
    const truncated = links.size > CATALOG_EVENT_CAP || pageCount >= CATALOG_PAGE_CAP;
    const knownPriceCount = events.reduce((sum, event) => sum + event.performances.filter((item) => item.minPrice != null).length, 0);
    const knownCategoryCount = events.filter((event) => event.classificationReason === "source-category").length;
    return { schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt: now.toISOString(), events, completeness: { source, fetchedAt: now.toISOString(), eventCount: events.length, pageCount, detailCount, stopReason: truncated ? "cap" : "normal-exhaustion", scanState: truncated ? "truncated" : "complete", summaryCount: events.length, knownPriceCount, knownCategoryCount, health: "ok" } };
  } catch (error) {
    return { schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt: now.toISOString(), events: [], completeness: { source, fetchedAt: now.toISOString(), eventCount: 0, pageCount, detailCount: 0, stopReason: "error", scanState: "stale", health: "stale", error: error instanceof Error ? error.message : "unknown" } };
  }
}
