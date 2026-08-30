# ATR Portfolio PWA

Mobile-first Bursa Malaysia portfolio, ATR risk and sell-signal terminal.

## Cloudflare Workers Builds

- Project name: `atr-portfolio`
- Production branch: `main`
- Build command: leave blank
- Deploy command: `npx wrangler deploy`
- Root path: `/`

Static assets are configured in `wrangler.jsonc`. Phase 1 provides the installable PWA interface. Phase 2 adds the Worker API, Cloudflare D1 binding, database migration, and D1-backed portfolio state.

## Local preview

Serve the `public` directory with any static web server. The service worker requires HTTP or HTTPS rather than opening `index.html` directly.
