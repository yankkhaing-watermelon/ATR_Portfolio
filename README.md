# ATR Portfolio PWA

Mobile-first Bursa Malaysia portfolio, ATR risk and sell-signal terminal.

## Cloudflare Workers Builds

- Project name: `atr-portfolio`
- Production branch: `main`
- Build command: leave blank
- Deploy command: `npx wrangler deploy`
- Root path: `/`

Static assets are configured in `wrangler.jsonc`.

## Phase status

### Phase 1 — complete

Installable PWA shell, responsive Bursa MusangKing interface, navigation, light/dark theme and Cloudflare Worker asset deployment.

### Phase 2 — D1 portfolio foundation

The Worker now self-initializes the D1 schema on first API access, so a separate manual migration command is not required for the deployed Worker.

D1-backed records include:

- holdings
- transactions
- cash ledger
- watchlist
- signal events
- price snapshots with ATR14 and moving averages
- risk snapshots
- portfolio snapshots
- journal notes
- settings

Read APIs:

- `GET /api/health`
- `GET /api/state`
- `GET /api/portfolio`
- `GET /api/holdings`
- `GET /api/transactions`
- `GET /api/signals`
- `GET /api/market`

Protected write APIs remain disabled unless the optional Cloudflare `ADMIN_TOKEN` secret is configured. The browser never embeds an admin secret.

The Phase 2 interface no longer falls back to fabricated demo holdings. An empty D1 portfolio is shown as an empty live portfolio.

## Local preview

Serve the `public` directory with any static web server. The service worker requires HTTP or HTTPS rather than opening `index.html` directly.
