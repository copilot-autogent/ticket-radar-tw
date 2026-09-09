# Ticket Radar TW

A narrow, public OPENTIX monitor for [C MUSICAL《我的遺願清單》](https://www.opentix.life/event/2054406826574860289).
The adapter reads only bounded public HTML/JSON-LD, never logs or persists upstream HTML, and never
logs in, reserves, purchases, bypasses a queue, or calls protected endpoints.

## Data and safety

`src/opentix.ts` normalizes the event, 25 performances, venue and `Asia/Taipei` timestamps, lifecycle,
TWD price range, remaining totals, source identity, and schema/parser versions. Missing or ambiguous
fields remain `unknown`/`null`; malformed, challenge, login, partial, oversized, or drifted pages fail
closed. `generated/runtime-state.json` is the durable authority and atomically retains the last valid
snapshot, bounded history, health/freshness, ETag/Last-Modified cache, transition outbox, and marker
ledger. The first valid poll is a baseline. Subsequent zero-to-positive, sale-open, new-performance,
and threshold transitions are deterministic and deduplicated.

The monitor enforces a 30-minute minimum interval, conditional requests, timeout handling, 429/5xx
retry classification, `Retry-After`, capped backoff, and retained stale data. GitHub issue notification
reconciliation is a safe no-op without a token and uses hidden deterministic markers when configured.

## Actions and dashboard

`.github/workflows/manual-monitor.yml` runs only on a 30-minute schedule or manual dispatch, shares a
non-cancelling concurrency group, uses least required `contents`/`issues` permissions, and commits
state with remote-head reconciliation. It never triggers on push. Pages renders the checked-in
normalized snapshot and clearly labels stale/error health, retained-data timestamps, freshness,
source URL, lifecycle, prices, remaining totals, and bounded transition history.

## Development

Requires Node 22. Run:

```sh
npm ci
npm test
npm run lint
npm run build
npm run test:coverage
```

`npm run monitor` performs one live public poll. `npm run build` regenerates the Pages artifact from the
validated committed runtime state; it uses the fixture only when that state is absent.

### Catalog discovery and presentation

Catalog discovery first reads official structured summaries, at most 20 summaries per page across five pages (100 summaries/source). It then enriches at most 20 prioritized events (watched, matching interests, sale-soon, then stable title order). Each row is explicitly marked `discovered-summary` or `detail-enriched`; completeness is `complete`, `truncated`, or `stale`, and source URL/parser provenance plus summary/detail, performance, price, and category coverage are retained.

Catalog state is merged non-destructively: a failed or partial refresh marks retained data stale instead of deleting the last validated summaries or details. UDN’s default view contains only exact-positive and clearly labelled hot-selling tiers; unavailable tiers are behind **Show unavailable tiers**, while the cheapest unrestricted exact-positive tier links to the official source. OPENTIX values are labelled **advertised price range** and never presented as purchasable tiers. The replay demonstration is isolated and performs no delivery or network operation.
