/**
 * Trades: positions an agent (through the TradeEdge MCP) or the person builds and keeps to compare on
 * the board (D1 `trades`, sealed, migration 0027). Legs use the trade_evaluate leg format
 * plus the entry price per share. Only the definition is stored: payoff and metrics are computed live
 * by `@edgedesk/strategies` (trade_evaluate, the app). Every read and write is scoped to `owner`.
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import type { UserVault, Vault } from '../../vault';
import { portfolioOwner } from './portfolio';

const MAX_TRADES = 500;

export const tradeIdSchema = z.string().regex(/^tr_[0-9a-f]{16}$/, 'trade id (tr_…)');

const legSchema = z
  .object({
    action: z.enum(['buy', 'sell']),
    instrument: z.enum(['call', 'put', 'stock']),
    strike: z.number().positive().finite().optional().describe('Options: strike in USD.'),
    expiration: z
      .number()
      .int()
      .min(20000101)
      .max(29991231)
      .optional()
      .describe('Options: YYYYMMDD.'),
    qty: z
      .number()
      .int()
      .positive()
      .max(10_000)
      .describe('Contracts for options, shares for stock.'),
    price: z
      .number()
      .finite()
      .nonnegative()
      .optional()
      .describe('Entry price per share in USD. Omit to value it at the live mid.'),
    bid: z
      .number()
      .finite()
      .nonnegative()
      .optional()
      .describe(
        'Bid per share when the leg was added. With ask, prices the fill from mid to natural.',
      ),
    ask: z
      .number()
      .finite()
      .nonnegative()
      .optional()
      .describe('Ask per share when the leg was added.'),
  })
  .refine(
    (l) =>
      l.instrument === 'stock'
        ? l.strike === undefined && l.expiration === undefined
        : l.strike !== undefined && l.expiration !== undefined,
    { message: 'an option leg needs strike and expiration; a stock leg has neither' },
  );
export type TradeLeg = z.infer<typeof legSchema>;

/** `trade_write` input (MCP) and the POST/PUT body (REST). */
export const tradeWriteShape = {
  id: tradeIdSchema
    .optional()
    .describe('Omit to create, or to update your trade with this underlying and name.'),
  underlying: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9.^/-]{0,14}$/, 'ticker')
    .transform((s) => s.toUpperCase()),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe('Shown on the board, e.g. "Iron condor 550/595".'),
  legs: z.array(legSchema).min(1).max(8),
  note: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .describe('Why this trade: the thesis, exits, what to watch. Shown next to the payoff.'),
};
export const tradeWriteSchema = z.object(tradeWriteShape);
export type TradeWrite = z.infer<typeof tradeWriteSchema>;

export type WrittenBy = 'agent' | 'person';

export interface Trade {
  id: string;
  underlying: string;
  name: string;
  legs: TradeLeg[];
  note: string | null;
  written_by: WrittenBy;
  created_at: string;
  updated_at: string;
}

export class TradeNotFound extends Error {
  constructor() {
    super('trade not found');
  }
}
export class TradeInvalid extends Error {}

