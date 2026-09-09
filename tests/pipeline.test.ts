import { describe, expect, it } from "vitest";
import { processFixture, validateFixture, MAX_HISTORY } from "../src/pipeline.js";
import fixture from "../fixtures/observations.json";

describe("fixture pipeline", () => {
  it("emits one sold-out to available transition and ignores replay", () => {
    const output = processFixture(validateFixture(fixture));
    expect(output.transitions).toHaveLength(1);
    expect(output.transitions[0]?.idempotencyKey).toBe("fixture-performance-001:tier-standard:sold-out:available:v2");
  });

  it("treats the first observation as a baseline", () => {
    const input = validateFixture(fixture);
    input.observations = [input.observations[0]!];
    expect(processFixture(input).transitions).toHaveLength(0);
  });

  it("prunes history deterministically at its bound", () => {
    const input = validateFixture(fixture);
    input.observations = Array.from({ length: MAX_HISTORY + 5 }, (_, index) => ({
      ...input.observations[0]!,
      observationVersion: index + 1,
      observedAt: `2026-09-09T08:${String(index % 60).padStart(2, "0")}:00+08:00`
    }));
    const output = processFixture(input);
    expect(output.history).toHaveLength(MAX_HISTORY);
    expect(output.history[0]?.observationVersion).toBe(6);
  });

  it("reports JSON paths for malformed input", () => {
    expect(() => validateFixture({ observations: [{ schemaVersion: 1, availability: "maybe" }] })).toThrow("$.event");
    expect(() => validateFixture({ ...fixture, observations: [{ ...fixture.observations[0], availability: "maybe" }] })).toThrow("$.observations[0].availability");
  });
});
