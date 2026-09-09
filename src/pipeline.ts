import { readFile, rename, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  Availability,
  AvailabilitySnapshot,
  Fixture,
  PipelineOutput,
  Transition
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export const MAX_HISTORY = 100;
export const MAX_TRANSITIONS = 100;

const availabilityValues = new Set<Availability>(["available", "sold-out", "zero", "unknown"]);
const isoWithOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(path: string, reason: string): never {
  throw new Error(`Validation failed at ${path}: ${reason}`);
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "expected non-empty string");
  return value;
}

function timestamp(value: unknown, path: string): string {
  const result = stringValue(value, path);
  if (!isoWithOffset.test(result) || Number.isNaN(Date.parse(result))) fail(path, "expected ISO-8601 timestamp with timezone");
  return result;
}

function snapshot(value: unknown, path: string): AvailabilitySnapshot {
  if (!value || typeof value !== "object") fail(path, "expected object");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== SCHEMA_VERSION) fail(`${path}.schemaVersion`, "unsupported schema version");
  const availability = stringValue(item.availability, `${path}.availability`) as Availability;
  if (!availabilityValues.has(availability)) fail(`${path}.availability`, "unsupported availability");
  if (!Number.isInteger(item.observationVersion) || Number(item.observationVersion) < 1) {
    fail(`${path}.observationVersion`, "expected positive integer");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    source: stringValue(item.source, `${path}.source`),
    performanceId: stringValue(item.performanceId, `${path}.performanceId`),
    tierId: stringValue(item.tierId, `${path}.tierId`),
    availability,
    observedAt: timestamp(item.observedAt, `${path}.observedAt`),
    observationVersion: Number(item.observationVersion)
  };
}

export function validateFixture(value: unknown): Fixture {
  if (!value || typeof value !== "object") fail("$", "expected object");
  const fixture = value as Record<string, unknown>;
  if (!Array.isArray(fixture.observations)) fail("$.observations", "expected array");
  const event = fixture.event as Record<string, unknown> | undefined;
  const performance = fixture.performance as Record<string, unknown> | undefined;
  if (!event || typeof event !== "object") fail("$.event", "expected object");
  if (!performance || typeof performance !== "object") fail("$.performance", "expected object");
  const source = stringValue(performance.source, "$.performance.source");
  const performanceId = stringValue(performance.performanceId, "$.performance.performanceId");
  for (const [path, item] of [["$.event", event], ["$.performance", performance]] as const) {
    if (item.schemaVersion !== SCHEMA_VERSION) fail(`${path}.schemaVersion`, "unsupported schema version");
    stringValue(item.source, `${path}.source`);
    stringValue(item.upstreamEventId, `${path}.upstreamEventId`);
  }
  stringValue(event.title, "$.event.title");
  stringValue(event.venue, "$.event.venue");
  stringValue(performance.eventTitle, "$.performance.eventTitle");
  timestamp(performance.startsAt, "$.performance.startsAt");
  if (!Array.isArray(fixture.tiers)) fail("$.tiers", "expected array");
  const tiers = fixture.tiers.map((item, index) => {
    if (!item || typeof item !== "object") fail(`$.tiers[${index}]`, "expected object");
    const tier = item as Record<string, unknown>;
    if (tier.schemaVersion !== SCHEMA_VERSION) fail(`$.tiers[${index}].schemaVersion`, "unsupported schema version");
    if (tier.source !== source) fail(`$.tiers[${index}].source`, "must match performance source");
    if (tier.performanceId !== performanceId) fail(`$.tiers[${index}].performanceId`, "must match performance");
    stringValue(tier.tierId, `$.tiers[${index}].tierId`);
    stringValue(tier.label, `$.tiers[${index}].label`);
    if (typeof tier.price !== "number" || !Number.isFinite(tier.price) || tier.price < 0) fail(`$.tiers[${index}].price`, "expected finite non-negative number");
    return tier;
  });
  if (!fixture.lifecycle || typeof fixture.lifecycle !== "object") fail("$.lifecycle", "expected object");
  const lifecycle = fixture.lifecycle as Record<string, unknown>;
  if (lifecycle.schemaVersion !== SCHEMA_VERSION) fail("$.lifecycle.schemaVersion", "unsupported schema version");
  if (lifecycle.source !== source || lifecycle.performanceId !== performanceId) fail("$.lifecycle", "identity must match performance");
  timestamp(lifecycle.salesOpenAt, "$.lifecycle.salesOpenAt");
  timestamp(lifecycle.salesCloseAt, "$.lifecycle.salesCloseAt");
  if (Date.parse(String(lifecycle.salesCloseAt)) < Date.parse(String(lifecycle.salesOpenAt))) fail("$.lifecycle", "salesCloseAt must not precede salesOpenAt");
  const observations = fixture.observations.map((item, index) => snapshot(item, `$.observations[${index}]`));
  for (const [index, item] of observations.entries()) {
    if (item.source !== source) fail(`$.observations[${index}].source`, "must match performance source");
    if (item.performanceId !== performanceId) fail(`$.observations[${index}].performanceId`, "must match performance");
    if (!tiers.some((tier) => tier.tierId === item.tierId)) fail(`$.observations[${index}].tierId`, "must reference a known tier");
  }
  if (!Array.isArray(fixture.watchRules)) fail("$.watchRules", "expected array");
  const watchRules = fixture.watchRules.map((item, index) => {
    if (!item || typeof item !== "object") fail(`$.watchRules[${index}]`, "expected object");
    const rule = item as Record<string, unknown>;
    if (rule.source !== source || rule.performanceId !== performanceId) fail(`$.watchRules[${index}]`, "identity must match performance");
    stringValue(rule.acceptableTierId, `$.watchRules[${index}].acceptableTierId`);
    if (!tiers.some((tier) => tier.tierId === rule.acceptableTierId)) fail(`$.watchRules[${index}].acceptableTierId`, "must reference a known tier");
    return rule;
  });
  const priorVersions = new Map<string, number>();
  const seenVersions = new Map<string, AvailabilitySnapshot>();
  for (const [index, item] of observations.entries()) {
    const itemKey = `${item.performanceId}:${item.tierId}`;
    const priorVersion = priorVersions.get(itemKey) ?? 0;
    if (item.observationVersion < priorVersion) fail(`$.observations[${index}].observationVersion`, "must not go backwards");
    const seen = seenVersions.get(`${item.performanceId}:${item.tierId}:${item.observationVersion}`);
    if (seen && seen.availability !== item.availability) fail(`$.observations[${index}].availability`, "conflicting replay for observation version");
    seenVersions.set(`${item.performanceId}:${item.tierId}:${item.observationVersion}`, item);
    priorVersions.set(itemKey, Math.max(priorVersion, item.observationVersion));
  }
  return {
    event: event as unknown as Fixture["event"],
    performance: performance as unknown as Fixture["performance"],
    tiers: tiers as unknown as Fixture["tiers"],
    lifecycle: lifecycle as unknown as Fixture["lifecycle"],
    watchRules: watchRules as unknown as Fixture["watchRules"],
    observations
  };
}

