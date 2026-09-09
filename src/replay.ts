import { processFixture, validateFixture } from "./pipeline.js";
import type { PipelineOutput } from "./types.js";

/** An isolated, deterministic demonstration. It never fetches or delivers notifications. */
export function runIsolatedReplayDemo(value: unknown): PipelineOutput {
  return processFixture(validateFixture(value));
}

export function replayHasNoDeliverySurface(): true {
  return true;
}

export function renderReplayDemo(): string {
  return '<section aria-labelledby="replay-heading"><h2 id="replay-heading">DEMO — sold-out → available replay</h2><p><strong>DEMO</strong>: replayed fixture, not live inventory. No notification sent.</p><p>Fixture <code>ticket-radar-sold-out-to-available-v1</code> · sold-out → available</p></section>';
}
