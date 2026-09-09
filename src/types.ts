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

export const NORMALIZED_SCHEMA_VERSION = 2 as const;
export const OPENTIX_SOURCE = "https://www.opentix.life/event/2054406826574860289";
export const OPENTIX_TIME_ZONE = "Asia/Taipei";
export type LifecycleState = "pre-sale" | "on-sale" | "ended" | "unknown";
export type HealthCategory = "ok" | "stale" | "error" | "not-run";
export interface NormalizedVenue { name: string; address?: string; timeZone: typeof OPENTIX_TIME_ZONE; }
export interface NormalizedPrice { currency: "TWD"; min: number; max: number; }
export interface NormalizedPerformance {
  schemaVersion: typeof NORMALIZED_SCHEMA_VERSION;
  source: typeof OPENTIX_SOURCE;
  eventId: string;
  performanceId: string;
  startsAt: string;
  endsAt?: string;
  venue: NormalizedVenue;
  lifecycle: LifecycleState;
  saleOpenAt?: string;
  saleCloseAt?: string;
  price: NormalizedPrice;
  remaining: number | null;
}
export interface NormalizedEvent {
  schemaVersion: typeof NORMALIZED_SCHEMA_VERSION;
  source: typeof OPENTIX_SOURCE;
  eventId: string;
  title: string;
  venue: NormalizedVenue;
  performances: NormalizedPerformance[];
  remainingTotal: number | null;
  observedAt: string;
  parserVersion: string;
}
export interface NormalizedObservation {
  schemaVersion: typeof NORMALIZED_SCHEMA_VERSION;
  source: typeof OPENTIX_SOURCE;
  event: NormalizedEvent;
  observedAt: string;
}

export const MULTI_SOURCE_SCHEMA_VERSION = 4 as const;
export const UDN_PROVIDER = "udn" as const;
export const UDN_EVENT_ID = "P1AEBJG5" as const;
export const UDN_EVENT_SOURCE = "https://tickets.udnfunlife.com/Application/UTK02/UTK0201_.aspx?PRODUCT_ID=P1AEBJG5" as const;

export type UdnAvailabilityKind = "exact" | "sold-out" | "hot-selling-unknown" | "unknown";
export interface UdnTier {
  provider: typeof UDN_PROVIDER;
  eventId: typeof UDN_EVENT_ID;
  performanceId: string;
  tierId: string;
  label: string;
  priceTwd: number;
  sourceUrl: string;
  availability: UdnAvailabilityKind;
  exactCount: number | null;
}
export interface UdnObservation {
  provider: typeof UDN_PROVIDER;
  eventId: typeof UDN_EVENT_ID;
  performanceId: string;
  title: string;
  sourceUrl: string;
  observedAt: string;
  parserVersion: string;
  tiers: UdnTier[];
}

export const TICKET_PLUS_SOURCE = "ticket-plus" as const;
export const TICKET_PLUS_ORDINARY_ACTIVITY = "df31f9384cf60a3110dbf9607e780a1b" as const;
export const TICKET_PLUS_ORDINARY_EVENT = "e000001508" as const;
export const TICKET_PLUS_LOTTERY_ACTIVITY = "6c3d8c24e0f00c9c84777615c001bebe" as const;
export type TicketPlusOrdinaryLifecycle = "announced" | "sale-scheduled" | "on-sale" | "sale-closed" | "ended" | "unknown";
export type TicketPlusLotteryState = "registration-scheduled" | "registration-open" | "registration-closed" | "results-pending" | "payment-window" | "general-sale-scheduled" | "ended" | "unknown";
export interface TicketPlusSession {
  activityId: string;
  eventId: string;
  sessionId: string;
  status: string;
  lifecycle: TicketPlusOrdinaryLifecycle;
  exposureStartAt?: string;
  exposureEndAt?: string;
  saleStartAt?: string;
  saleEndAt?: string;
  startsAt?: string;
  endsAt?: string;
  venue?: string;
  sourceUrl: string;
}
export interface TicketPlusOrdinaryObservation {
  source: typeof TICKET_PLUS_SOURCE;
  activityId: string;
  eventId: string;
  title: string;
  sessions: TicketPlusSession[];
  observedAt: string;
  parserVersion: string;
  sourceUrl: string;
}
export type TicketPlusRoundKind = "initial" | "second" | "other";
export interface TicketPlusLotteryWindow {
  kind: "registration" | "results" | "payment" | "general-sale";
  startAt?: string;
  endAt?: string;
  version: number;
  evidenceId: string;
}
export interface TicketPlusLotteryRound {
  roundId: string;
  kind: TicketPlusRoundKind;
  windows: TicketPlusLotteryWindow[];
  state: TicketPlusLotteryState;
  version: number;
}
export interface TicketPlusLotteryObservation {
  source: typeof TICKET_PLUS_SOURCE;
  activityId: string;
  title: string;
  rounds: TicketPlusLotteryRound[];
  currentState: TicketPlusLotteryState;
  parseVersion: string;
  evidenceIds: string[];
  observedAt: string;
  sourceUrl: string;
}
export interface TicketPlusPairingCandidate {
  lotteryActivityId: string;
  ordinaryActivityId: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  automationEligible: boolean;
}
export interface TicketPlusConflict {
  id: string;
  field: string;
  previous: string;
  current: string;
  evidenceId: string;
  correction: boolean;
  observedAt: string;
}
export interface TicketPlusRuntimeState {
  source: typeof TICKET_PLUS_SOURCE;
  ordinary: TicketPlusOrdinaryObservation | null;
  lottery: TicketPlusLotteryObservation | null;
  pairings: TicketPlusPairingCandidate[];
  conflicts: TicketPlusConflict[];
  history: Array<{ observedAt: string; ordinary: boolean; lottery: boolean }>;
  health: { category: HealthCategory; error?: string; lastAttemptAt: string | null; lastSuccessfulAt: string | null };
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
}
