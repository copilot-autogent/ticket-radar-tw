import { describe, expect, it } from "vitest";
import { catalogStateMateriallyEqual, classifyEvent, discoverCatalog } from "../src/catalog.js";

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
});
