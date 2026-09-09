import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { renderLiveDashboard } from "./dashboard.js";
import { fetchOpentix } from "./opentix.js";
import { applyPoll, emptyState, eligibleToPoll, loadState, reconcileNotifications, saveState, type RuntimeState } from "./runtime.js";
import { writeJsonAtomic } from "./pipeline.js";
import type { NormalizedEvent } from "./types.js";

const root = process.cwd(); const statePath = resolve(root, "generated/runtime-state.json");
async function build(): Promise<void> {
  const event = JSON.parse(await readFile(resolve(root, "fixtures/opentix-event.json"), "utf8")) as NormalizedEvent; const state = applyPoll(emptyState(), { kind: "success", status: 200, observation: event }, new Date(event.observedAt));
  await mkdir(resolve(root, "generated"), { recursive: true }); await mkdir(resolve(root, "public/data"), { recursive: true });
  await Promise.all([writeJsonAtomic(resolve(root, "generated/normalized-snapshot.json"), event), writeJsonAtomic(resolve(root, "generated/state.json"), state), writeJsonAtomic(resolve(root, "generated/history.json"), state.history), writeJsonAtomic(resolve(root, "generated/transitions.json"), state.transitions), saveState(statePath, state)]); await renderLiveDashboard(root, event, state);
}
async function monitor(): Promise<void> {
  let state: RuntimeState = await loadState(statePath); const now = new Date(); if (!eligibleToPoll(state, now.getTime())) { await writeJsonAtomic(resolve(root, "generated/state.json"), state); await renderLiveDashboard(root, state.snapshot, state); return; }
  const result = await fetchOpentix(undefined, { ...(state.cache.etag ? { etag: state.cache.etag } : {}), ...(state.cache.lastModified ? { lastModified: state.cache.lastModified } : {}), now }); state = applyPoll(state, result, now, Number(process.env.AVAILABILITY_THRESHOLD ?? "1")); state = await reconcileNotifications(state, { ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}), ...(process.env.GITHUB_REPOSITORY ? { repository: process.env.GITHUB_REPOSITORY } : {}), issueNumber: Number(process.env.OPENTIX_ISSUE_NUMBER ?? "3") }); await saveState(statePath, state); await Promise.all([writeJsonAtomic(resolve(root, "generated/normalized-snapshot.json"), state.snapshot), writeJsonAtomic(resolve(root, "generated/state.json"), state), writeJsonAtomic(resolve(root, "generated/history.json"), state.history), writeJsonAtomic(resolve(root, "generated/transitions.json"), state.transitions)]); await renderLiveDashboard(root, state.snapshot, state);
}
if (process.argv[2] === "build") await build(); else if (process.argv[2] === "monitor") await monitor(); else { console.error("Usage: node dist/cli.js build|monitor"); process.exitCode = 2; }
