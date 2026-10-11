/**
 * Sector and Basket (Bikram, 2026-10-09): the two tags on holdings (D1 `symbol_sectors` and
 * `position_baskets`, one sealed document per person each, migration 0027). A sector belongs to a ticker: every holding of it, and every
 * option on it, shows it. A basket belongs to a holding: one account's position in a ticker or OCC
 * contract, or every account's at once. Both are holdings fields that views show, group and filter
 * by. Every read and write is scoped to the caller (`owner`).
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import { OwnerDoc, type Vault } from '../../vault';
import { portfolioIdSchema, portfolioOwner } from './portfolio';

const MAX_SYMBOLS = 500;

const symbolSchema = z
  .string()
  .regex(/^[A-Za-z^][A-Za-z0-9 .^/-]{0,30}$/, 'ticker or OCC symbol')
  .transform((s) => s.toUpperCase());
const tagValue = z.string().trim().min(1).max(60);

export const sectorWriteShape = {
  sectors: z
    .record(symbolSchema, tagValue.nullable())
    .refine((r) => Object.keys(r).length > 0 && Object.keys(r).length <= MAX_SYMBOLS, {
      message: `1 to ${MAX_SYMBOLS} tickers`,
    })
    .describe('Ticker → sector; null clears it. Example: {"TQQQ": "Technology", "GLDM": "Gold"}.'),
};

export const basketWriteShape = {
  basket: tagValue
    .nullable()
    .describe('The basket name, e.g. "9-sig"; null takes the symbols out of their basket.'),
  symbols: z
    .array(symbolSchema)
    .min(1)
    .max(MAX_SYMBOLS)
    .describe('Tickers, or OCC symbols for options, e.g. ["TQQQ", "GLDM"].'),
  portfolio_id: portfolioIdSchema
    .optional()
    .describe(
      'Only this account. Leave it out to set every account that holds the symbols (and any that ' +
        'buys them later); that also clears one-account baskets on them.',
    ),
};
const basketWriteSchema = z.object(basketWriteShape);
export type BasketWrite = z.infer<typeof basketWriteSchema>;

export interface HoldingTagSet {
  /** Ticker → sector. */
  sectors: Record<string, string>;
  /** Baskets by symbol; `portfolio_id` null means every account. */
  baskets: { symbol: string; portfolio_id: string | null; basket: string }[];
}

export class HoldingTags {
  private readonly sectors: OwnerDoc<HoldingTagSet['sectors']>;
  private readonly baskets: OwnerDoc<HoldingTagSet['baskets']>;
  constructor(db: D1Like, vault: Vault) {
    this.sectors = new OwnerDoc(db, vault, 'symbol_sectors', () => ({}));
    this.baskets = new OwnerDoc(db, vault, 'position_baskets', () => []);
  }

  async list(owner: string): Promise<HoldingTagSet> {
    const [sectors, baskets] = await Promise.all([
      this.sectors.read(owner),
      this.baskets.read(owner),
    ]);
    return { sectors, baskets };
  }

  async setSectors(owner: string, sectors: Record<string, string | null>) {
    await this.sectors.update(owner, (have) => {
      const next = { ...have };
      for (const [symbol, sector] of Object.entries(sectors)) {
        if (sector === null) delete next[symbol];
        else next[symbol] = sector;
      }
      return Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1)));
    });
    return this.list(owner);
  }

  async setBasket(owner: string, w: BasketWrite) {
    const one = w.portfolio_id ?? null;
    const symbols = new Set(w.symbols);
    await this.baskets.update(owner, (have) => {
      // Every account: its value replaces each account's own; one account: just that row.
      const kept = have.filter(
        (b) => !symbols.has(b.symbol) || (one !== null && b.portfolio_id !== one),
      );
      const added =
        w.basket === null
          ? []
          : w.symbols.map((symbol) => ({ symbol, portfolio_id: one, basket: w.basket as string }));
      return [...kept, ...added].sort((a, b) =>
        a.symbol !== b.symbol
          ? a.symbol < b.symbol
            ? -1
            : 1
          : (a.portfolio_id ?? '') < (b.portfolio_id ?? '')
            ? -1
            : 1,
      );
    });
    return this.list(owner);
  }
}

/** A position's sector (by its underlying) and basket (its account's own, else every account's). */
export function tagsOf(
  set: HoldingTagSet,
  p: { symbol: string; underlying: string; portfolio_id: string },
) {
  const own = set.baskets.find((b) => b.symbol === p.symbol && b.portfolio_id === p.portfolio_id);
  const all = set.baskets.find((b) => b.symbol === p.symbol && b.portfolio_id === null);
  return {
    sector: set.sectors[p.underlying] ?? null,
    basket: (own ?? all)?.basket ?? null,
  };
}

type Env = { Variables: { identity?: AccessIdentity } };

const invalid = (issues: z.ZodIssue[]) => ({
  error: 'invalid input',
  issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
});

/**
 * REST under `/api/tags` (signed in): the caller's sectors and baskets. The holdings table edits
 * them in place (Bikram, 2026-10-09); agents use MCP `sector_write` and `basket_write`.
 */
export function tagRoutes(tags: HoldingTags) {
  const r = new Hono<Env>();
  const owner = (c: Context<Env>) => portfolioOwner(c.get('identity'));
  r.get('/', async (c) => c.json(await tags.list(owner(c))));
  /** `{sectors: {TQQQ: "Technology", GLDM: null}}`; null clears one. */
  r.post('/sectors', async (c) => {
    const body = z.object(sectorWriteShape).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    return c.json(await tags.setSectors(owner(c), body.data.sectors));
  });
  /** `{basket: "9-sig", symbols: ["TQQQ"], portfolio_id?}`; basket null clears. */
  r.post('/baskets', async (c) => {
    const body = basketWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    return c.json(await tags.setBasket(owner(c), body.data));
  });
  return r;
}
