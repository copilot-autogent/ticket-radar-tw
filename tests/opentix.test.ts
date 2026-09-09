import { describe, expect, it } from "vitest";
import fixture from "../fixtures/opentix-event.json";
import { backoffMs, isEligible, parseOpentixHtml } from "../src/opentix.js";
import { applyPoll, emptyState, reconcileNotifications, validateNormalizedEvent } from "../src/runtime.js";

describe("OPENTIX normalized slice", () => {
  it("retains stable source, Asia/Taipei performance identities, prices, and exact totals", () => {
    const event = validateNormalizedEvent(fixture);
    expect(event.source).toContain("opentix.life/event/2054406826574860289");
    expect(event.venue.timeZone).toBe("Asia/Taipei");
    expect(event.performances).toHaveLength(25);
    expect(event.performances.every((item) => item.remaining !== null)).toBe(true);
    expect(event.performances[0]?.price).toEqual({ currency: "TWD", min: 1200, max: 2200 });
  });
  it("fails closed for missing performance data", () => {
    expect(() => validateNormalizedEvent({ ...fixture, performances: [] })).toThrow("validation");
    expect(() => parseOpentixHtml("<title>login</title>")).toThrow("challenge");
  });
  it("establishes a baseline and detects zero-to-available once", () => {
    const baseline = structuredClone(fixture); baseline.performances = [structuredClone(fixture.performances[0])]; baseline.performances[0].remaining = 0; baseline.observedAt = "2026-09-09T02:00:00Z";
    const next = structuredClone(fixture); next.performances = [structuredClone(fixture.performances[0])]; next.performances[0].remaining = 5; next.observedAt = "2026-09-09T02:31:00Z";
    const first = applyPoll(emptyState(), { kind: "success", status: 200, observation: baseline }, new Date("2026-09-09T02:00:00Z"));
    const second = applyPoll(first, { kind: "success", status: 200, observation: next }, new Date("2026-09-09T02:31:00Z"));
    expect(first.transitions).toHaveLength(0); expect(second.transitions.some((item) => item.kind === "became-available")).toBe(true);
  });
  it("enforces interval and capped retry backoff", () => {
    expect(isEligible("2026-09-09T02:00:00.000Z", Date.parse("2026-09-09T02:29:59.000Z"))).toBe(false);
    expect(isEligible("2026-09-09T02:00:00.000Z", Date.parse("2026-09-09T02:30:00.000Z"))).toBe(true);
    expect(backoffMs(20, 30_000)).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });
  it("reconciles an existing marker without posting a duplicate", async () => {
    const baseline = structuredClone(fixture); baseline.performances = [structuredClone(fixture.performances[0])]; baseline.performances[0].remaining = 0;
    const current = structuredClone(fixture); current.performances = [structuredClone(fixture.performances[0])]; current.performances[0].remaining = 5;
    let state = applyPoll(emptyState(), { kind: "success", status: 200, observation: baseline }, new Date("2026-09-09T02:00:00Z"));
    state = applyPoll(state, { kind: "success", status: 200, observation: current }, new Date("2026-09-09T02:31:00Z"));
    const result = await reconcileNotifications(state, { token: "token", repository: "owner/repo", issueNumber: 3, fetchImpl: async (_url, init) => {
      if (init?.method === "POST") throw new Error("must not post");
      return new Response(JSON.stringify([{ body: `<!-- ticket-radar-transition:${state.outbox[0]?.key} -->` }]), { status: 200 });
    } });
    expect(result.ledger[state.outbox[0]!.key]?.status).toBe("sent");
  });
});
