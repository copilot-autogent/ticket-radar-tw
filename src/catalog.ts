import { parseOpentixHtml } from "./opentix.js";

export const CATALOG_SCHEMA_VERSION = 1 as const;
export const CATALOG_EVENT_CAP = 100;
export const CATALOG_PAGE_CAP = 5;
export const CATALOG_DETAIL_CAP = 20;
export const CATALOG_SITEMAP_CAP = 500;

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
}

export interface CatalogCompleteness {
  source: CatalogSource;
  fetchedAt: string;
  eventCount: number;
  pageCount: number;
  detailCount: number;
  stopReason: "normal-exhaustion" | "cap" | "partial" | "backoff" | "error";
  health: "ok" | "stale" | "error" | "not-run";
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

function sourceUrl(source: CatalogSource, id: string): string {
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

/** Extracts only source-visible schedule facts; absent facts remain null/undefined. */
export function parseUdnCatalogDetailHtml(html: string, eventUrl: string, _now = new Date()): { title: string; performances: CatalogPerformance[] } {
  const eventId = eventIdFromUrl(eventUrl);
  const title = htmlTitle(html).replace(/\s*[|｜]\s*udn.*$/i, "").trim();
  const links = [...html.matchAll(/(?:https?:\/\/tickets\.udnfunlife\.com)?\/Application\/UTK02\/UTK0204_(?:000)?\.aspx\?[^"' <]+/gi)]
    .map((match) => new URL(match[0]!.replace(/&amp;/g, "&"), "https://tickets.udnfunlife.com").toString());
  const uniqueLinks = [...new Map(links.map((url) => [new URL(url).searchParams.get("PERFORMANCE_ID") ?? url, url])).values()];
  const blocks = [...html.matchAll(/<(?:tr|li|div)\b[^>]*>([\s\S]*?)<\/(?:tr|li|div)>/gi)].map((match) => plainText(match[1] ?? ""));
  const sourceBlocks = blocks.filter((block) => isoDate(block) || /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(block));
  const performanceCount = Math.max(uniqueLinks.length, sourceBlocks.length);
  const performances = Array.from({ length: performanceCount }, (_, index) => {
    const block = sourceBlocks[index] ?? plainText(html);
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

export async function discoverCatalog(source: CatalogSource, options: {
  now?: Date;
  fetchImpl?: typeof fetch;
  indexUrls?: string[];
} = {}): Promise<CatalogState> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const indexUrls = options.indexUrls ?? (source === "opentix" ? ["https://www.opentix.life/"] : ["https://tickets.udnfunlife.com/"]);
  const links = new Set<string>();
  let pageCount = 0;
  try {
    for (const index of indexUrls.slice(0, CATALOG_PAGE_CAP)) {
      const response = await fetchImpl(index, { headers: { accept: "text/html,application/xhtml+xml" }, redirect: "follow" });
      pageCount++;
      if (!response.ok) throw new Error(`http-${response.status}`);
      for (const link of eventLinks(await response.text(), source)) links.add(link);
      if (links.size >= CATALOG_EVENT_CAP) break;
    }
    const events: CatalogEvent[] = [];
    let detailCount = 0;
    for (const url of deduplicateLinks([...links], source).slice(0, CATALOG_DETAIL_CAP)) {
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
          events.push({ schemaVersion: CATALOG_SCHEMA_VERSION, source, eventId: eventIdFromUrl(url), sourceUrl: url, title, ...classification, firstSeenAt: now.toISOString(), catalogFetchedAt: now.toISOString(), performances: [] });
          continue;
        }
        const classification = classifyEvent(parsed.title, undefined);
        events.push({
          schemaVersion: CATALOG_SCHEMA_VERSION, source, eventId: eventIdFromUrl(url), sourceUrl: url,
          title: parsed.title, venue: parsed.venue.name, ...(parsed.venue.address?.split(/[ ,，]/)[0] ? { city: parsed.venue.address.split(/[ ,，]/)[0] } : {}),
          ...classification, firstSeenAt: now.toISOString(), catalogFetchedAt: now.toISOString(),
          performances: parsed.performances.map((item) => ({
            schemaVersion: CATALOG_SCHEMA_VERSION, source, eventId: eventIdFromUrl(url), performanceId: item.performanceId,
            sourceUrl: url, startsAt: item.startsAt, ...(item.endsAt ? { endsAt: item.endsAt } : {}),
            cancelled: false, ...(item.saleOpenAt ? { saleStart: item.saleOpenAt } : {}), ...(item.saleCloseAt ? { saleEnd: item.saleCloseAt } : {}),
            minPrice: item.price.min, maxPrice: item.price.max, currency: "TWD"
          }))
        });
      } else {
        const title = htmlTitle(html);
        if (!title) continue;
        const classification = classifyEvent(title, undefined);
        const scheduleLinks = [...new Set([...html.matchAll(/(?:https?:\/\/tickets\.udnfunlife\.com)?\/Application\/UTK02\/UTK0204_(?:000)?\.aspx\?[^"' <]+/gi)].map((match) => new URL(match[0]!.replace(/&amp;/g, "&"), "https://tickets.udnfunlife.com").toString()))].slice(0, CATALOG_DETAIL_CAP - detailCount);
        const schedulePages: string[] = [];
        for (const scheduleUrl of scheduleLinks) {
          const scheduleResponse = await fetchImpl(scheduleUrl, { headers: { accept: "text/html,application/xhtml+xml" }, redirect: "follow" });
          detailCount++;
          if (scheduleResponse.ok) schedulePages.push(await scheduleResponse.text());
        }
        const parsed = parseUdnCatalogDetailHtml(schedulePages.join("\n") || html, url, now);
        events.push({ schemaVersion: CATALOG_SCHEMA_VERSION, source, eventId: eventIdFromUrl(url), sourceUrl: url, title: parsed.title || title, ...classification, firstSeenAt: now.toISOString(), catalogFetchedAt: now.toISOString(), performances: parsed.performances });
      }
    }
    return { schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt: now.toISOString(), events, completeness: { source, fetchedAt: now.toISOString(), eventCount: events.length, pageCount, detailCount, stopReason: links.size > CATALOG_DETAIL_CAP || events.length >= CATALOG_EVENT_CAP ? "cap" : "normal-exhaustion", health: "ok" } };
  } catch (error) {
    return { schemaVersion: CATALOG_SCHEMA_VERSION, generatedAt: now.toISOString(), events: [], completeness: { source, fetchedAt: now.toISOString(), eventCount: 0, pageCount, detailCount: 0, stopReason: "error", health: "error", error: error instanceof Error ? error.message : "unknown" } };
  }
}
