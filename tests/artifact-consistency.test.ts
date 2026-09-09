import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CatalogState } from "../src/catalog.js";

describe("production artifact consistency", () => {
  it("loads the committed catalog, dashboard JSON, and rendered HTML as one state", async () => {
    const catalog = JSON.parse(await readFile("generated/catalog-state.json", "utf8")) as { opentix: CatalogState | null; udn: CatalogState | null };
    const dashboard = JSON.parse(await readFile("public/data/dashboard.json", "utf8")) as { catalog: typeof catalog };
    const html = await readFile("public/index.html", "utf8");
    for (const source of ["opentix", "udn"] as const) {
      const expected = catalog[source];
      const actual = dashboard.catalog[source];
      expect(actual?.completeness).toEqual(expected?.completeness);
      expect(actual?.coverage).toEqual(expected?.coverage);
      expect(actual?.events.length ?? 0).toBe(expected?.events.length ?? 0);
      expect(html).toContain(`${source.toUpperCase()}: ${expected?.coverage.summariesDiscovered ?? 0} summaries`);
      expect(html).toContain(`detail-enriched/discovered: ${expected?.coverage.detailEnriched ?? 0}/${expected?.coverage.summariesDiscovered ?? 0}`);
    }
    expect(html).not.toContain("cap/scan: complete");
  });
});
