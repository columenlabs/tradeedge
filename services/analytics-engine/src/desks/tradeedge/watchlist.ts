/**
 * Watchlist: the underlyings whose live chain the person follows (D1 `watchlist`, one sealed document per person, migration 0027).
 * Adding a symbol twice is a no-op; every read and write is scoped to the caller (`owner`).
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import { OwnerDoc, type Vault } from '../../vault';
import { portfolioOwner } from './portfolio';

const MAX_SYMBOLS = 100;

export const watchSymbolSchema = z
  .string()
  .regex(/^[A-Za-z^][A-Za-z0-9.^/-]{0,14}$/, 'ticker')
  .transform((s) => s.toUpperCase());

export interface WatchItem {
  symbol: string;
  added_at: string;
}

export class WatchlistFull extends Error {
  constructor() {
    super(`at most ${MAX_SYMBOLS} symbols on the watchlist`);
  }
}

export class Watchlist {
  private readonly doc: OwnerDoc<WatchItem[]>;
  constructor(db: D1Like, vault: Vault) {
    this.doc = new OwnerDoc(db, vault, 'watchlist', () => []);
  }

  async list(owner: string): Promise<WatchItem[]> {
    return this.doc.read(owner);
  }

  /** Adds symbols that aren't on the list yet; returns the whole list. */
  async add(owner: string, symbols: string[]): Promise<WatchItem[]> {
    return this.doc.update(owner, (list) => {
      const have = new Set(list.map((w) => w.symbol));
      const fresh = [...new Set(symbols)].filter((s) => !have.has(s));
      if (have.size + fresh.length > MAX_SYMBOLS) throw new WatchlistFull();
      const now = new Date().toISOString();
      return [...list, ...fresh.map((symbol) => ({ symbol, added_at: now }))];
    });
  }

  async remove(owner: string, symbol: string): Promise<WatchItem[]> {
    return this.doc.update(owner, (list) => list.filter((w) => w.symbol !== symbol));
  }
}

type Env = { Variables: { identity?: AccessIdentity } };

/** REST under `/api/watchlist` (signed in). */
export function watchlistRoutes(watchlist: Watchlist) {
  const r = new Hono<Env>();
  const owner = (c: Context<Env>) => portfolioOwner(c.get('identity'));
  r.onError((err, c) => {
    if (err instanceof WatchlistFull) return c.json({ error: err.message }, 400);
    throw err;
  });
  r.get('/', async (c) => c.json(await watchlist.list(owner(c))));
  r.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({ symbols: z.array(watchSymbolSchema).min(1).max(MAX_SYMBOLS) })
      .safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid input',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    return c.json(await watchlist.add(owner(c), parsed.data.symbols));
  });
  r.delete('/:symbol', async (c) => {
    const symbol = watchSymbolSchema.safeParse(c.req.param('symbol'));
    if (!symbol.success) return c.json({ error: 'not on the watchlist' }, 404);
    return c.json(await watchlist.remove(owner(c), symbol.data));
  });
  return r;
}
