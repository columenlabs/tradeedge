import { parseOccSymbol } from '@edgedesk/providers';
import { REFRESH_HEADER } from '@edgedesk/types';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { ChainParams, MarketService } from '../../market';
import { OPERATIONS, type OpContext } from '../../operations';
import { LegNotFound } from '../../screener';
import { parseExpiration, parseNum, parseSymbol, parseType } from '../../validate';
import type { Integrations } from './integrations';
import { portfolioOwner } from './portfolio';
import { ScreenerInvalid, ScreenerNotFound } from './screeners';
import { StrategyNotFound } from './strategies';

type ChainQueryResult = { ok: true; params: ChainParams } | { ok: false; error: string };

function chainParams(
  underlying: string | undefined,
  q: (k: string) => string | undefined,
): ChainQueryResult {
  const sym = parseSymbol(underlying);
  if (!sym) return { ok: false, error: 'invalid underlying' };
  const expiration = parseExpiration(q('expiration'));
  if (expiration === null) return { ok: false, error: 'invalid expiration (YYYYMMDD)' };
  const type = parseType(q('type'));
  if (type === null) return { ok: false, error: 'invalid type (call|put)' };
  const minDte = parseNum(q('min_dte'));
  if (minDte === null) return { ok: false, error: 'invalid min_dte' };
  const strikeGte = parseNum(q('strike_min'));
  const strikeLte = parseNum(q('strike_max'));
  if (strikeGte === null || strikeLte === null) return { ok: false, error: 'invalid strike range' };
  return { ok: true, params: { underlying: sym, expiration, minDte, type, strikeGte, strikeLte } };
}

/** Live data uses the caller's own Alpaca key when they set one in Settings ▸ Integrations. */
export function apiRoutes(market: MarketService, ctx: OpContext, integrations?: Integrations) {
  const api = new Hono<{ Variables: { identity?: AccessIdentity } }>();
  const marketOf = (c: { get(k: 'identity'): AccessIdentity | undefined }) =>
    integrations
      ? integrations.marketFor(portfolioOwner(c.get('identity')))
      : Promise.resolve(market);

  api.get('/health', (c) =>
    c.json({ ok: true, live: market.available, history: ctx.history.available }),
  );

  /** ClickHouse round-trip (uncached). 503 when configured but unreachable. REST only. */
  api.get('/history/health', async (c) => {
    const h = await ctx.history.health();
    return c.json(h, h.ok || !h.configured ? 200 : 503);
  });

  /** Latest quotes for many symbols in one request (Holdings), `?symbols=A,B,...`: tickers, or OCC
   *  symbols for option contracts. A fund the feed has no quote for (ARKVX) gets its daily NAV from
   *  ClickHouse.
   *  A symbol that is not a valid ticker or OCC symbol comes back null and the rest still price. A
   *  symbol whose quote fails keeps its last price and is listed in `stale` (null when there never
   *  was one). The AppShell's Refresh header (`REFRESH_HEADER`) skips the quote cache. REST only. */
  api.get('/quotes', async (c) => {
    const raw = [...new Set((c.req.query('symbols') ?? '').split(',').filter(Boolean))];
    if (raw.length === 0 || raw.length > 200) {
      return c.json({ error: 'symbols: 1 to 200 comma-separated tickers or OCC symbols' }, 400);
    }
    const parsed = raw.map((s) => ({ raw: s, symbol: parseOccSymbol(s) ? s : parseSymbol(s) }));
    const symbols = [...new Set(parsed.flatMap((p) => (p.symbol ? [p.symbol] : [])))];
    const fresh = Boolean(c.req.header(REFRESH_HEADER));
    const live = await marketOf(c);
    const out = symbols.length
      ? await live.quotes(symbols, fresh, (t) => ctx.history.fundNavs(t))
      : { quotes: {}, stale: [] };
    for (const p of parsed) if (!p.symbol) out.quotes[p.raw] = null;
    return c.json(out);
  });

  /** Server-sent events: pushes the chain every `interval` seconds (2–60). */
  api.get('/options/:underlying/stream', async (c) => {
    const r = chainParams(c.req.param('underlying'), (k) => c.req.query(k));
    if (!r.ok) return c.json({ error: r.error }, 400);
    const params = r.params;
    const live = await marketOf(c);
    const interval = Math.min(60, Math.max(2, Number(c.req.query('interval') ?? 3) || 3)) * 1000;

    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      let id = 0;
      while (open) {
        try {
          const chain = await live.chain(params);
          // Pin the expiration after the first push so "nearest" doesn't roll mid-stream.
          params.expiration ??= chain.quotes[0]?.expiration;
          await stream.writeSSE({ event: 'chain', id: String(id++), data: JSON.stringify(chain) });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'stream error';
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: message }) });
        }
        await stream.sleep(interval);
      }
    });
  });

  // Every registry operation (operations.ts) as a REST route: path params + query (GET) or JSON body
  // (POST), validated with the same zod schema the MCP tool uses.
  for (const op of OPERATIONS) {
    const schema = z.object(op.input);
    api.on(op.method, op.path, async (c) => {
      let raw: Record<string, unknown> = {};
      if (op.method === 'GET') raw = { ...c.req.query() };
      else {
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return c.json(
            {
              error: 'invalid input',
              issues: [{ path: '', message: 'JSON object body required' }],
            },
            400,
          );
        }
        raw = body as Record<string, unknown>;
      }
      for (const p of op.pathParams) raw[p] = c.req.param(p);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          {
            error: 'invalid input',
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          400,
        );
      }
      try {
        const opCtx: OpContext = { ...ctx, owner: portfolioOwner(c.get('identity')) };
        return c.json(
          await op.run(await marketOf(c), parsed.data as Record<string, unknown>, opCtx),
        );
      } catch (err) {
        if (
          err instanceof LegNotFound ||
          err instanceof StrategyNotFound ||
          err instanceof ScreenerInvalid
        )
          return c.json({ error: err.message }, 400);
        if (err instanceof ScreenerNotFound) return c.json({ error: err.message }, 404);
        throw err;
      }
    });
  }

  return api;
}
