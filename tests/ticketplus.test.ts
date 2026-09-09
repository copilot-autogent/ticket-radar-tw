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
  });
  it("parses bounded lottery rounds and evidence without retaining prose", () => {
    const result = parseTicketPlusLotteryHtml(lottery);
    expect(result.rounds[0]?.windows.map((item) => item.kind)).toContain("registration");
    expect(result.currentState).toBe("registration-closed");
    expect(result.evidenceIds.join(" ")).not.toContain("第二輪結果與付款公告");
  });
  it("fails closed for malformed, oversized, and ambiguous content", () => {
    expect(() => parseTicketPlusOrdinaryJson("<script type=\"application/json\">bad</script>")).toThrow("malformed-json");
    expect(() => parseTicketPlusOrdinaryJson("x".repeat(2_000_001))).toThrow("response-size");
    expect(() => parseTicketPlusLotteryHtml("<main>no dates</main>")).toThrow("missing-lottery-windows");
  });
  it("isolates partial fetch failures and conservative pairing", async () => {
    const result = await fetchTicketPlus(async (url) => url.includes("sessions.json") ? new Response(ordinary) : new Response(lottery));
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
});
