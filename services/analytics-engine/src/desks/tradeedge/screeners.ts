/**
 * Screeners: a person's saved screener runs, each kept under one strategy (D1 `screeners`, sealed,
 * migration 0027). A screener holds a name, an underlying and the screener inputs `screener_run` takes (DTE window,
 * delta, width, filters, ...); `screener_run {id}` runs it on the live chain. Every read and write is
 * scoped to `owner`. Deleting a strategy deletes its screeners.
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import type { UserVault, Vault } from '../../vault';
import { portfolioOwner } from './portfolio';
import { type Strategies, StrategyNotFound, strategyIdSchema } from './strategies';

const MAX_SCREENERS = 500;

const expiration = z.coerce
  .number()
  .int()
  .min(20000101)
  .max(20991231)
  .describe('Expiration as YYYYMMDD, e.g. 20261016');

const oneOrMany = (base: z.ZodNumber) => z.union([base, z.array(base).min(1).max(8)]);

/** The screener's inputs besides the underlying and the strategy (screener_run, screener_write). */
export const screenerInputShape = {
  expiration: expiration.optional(),
  dte_min: z.number().int().min(0).max(1000).optional(),
  dte_max: z.number().int().min(0).max(1000).optional(),
  max_expirations: z.number().int().min(1).max(6).optional(),
  back_dte_min: z.number().int().min(1).max(1000).optional(),
  back_dte_max: z.number().int().min(1).max(1000).optional(),
  delta: oneOrMany(z.number().min(0.01).max(0.99)).optional(),
  otm_pct: oneOrMany(z.number().min(-0.5).max(0.5)).optional(),
  width: oneOrMany(z.number().positive().max(1000)).optional(),
  long_delta: z.number().min(0.05).max(0.99).optional().describe('ZEBRA / PMCC long leg abs delta'),
  strikes: z
    .record(z.string(), z.number().positive())
    .optional()
    .describe(
      'Exact strikes by role, e.g. {short_put:95, long_put:90}. Roles per strategy: see strategy_list.',
    ),
  pricing: z.enum(['mid', 'natural']).optional().describe('mid (default) or natural.'),
  min_credit: z.number().optional(),
  max_debit: z.number().optional(),
  min_pop: z.number().min(0).max(1).optional(),
  min_return_on_risk: z.number().min(0).optional(),
  max_leg_spread_pct: z.number().min(0).max(5).optional(),
  min_leg_volume: z.number().int().min(0).optional(),
  sort_by: z
    .enum([
      'expected_value',
      'pop',
      'return_on_risk',
      'credit',
      'credit_to_width',
      'lowest_debit',
      'theta',
    ])
    .optional()
    .describe(
      'expected_value (default), pop, return_on_risk, credit, credit_to_width, lowest_debit or theta.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe('Results to return, 1 to 25 (default 5).'),
};
const screenerInputSchema = z.object(screenerInputShape);
export type ScreenerInput = z.infer<typeof screenerInputSchema>;

export const screenerIdSchema = z.string().regex(/^sc_[0-9a-f]{16}$/, 'screener id (sc_…)');

export const underlyingSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9.]{0,9}$/, 'ticker')
  .transform((s) => s.toUpperCase())
  .describe('Ticker, e.g. SPY');

/** `screener_write` input (MCP) and the POST/PUT body (REST). */
export const screenerWriteShape = {
  id: screenerIdSchema
    .optional()
    .describe('Omit to create, or to update your screener with this strategy and name.'),
  strategy: strategyIdSchema.describe(
    'The strategy it belongs to (strategy_list), e.g. iron_condor.',
  ),
  name: z.string().trim().min(1).max(80).describe('e.g. "SPY 30-45 DTE 16Δ".'),
  underlying: underlyingSchema,
  inputs: screenerInputSchema
    .default({})
    .describe(
      'The screener_run inputs to keep, e.g. {dte_min:30, dte_max:45, delta:0.16, width:5}.',
    ),
};
export const screenerWriteSchema = z.object(screenerWriteShape);
export type ScreenerWrite = z.infer<typeof screenerWriteSchema>;

export type WrittenBy = 'agent' | 'person';

export interface Screener {
  id: string;
  strategy: string;
  name: string;
  underlying: string;
  inputs: ScreenerInput;
  written_by: WrittenBy;
  created_at: string;
  updated_at: string;
}

export class ScreenerNotFound extends Error {
  constructor() {
    super('screener not found');
  }
}
export class ScreenerInvalid extends Error {}

