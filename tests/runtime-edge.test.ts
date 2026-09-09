import { describe, expect, it } from "vitest";
import { fetchOpentix, parseOpentixHtml } from "../src/opentix.js";
import { applyPoll, emptyState, loadState, validateState, eligibleToPoll, reconcileNotifications } from "../src/runtime.js";
import fixture from "../fixtures/opentix-event.json";

const jsonld = (name: string, start: string, end = "2026-10-10T21:10:00") => JSON.stringify({ "@type": "Event", name, startDate: start, endDate: end, location: { name: "Venue & Hall", address: { streetAddress: "Taipei" } }, offers: { lowPrice: 100, highPrice: 200, validFrom: "2026-01-01T00:00:00", availabilityEnds: end } });
const html = `<title>Good event</title><meta property="og:title" content="Fallback"><script type="application/ld+json">${jsonld("A &amp; B", "2026-10-10T19:30:00")}</script><script type="application/ld+json">${jsonld("A &amp; B", "2026-10-11T19:30:00")}</script><div>2026/10/10 19:30 剩：5</div><div>2026/10/11 19:30 剩：0</div>`;

describe("OPENTIX transport and failure edges", () => {
  it("parses bounded JSON-LD and visible remaining values", () => {
    const value = parseOpentixHtml(html, "2026-09-09T01:00:00Z", new Date("2026-09-09T01:00:00Z"));
    expect(value.title).toBe("A & B"); expect(value.performances).toHaveLength(2); expect(value.performances[0]?.remaining).toBe(5); expect(value.performances[1]?.remaining).toBe(0);
  });
  it.each([304, 429, 500, 404])("handles HTTP %s without parsing", async (status) => {
    const result = await fetchOpentix("https://example.test", { fetchImpl: async () => ({ status, ok: status >= 200 && status < 300, headers: new Headers({ "retry-after": "2" }), text: async () => "ignored" }) as unknown as Response });
    expect(result.status).toBe(status); expect(result.kind).toBe(status === 304 ? "not-modified" : status === 404 ? "failure" : "retryable");
  });
  it("handles success, parse drift, and timeout", async () => {
    const success = await fetchOpentix("https://example.test", { fetchImpl: async () => new Response(html, { status: 200 }), now: new Date("2026-09-09T01:00:00Z") });
    expect(success.kind).toBe("success");
    const drift = await fetchOpentix("https://example.test", { fetchImpl: async () => new Response("<html>partial</html>", { status: 200 }) });
    expect(drift.kind).toBe("retryable");
    const timeout = await fetchOpentix("https://example.test", { fetchImpl: async () => { const error = new Error("abort"); error.name = "AbortError"; throw error; } });
    expect(timeout.errorCategory).toBe("timeout");
  });
  it("fails closed and labels ended lifecycle without sale dates", async () => {
    const source = JSON.stringify({ "@type": "Event", name: "Ended", startDate: "2020-10-10T19:30:00", endDate: "2020-10-10T21:10:00", location: { name: "Venue" }, offers: { lowPrice: 100, highPrice: 200, availabilityEnds: "2020-10-10T21:10:00" } });
    const ended = `<script type="application/ld+json">not-json</script><script type="application/ld+json">${source}</script><span>remainingQuantity:7</span>`;
    const value = parseOpentixHtml(ended, "2026-09-09T01:00:00Z", new Date("2026-09-09T01:00:00Z"));
    expect(value.performances[0]?.lifecycle).toBe("ended"); expect(value.performances[0]?.remaining).toBe(7);
    expect(eligibleToPoll(emptyState())).toBe(true); expect(await reconcileNotifications(emptyState())).toEqual(emptyState());
  });
  it("retains validated data on 304 and failure", () => {
    const state = applyPoll(emptyState(), { kind: "success", status: 200, observation: fixture }, new Date("2026-09-09T01:00:00Z"));
    expect(applyPoll(state, { kind: "not-modified", status: 304 }, new Date("2026-09-09T01:30:00Z")).snapshot).not.toBeNull();
    const failed = applyPoll(state, { kind: "retryable", status: 503, errorCategory: "upstream-5xx" }, new Date("2026-09-09T01:31:00Z"));
    expect(failed.health.category).toBe("stale"); expect(failed.snapshot).toEqual(state.snapshot);
  });
  it("rejects invalid state and loads a safe empty state", async () => {
    expect(() => validateState({})).toThrow("validation");
    const state = await loadState("generated/does-not-exist.json"); expect(state.snapshot).toBeNull();
  });
});
