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

### Phase 2A — complete

Cloudflare D1 portfolio foundation with automatic schema initialization and live read APIs.

D1-backed records include holdings, transactions, cash ledger, watchlist, signal events, price/ATR snapshots, risk snapshots, portfolio snapshots, journal notes and settings.

Read APIs:

- `GET /api/health`
- `GET /api/state`
- `GET /api/portfolio`
- `GET /api/holdings`
- `GET /api/transactions`
- `GET /api/signals`
- `GET /api/market`

### Phase 2B — portfolio setup & transactions

`/manage.html` provides a protected management console for:

- opening cash setup
- importing existing portfolio positions without inventing historical trades
- recording BUY / SELL transactions
- recording deposits, withdrawals, dividends and adjustments
- reviewing the current D1 portfolio summary and recent activity

Protected writes require the Cloudflare `ADMIN_TOKEN` secret. The token is not embedded in the application or GitHub and is kept only in browser session storage after the user enters it in the management console.

The main portfolio interface does not fall back to fabricated demo holdings. An empty D1 portfolio is shown as an empty live portfolio.

## Local preview

Serve the `public` directory with any static web server. The service worker requires HTTP or HTTPS rather than opening `index.html` directly.