const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return `tr_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
};

/** Sealed in D1 `trades.data` (migration 0027); `name_key` keeps underlying + name unique. */
type Stored = Omit<Trade, 'id'>;

export class Trades {
  constructor(
    private readonly db: D1Like,
    private readonly vault: Vault,
  ) {}

  private async rows(v: UserVault): Promise<Trade[]> {
    const { results } = await this.db
      .prepare('SELECT id, data FROM trades WHERE owner = ?')
      .bind(v.owner)
      .all<{ id: string; data: string }>();
    return Promise.all(
      results.map(async (r) => ({ id: r.id, ...(await v.open<Stored>(`trades:${r.id}`, r.data)) })),
    );
  }

  async list(owner: string, underlying?: string): Promise<Trade[]> {
    const v = await this.vault.for(owner);
    const u = underlying?.toUpperCase();
    return (await this.rows(v))
      .filter((t) => !u || t.underlying === u)
      .sort((a, b) =>
        a.underlying !== b.underlying
          ? a.underlying < b.underlying
            ? -1
            : 1
          : a.updated_at < b.updated_at
            ? 1
            : a.updated_at > b.updated_at
              ? -1
              : 0,
      );
  }

  async read(owner: string, id: string): Promise<Trade> {
    const v = await this.vault.for(owner);
    const row = await this.db
      .prepare('SELECT data FROM trades WHERE id = ? AND owner = ?')
      .bind(id, v.owner)
      .first<{ data: string }>();
    if (!row) throw new TradeNotFound();
    return { id, ...(await v.open<Stored>(`trades:${id}`, row.data)) };
  }

  /** Without `id`, updates the owner's trade with that underlying and name, or creates it. */
  async write(owner: string, input: TradeWrite, by: WrittenBy): Promise<Trade> {
    const v = await this.vault.for(owner);
    const nameKey = await v.index(`trade:${input.underlying}\u0000${input.name}`);
    const byName = await this.db
      .prepare('SELECT id FROM trades WHERE owner = ? AND name_key = ?')
      .bind(v.owner, nameKey)
      .first<{ id: string }>();
    let id = input.id;
    let created_at = new Date().toISOString();
    if (id || byName) {
      const prev = await this.read(owner, (id ?? byName?.id) as string);
      if (id && byName && byName.id !== id) {
        throw new TradeInvalid(`another ${input.underlying} trade has that name`);
      }
      id = prev.id;
      created_at = prev.created_at;
    } else {
      const count = await this.db
        .prepare('SELECT COUNT(*) AS n FROM trades WHERE owner = ?')
        .bind(v.owner)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_TRADES) {
        throw new TradeInvalid(`at most ${MAX_TRADES} trades; delete some first`);
      }
      id = newId();
    }
    const stored: Stored = {
      underlying: input.underlying,
      name: input.name,
      legs: input.legs,
      note: input.note ?? null,
      written_by: by,
      created_at,
      updated_at: new Date().toISOString(),
    };
    await this.db
      .prepare(
        `INSERT INTO trades (id, owner, name_key, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name_key = excluded.name_key, data = excluded.data`,
      )
      .bind(id, v.owner, nameKey, await v.seal(`trades:${id}`, stored))
      .run();
    return { id, ...stored };
  }

  async delete(owner: string, id: string): Promise<void> {
    await this.read(owner, id);
    const v = await this.vault.for(owner);
    await this.db.prepare('DELETE FROM trades WHERE id = ? AND owner = ?').bind(id, v.owner).run();
  }
}

type Env = { Variables: { identity?: AccessIdentity } };
const invalid = (issues: z.ZodIssue[]) => ({
  error: 'invalid input',
  issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
});

/** REST under `/api/trades` (signed in). Writes from the app are marked as the person's. */
export function tradeRoutes(trades: Trades) {
  const r = new Hono<Env>();
  const owner = (c: Context<Env>) => portfolioOwner(c.get('identity'));

  r.onError((err, c) => {
    if (err instanceof TradeNotFound) return c.json({ error: err.message }, 404);
    if (err instanceof TradeInvalid) return c.json({ error: err.message }, 400);
    throw err;
  });

  r.get('/', async (c) => c.json(await trades.list(owner(c), c.req.query('underlying'))));
  r.get('/:id', async (c) => {
    const id = tradeIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'trade not found' }, 404);
    return c.json(await trades.read(owner(c), id.data));
  });
  const write = (id?: string) => async (c: Context<Env>) => {
    const body = await c.req.json().catch(() => null);
    const parsed = tradeWriteSchema.safeParse(
      body && typeof body === 'object' && !Array.isArray(body) ? { ...body, id } : null,
    );
    if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
    return c.json(await trades.write(owner(c), parsed.data, 'person'));
  };
  r.post('/', (c) => write()(c));
  r.put('/:id', (c) => {
    const id = tradeIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'trade not found' }, 404);
    return write(id.data)(c);
  });
  r.delete('/:id', async (c) => {
    const id = tradeIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'trade not found' }, 404);
    await trades.delete(owner(c), id.data);
    return c.json({ ok: true });
  });
  return r;
}
