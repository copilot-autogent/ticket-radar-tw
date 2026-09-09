import { resolve } from "node:path";
import type { NormalizedEvent, TicketPlusRuntimeState } from "./types.js";
import type { RuntimeState, UdnRuntimeState } from "./runtime.js";
import type { CatalogEvent, CatalogState } from "./catalog.js";
import { writeJsonAtomic, writeTextAtomic } from "./pipeline.js";
import { renderReplayDemo } from "./replay.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function display(value: string | number | null | undefined): string { return value === null || value === undefined || value === "" ? "unknown" : escapeHtml(String(value)); }
function healthColor(category: string | undefined): string { return category === "ok" ? "#146c38" : category === "stale" ? "#9a6700" : category === "error" ? "#b42318" : "#667085"; }

function catalogMarkup(catalog: { opentix: CatalogState | null; udn: CatalogState | null }, watchedIds: string[]): string {
  const events: CatalogEvent[] = [...(catalog.opentix?.events ?? []), ...(catalog.udn?.events ?? [])];
  for (const watchedId of watchedIds) {
    if (events.some((event) => `${event.source}:${event.eventId}` === watchedId)) continue;
    const [source, eventId = ""] = watchedId.split(":");
    if (source !== "opentix" && source !== "udn") continue;
    events.push({ schemaVersion: 1, source: source as "opentix" | "udn", eventId, sourceUrl: source === "opentix" ? `https://www.opentix.life/event/${eventId}` : `https://tickets.udnfunlife.com/Application/UTK02/UTK0201_.aspx?PRODUCT_ID=${eventId}`, title: "Watched event (catalog not currently discovered)", category: "unknown", classificationReason: "unknown", classificationConfidence: "low", firstSeenAt: new Date(0).toISOString(), catalogFetchedAt: new Date(0).toISOString(), performances: [] });
  }
  const payload = JSON.stringify({ events, watchedIds }).replaceAll("<", "\\u003c");
  return `<section aria-labelledby="catalog-heading"><h2 id="catalog-heading">Event catalog</h2>
    <p>Discovery is informational; watched availability remains separate. OPENTIX: ${catalog.opentix?.completeness.eventCount ?? 0}; UDN: ${catalog.udn?.completeness.eventCount ?? 0}. Watch requests require GitHub sign-in plus maintainer manual validation and commit; clicking does not add a watch.</p>
    <nav class="catalog-views" aria-label="Catalog views">${["upcoming", "musicals", "concerts", "recent", "sale-soon", "watched"].map((view, index) => `<button type="button" data-view="${view}" aria-pressed="${index === 0 ? "true" : "false"}">${view === "sale-soon" ? "Sale opening soon" : view[0]!.toUpperCase() + view.slice(1)}</button>`).join("")}</nav>
    <form id="catalog-filters"><div class="filter-grid">
      <label for="catalog-search">Title or artist <input id="catalog-search" type="search" autocomplete="off"></label>
      <label for="catalog-platform">Platform <select id="catalog-platform"><option value="">All platforms</option><option value="opentix">OPENTIX</option><option value="udn">UDN</option></select></label>
      <label for="catalog-category">Category <select id="catalog-category"><option value="">All categories</option><option value="musical">Musical</option><option value="concert">Concert</option><option value="other">Other</option><option value="unknown">Unknown</option></select></label>
      <label for="catalog-city">City <select id="catalog-city"><option value="">All cities</option></select></label>
      <label for="catalog-from">Date from <input id="catalog-from" type="date"></label>
      <label for="catalog-to">Date to <input id="catalog-to" type="date"></label>
      <label for="catalog-max-price">Maximum price (TWD) <input id="catalog-max-price" type="number" min="0" inputmode="numeric"></label>
      <label class="check"><input id="catalog-unknown-price" type="checkbox"> Include unknown prices</label>
    </div><button type="reset" id="catalog-reset">Reset filters</button></form>
    <p id="catalog-count" role="status" aria-live="polite"></p><div class="catalog-results" id="catalog-results"></div>
    <script type="application/json" id="catalog-data">${payload}</script>
    <script>
      (() => {
        const data = JSON.parse(document.getElementById("catalog-data").textContent), state = { view: "upcoming" };
        const $ = (id) => document.getElementById(id), controls = ["catalog-search","catalog-platform","catalog-category","catalog-city","catalog-from","catalog-to","catalog-max-price","catalog-unknown-price"];
        const cities = [...new Set(data.events.flatMap((e) => [e.city, ...e.performances.map((p) => p.city)].filter(Boolean)))].sort((a,b) => a.localeCompare(b));
        cities.forEach((city) => { const option = document.createElement("option"); option.value = city; option.textContent = city; $("catalog-city").append(option); });
        const now = Date.now(), in14 = now + 14 * 86400000;
        const date = (v) => v ? Date.parse(v) : NaN;
        const esc = (value) => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
        function render() {
          const query = $("catalog-search").value.trim().toLocaleLowerCase(), max = Number($("catalog-max-price").value), includeUnknown = $("catalog-unknown-price").checked;
          const from = $("catalog-from").value ? Date.parse($("catalog-from").value + "T00:00:00+08:00") : -Infinity, to = $("catalog-to").value ? Date.parse($("catalog-to").value + "T23:59:59+08:00") : Infinity;
          const rows = data.events.filter((event) => {
            const performances = event.performances || [], dates = performances.map((p) => date(p.startsAt)).filter(Number.isFinite), saleStarts = performances.map((p) => date(p.saleStart)).filter(Number.isFinite);
            const text = (event.title + " " + (event.artist || "")).toLocaleLowerCase(), prices = performances.map((p) => p.minPrice).filter((p) => typeof p === "number");
            if (query && !text.includes(query) || $("catalog-platform").value && event.source !== $("catalog-platform").value || $("catalog-category").value && event.category !== $("catalog-category").value || $("catalog-city").value && ![event.city, ...performances.map((p) => p.city)].includes($("catalog-city").value)) return false;
            if (state.view === "upcoming" && !dates.some((d) => d >= now)) return false;
            if (state.view === "musicals" && event.category !== "musical" || state.view === "concerts" && event.category !== "concert") return false;
            if (state.view === "recent" && !(date(event.firstSeenAt) >= now - 14 * 86400000 && date(event.firstSeenAt) <= now)) return false;
            if (state.view === "sale-soon" && !saleStarts.some((d) => d > now && d <= in14)) return false;
            if (state.view === "watched" && !data.watchedIds.includes(event.source + ":" + event.eventId)) return false;
            if (!dates.some((d) => d >= from && d <= to) && (from !== -Infinity || to !== Infinity)) return false;
            if ($("catalog-max-price").value && !prices.some((p) => p <= max) && !(includeUnknown && performances.some((p) => p.minPrice == null || p.maxPrice == null))) return false;
            return true;
          }).sort((a,b) => {
            const ad = Math.min(...a.performances.map((p) => date(p.startsAt)).filter(Number.isFinite), Infinity), bd = Math.min(...b.performances.map((p) => date(p.startsAt)).filter(Number.isFinite), Infinity);
            return ad - bd || a.title.localeCompare(b.title) || (a.source + ":" + a.eventId).localeCompare(b.source + ":" + b.eventId);
          });
          $("catalog-count").textContent = rows.length + " events shown";
          $("catalog-results").innerHTML = rows.length ? "<table><caption>Catalog results</caption><thead><tr><th>Platform</th><th>Event</th><th>Category</th><th>Performances</th><th>Dates / prices</th><th>Watch</th></tr></thead><tbody>" + rows.map((e) => {
            const request = "https://github.com/copilot-autogent/ticket-radar-tw/issues/new?labels=watch-request&title=" + encodeURIComponent("Watch request: " + e.title) + "&body=" + encodeURIComponent("source=" + e.source + "\\neventId=" + e.eventId + "\\nurl=" + e.sourceUrl + "\\nManual maintainer validation and commit required.");
            return "<tr><td>" + esc(e.source) + "</td><td><a href='" + esc(e.sourceUrl) + "'>" + esc(e.title) + "</a></td><td>" + esc(e.category) + "</td><td>" + e.performances.length + "</td><td>" + (e.performances.length ? e.performances.map((p) => esc((p.startsAt || "date unknown") + " · " + (p.minPrice == null ? "price unknown" : p.maxPrice == null ? p.minPrice + "–unknown TWD" : p.minPrice + "–" + p.maxPrice + " TWD"))).join("<br>") : "Details incomplete") + "</td><td><a href='" + esc(request) + "'>Request watch</a></td></tr>";
          }).join("") + "</tbody></table>" : "<p>No events match these filters.</p>";
        }
        document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => { state.view = button.dataset.view; document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b === button))); render(); }));
        controls.forEach((id) => $(id).addEventListener("input", render)); $("catalog-filters").addEventListener("reset", () => setTimeout(render)); render();
      })();
    </script></section>`;
}

