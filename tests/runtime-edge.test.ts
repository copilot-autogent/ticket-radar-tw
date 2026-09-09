import { describe, expect, it } from "vitest";
import { unlink, writeFile } from "node:fs/promises";
import { fetchOpentix, parseOpentixHtml } from "../src/opentix.js";
import { applyPoll, emptyState, loadState, validateState, eligibleToPoll, reconcileNotifications, MAX_OUTBOX, validateThreshold } from "../src/runtime.js";
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
    expect(drift.kind).toBe("failure"); expect(drift.errorCategory).toBe("parse-failure");
    const timeout = await fetchOpentix("https://example.test", { fetchImpl: async () => { const error = new Error("abort"); error.name = "AbortError"; throw error; } });
    expect(timeout.errorCategory).toBe("timeout");
  });
  it("fails closed and labels ended lifecycle without sale dates", async () => {
    const source = JSON.stringify({ "@type": "Event", name: "Ended", startDate: "2020-10-10T19:30:00", endDate: "2020-10-10T21:10:00", location: { name: "Venue" }, offers: { lowPrice: 100, highPrice: 200, availabilityEnds: "2020-10-10T21:10:00" } });
    const ended = `<script type="application/ld+json">${source}</script><span>remainingQuantity:7</span>`;
    const value = parseOpentixHtml(ended, "2026-09-09T01:00:00Z", new Date("2026-09-09T01:00:00Z"));
    expect(value.performances[0]?.lifecycle).toBe("ended"); expect(value.performances[0]?.remaining).toBe(7);
    expect(() => parseOpentixHtml(`<script type="application/ld+json">not-json</script>`)).toThrow("malformed-jsonld");
    expect(eligibleToPoll(emptyState())).toBe(true); expect(await reconcileNotifications(emptyState())).toEqual(emptyState());
  });
  it("retains validated data on 304 and failure", () => {
    const state = applyPoll(emptyState(), { kind: "success", status: 200, observation: fixture, validators: { etag: "old", lastModified: "yesterday" } }, new Date("2026-09-09T01:00:00Z"));
    expect(applyPoll(state, { kind: "not-modified", status: 304, validators: {} }, new Date("2026-09-09T01:30:00Z")).cache).toEqual({ etag: "old", lastModified: "yesterday" });
    const failed = applyPoll(state, { kind: "retryable", status: 503, errorCategory: "upstream-5xx" }, new Date("2026-09-09T01:31:00Z"));
    expect(failed.health.category).toBe("stale"); expect(failed.snapshot).toEqual(state.snapshot);
  });
  it("rejects invalid state, loads only missing state as empty, and surfaces corruption", async () => {
    expect(() => validateState({})).toThrow("validation");
    const state = await loadState("generated/does-not-exist.json"); expect(state.snapshot).toBeNull();
    const path = "generated/test-corrupt-runtime-state.json";
    await writeFile(path, "{not-json", "utf8");
    try { await expect(loadState(path)).rejects.toThrow(SyntaxError); } finally { await unlink(path); }
  });

  it("parses Retry-After HTTP dates and rejects invalid thresholds", async () => {
    const now = new Date("2026-09-09T01:00:00.000Z");
    const result = await fetchOpentix("https://example.test", { now, fetchImpl: async () => new Response("", { status: 429, headers: { "retry-after": "Wed, 09 Sep 2026 01:00:05 GMT" } }) });
    expect(result.retryAfterMs).toBe(5000);
    expect(() => validateThreshold(0)).toThrow("threshold"); expect(() => validateThreshold(Number.NaN)).toThrow("threshold"); expect(validateThreshold(1)).toBe(1);
  });

  it("keeps every pending outbox item beyond the history cap", () => {
    const baseline = structuredClone(fixture); baseline.performances = [structuredClone(fixture.performances[0])]; baseline.performances[0].remaining = 0; baseline.remainingTotal = 0;
    const current = structuredClone(fixture); current.performances = Array.from({ length: MAX_OUTBOX + 5 }, (_, index) => ({ ...fixture.performances[0], performanceId: `performance-${index}`, remaining: 5 })); current.remainingTotal = (MAX_OUTBOX + 5) * 5;
    const first = applyPoll(emptyState(), { kind: "success", status: 200, observation: baseline }, new Date("2026-09-09T01:00:00Z"));
    const second = applyPoll(first, { kind: "success", status: 200, observation: current }, new Date("2026-09-09T01:31:00Z"));
    expect(second.outbox).toHaveLength(MAX_OUTBOX + 5); expect(second.outbox.every((item) => second.ledger[item.key]?.status === "pending")).toBe(true);
  });

  it("finds markers on later GitHub comment pages", async () => {
    const baseline = structuredClone(fixture); baseline.performances = [structuredClone(fixture.performances[0])]; baseline.performances[0].remaining = 0; baseline.remainingTotal = 0;
    const current = structuredClone(fixture); current.performances = [structuredClone(fixture.performances[0])]; current.performances[0].remaining = 5; current.remainingTotal = 5;
    let state = applyPoll(emptyState(), { kind: "success", status: 200, observation: baseline }, new Date("2026-09-09T01:00:00Z"));
    state = applyPoll(state, { kind: "success", status: 200, observation: current }, new Date("2026-09-09T01:31:00Z"));
    const marker = `<!-- ticket-radar-transition:${state.outbox[0]!.key} -->`; let gets = 0; let posts = 0;
    const result = await reconcileNotifications(state, { token: "token", repository: "owner/repo", issueNumber: 3, fetchImpl: async (_url, init) => {
      if (init?.method === "POST") { posts++; return new Response("", { status: 201 }); }
      gets++;
      if (gets === 1) return new Response("[]", { status: 200, headers: { link: "<https://api.github.com/repos/owner/repo/issues/3/comments?per_page=100&page=2>; rel=\"next\"" } });
      return new Response(JSON.stringify([{ body: marker }]), { status: 200 });
    } });
    expect(gets).toBe(2); expect(posts).toBe(0); expect(result.ledger[state.outbox[0]!.key]?.status).toBe("sent");
  });

  it("emits only became-available for zero to positive at threshold one", () => {
    const baseline = structuredClone(fixture); baseline.performances = [structuredClone(fixture.performances[0])]; baseline.performances[0].remaining = 0; baseline.remainingTotal = 0;
    const current = structuredClone(fixture); current.performances = [structuredClone(fixture.performances[0])]; current.performances[0].remaining = 5; current.remainingTotal = 5;
    const first = applyPoll(emptyState(), { kind: "success", status: 200, observation: baseline }, new Date("2026-09-09T01:00:00Z"));
    const second = applyPoll(first, { kind: "success", status: 200, observation: current }, new Date("2026-09-09T01:31:00Z"), 1);
    expect(second.transitions.filter((item) => item.kind === "threshold")).toHaveLength(0); expect(second.transitions.filter((item) => item.kind === "became-available")).toHaveLength(1);
  });
});
