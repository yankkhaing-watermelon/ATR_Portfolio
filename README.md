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

### Phase 2B — complete

`/manage.html` provides a protected management console for opening cash, existing-position imports, BUY/SELL transactions, deposits, withdrawals, dividends and adjustments.

Protected writes require the Cloudflare `ADMIN_TOKEN` secret. The token is not embedded in the application or GitHub and is kept only in browser session storage after the user enters it in the management console.

### Phase 3 — Bursa market-data engine

Phase 3 synchronizes market data only for counters currently held in the portfolio.

- Raw daily OHLC is used consistently for valuation and indicators.
- Yahoo Finance Bursa symbols (`CODE.KL`) are the Phase 3 provider.
- Up to 260 recent sessions are stored in D1.
- ATR14 uses Wilder smoothing.
- MA10, MA20, MA50 and MA200 are calculated from raw closes.
- Current portfolio prices and MA10 are refreshed from the latest stored daily bar.
- Portfolio value and equity are recalculated after each sync.
- Manual sync: `POST /api/market/sync` with `Authorization: Bearer ADMIN_TOKEN`.
- Single-counter sync: `POST /api/market/sync-one`.
- Automatic Cloudflare Cron sync: weekdays at `10:20 UTC` (`18:20 MYT`).
- `/manage.html` includes a Phase 3 market-data control panel and per-counter sync results.

The main portfolio interface does not fall back to fabricated demo holdings.

## Local preview

Serve the `public` directory with any static web server. The service worker requires HTTP or HTTPS rather than opening `index.html` directly.
