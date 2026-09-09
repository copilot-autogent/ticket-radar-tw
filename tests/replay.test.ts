import { describe, expect, it } from "vitest";
import fixture from "../fixtures/observations.json";
import { replayHasNoDeliverySurface, runIsolatedReplayDemo } from "../src/replay.js";

describe("isolated replay demo", () => {
  it("replays one deterministic transition without a delivery surface", () => {
    const output = runIsolatedReplayDemo(fixture);
    expect(output.transitions).toHaveLength(1);
    expect(output.transitions[0]?.from).toBe("sold-out");
    expect(output.transitions[0]?.to).toBe("available");
    expect(replayHasNoDeliverySurface()).toBe(true);
  });
});
