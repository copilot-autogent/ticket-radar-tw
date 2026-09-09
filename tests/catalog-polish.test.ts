import { describe, expect, it } from "vitest";
import { cheapestUdnExactPositive, discoverCatalog, mergeCatalogState, selectUdnTiers } from "../src/catalog.js";
import type { CatalogState } from "../src/catalog.js";

describe("catalog polish boundaries", () => {
  it("discovers five 20-summary pages but enriches no more than twenty details", async () => {
    let detailRequests = 0;
    const result = await discoverCatalog("opentix", {
      now: new Date("2026-09-09T00:00:00Z"),
      indexUrls: Array.from({ length: 5 }, (_, page) => `https://index.test/?page=${page + 1}`),
      fetchImpl: async (url) => {
        if (url.startsWith("https://index.test")) {
          const page = Number(new URL(url).searchParams.get("page"));
          return new Response(Array.from({ length: 20 }, (_, offset) => `<a href="/event/${page * 100 + offset}">event</a>`).join(""));
        }
        detailRequests++;
        return new Response(`<script type="application/ld+json">{"@type":"Event","name":"Event","startDate":"2027-01-01T19:00:00+08:00","location":{"name":"Venue"},"offers":{"lowPrice":100,"highPrice":500}}</script>`);
      }
    });
    expect(result.events).toHaveLength(100);
    expect(result.summaries).toHaveLength(100);
    expect(result.completeness).toMatchObject({ pageCount: 5, detailCount: 20, status: "truncated" });
    expect(detailRequests).toBe(20);
    expect(result.coverage.detailEnriched).toBe(20);
  });

  it("merges stale discovery without deleting a durable catalog", async () => {
    const good = await discoverCatalog("opentix", { indexUrls: ["https://index.test/"], fetchImpl: async (url) => new Response(url === "https://index.test/" ? '<a href="/event/1">one</a>' : "<title>Event 1</title>") });
    const stale: CatalogState = { schemaVersion: 1, generatedAt: "2026-09-10T00:00:00Z", summaries: [], events: [], completeness: { source: "opentix", fetchedAt: "2026-09-10T00:00:00Z", eventCount: 0, pageCount: 1, detailCount: 0, stopReason: "error", status: "stale", health: "error", error: "network" }, coverage: { summariesDiscovered: 0, detailEnriched: 0, performancesDiscovered: 0, pricesKnown: 0, categoriesKnown: 0 } };
    const merged = mergeCatalogState(good, stale);
    expect(merged.events).toHaveLength(1);
    expect(merged.completeness.status).toBe("stale");
  });

  it("migrates legacy capped metadata into truthful summary coverage", async () => {
    const legacy = {
      schemaVersion: 1,
      generatedAt: "2026-09-09T12:25:42.464Z",
      events: [{ schemaVersion: 1, source: "opentix", eventId: "legacy-1", sourceUrl: "https://www.opentix.life/event/legacy-1", title: "Legacy event", category: "unknown", classificationReason: "unknown", classificationConfidence: "low", firstSeenAt: "2026-09-09T12:25:42.464Z", catalogFetchedAt: "2026-09-09T12:25:42.464Z", performances: [] }],
      completeness: { source: "opentix", fetchedAt: "2026-09-09T12:25:42.464Z", eventCount: 20, pageCount: 1, detailCount: 20, stopReason: "cap", health: "ok" }
    } as unknown as CatalogState;
    const current = await discoverCatalog("opentix", { indexUrls: ["https://index.test/"], fetchImpl: async () => new Response("") });
    const migrated = mergeCatalogState(legacy, current);
    expect(migrated.completeness.status).toBe("complete");
    expect(migrated.completeness.eventCount).toBe(migrated.coverage.summariesDiscovered);
    expect(migrated.events.every((event) => event.detailStatus)).toBe(true);
  });

  it("defaults UDN to exact-positive and hot-selling tiers and finds the cheapest unrestricted exact tier", () => {
    const tiers = [
      { availability: "exact", exactCount: 0, priceTwd: 1000 },
      { availability: "hot-selling-unknown", exactCount: null, priceTwd: 1200 },
      { availability: "exact", exactCount: 3, priceTwd: 1400 },
      { availability: "sold-out", exactCount: null, priceTwd: 800 }
    ];
    expect(selectUdnTiers(tiers)).toHaveLength(2);
    expect(selectUdnTiers(tiers, true)).toHaveLength(4);
    expect(cheapestUdnExactPositive(tiers)?.priceTwd).toBe(1400);
  });
});
