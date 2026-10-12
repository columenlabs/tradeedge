/**
 * The tradeedge part of the Worker: its sign-in, REST API, SnapTrade webhook, OAuth discovery and
 * MCP. Two entries mount it: `app.ts` (the EdgeDesk suite, on trade.edgedesk.app) and
 * `worker-trade.ts` (TradeEdge alone, the self-hosted copy). Nothing here imports another desk, so
 * the public `columenlabs/tradeedge` export builds from this folder and its shared files only.
 */
import { ClickHouseError } from '@edgedesk/clickhouse';
import { ProviderError } from '@edgedesk/providers';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { getPath } from 'hono/utils/url';
import { type AccessIdentity, AccessVerifier } from '../../access';
import type { Config } from '../../config';
import type { D1Like } from '../../d1';
import type { Feedback } from '../../feedback';
import { HistoryService, HistoryUnavailable } from '../../history';
import { LiveDataUnavailable, type MarketService } from '../../market';
import { mcpRoutes } from '../../mcp';
import { type RateLimiter, clientIp, rateLimited } from '../../ratelimit';
import { buildLlmsTxt, buildOpenApi } from '../../spec';
import { runWithStats, serverTiming } from '../../telemetry';
import { Vault } from '../../vault';
import { customViewRoutes } from '../../views/custom-views';
import { CustomViews } from '../../views/store';
import { apiRoutes } from './api';
import { Integrations, type SendNotice, integrationRoutes } from './integrations';
import { Logs, logRequests, logRoutes } from './logs';
import { Portfolios, portfolioRoutes } from './portfolio';
import { type PostArchive, Posts, postRoutes } from './posts';
import { Schedules, scheduleRoutes } from './schedules';
import { Screeners, screenerRoutes } from './screeners';
import { SnapTradeBrokers } from './snaptrade';
import { Strategies, StrategiesUnavailable, strategyRoutes } from './strategies';
import { SymbolFactsService, symbolRoutes } from './symbols';
import { HoldingTags, tagRoutes } from './tags';
import { Trades, tradeRoutes } from './trades';
import { Watchlist, watchlistRoutes } from './watchlist';
import { type AiBinding, PostTagger } from './x';

const VERSION = '0.1.0';

export type AppEnv = { Variables: { identity?: AccessIdentity } };
/**
 * Runtime-specific static serving (Bun: files on disk; Worker: Static Assets).
 * Registered after `/api` + `/mcp`, so it only sees everything else.
 */
export type MountStatic = (app: Hono<AppEnv>) => void;

export interface TradeedgeDeps {
  /** Override the /mcp Access verifier (tests). */
  accessVerifier?: AccessVerifier | null;
  /** Override the /api Access verifier (tests). */
  apiAccessVerifier?: AccessVerifier | null;
  limiters?: { api?: RateLimiter; mcp?: RateLimiter; waitlist?: RateLimiter };
  /** History (ClickHouse). Omitted → `/api/history/*` answers 503 and its MCP tools are hidden. */
  history?: HistoryService;
  /** Portfolios (D1). Omitted → `/api/portfolios` is not mounted and the MCP has no portfolio tools. */
  portfolios?: Portfolios;
  /**
   * Each person's SnapTrade and Alpaca keys (D1). Omitted → no `/api/integrations`, no SnapTrade
   * webhook, no integration_* tools, and live data always uses the Worker's own key.
   */
  integrations?: Integrations;
  /** Saved trades (D1). Omitted → `/api/trades` not mounted, no trade_* tools. */
  trades?: Trades;
  /** Strategies the screener builds (D1). Omitted → no `/api/strategies`, no strategy_* tools, no screener_run. */
  strategies?: Strategies;
  /** Saved screeners (D1). Omitted → no `/api/screeners`, no screener_* tools but screener_run. */
  screeners?: Screeners;
  /** Live-chain watchlist (D1). Omitted → `/api/watchlist` not mounted, no MCP tools. */
  watchlist?: Watchlist;
  /** The person's sectors and baskets (D1). Omitted → `/api/tags` not mounted, no MCP tools. */
  tags?: HoldingTags;
  /** Agent feedback (GitHub issues). Omitted → no feedback_* tools and no GitHub hook. */
  feedback?: Feedback;
  /** Saved CustomViewPage views (D1). Omitted → no `/api/custom-views` and no custom_view_* tools. */
  customViews?: CustomViews;
  /** Each person's activity log (D1). Omitted → no `/api/logs` and nothing is logged. */
  logs?: Logs;
  /** Posts from the X accounts each person tracks. Omitted → no `/api/posts` and no post_list. */
  posts?: Posts;
  /** Each person's schedules (D1). Omitted → no `/api/schedules`, and nothing runs on the cron. */
  schedules?: Schedules;
}

