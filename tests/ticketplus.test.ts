import { describe, expect, it } from "vitest";
import { applyTicketPlusPoll, emptyTicketPlusState, migrateRuntimeState, validateMultiSourceState } from "../src/runtime.js";
import { parseTicketPlusLotteryHtml, parseTicketPlusOrdinaryJson, pairTicketPlus, fetchTicketPlus } from "../src/ticketplus.js";
import { emptyState } from "../src/runtime.js";

const ordinary = JSON.stringify({ eventId: "e000001508", title: "2026 R1AN SOLO FANCON", sessions: [
  { id: "s000002229", status: "pending", saleStart: "2026-09-11T12:00:00+08:00", saleEnd: "2026-09-19T17:00:00+08:00", startAt: "2026-10-01T19:00:00+08:00" },
  { id: "s000002230", status: "onsale", saleStart: "2026-09-11T12:00:00+08:00", saleEnd: "2026-09-19T17:00:00+08:00" }
] });
const lottery = `<main>登記抽選：2026/05/13 12:00 - 2026/05/17 21:00；中選結果：2026/05/19 12:00；付款：2026/05/20 12:00；條件一般販售：2026/05/23 11:00；登記截止。第二輪結果與付款公告。</main>`;

describe("Ticket Plus lifecycle adapter", () => {
  it("preserves ordinary machine identities, status, and exact windows", () => {
    const result = parseTicketPlusOrdinaryJson(ordinary, "2026-09-09T00:00:00Z", new Date("2026-09-09T00:00:00Z"));
    expect(result.eventId).toBe("e000001508");
    expect(result.sessions.map((item) => item.sessionId)).toEqual(["s000002229", "s000002230"]);
    expect(result.sessions[0]?.status).toBe("pending");
    expect(result.sessions[0]?.saleEndAt).toBe("2026-09-19T17:00:00+08:00");
    expect(result.sessions[0]?.lifecycle).toBe("sale-scheduled");
  });
  it("does not end an active performance merely because it has started", () => {
    const body = JSON.stringify({ eventId: "e000001508", sessions: [{ id: "s000002229", status: "onsale", saleStart: "2026-09-01T12:00:00+08:00", saleEnd: "2026-09-19T17:00:00+08:00", startAt: "2026-09-09T18:00:00+08:00", endAt: "2026-09-09T20:00:00+08:00" }] });
    const result = parseTicketPlusOrdinaryJson(body, undefined, new Date("2026-09-09T19:00:00+08:00"));
    expect(result.sessions[0]?.lifecycle).toBe("on-sale");
    const ended = parseTicketPlusOrdinaryJson(body, undefined, new Date("2026-09-09T20:00:00+08:00"));
    expect(ended.sessions[0]?.lifecycle).toBe("ended");
  });
  it("parses each lottery round from its own bounded evidence", () => {
    const result = parseTicketPlusLotteryHtml(`<main>第一輪 登記抽選：2026/09/01 12:00 - 2026/09/03 21:00；第二輪 登記抽選公告，結果公布：2026/09/10 12:00 - 2026/09/11 12:00。</main>`, undefined, new Date("2026-09-09T00:00:00Z"));
    expect(result.rounds[0]?.windows.map((item) => item.kind)).toContain("registration");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.windows[0]?.startAt).toContain("2026-09-01");
    expect(result.rounds[1]?.windows[0]?.startAt).toContain("2026-09-10");
    expect(result.rounds[1]?.windows[0]?.startAt).not.toBe(result.rounds[0]?.windows[0]?.startAt);
  });
  it("keeps incomplete second-round announcements unknown instead of cloning", () => {
    const result = parseTicketPlusLotteryHtml(`<main>登記抽選：2026/09/01 12:00 - 2026/09/03 21:00。第二輪結果與付款公告。</main>`, undefined, new Date("2026-09-04T00:00:00Z"));
    expect(result.rounds[1]?.windows).toEqual([]);
    expect(result.rounds[1]?.state).toBe("unknown");
  });
  it("does not let undated historical prose claim an active lifecycle", () => {
    const result = parseTicketPlusLotteryHtml("<main>付款已完成。一般販售資訊請見官網。</main>", undefined, new Date("2026-09-04T00:00:00Z"));
    expect(result.currentState).toBe("unknown");
  });
  it("does not leak dates from adjacent labeled sections or rounds", () => {
    const result = parseTicketPlusLotteryHtml("<main>第一輪 付款：請留意公告；一般販售：2026/09/20 12:00。第二輪 付款：2026/10/01 12:00。</main>", undefined, new Date("2026-09-04T00:00:00Z"));
    expect(result.rounds[0]?.windows.find((item) => item.kind === "payment")).toBeUndefined();
    expect(result.rounds[0]?.windows.find((item) => item.kind === "general-sale")?.startAt).toContain("2026-09-20");
    expect(result.rounds[1]?.windows.find((item) => item.kind === "payment")?.startAt).toContain("2026-10-01");
  });
  it.each([
    ["historical", "2026-09-04T00:00:00Z", "results-pending"],
    ["current", "2026-09-02T00:00:00Z", "registration-open"],
    ["future", "2026-08-01T00:00:00Z", "registration-scheduled"]
  ] as const)("derives %s lottery state from windows and now", (_label, now, expected) => {
    const result = parseTicketPlusLotteryHtml(`<main>登記抽選：2026/09/01 12:00 - 2026/09/03 21:00；付款：2026/09/04 12:00 - 2026/09/05 21:00；一般販售：2026/09/10 12:00。</main>`, undefined, new Date(now));
    expect(result.currentState).toBe(expected);
  });
  it("fails closed for malformed, oversized, and ambiguous content", () => {
    expect(() => parseTicketPlusOrdinaryJson("<script type=\"application/json\">bad</script>")).toThrow("malformed-json");
    expect(() => parseTicketPlusOrdinaryJson("x".repeat(2_000_001))).toThrow("response-size");
    expect(() => parseTicketPlusLotteryHtml("<main>no dates</main>")).toThrow("missing-lottery-windows");
  });
  it("isolates partial fetch failures and conservative pairing", async () => {
    const result = await fetchTicketPlus(async (url) => url.includes("eventId=") ? new Response(ordinary) : new Response(lottery));
    expect(result.ordinary?.sessions).toHaveLength(2);
    expect(result.lottery?.rounds).toHaveLength(2);
    expect(pairTicketPlus(result.ordinary!, result.lottery!)[0]?.automationEligible).toBe(false);
    const failed = await fetchTicketPlus(async () => new Response("gone", { status: 503 }));
    expect(failed.errors).toHaveLength(2);
  });
  it("retains the other sources during versioned migration and ticket failure", () => {
    const legacy = emptyState();
    const migrated = migrateRuntimeState(legacy);
    validateMultiSourceState(migrated);
    const state = applyTicketPlusPoll(emptyTicketPlusState(), { errors: ["ordinary:http-503", "lottery:timeout"] });
    expect(state.health.category).toBe("error");
    expect(migrated.sources.opentix).toEqual(legacy);
    expect(migrated.sources.ticketPlus.ordinary).toBeNull();
  });
  it("quarantines retained Ticket Plus rows after both public endpoints return 403", () => {
    const ordinaryObservation = parseTicketPlusOrdinaryJson(ordinary, "2026-09-08T00:00:00Z");
    const lotteryObservation = parseTicketPlusLotteryHtml(lottery, "2026-09-08T00:00:00Z");
    const retained = applyTicketPlusPoll(emptyTicketPlusState(), { ordinary: ordinaryObservation, lottery: lotteryObservation, errors: [] }, new Date("2026-09-08T00:00:00Z"));
    const degraded = applyTicketPlusPoll(retained, { errors: ["ordinary:http-403", "lottery:http-403"] }, new Date("2026-09-09T00:00:00Z"));
    expect(degraded.health).toMatchObject({ category: "stale", error: "ordinary:http-403;lottery:http-403" });
    expect(degraded.ordinary).toBeNull();
    expect(degraded.lottery).toBeNull();
    expect(degraded.pairings).toEqual([]);
    expect(degraded.history.at(-1)).toMatchObject({ ordinary: false, lottery: false });
  });
  it("rejects malformed persisted Ticket Plus observations before dashboard rendering", () => {
    const state = migrateRuntimeState(emptyState());
    state.sources.ticketPlus.ordinary = { ...parseTicketPlusOrdinaryJson(ordinary), sessions: [{ ...parseTicketPlusOrdinaryJson(ordinary).sessions[0]!, saleStartAt: "not-a-date" }] };
    expect(() => validateMultiSourceState(state)).toThrow("ticket-plus-session-date");
    state.sources.ticketPlus.ordinary = null;
    state.sources.ticketPlus.lottery = { ...parseTicketPlusLotteryHtml(lottery), rounds: [{ ...parseTicketPlusLotteryHtml(lottery).rounds[0]!, windows: [{ ...parseTicketPlusLotteryHtml(lottery).rounds[0]!.windows[0]!, evidenceId: "" }] }] };
    expect(() => validateMultiSourceState(state)).toThrow("ticket-plus-window");
  });
});
