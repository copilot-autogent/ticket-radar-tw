# Ticket Radar TW

Fixture-backed scaffold for a low-maintenance Taiwan performance and ticket-availability radar.

## Runtime

The checked-in fixture at `fixtures/observations.json` is the authoritative input. `npm run build`
validates and normalizes it, then atomically writes bounded generated state to:

- `generated/normalized-snapshot.json`
- `generated/state.json`
- `generated/history.json`
- `generated/transitions.json`
- `public/index.html` and `public/data/dashboard.json`

The first observation is a baseline. A watched tier changing from `sold-out` or `zero` to
`available` emits one deterministic transition; an identical observation replay emits none.
Generated assets are checked in so CI can detect drift. Actions temporary files are never durable
state.

## Scope and ethics

This sprint has no live adapters, polling schedule, database, API server, notifications, login,
reservation, purchase, CAPTCHA bypass, queue bypass, or protected-seat scraping. Future adapters
must use public, respectful access and preserve source attribution and stable upstream identities.
Fixture strings are untrusted and escaped before rendering.

## Development

Requires Node 22. Run `npm ci`, then `npm run lint`, `npm run build`, and `npm run test:coverage`.
GitHub Pages is deployed from the `public` artifact by Actions under `/ticket-radar-tw/`.
