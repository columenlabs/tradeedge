/**
 * Cloudflare Worker entry for TradeEdge alone: the self-hosted copy published as
 * `columenlabs/tradeedge` (see wrangler.trade.jsonc and export/tradeedge/). Same tradeedge
 * code as the suite (`desks/tradeedge/app.ts`), on whatever host it is installed at, with plain
 * Worker secrets instead of the Secrets Store. No history chains (no ClickHouse), no agent feedback.
 * Encryption is the installer's choice (Bikram, 2026-10-12): without VAULT_KEK rows are stored
 * readable; once a key is set, the first start seals them (src/vault.ts `sealPlainRows`).
 *
 *   /           opens the app (/app/)
 *   /app        the SPA, signed in
 *   /api/v1/*   REST + SSE (/api/* routes the same); /api/public/snaptrade-hook/:id is open
 *   /mcp        the TradeEdge MCP
 */
import { AlpacaClient } from '@edgedesk/providers';
import { type ExecutionContext, Hono } from 'hono';
import { loadConfig } from './config';
import type { D1Like } from './d1';
import {
  type AppEnv,
  TRADE_PATHS,
  handleErrors,
  requestTelemetry,
  routePath,
  signIn,
  tradeedgeBase,
  tradeedgeRoutes,
  tradeedgeStores,
  underPath,
} from './desks/tradeedge/app';
import type { Schedules } from './desks/tradeedge/schedules';
import type { AiBinding } from './desks/tradeedge/x';
import { MarketService } from './market';
import type { RateLimiter } from './ratelimit';
import { cacheApi } from './shared-cache';
import { type AssetsFetcher, siteStatic } from './static-worker';
import { sealPlainRows } from './vault';

type Env = Record<string, string | AssetsFetcher | RateLimiter | D1Like | AiBinding | undefined> & {
  ASSETS: AssetsFetcher;
  DB?: D1Like;
  /** Workers AI: tags X posts with their symbols. */
  AI?: AiBinding;
  API_RATE_LIMITER?: RateLimiter;
  MCP_RATE_LIMITER?: RateLimiter;
};

let appPromise: Promise<Hono<AppEnv> & { schedules?: Schedules }> | undefined;

async function createTradeApp(env: Env) {
  const vars: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') vars[k] = v;
  const cfg = loadConfig(vars);
  const edgeCache = (globalThis as { caches?: { default: Parameters<typeof cacheApi>[0] } }).caches
    ?.default;
  const market = new MarketService(
    cfg.live ? new AlpacaClient(cfg.live) : null,
    cfg.liveCacheTtlMs,
    Date.now,
    edgeCache ? cacheApi(edgeCache) : undefined,
  );
  const deps = {
    limiters: { api: env.API_RATE_LIMITER, mcp: env.MCP_RATE_LIMITER },
    // No DataEdge here: X posts stay in D1, sealed, 30 days.
    ...tradeedgeStores(cfg, env.DB, market, undefined, true, { ai: env.AI }),
  };
  if (env.DB && deps.vault) await sealPlainRows(env.DB, deps.vault);

  const app = new Hono<AppEnv>({ getPath: routePath });
  handleErrors(app);
  const auth = signIn(cfg, deps);
  // Only tradeedge answers, all signed in (/api and /mcp check their own).
  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (path === '/') return c.redirect('/app/', 302);
    if (
      underPath(path, '/api/admin') ||
      (underPath(path, '/api/public') && !underPath(path, '/api/public/snaptrade-hook')) ||
      !TRADE_PATHS.some((p) => underPath(path, p))
    ) {
      return c.json({ error: 'not found' }, 404);
    }
    if (!['/api', '/mcp', '/.well-known'].some((p) => underPath(path, p))) {
      const refused = await auth.required(c.req.raw);
      if (refused) return refused;
    }
    return next();
  });
  requestTelemetry(app);
  tradeedgeBase(app, cfg, deps, auth);
  tradeedgeRoutes(app, cfg, market, deps, auth);
  const site = new Hono<AppEnv>();
  siteStatic(env.ASSETS)(site);
  site.notFound((c) => c.json({ error: 'not found' }, 404));
  app.all('*', (c) => site.fetch(c.req.raw));
  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return Object.assign(app, { schedules: deps.schedules });
}

function getApp(env: Env) {
  appPromise ??= createTradeApp(env);
  // Don't pin a failed init for the isolate's lifetime.
  appPromise.catch(() => {
    appPromise = undefined;
  });
  return appPromise;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The context lets a route finish work after its reply (SnapTrade's webhook re-sync).
    return (await getApp(env)).fetch(req, undefined, ctx);
  },
  /** Cron Trigger, every minute: runs each person's due schedules (Check X, Prune old posts). */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const app = await getApp(env);
    if (app.schedules) ctx.waitUntil(app.schedules.runDue());
  },
};