function key(item: AvailabilitySnapshot): string {
  return `${item.performanceId}:${item.tierId}`;
}

function isPositive(value: Availability): boolean {
  return value === "available";
}

function isSoldOut(value: Availability): boolean {
  return value === "sold-out" || value === "zero";
}

export function processFixture(fixture: Fixture): PipelineOutput {
  const state = new Map<string, AvailabilitySnapshot>();
  const history: AvailabilitySnapshot[] = [];
  const transitions: Transition[] = [];
  const watched = new Set(fixture.watchRules.map((rule) => `${rule.performanceId}:${rule.acceptableTierId}`));
  for (const observation of fixture.observations) {
    const itemKey = key(observation);
    const previous = state.get(itemKey);
    state.set(itemKey, observation);
    history.push(observation);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    if (!previous || previous.observationVersion === observation.observationVersion) continue;
    if (!watched.has(itemKey) || !isSoldOut(previous.availability) || !isPositive(observation.availability)) continue;
    const transition: Transition = {
      schemaVersion: SCHEMA_VERSION,
      source: observation.source,
      performanceId: observation.performanceId,
      tierId: observation.tierId,
      from: previous.availability,
      to: observation.availability,
      observedAt: observation.observedAt,
      observationVersion: observation.observationVersion,
      idempotencyKey: `${observation.performanceId}:${observation.tierId}:${previous.availability}:${observation.availability}:v${observation.observationVersion}`
    };
    if (!transitions.some((item) => item.idempotencyKey === transition.idempotencyKey)) transitions.push(transition);
  }
  return {
    snapshot: [...state.values()],
    state: [...state.values()],
    history,
    transitions: transitions.slice(-MAX_TRANSITIONS)
  };
}

export async function readFixture(path: string): Promise<Fixture> {
  return validateFixture(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function writeTextAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

export function outputPaths(root = process.cwd()) {
  return {
    snapshot: resolve(root, "generated/normalized-snapshot.json"),
    state: resolve(root, "generated/state.json"),
    history: resolve(root, "generated/history.json"),
    transitions: resolve(root, "generated/transitions.json")
  };
}