/**
 * The D1 stores. Every person's rows are sealed; without the master key their stores stay off,
 * unless `encryptionOptional` (the self-host entry): then rows are stored readable (src/vault.ts).
 * `vault` is returned for the entries that hand it on (researchedge in the suite).
 */
export function tradeedgeStores(
  cfg: Config,
  db: D1Like | undefined,
  market: MarketService,
  history?: HistoryService,
  encryptionOptional = false,
  /**
   * X posts: Workers AI tags symbols (`AI` binding); with DataEdge (the suite) posts go to its
   * `x_posts` dataset, else to D1.
   */
  x: { ai?: AiBinding; archive?: PostArchive } = {},
  /** Notification email (the suite's Email Service); omitted → no Email row. */
  mail?: SendNotice,
) {
  if (!db) return { vault: undefined };
  const strategies = new Strategies(db);
  const vault = cfg.vaultKek
    ? new Vault(db, cfg.vaultKek)
    : encryptionOptional
      ? new Vault(db, null)
      : undefined;
  if (!vault) return { vault, strategies };
  // Manual accounts are refused for brokers on SnapTrade's public list (Bikram, 2026-10-10).
  // History fills lot costs a broker left at 0 with that day's close (Bikram, 2026-10-11).
  // Splits split the lots bought before them (Bikram, 2026-10-11: KLAC 10:1 left sells unmatched).
  const portfolios = new Portfolios(db, vault, new SnapTradeBrokers().match, history, (s, from) =>
    market.splits(s, from),
  );
  const logs = new Logs(db, vault);
  const integrations = new Integrations(db, vault, portfolios, {
    hookOrigin: cfg.publicOrigin,
    portalReturn: `${tradeOrigin(cfg)}/app/?settings=accounts`,
    market,
    logs,
    mail,
    alpaca: {
      optionsFeed: cfg.live?.optionsFeed,
      stockFeed: cfg.live?.stockFeed,
      dataUrl: cfg.live?.dataUrl,
      tradingUrl: cfg.live?.tradingUrl,
    },
  });
  const posts = new Posts(db, vault, integrations, new PostTagger(x.ai), {
    archive: x.archive,
    logs,
  });
  const schedules = new Schedules(
    db,
    vault,
    {
      x_market: (owner, why) => posts.check(owner, why),
      x_outside: (owner, why) => posts.check(owner, why),
      posts_prune: (owner) => posts.prune(owner),
    },
    logs,
  );
  integrations.onXChange = (owner, connected) => schedules.setX(owner, connected);
  return {
    logs,
    vault,
    strategies,
    portfolios,
    integrations,
    posts,
    schedules,
    trades: new Trades(db, vault),
    screeners: new Screeners(db, strategies, vault),
    watchlist: new Watchlist(db, vault),
    tags: new HoldingTags(db, vault),
    customViews: new CustomViews(db, vault),
  };
}

/**
 * `/api/v1/*` (canonical, ADR-0002) and `/api/*` (alias for existing clients)
 * route identically: Hono's `getPath` maps the versioned prefix onto the
 * unversioned routes, so every middleware and route sees one path.
 */
export const routePath = (req: Request) => getPath(req).replace(/^\/api\/v1(?=\/|$)/, '/api');

/** Everything tradeedge answers; nothing else answers on its host. */
export const TRADE_PATHS = [
  '/app',
  '/docs',
  '/api',
  '/mcp',
  '/health',
  '/version',
  '/llms.txt',
  '/.well-known',
];
export const underPath = (path: string, base: string) =>
  path === base || path.startsWith(`${base}/`);

/** The tradeedge origin: `https://<tradeedgeHost>`. */
export const tradeOrigin = (cfg: Config) =>
  `${new URL(cfg.publicOrigin).protocol}//${cfg.tradeedgeHost}`;

/**
 * The Access check for the signed-in pages and /api. Without an Access verifier, local dev
 * enforces nothing and prod refuses (503).
 */
export function signIn(cfg: Config, deps: TradeedgeDeps) {
  const apiAccess =
    deps.apiAccessVerifier !== undefined
      ? deps.apiAccessVerifier
      : cfg.apiAccess
        ? new AccessVerifier(cfg.apiAccess)
        : null;
  const missing = cfg.env === 'prod' && apiAccess === null;
  const notConfigured = () => Response.json({ error: 'sign-in not configured' }, { status: 503 });
  const required = async (req: Request) => {
    if (missing) return notConfigured();
    return apiAccess &&
      !(await apiAccess.verify(req.headers.get('cf-access-jwt-assertion') ?? undefined))
      ? Response.json({ error: 'unauthorized: sign in' }, { status: 401 })
      : null;
  };
  return { apiAccess, missing, notConfigured, required };
}
export type SignIn = ReturnType<typeof signIn>;

