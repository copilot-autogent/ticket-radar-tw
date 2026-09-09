import { describe, expect, it } from "vitest";
import { buildReplayDemo, renderReplayDemo } from "../src/replay.js";

describe("isolated replay demo", () => {
  it("is immutable, visibly non-live, and uses only the pure transition renderer", () => {
    const demo = buildReplayDemo();
    expect(demo.live).toBe(false);
    expect(demo.frames.map((frame) => frame.availability)).toEqual(["sold-out", "available"]);
    expect(renderReplayDemo(demo)).toContain("not live inventory");
    expect(renderReplayDemo(demo)).toContain("No notification sent");
  });
});
