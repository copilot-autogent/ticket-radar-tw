import { describe, expect, it } from "vitest";
import { catalogStateMateriallyEqual, classifyEvent, discoverCatalog, parseUdnCatalogDetailHtml } from "../src/catalog.js";

describe("catalog discovery", () => {
  it("uses source categories before bounded title fallback", () => {
    expect(classifyEvent("Live show", "演唱會")).toMatchObject({ category: "concert", classificationReason: "source-category", classificationConfidence: "high" });
    expect(classifyEvent("我的音樂劇", undefined)).toMatchObject({ category: "musical", classificationReason: "title-keyword-fallback" });
  });

  it("discovers bounded OPENTIX events without hard-coded event URLs", async () => {
    const detail = (id: string) => `<script type="application/ld+json">{"@type":"Event","name":"Event ${id}","startDate":"2027-01-01T19:00:00+08:00","location":{"name":"Venue"},"offers":{"lowPrice":100,"highPrice":500}}</script>`;
    const result = await discoverCatalog("opentix", {
      now: new Date("2026-09-09T00:00:00Z"),
      indexUrls: ["https://index.test/"],
      fetchImpl: async (url) => new Response(url === "https://index.test/" ? '<a href="/event/1">a</a><a href="/event/2">b</a>' : detail(new URL(url).pathname.split("/").pop()!))
    });
    expect(result.events).toHaveLength(2);
    expect(result.completeness.stopReason).toBe("normal-exhaustion");
    expect(result.events[0]?.sourceUrl).toBe("https://www.opentix.life/event/1");
  });

  it("retains material catalog identity despite timestamp-only changes", () => {
    const state = { schemaVersion: 1 as const, generatedAt: "a", events: [], completeness: { source: "udn" as const, fetchedAt: "a", eventCount: 0, pageCount: 1, detailCount: 0, stopReason: "normal-exhaustion" as const, health: "ok" as const } };
    expect(catalogStateMateriallyEqual(state, { ...state, generatedAt: "b", completeness: { ...state.completeness, fetchedAt: "b" } })).toBe(true);
  });

  it("extracts multiple UDN schedule identities and leaves missing facts unknown", () => {
    const html = `<meta property="og:title" content="UDN musical | udn售票網"><a href="/Application/UTK02/UTK0204_.aspx?PRODUCT_ID=P1AEBJG5&PERFORMANCE_ID=P1">one</a><a href="/Application/UTK02/UTK0204_.aspx?PRODUCT_ID=P1AEBJG5&PERFORMANCE_ID=P2">two</a><div>日期：2026/10/01 19:30 場館：台北場館 城市：台北市 NT$1,200</div><div>日期：2026/10/02 14:00 場館：台北場館 城市：台北市 NT$1,500</div>`;
    const parsed = parseUdnCatalogDetailHtml(html, "https://tickets.udnfunlife.com/Application/UTK02/UTK0201_.aspx?PRODUCT_ID=P1AEBJG5");
    expect(parsed.performances).toHaveLength(2);
    expect(parsed.performances.map((item) => item.performanceId)).toEqual(["P1", "P2"]);
    expect(parsed.performances[0]).toMatchObject({ startsAt: "2026-10-01T19:30:00+08:00", minPrice: 1200, maxPrice: 1200, city: "台北市" });
    const incomplete = parseUdnCatalogDetailHtml(`<meta property="og:title" content="Incomplete"><a href="/Application/UTK02/UTK0204_.aspx?PRODUCT_ID=P1AEBJG5&PERFORMANCE_ID=P3">schedule</a>`, "https://tickets.udnfunlife.com/Application/UTK02/UTK0201_.aspx?PRODUCT_ID=P1AEBJG5");
    expect(incomplete.performances[0]).not.toHaveProperty("startsAt");
    expect(incomplete.performances[0]).toHaveProperty("performanceId", "P3");
  });
});
