export const SCHEMA_VERSION = 1 as const;

export type Availability = "available" | "sold-out" | "zero" | "unknown";

export interface Event {
  schemaVersion: typeof SCHEMA_VERSION;
  source: string;
  upstreamEventId: string;
  title: string;
  venue: string;
}

export interface Performance {
  schemaVersion: typeof SCHEMA_VERSION;
  source: string;
  performanceId: string;
  upstreamEventId: string;
  eventTitle: string;
  startsAt: string;
}

export interface PriceTier {
  schemaVersion: typeof SCHEMA_VERSION;
  source: string;
  performanceId: string;
  tierId: string;
  label: string;
  price: number;
}

export interface LifecycleWindow {
  schemaVersion: typeof SCHEMA_VERSION;
  source: string;
  performanceId: string;
  salesOpenAt: string;
  salesCloseAt: string;
}

export interface AvailabilitySnapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  source: string;
  performanceId: string;
  tierId: string;
  availability: Availability;
  observedAt: string;
  observationVersion: number;
}

export interface WatchRule {
  source: string;
  performanceId: string;
  acceptableTierId: string;
}

export interface Transition {
  schemaVersion: typeof SCHEMA_VERSION;
  source: string;
  performanceId: string;
  tierId: string;
  from: Availability;
  to: Availability;
  observedAt: string;
  observationVersion: number;
  idempotencyKey: string;
}

export interface Fixture {
  event: Event;
  performance: Performance;
  tiers: PriceTier[];
  lifecycle: LifecycleWindow;
  watchRules: WatchRule[];
  observations: AvailabilitySnapshot[];
}

export interface PipelineOutput {
  snapshot: AvailabilitySnapshot[];
  state: AvailabilitySnapshot[];
  history: AvailabilitySnapshot[];
  transitions: Transition[];
}
