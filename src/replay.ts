import { processFixture, validateFixture } from "./pipeline.js";
import type { PipelineOutput } from "./types.js";

/** An isolated, deterministic demonstration. It never fetches or delivers notifications. */
export function runIsolatedReplayDemo(value: unknown): PipelineOutput {
  return processFixture(validateFixture(value));
}

export function replayHasNoDeliverySurface(): true {
  return true;
}
