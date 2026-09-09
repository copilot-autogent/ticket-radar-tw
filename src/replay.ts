import type { Availability, Transition } from "./types.js";

export interface ReplayFrame {
  readonly observedAt: string;
  readonly availability: Availability;
}

export interface ReplayDemo {
  readonly kind: "replay-demo";
  readonly live: false;
  readonly fixtureId: string;
  readonly frames: readonly [ReplayFrame, ReplayFrame];
  readonly transition: Transition;
}

const replayFrames: readonly [ReplayFrame, ReplayFrame] = [
  { observedAt: "2026-01-01T00:00:00Z", availability: "sold-out" },
  { observedAt: "2026-01-01T00:05:00Z", availability: "available" }
];

export function buildReplayDemo(): ReplayDemo {
  return {
    kind: "replay-demo",
    live: false,
    fixtureId: "ticket-radar-sold-out-to-available-v1",
    frames: replayFrames,
    transition: {
      schemaVersion: 1,
      source: "replay-fixture",
      performanceId: "replay-performance-001",
      tierId: "replay-tier-standard",
      from: "sold-out",
      to: "available",
      observedAt: replayFrames[1]!.observedAt,
      observationVersion: 2,
      idempotencyKey: "replay-performance-001:replay-tier-standard:sold-out:available:v2"
    }
  };
}

export function renderReplayDemo(demo = buildReplayDemo()): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const from = demo.frames[0]?.availability ?? demo.transition.from;
  const to = demo.frames[1]?.availability ?? demo.transition.to;
  return `<section aria-labelledby="replay-heading"><h2 id="replay-heading">DEMO — sold-out → available replay</h2><p><strong>DEMO</strong>: replayed fixture, not live inventory. No notification sent.</p><p>Fixture <code>${escape(demo.fixtureId)}</code> · ${escape(from)} → ${escape(to)}</p></section>`;
}
