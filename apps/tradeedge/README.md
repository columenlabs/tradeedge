# tradeedge

tradeedge, served at `https://trade.edgedesk.app/app`.

- **Framework**: Vite + React SPA (`base: /app/`), TanStack Router (`basepath: /app`) + Query + Table, shadcn/ui on Tailwind v4, Recharts via shadcn Chart. Built to `dist/`, copied into the Worker's static assets by `scripts/assemble-assets.sh`.
- **Pages**: `/strategy` strategy builder, `/chain` live chain + IV smile, `/coverage` ClickHouse data coverage, `/coverage/:underlying/:date` a stored day's chain.
- **Data**: same-origin `/api` — REST + SSE (`/api/options/:underlying/stream`). Coverage reads `/api/history/*` and falls back to labelled sample data while those routes return 404.
- **Design**: light by default with a dark toggle; density compact / default / comfortable (`data-density` on `<html>`). Tokens live in `src/index.css` (see `DESIGN.md`). `src/components/ui` is shadcn CLI output — add components with `bunx shadcn@latest add <name> -c apps/tradeedge`, don't hand-edit.
- **Pricing**: `src/lib/bs.ts` (Black-Scholes) and `src/lib/strategy.ts` (payoff, breakevens, PoP, greeks), unit-tested.

## Dev

```bash
bun --filter=@edgedesk/analytics-engine dev   # :8080 (needs provider credentials for live data)
bun --filter=tradeedge dev                   # :3000/app/ — proxies /api to $API_ORIGIN (default :8080)
```

Against a preview version behind Access, load the repo-root `.env` (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`, service token `edgedesk-preview-uat`) and point the proxy at it:

```bash
set -a; source ../../.env; set +a
API_ORIGIN=https://<alias>-edgedesk.columenapps.workers.dev bun run dev
```

Upload a preview version (never takes Prod traffic). The Worker re-verifies the Access JWT against `ACCESS_APP_AUD`, so previews override it with the audience of the preview Access app `edgedesk - Cloudflare Workers`:

```bash
cd services/analytics-engine && bun run assets
bunx wrangler versions upload --preview-alias <alias> \
  --var ACCESS_APP_AUD:83c26dc282225c92a9092cb467802703939cfd417eb9ea926b73984ba857778c
```