export async function renderLiveDashboard(root: string, event: NormalizedEvent | null, state: RuntimeState, udn: UdnRuntimeState | null = null, ticketPlus: TicketPlusRuntimeState | null = null, catalog: { opentix: CatalogState | null; udn: CatalogState | null } = { opentix: null, udn: null }): Promise<void> {
  const title = escapeHtml(event?.title ?? state.snapshot?.title ?? "OPENTIX monitor");
  const performances = event?.performances ?? state.snapshot?.performances ?? [];
  const rows = performances.map((item) => `<tr><td>${display(item.startsAt)}</td><td>${escapeHtml(item.lifecycle)}</td><td>${display(item.remaining)}</td><td>${display(item.price.min)}–${display(item.price.max)} TWD</td></tr>`).join("");
  const udnTiers = udn?.snapshot?.tiers ?? [];
  const udnRows = udnTiers.filter((tier) => tier.availability === "exact" && (tier.exactCount ?? 0) > 0 || tier.availability === "hot-selling-unknown")
    .map((tier) => `<tr><td>${escapeHtml(tier.label)}</td><td>${display(tier.priceTwd)} TWD</td><td>${escapeHtml(tier.availability === "hot-selling-unknown" ? "may be purchasable (hot-selling; not verified)" : "verified available")}</td><td>${display(tier.exactCount)}</td><td><a href="${escapeHtml(tier.sourceUrl)}">Official purchase page</a></td></tr>`).join("");
  const udnUnavailableRows = udnTiers.filter((tier) => !(tier.availability === "exact" && (tier.exactCount ?? 0) > 0 || tier.availability === "hot-selling-unknown"))
    .map((tier) => `<tr><td>${escapeHtml(tier.label)}</td><td>${display(tier.priceTwd)} TWD</td><td>${escapeHtml(tier.availability)}</td><td>${display(tier.exactCount)}</td><td><a href="${escapeHtml(tier.sourceUrl)}">Official page</a></td></tr>`).join("");
  const cheapest = udnTiers.filter((tier) => tier.availability === "exact" && (tier.exactCount ?? 0) > 0 && !/(access|companion|student|member|package|lottery|wheelchair|accessibility|身份|會員|陪同|套票|抽籤|輪椅|無障礙)/i.test(tier.label)).sort((a, b) => a.priceTwd - b.priceTwd)[0];
  const ordinaryRows = ticketPlus?.ordinary?.sessions.map((item) => `<tr><td>${escapeHtml(item.sessionId)}</td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.lifecycle)}</td><td>${display(item.saleStartAt)}</td><td>${display(item.saleEndAt)}</td></tr>`).join("") ?? "";
  const lotteryRows = ticketPlus?.lottery?.rounds.flatMap((round) => round.windows.map((window) => `<tr><td>${escapeHtml(round.roundId)}</td><td>${escapeHtml(window.kind)}</td><td>${display(window.startAt)}</td><td>${display(window.endAt)}</td><td>${escapeHtml(round.state)}</td></tr>`)).join("") ?? "";
  const ticketPlusUnsupported = Boolean(ticketPlus && !ticketPlus.ordinary && !ticketPlus.lottery && ticketPlus.health.error?.split(";").sort().join(";") === "lottery:http-403;ordinary:http-403");
  const ticketPlusNotice = ticketPlusUnsupported ? "<p><strong>Ticket Plus is unsupported from this public Actions host; retained lifecycle rows were quarantined after HTTP 403 responses. Lifecycle alerts are disabled until a fresh validated poll succeeds.</strong></p>" : "";
  const lotteryState = ticketPlus?.lottery?.currentState ?? (ticketPlusUnsupported ? "unsupported — no validated observation" : "unknown");
  const watchedIds = [state.snapshot?.eventId ? "opentix:" + state.snapshot.eventId : "", udn?.snapshot?.eventId ? "udn:" + udn.snapshot.eventId : ""].filter(Boolean);
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="/ticket-radar-tw/"><title>Ticket Radar TW — OPENTIX + UDN + Ticket Plus</title><style>:root{font-family:system-ui,sans-serif;color:#172033;background:#f5f7fb}body{margin:0}main{max-width:70rem;margin:auto;padding:1rem}header,section{background:#fff;border:1px solid #dce2ee;border-radius:.75rem;padding:1rem;margin-block:1rem}h1{font-size:clamp(1.5rem,5vw,2.5rem);margin:.2rem 0}a{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}th,td{border-bottom:1px solid #dce2ee;padding:.55rem;text-align:left;white-space:nowrap}.health{font-weight:700;color:${healthColor(state.health.category)}}.source-health{font-weight:700}.source-health.udn{color:${healthColor(udn?.health.category)}}.source-health.ticket-plus{color:${healthColor(ticketPlus?.health.category)}}.filter-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.7rem;margin-block:.8rem}.filter-grid label{display:flex;flex-direction:column;gap:.25rem}.filter-grid .check{flex-direction:row;align-items:center;margin-top:1.5rem}.catalog-views{display:flex;flex-wrap:wrap;gap:.4rem}.catalog-views button{padding:.45rem .65rem}.catalog-views button[aria-pressed=true]{font-weight:700;background:#d9e8ff}@media(max-width:40rem){main{padding:.6rem}header,section{margin-block:.6rem;padding:.8rem}.filter-grid{grid-template-columns:1fr}.filter-grid .check{margin-top:0}}</style></head><body><main><header><p class="health">OPENTIX health: ${escapeHtml(state.health.category)}</p><p class="source-health udn">UDN health: ${escapeHtml(udn?.health.category ?? "not-run")}</p><p class="source-health ticket-plus">Ticket Plus health: ${escapeHtml(ticketPlus?.health.category ?? "not-run")}</p><h1>${title}</h1><p>Public multi-source ticket availability</p></header><section><h2>Source freshness</h2><ul><li>OPENTIX last successful: ${display(state.lastSuccessfulAt)}</li><li>UDN last successful: ${display(udn?.lastSuccessfulAt)}</li><li>UDN error category: ${display(udn?.health.error)}</li><li>Ticket Plus last successful: ${display(ticketPlus?.lastSuccessfulAt)}</li><li>Ticket Plus error category: ${display(ticketPlus?.health.error)}</li></ul></section>${catalogMarkup(catalog, watchedIds)}<section><h2>OPENTIX performances</h2><p>Advertised price range; tier availability not published/verified.</p><table><thead><tr><th>Starts</th><th>Lifecycle</th><th>Remaining</th><th>Advertised price range</th></tr></thead><tbody>${rows || "<tr><td colspan=4>No validated observation; retained data is not available.</td></tr>"}</tbody></table></section><section><h2>UDN purchasable tiers · ${escapeHtml(udn?.snapshot?.title ?? "not observed")}</h2><p>Exact positive counts are verified available. Hot-selling is may be purchasable, not verified availability. ${cheapest ? `Cheapest unrestricted verified tier: ${escapeHtml(cheapest.label)} at ${display(cheapest.priceTwd)} TWD.` : "No unrestricted verified tier is currently known."}</p><label><input type="checkbox" id="show-unavailable"> Show unavailable/history tiers</label><table><thead><tr><th>Tier</th><th>Price</th><th>Availability</th><th>Exact count</th><th>Source</th></tr></thead><tbody id="udn-available-rows">${udnRows || "<tr><td colspan=5>No verified or may-be-purchasable tiers.</td></tr>"}</tbody><tbody id="udn-unavailable-rows" hidden>${udnUnavailableRows}</tbody></table></section><section><h2>Ticket Plus ordinary sale</h2>${ticketPlusNotice}<p>Machine status is shown verbatim; exact seat inventory is not monitored.</p><table><tbody>${ordinaryRows || "<tr><td>No validated ordinary observation.</td></tr>"}</tbody></table></section><section><h2>Ticket Plus lottery</h2>${ticketPlusNotice}<p>Current state: ${escapeHtml(lotteryState)}</p><table><tbody>${lotteryRows || "<tr><td>No validated lottery observation.</td></tr>"}</tbody></table></section>${renderReplayDemo()}</main><script>document.getElementById("show-unavailable")?.addEventListener("change",(event)=>{document.getElementById("udn-unavailable-rows").hidden=!(event.target).checked})</script></body></html>`;
  const browserSafeHtml = html
    .replace("<title>", "<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='24' font-size='24'%3E%F0%9F%8E%9F%3C/text%3E%3C/svg%3E\"><title>")
    .replace("body{margin:0}", "body{margin:0;overflow-x:hidden}")
    .replace("main{max-width:70rem;margin:auto;padding:1rem}", "main{max-width:70rem;margin:auto;padding:1rem;min-width:0}")
    .replace("header,section{background:#fff;border:1px solid #dce2ee;border-radius:.75rem;padding:1rem;margin-block:1rem}", "header,section{background:#fff;border:1px solid #dce2ee;border-radius:.75rem;padding:1rem;margin-block:1rem;min-width:0;overflow:hidden}")
    .replace("table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}", ".catalog-results,section>table{max-width:100%;min-width:0;overflow-x:auto}table{border-collapse:collapse;width:max-content;min-width:100%;display:table}");
  await writeTextAtomic(resolve(root, "public/index.html"), browserSafeHtml);
  await writeJsonAtomic(resolve(root, "public/data/dashboard.json"), { source: state.source, parserVersion: state.snapshot?.parserVersion ?? null, event: event ?? state.snapshot, health: state.health, history: state.history, lastAttemptAt: state.lastAttemptAt, lastSuccessfulAt: state.lastSuccessfulAt, retainedDataAt: state.retainedDataAt, transitions: state.transitions.slice(-20), sources: { opentix: { health: state.health, event: event ?? state.snapshot }, udn: udn ?? { health: { category: "not-run" }, snapshot: null }, ticketPlus: ticketPlus ?? { health: { category: "not-run" }, ordinary: null, lottery: null, pairings: [], conflicts: [] } } });
}