/** Known failures map to their status; anything else is a 500 that never leaks its text. */
export function handleErrors(app: Hono<AppEnv>) {
  app.onError((err, c) => {
    if (err instanceof LiveDataUnavailable) return c.json({ error: err.message }, 503);
    if (err instanceof HistoryUnavailable) return c.json({ error: err.message }, 503);
    if (err instanceof StrategiesUnavailable) return c.json({ error: err.message }, 503);
    if (err instanceof ClickHouseError) {
      // Server text can name hosts/users: log it, never return it.
      console.error(err.message, err.detail);
      return c.json({ error: 'history unavailable' }, err.status === 503 ? 503 : 502);
    }
    if (err instanceof ProviderError) {
      return c.json({ error: err.message }, err.status === 429 ? 429 : 502);
    }
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });
}

/**
 * Per-request latency + cache telemetry for data routes: one JSON log line
 * (queryable in Workers Logs) and a Server-Timing header.
 */
export function requestTelemetry(app: Hono<AppEnv>) {
  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (!(path.startsWith('/api/') || path === '/mcp' || path.startsWith('/mcp/'))) return next();
    const route = path
      .replace(/^\/api\/(options|quotes|strategies)\/[^/]+/, '/api/$1/:symbol')
      .replace(/\/$/, '');
    const t0 = performance.now();
    await runWithStats(route, async (stats) => {
      await next();
      const ms = performance.now() - t0;
      if (!path.endsWith('/stream')) c.res.headers.set('server-timing', serverTiming(stats, ms));
      console.log(
        JSON.stringify({
          event: 'request',
          route: stats.route,
          method: c.req.method,
          rpc: stats.rpc,
          tool: stats.tool,
          status: c.res.status,
          ms: Math.round(ms),
          upstream_ms: Math.round(stats.upstreamMs),
          upstream_calls: stats.upstreamCalls,
          cache_memory_hits: stats.memoryHits,
          cache_shared_hits: stats.sharedHits,
          cache_misses: stats.misses,
        }),
      );
    });
  });
}

/** Descriptions, health and the /api gate (CORS, sign-in, rate limit). Mounted before any /api route. */
export function tradeedgeBase(app: Hono<AppEnv>, cfg: Config, deps: TradeedgeDeps, auth: SignIn) {
  const origin = tradeOrigin(cfg);
  // Generated descriptions (never drift from the registry).
  const openapi = JSON.stringify(buildOpenApi(origin));
  const llms = buildLlmsTxt(origin);
  app.get('/llms.txt', (c) =>
    c.body(llms, 200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, max-age=300',
    }),
  );

  app.get('/health', (c) => c.json({ ok: true, service: 'analytics-engine' }));
  app.get('/version', (c) =>
    c.json({
      service: 'analytics-engine',
      version: VERSION,
      commit: process.env.GIT_COMMIT ?? 'dev',
    }),
  );

  app.use(
    '/api/*',
    cors({
      origin: (o) => (o === origin || /^http:\/\/localhost:\d+$/.test(o) ? o : null),
    }),
  );
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    if (c.req.path.startsWith('/api/public/')) return next();
    if (auth.missing) return auth.notConfigured();
    let key = `ip:${clientIp((n) => c.req.header(n))}`;
    if (auth.apiAccess) {
      const who = await auth.apiAccess.verify(c.req.header('cf-access-jwt-assertion'));
      if (!who) return c.json({ error: 'unauthorized: sign in at /app' }, 401);
      key = `sub:${who.sub}`;
      c.set('identity', who);
    }
    const limited = await rateLimited(deps.limiters?.api, key);
    if (limited) return limited;
    await next();
  });
  app.get('/api/openapi.json', (c) =>
    c.body(openapi, 200, {
      'content-type': 'application/json',
      'cache-control': 'private, max-age=300',
    }),
  );
}

