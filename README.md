# TradeEdge

Options trading on live data, on your own Cloudflare account, built for AI agents.

- **Screeners:** build any options strategy (iron condor, jade lizard, your own) on the live chain and rank real trades.
- **Trades board:** save trades, compare their payoff curves, track them.
- **Holdings:** sync your brokers through your own free SnapTrade key, or keep a manual account for a broker SnapTrade can't reach.
- **MCP:** every screen is also a tool, so an agent (Claude, ChatGPT, any MCP client) can screen, compare and save trades for you at `/mcp`.

[TradeEdge](https://edgedesk.app/trade/) is one app of the [EdgeDesk](https://edgedesk.app) suite. This repository is a read-only copy of it, published from EdgeDesk with each release; pull requests are not merged here.

## Install

The easy way is [Appflare](https://appflare.dev): install TradeEdge from its catalog into your own Cloudflare account. Appflare creates the database, generates the encryption key, puts the app behind Cloudflare Access sign-in and keeps it updated.

You need:

- A Cloudflare account (the Workers free plan is enough) with a Zero Trust organization, for sign-in.
- A free [Alpaca](https://alpaca.markets) API key, for live quotes and option chains.
- Optional: a [SnapTrade](https://snaptrade.com) Personal key, to sync your broker accounts. It's free, covers up to 5 brokers and includes tax lots for eligible brokers. Placing trades through SnapTrade, for eligible accounts, is in progress and coming soon. Add the key in the app under Settings ▸ Integrations.

## What a self-hosted copy has

| | |
|---|---|
| App, REST API (`/api/v1`), MCP (`/mcp`) | yes |
| Sign-in | Cloudflare Access, in front of the whole app |
| Your data | in your own D1 database; encrypted per person only if you set `VAULT_KEK` (off by default) |
| Live quotes and chains | your Alpaca key |
| Broker holdings and tax lots | your SnapTrade Personal key (free, up to 5 brokers; tax lots for eligible brokers) |
| Historical option chains | no (`/api/v1/history/*` answers 503) |

## Deploy by hand

```bash
bun install
cd services/analytics-engine
wrangler d1 create tradeedge          # put the id in wrangler.jsonc under d1_databases
wrangler d1 migrations apply tradeedge --remote
wrangler secret put VAULT_KEK           # optional, turns encryption on: openssl rand -base64 32
wrangler secret put ALPACA_API_KEY_ID
wrangler secret put ALPACA_API_SECRET_KEY
wrangler deploy                         # builds the app first (scripts/assemble-trade-assets.sh)
```

Then put the Worker behind a Cloudflare Access application and set these vars (dashboard or `wrangler.jsonc`):

| Var | Value |
|---|---|
| `PUBLIC_ORIGIN` | the app's address, e.g. `https://tradeedge.example.workers.dev` |
| `TRADEEDGE_HOST` | the same, without `https://` |
| `ACCESS_TEAM_DOMAIN` | your Zero Trust team domain, e.g. `example.cloudflareaccess.com` |
| `ACCESS_AUD`, `ACCESS_APP_AUD` | the Access application's audience (AUD) tag |

Until the Access vars are set, every signed-in route answers 503. Leave `/api/public/snaptrade-hook/*` outside Access so SnapTrade's webhook reaches it (it checks SnapTrade's signature).

### Encryption (your choice)

- **Off** (no `VAULT_KEK`, the default): rows are stored readable in your D1, including your SnapTrade, Alpaca and Robinhood keys.
- **On** (`VAULT_KEK` set): every person's rows, keys included, are encrypted, so reading D1 shows nothing useful.
- Turning it on later: set `VAULT_KEK` and redeploy. On its first start the app encrypts every existing row once. There is no way to turn it back off.

Keep a copy of `VAULT_KEK`: without it the data in D1 can't be read.

## License

MIT, see [LICENSE](LICENSE).
