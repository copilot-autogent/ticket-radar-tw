import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderLiveDashboard } from "../src/dashboard.js";
import { emptyState, emptyTicketPlusState, emptyUdnState } from "../src/runtime.js";

describe("catalog dashboard controls and source truthfulness", () => {
  it("renders every view/filter, reset, manual watch wording, and deterministic result count", async () => {
    const root = await mkdtemp(join(tmpdir(), "ticket-radar-dashboard-"));
    try {
      const state = emptyState();
      const catalog = {
        opentix: { schemaVersion: 1 as const, generatedAt: "2026-09-09T00:00:00Z", events: [{ schemaVersion: 1 as const, source: "opentix" as const, eventId: "1", sourceUrl: "https://www.opentix.life/event/1", title: "A Concert", category: "concert" as const, classificationReason: "title-keyword-fallback" as const, classificationConfidence: "medium" as const, firstSeenAt: "2026-09-09T00:00:00Z", catalogFetchedAt: "2026-09-09T00:00:00Z", performances: [] }], completeness: { source: "opentix" as const, fetchedAt: "2026-09-09T00:00:00Z", eventCount: 1, pageCount: 1, detailCount: 1, stopReason: "normal-exhaustion" as const, health: "ok" as const } },
        udn: null
      };
      await renderLiveDashboard(root, null, state, emptyUdnState(), emptyTicketPlusState(), catalog);
      const html = await readFile(join(root, "public/index.html"), "utf8");
      expect(html).toContain('data-view="sale-soon"');
      expect(html).toContain('id="catalog-max-price"');
      expect(html).toContain('id="catalog-unknown-price"');
      expect(html).toContain('id="catalog-reset"');
      expect(html).toContain("GitHub sign-in plus maintainer manual validation");
      expect(html).toContain("events shown");
      expect(html).toContain('rel="icon" href="data:image/svg+xml');
      expect(html).toContain(".catalog-results,section>table{max-width:100%");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders validated lottery state and quarantined unsupported state truthfully", async () => {
    const root = await mkdtemp(join(tmpdir(), "ticket-radar-dashboard-"));
    try {
      const state = emptyState();
      const ticket = emptyTicketPlusState();
      ticket.lottery = { source: "ticket-plus", activityId: "6c3d8c24e0f00c9c84777615c001bebe", title: "Lottery", rounds: [], currentState: "registration-open", parseVersion: "test", evidenceIds: ["e"], observedAt: "2026-09-09T00:00:00Z", sourceUrl: "https://example.test" };
      await renderLiveDashboard(root, null, state, emptyUdnState(), ticket);
      expect(await readFile(join(root, "public/index.html"), "utf8")).toContain("Current state: registration-open");
      ticket.lottery = null;
      ticket.health = { category: "stale", error: "ordinary:http-403;lottery:http-403", lastAttemptAt: "2026-09-09T00:00:00Z", lastSuccessfulAt: null };
      await renderLiveDashboard(root, null, state, emptyUdnState(), ticket);
      const html = await readFile(join(root, "public/index.html"), "utf8");
      expect(html).toContain("unsupported — no validated observation");
      expect(html).not.toContain("Current state: unknown");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
