import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { parseUdnPerformanceHtml } from "../src/udn.js";
import { applyUdnPoll, emptyUdnState, migrateRuntimeState, validateUdnObservation } from "../src/runtime.js";
import { emptyState } from "../src/runtime.js";
import fixture from "../fixtures/opentix-event.json";

const url = "https://tickets.udnfunlife.com/Application/UTK02/UTK0204_.aspx?PERFORMANCE_ID=P1AFIPX7&PRODUCT_ID=P1AEBJG5";

describe("UDN public performance adapter", () => {
  it("keeps exact, hot-selling unknown, and sold-out distinct", async () => {
    const html = await readFile(new URL("../fixtures/udn-performance.html", import.meta.url), "utf8");
    const observation = parseUdnPerformanceHtml(html, url, "2026-09-09T02:00:00Z");
    expect(observation.tiers.map((tier) => [tier.availability, tier.exactCount])).toEqual([["exact", 41], ["hot-selling-unknown", null], ["sold-out", null]]);
    validateUdnObservation(observation);
  });
  it("is stable across whitespace and fails conflicting duplicates", () => {
    const base = '<meta property="og:title" content="Event"><table><tr><td> A  區 </td><td>NT$1,000</td><td>0</td></tr></table>';
    const a = parseUdnPerformanceHtml(base, url);
    const b = parseUdnPerformanceHtml(base.replace(" A  區 ", "A 區"), url);
    expect(a.tiers[0]?.tierId).toBe(b.tiers[0]?.tierId);
    expect(() => parseUdnPerformanceHtml('<meta property="og:title" content="Event"><table><tr><td>A</td><td>NT$1,000</td><td>0</td></tr><tr><td>A</td><td>NT$1,000</td><td>售完</td></tr></table>', url)).toThrow("conflicting-duplicate");
  });
  it("keeps the previous observation on a failed atomic poll and migrates OPENTIX intact", () => {
    const observation = { provider: "udn" as const, eventId: "P1AEBJG5" as const, performanceId: "P1AFIPX7", title: "Event", sourceUrl: url, observedAt: "2026-09-09T02:00:00Z", parserVersion: "test", tiers: [{ provider: "udn" as const, eventId: "P1AEBJG5" as const, performanceId: "P1AFIPX7", tierId: "a|1000", label: "A", priceTwd: 1000, sourceUrl: url, availability: "exact" as const, exactCount: 0 }] };
    const state = applyUdnPoll(emptyUdnState(), { kind: "success", observation }, new Date("2026-09-09T02:00:00Z"));
    const failed = applyUdnPoll(state, { kind: "failure", errorCategory: "parse-failure" }, new Date("2026-09-09T02:30:00Z"));
    expect(failed.snapshot).toEqual(state.snapshot);
    const migrated = migrateRuntimeState(applyState());
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.sources.opentix.snapshot?.eventId).toBe(fixture.eventId);
  });
});

function applyState() {
  const state = emptyState();
  state.snapshot = fixture;
  return state;
}
