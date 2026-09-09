import { access, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderLiveDashboard } from "./dashboard.js";
import { fetchOpentix } from "./opentix.js";
import { applyPoll, applyTicketPlusPoll, applyUdnPoll, emptyState, emptyUdnState, emptyTicketPlusState, eligibleToPoll, loadState, mergeMultiSourceState, migrateRuntimeState, reconcileNotifications, saveState, validateMultiSourceState, type MultiSourceRuntimeState, type RuntimeState } from "./runtime.js";
import { writeJsonAtomic } from "./pipeline.js";
import type { NormalizedEvent } from "./types.js";
import { discoverUdnPerformance, fetchUdnPerformance } from "./udn.js";
import { fetchTicketPlus } from "./ticketplus.js";
import { discoverCatalog, type CatalogState } from "./catalog.js";

async function loadBuildState(root: string): Promise<{ event: NormalizedEvent | null; state: RuntimeState }> {
  const statePath = resolve(root, "generated/runtime-state.json");
  try {
    await access(statePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const event = JSON.parse(await readFile(resolve(root, "fixtures/opentix-event.json"), "utf8")) as NormalizedEvent;
      return { event, state: applyPoll(emptyState(), { kind: "success", status: 200, observation: event }, new Date(event.observedAt)) };
    }
    throw error;
  }
  const state = await loadState(statePath);
  return { event: state.snapshot, state };
}

export async function build(root = process.cwd()): Promise<void> {
  const statePath = resolve(root, "generated/runtime-state.json");
  const { event, state } = await loadBuildState(root);
  let catalog: { opentix: CatalogState | null; udn: CatalogState | null } = { opentix: null, udn: null };
  try { catalog = JSON.parse(await readFile(resolve(root, "generated/catalog-state.json"), "utf8")) as typeof catalog; } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  let multi: MultiSourceRuntimeState;
  try {
    multi = JSON.parse(await readFile(resolve(root, "generated/multi-source-state.json"), "utf8")) as MultiSourceRuntimeState;
    if ((multi as unknown as { schemaVersion: number }).schemaVersion === 3) {
      const old = multi as unknown as { sources: { opentix: RuntimeState; udn: MultiSourceRuntimeState["sources"]["udn"] } };
      multi = { schemaVersion: 4, sources: { ...old.sources, ticketPlus: emptyTicketPlusState() } };
    }
    validateMultiSourceState(multi);
  } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") multi = migrateRuntimeState(state); else throw error; }
  await mkdir(resolve(root, "generated"), { recursive: true }); await mkdir(resolve(root, "public/data"), { recursive: true });
  await Promise.all([writeJsonAtomic(resolve(root, "generated/normalized-snapshot.json"), event), writeJsonAtomic(resolve(root, "generated/state.json"), state), writeJsonAtomic(resolve(root, "generated/history.json"), state.history), writeJsonAtomic(resolve(root, "generated/transitions.json"), state.transitions), writeJsonAtomic(resolve(root, "generated/multi-source-state.json"), multi), saveState(statePath, state)]); await renderLiveDashboard(root, event, state, multi.sources.udn, multi.sources.ticketPlus, catalog);
}
async function monitor(root = process.cwd()): Promise<void> {
  const statePath = resolve(root, "generated/runtime-state.json");
  let state: RuntimeState = await loadState(statePath);
  let multi: MultiSourceRuntimeState;
  try {
    multi = JSON.parse(await readFile(resolve(root, "generated/multi-source-state.json"), "utf8")) as MultiSourceRuntimeState;
    if ((multi as unknown as { schemaVersion: number }).schemaVersion === 3) {
      const old = multi as unknown as { sources: { opentix: RuntimeState; udn: MultiSourceRuntimeState["sources"]["udn"] } };
      multi = { schemaVersion: 4, sources: { ...old.sources, ticketPlus: emptyTicketPlusState() } };
    }
    validateMultiSourceState(multi);
  } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") multi = migrateRuntimeState(state); else throw error; }
  const now = new Date();
  let priorCatalog: { opentix: CatalogState | null; udn: CatalogState | null } = { opentix: null, udn: null };
  try { priorCatalog = JSON.parse(await readFile(resolve(root, "generated/catalog-state.json"), "utf8")) as typeof priorCatalog; } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (eligibleToPoll(state, now.getTime())) {
    const result = await fetchOpentix(undefined, { ...(state.cache.etag ? { etag: state.cache.etag } : {}), ...(state.cache.lastModified ? { lastModified: state.cache.lastModified } : {}), now });
    state = applyPoll(state, result, now, Number(process.env.AVAILABILITY_THRESHOLD ?? "1"));
    state = await reconcileNotifications(state, { ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}), ...(process.env.GITHUB_REPOSITORY ? { repository: process.env.GITHUB_REPOSITORY } : {}), issueNumber: Number(process.env.OPENTIX_ISSUE_NUMBER ?? "3") });
  }
  let udnResult: Awaited<ReturnType<typeof fetchUdnPerformance>>;
  try {
    const performanceUrl = process.env.UDN_PERFORMANCE_URL ?? await discoverUdnPerformance();
    udnResult = await fetchUdnPerformance(performanceUrl, { now });
  } catch (error) {
    udnResult = { kind: "failure", status: 0, errorCategory: error instanceof Error ? error.name === "AbortError" ? "timeout" : "discovery-failure" : "discovery-failure" };
  }
  multi.sources.opentix = state;
  multi.sources.udn = applyUdnPoll(multi.sources.udn ?? emptyUdnState(), udnResult, now);
  const ticketPlus = await fetchTicketPlus();
  multi.sources.ticketPlus = applyTicketPlusPoll(multi.sources.ticketPlus ?? emptyTicketPlusState(), ticketPlus, now);
  const discoveredOpentix = await discoverCatalog("opentix", { now });
  const discoveredUdn = await discoverCatalog("udn", { now });
  const catalog = {
    opentix: discoveredOpentix.completeness.health === "ok" && discoveredOpentix.events.length > 0 ? discoveredOpentix : priorCatalog.opentix,
    udn: discoveredUdn.completeness.health === "ok" && discoveredUdn.events.length > 0 ? discoveredUdn : priorCatalog.udn
  };
  try {
    const latest = JSON.parse(await readFile(resolve(root, "generated/multi-source-state.json"), "utf8")) as MultiSourceRuntimeState;
    validateMultiSourceState(latest);
    multi = mergeMultiSourceState(latest, multi);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  await saveState(statePath, state);
  await Promise.all([writeJsonAtomic(resolve(root, "generated/normalized-snapshot.json"), state.snapshot), writeJsonAtomic(resolve(root, "generated/state.json"), state), writeJsonAtomic(resolve(root, "generated/history.json"), state.history), writeJsonAtomic(resolve(root, "generated/transitions.json"), state.transitions), writeJsonAtomic(resolve(root, "generated/multi-source-state.json"), multi), writeJsonAtomic(resolve(root, "generated/catalog-state.json"), catalog)]);
  await renderLiveDashboard(root, state.snapshot, state, multi.sources.udn, multi.sources.ticketPlus, catalog);
}
const command = process.argv[2];
if (command === "build") await build(); else if (command === "monitor") await monitor(); else if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) { console.error("Usage: node dist/cli.js build|monitor"); process.exitCode = 2; }
