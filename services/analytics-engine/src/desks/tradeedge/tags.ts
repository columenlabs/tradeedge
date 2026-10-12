/**
 * Sector and Basket (Bikram, 2026-10-09): two holdings fields that views show, group and filter by.
 * A sector belongs to a ticker (D1 `symbol_sectors`, one sealed document per person): every holding
 * of it, and every option on it, shows it. A basket is an Autopilot basket (2026-10-12): a holding
 * shows the basket whose sleeve in that account holds it (`autopilot.ts`). Every read and write is
 * scoped to the caller (`owner`).
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import { OwnerDoc, type Vault } from '../../vault';
import type { Autopilot } from './autopilot';
import { portfolioOwner } from './portfolio';

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

export interface HoldingTagSet {
  /** Ticker → sector. */
  sectors: Record<string, string>;
  /** The basket each account's holding sits in (its sleeve). */
  baskets: { symbol: string; portfolio_id: string | null; basket: string }[];
}

export class HoldingTags {
  private readonly sectors: OwnerDoc<HoldingTagSet['sectors']>;
  constructor(
    db: D1Like,
    vault: Vault,
    /** Baskets live in Autopilot (sleeves); without it holdings show none. */
    private readonly autopilot?: Autopilot,
  ) {
    this.sectors = new OwnerDoc(db, vault, 'symbol_sectors', () => ({}));
  }

  async list(owner: string): Promise<HoldingTagSet> {
    const [sectors, baskets] = await Promise.all([
      this.sectors.read(owner),
      this.autopilot ? this.autopilot.tags(owner) : Promise.resolve([]),
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
 * sectors here and baskets through `/api/baskets/assign`; agents use MCP `sector_write` and basket_*.
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
  return r;
}