const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return `sc_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
};

/** Sealed in D1 `screeners.data` (migration 0027); `strategy_id` stays plain for the cascade. */
type Stored = Omit<Screener, 'id' | 'strategy'>;

export class Screeners {
  constructor(
    private readonly db: D1Like,
    private readonly strategies: Strategies,
    private readonly vault: Vault,
  ) {}

  private async open(v: UserVault, r: { id: string; strategy_id: string; data: string }) {
    const s = await v.open<Stored>(`screeners:${r.id}`, r.data);
    return { id: r.id, strategy: r.strategy_id, ...s } as Screener;
  }

  async list(owner: string, strategy?: string): Promise<Screener[]> {
    const v = await this.vault.for(owner);
    const q = strategy
      ? this.db
          .prepare(
            'SELECT id, strategy_id, data FROM screeners WHERE owner = ? AND strategy_id = ?',
          )
          .bind(v.owner, strategy)
      : this.db
          .prepare('SELECT id, strategy_id, data FROM screeners WHERE owner = ?')
          .bind(v.owner);
    const { results } = await q.all<{ id: string; strategy_id: string; data: string }>();
    const rows = await Promise.all(results.map((r) => this.open(v, r)));
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return rows.sort((a, b) => cmp(a.strategy, b.strategy) || cmp(a.name, b.name));
  }

  async read(owner: string, id: string): Promise<Screener> {
    const v = await this.vault.for(owner);
    const row = await this.db
      .prepare('SELECT id, strategy_id, data FROM screeners WHERE id = ? AND owner = ?')
      .bind(id, v.owner)
      .first<{ id: string; strategy_id: string; data: string }>();
    if (!row) throw new ScreenerNotFound();
    return this.open(v, row);
  }

  /** Without `id`, updates the owner's screener with that strategy and name, or creates it. */
  async write(owner: string, input: ScreenerWrite, by: WrittenBy): Promise<Screener> {
    try {
      await this.strategies.read(input.strategy);
    } catch (err) {
      if (err instanceof StrategyNotFound) throw new ScreenerInvalid(err.message);
      throw err;
    }
    const v = await this.vault.for(owner);
    const nameKey = await v.index(`screener:${input.strategy}\u0000${input.name}`);
    const byName = await this.db
      .prepare('SELECT id FROM screeners WHERE owner = ? AND name_key = ?')
      .bind(v.owner, nameKey)
      .first<{ id: string }>();
    let id = input.id;
    let created_at = new Date().toISOString();
    if (id || byName) {
      const prev = await this.read(owner, (id ?? byName?.id) as string);
      if (id && byName && byName.id !== id) {
        throw new ScreenerInvalid(`another ${input.strategy} screener has that name`);
      }
      id = prev.id;
      created_at = prev.created_at;
    } else {
      const count = await this.db
        .prepare('SELECT COUNT(*) AS n FROM screeners WHERE owner = ?')
        .bind(v.owner)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_SCREENERS) {
        throw new ScreenerInvalid(`at most ${MAX_SCREENERS} screeners; delete some first`);
      }
      id = newId();
    }
    const stored: Stored = {
      name: input.name,
      underlying: input.underlying,
      inputs: input.inputs,
      written_by: by,
      created_at,
      updated_at: new Date().toISOString(),
    };
    await this.db
      .prepare(
        `INSERT INTO screeners (id, owner, strategy_id, name_key, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET strategy_id = excluded.strategy_id,
           name_key = excluded.name_key, data = excluded.data`,
      )
      .bind(id, v.owner, input.strategy, nameKey, await v.seal(`screeners:${id}`, stored))
      .run();
    return { id, strategy: input.strategy, ...stored };
  }

  async delete(owner: string, id: string): Promise<void> {
    await this.read(owner, id);
    const v = await this.vault.for(owner);
    await this.db
      .prepare('DELETE FROM screeners WHERE id = ? AND owner = ?')
      .bind(id, v.owner)
      .run();
  }
}

type Env = { Variables: { identity?: AccessIdentity } };
const invalid = (issues: z.ZodIssue[]) => ({
  error: 'invalid input',
  issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
});

/** REST under `/api/screeners` (signed in). Writes from the app are marked as the person's. */
export function screenerRoutes(screeners: Screeners) {
  const r = new Hono<Env>();
  const owner = (c: Context<Env>) => portfolioOwner(c.get('identity'));

  r.onError((err, c) => {
    if (err instanceof ScreenerNotFound) return c.json({ error: err.message }, 404);
    if (err instanceof ScreenerInvalid) return c.json({ error: err.message }, 400);
    throw err;
  });

  r.get('/', async (c) => c.json(await screeners.list(owner(c), c.req.query('strategy'))));
  r.get('/:id', async (c) => {
    const id = screenerIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'screener not found' }, 404);
    return c.json(await screeners.read(owner(c), id.data));
  });
  const write = (id?: string) => async (c: Context<Env>) => {
    const body = await c.req.json().catch(() => null);
    const parsed = screenerWriteSchema.safeParse(
      body && typeof body === 'object' && !Array.isArray(body) ? { ...body, id } : null,
    );
    if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
    return c.json(await screeners.write(owner(c), parsed.data, 'person'));
  };
  r.post('/', (c) => write()(c));
  r.put('/:id', (c) => {
    const id = screenerIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'screener not found' }, 404);
    return write(id.data)(c);
  });
  r.delete('/:id', async (c) => {
    const id = screenerIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'screener not found' }, 404);
    await screeners.delete(owner(c), id.data);
    return c.json({ ok: true });
  });
  return r;
}