/** The SnapTrade webhook, the REST routes, OAuth discovery for /mcp and the MCP itself. */
export function tradeedgeRoutes(
  app: Hono<AppEnv>,
  cfg: Config,
  market: MarketService,
  deps: TradeedgeDeps,
  auth: SignIn,
) {
  const ctx = {
    history: deps.history ?? new HistoryService(null),
    strategies: deps.strategies,
    screeners: deps.screeners,
  };
  // Each person's SnapTrade webhook (Bikram, 2026-10-10), open like GitHub's: the id in the path finds
  // the person and SnapTrade's signature is checked with their key. The re-sync runs after the reply.
  // Logs (Bikram, 2026-10-11): ahead of TradeEdge's own routes only, so no other desk's traffic.
  if (deps.logs) {
    app.use('*', logRequests(deps.logs));
  }
  const integrations = deps.integrations;
  if (integrations) {
    // Open route: cap the body at 64 KB while it is read (Content-Length, or counted bytes when
    // streamed), so an oversized request is refused before it is buffered or its signature checked.
    const hookBodyLimit = bodyLimit({
      maxSize: 64_000,
      onError: (c) => c.json({ error: 'too large' }, 413),
    });
    app.post('/api/public/snaptrade-hook/:hookId', hookBodyLimit, async (c) => {
      const raw = await c.req.text();
      const r = await integrations.hook(
        c.req.param('hookId'),
        raw,
        c.req.header('signature') ?? null,
      );
      if (r.work) {
        const work = r.work.catch((err) => console.error('snaptrade hook sync', err));
        try {
          c.executionCtx.waitUntil(work);
        } catch {
          await work; // no execution context (local Bun): finish before replying
        }
      }
      if (r.status === 200) return c.json({ ok: true });
      return c.json({ error: r.status === 401 ? 'bad signature' : 'not found' }, r.status);
    });
  }
  if (deps.logs) app.route('/api/logs', logRoutes(deps.logs));
  if (deps.posts) app.route('/api/posts', postRoutes(deps.posts));
  if (deps.schedules) app.route('/api/schedules', scheduleRoutes(deps.schedules));
  if (deps.portfolios) app.route('/api/portfolios', portfolioRoutes(deps.portfolios));
  if (integrations) app.route('/api/integrations', integrationRoutes(integrations));
  if (deps.trades) app.route('/api/trades', tradeRoutes(deps.trades));
  if (deps.strategies) app.route('/api/strategies', strategyRoutes(deps.strategies));
  if (deps.screeners) app.route('/api/screeners', screenerRoutes(deps.screeners));
  if (deps.watchlist) app.route('/api/watchlist', watchlistRoutes(deps.watchlist));
  if (deps.tags) app.route('/api/tags', tagRoutes(deps.tags));
  if (deps.customViews) app.route('/api/custom-views', customViewRoutes(deps.customViews, 'trade'));
  // Symbol fields (Bikram, 2026-10-12): the person's Robinhood sign-in and DataEdge market data.
  const symbols = new SymbolFactsService(ctx.history, integrations);
  app.route('/api/symbols', symbolRoutes(symbols));
  app.route('/api', apiRoutes(market, ctx, integrations));
  const access =
    deps.accessVerifier !== undefined
      ? deps.accessVerifier
      : cfg.access
        ? new AccessVerifier(cfg.access)
        : null;
  // OAuth discovery for /mcp at the standard paths (RFC 9728, RFC 8414). Access serves these itself
  // only on hosts it guards whole; clients that skip the 401's resource_metadata hint would
  // otherwise get a 404.
  const accessIssuer = cfg.access ? `https://${cfg.access.teamDomain}` : null;
  if (accessIssuer) {
    const protectedResource = (c: Context<AppEnv>) =>
      c.json({
        resource: `${new URL(c.req.url).origin}/mcp`,
        authorization_servers: [accessIssuer],
      });
    app.get('/.well-known/oauth-protected-resource', protectedResource);
    app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);
    app.get('/.well-known/oauth-authorization-server', (c) => {
      const oauth = `${accessIssuer}/cdn-cgi/access/oauth`;
      return c.json({
        issuer: accessIssuer,
        authorization_endpoint: `${oauth}/authorization`,
        token_endpoint: `${oauth}/token`,
        revocation_endpoint: `${oauth}/revoke`,
        registration_endpoint: `${oauth}/registration`,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: [
          'client_secret_basic',
          'client_secret_post',
          'none',
        ],
        code_challenge_methods_supported: ['S256'],
      });
    });
  }
  if (cfg.env === 'prod' && access === null) app.use('/mcp/*', async () => auth.notConfigured());
  app.route(
    '/mcp',
    mcpRoutes(
      market,
      {
        token: cfg.mcpToken,
        access,
        limiter: deps.limiters?.mcp,
        portfolios: deps.portfolios,
        integrations,
        trades: deps.trades,
        watchlist: deps.watchlist,
        tags: deps.tags,
        feedback: deps.feedback,
        customViews: deps.customViews,
        symbols,
        posts: deps.posts,
      },
      ctx,
    ),
  );
}
