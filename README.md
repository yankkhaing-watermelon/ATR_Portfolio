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

### Phase 2 — complete

Cloudflare D1 portfolio foundation, opening portfolio import, protected BUY / SELL / cash transactions, cash ledger, watchlist, signal history and journal storage.

### Phase 3 — complete

Portfolio market-data sync for current Bursa holdings using raw daily OHLC data. Up to 260 daily sessions are stored in D1 with ATR14 and MA10/20/50/200. The weekday Cloudflare cron runs at 6:20 pm MYT.

### Phase 4 — ATR risk & sell-signal engine

The deployed Worker entry point is `worker/index-v4.js`. It extends the Phase 3 service without duplicating the portfolio and market-data implementation.

Risk rules (`atr-risk-v1`):

- automatic initial floor = average cost − 2 ATR14
- Watch = tracked peak − 1.5 ATR14, or a completed close below MA10
- Partial = tracked peak − 2 ATR14
- ATR trailing stop = tracked peak − 3 ATR14
- active sell stop = highest of manual hard stop, automatic initial floor and ATR trailing stop

The risk engine runs automatically after successful market-data synchronization and after the scheduled weekday refresh. It stores current risk levels on holdings, daily `risk_snapshots`, portfolio heat snapshots and state-change events in `signal_events`.

New Phase 4 APIs:

- `GET /api/risk`
- `POST /api/risk/run` — protected by `ADMIN_TOKEN`

The main PWA uses `public/app-v4.js`, and `/risk.html` provides a dedicated risk control console. Partial and Sell states are alerts only; the application does not place broker orders automatically.

## Core APIs

- `GET /api/health`
- `GET /api/state`
- `GET /api/portfolio`
- `GET /api/holdings`
- `GET /api/transactions`
- `GET /api/signals`
- `GET /api/market`
- `POST /api/market/sync`
- `POST /api/market/sync-one`
- `GET /api/risk`
- `POST /api/risk/run`

Protected writes require the Cloudflare `ADMIN_TOKEN` secret. The token is never embedded in GitHub or the PWA and is kept only in browser session storage after the user enters it.

## Local preview

Serve the `public` directory with any static web server. The service worker requires HTTP or HTTPS rather than opening `index.html` directly.
