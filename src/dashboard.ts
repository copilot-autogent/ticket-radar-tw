import { resolve } from "node:path";
import type { Fixture, PipelineOutput } from "./types.js";
import { writeJsonAtomic, writeTextAtomic } from "./pipeline.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export async function renderDashboard(root: string, fixture: Fixture, output: PipelineOutput): Promise<void> {
  const path = resolve(root, "public/index.html");
  const transition = output.transitions[0];
  const marker = transition?.idempotencyKey ?? "no-transition";
  const title = escapeHtml(fixture.event.title);
  const transitionText = transition
    ? `${escapeHtml(transition.tierId)} changed from ${escapeHtml(transition.from)} to ${escapeHtml(transition.to)}`
    : "No new transitions";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<base href="/ticket-radar-tw/"><title>Ticket Radar TW</title><style>
:root{font-family:system-ui,sans-serif;color:#172033;background:#f5f7fb}body{margin:0}main{max-width: seventyrem;max-width:70rem;margin:auto;padding:1rem}header,section{background:#fff;border:1px solid #dce2ee;border-radius:.75rem;padding:1rem;margin-block:1rem}h1{font-size:clamp(1.6rem,5vw,2.5rem);margin:.2rem 0}.badge{display:inline-block;background:#dff7e8;color:#146c38;border-radius:99px;padding:.3rem .65rem;font-weight:700}ul{padding-left:1.2rem}li{margin:.7rem 0;overflow-wrap:anywhere}@media(max-width:40rem){main{padding:.6rem}header,section{margin-block:.6rem;padding:.8rem}}
</style></head><body><main><header><p class="badge">Fixture-backed monitor</p><h1>Ticket Radar TW</h1><p>Normalized public performance availability for Taiwan.</p></header>
<section aria-labelledby="event"><h2 id="event">${title}</h2><p>Deterministic transition evidence from the checked-in fixture.</p>
<ul><li data-transition-marker="${escapeHtml(marker)}">${transitionText}</li></ul></section>
<section><h2>Scope</h2><p>No live adapters, purchasing, reservation, login, CAPTCHA bypass, or queue bypass are included in this scaffold.</p></section>
</main></body></html>`;
  await writeTextAtomic(path, html);
  await writeJsonAtomic(resolve(root, "public/data/dashboard.json"), { fixture: fixture.event, transitions: output.transitions });
}
