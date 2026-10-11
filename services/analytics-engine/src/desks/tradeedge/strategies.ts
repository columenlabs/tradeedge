/**
 * Strategies: the structures a trade starts from (iron condor, jade lizard, ...), in D1 `strategies`
 * (migrations 0017 and 0022). One shared set for every signed-in caller: agents add strategies with
 * strategy_write, and the screener builds any of them on a live chain (`buildStrategy` in `@edgedesk/strategies`).
 * Each strategy has saved screeners (screeners.ts).
 */
import { type Strategy, strategyFacts, strategyProblem } from '@edgedesk/strategies';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import { portfolioOwner } from './portfolio';

const MAX_STRATEGIES = 200;

export const strategyIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,47}$/, 'strategy id: lower snake_case, e.g. iron_condor');

const role = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'role: lower snake_case');

const strikeSchema = z.union([
  z.object({
    pick: z.union([
      z.object({ delta: z.number().min(0.01).max(0.99) }),
      z.object({ atm: z.literal(true) }),
    ]),
    knob: z
      .enum(['delta', 'long_delta', 'none'])
      .describe(
        'Which screener knob may override the default: delta (also otm_pct), long_delta, or none.',
      ),
  }),
  z.object({ wing: role, dir: z.enum(['up', 'down']) }),
  z.object({ same: role }),
]);

const legSchema = z.object({
  action: z.enum(['buy', 'sell']),
  instrument: z.enum(['call', 'put', 'stock']),
  qty: z.number().int().positive().max(1000).describe('Contracts for options, shares for stock.'),
  expiry: z
    .enum(['front', 'back'])
    .optional()
    .describe('Options: front (default) or the later back expiry.'),
  role: role.optional().describe('Names the leg for `strikes` and for other legs’ wing / same.'),
  strike: strikeSchema
    .optional()
    .describe(
      'Options: {pick:{delta:0.16}|{atm:true}, knob}, {wing:<role>, dir:up|down} (width $ past that role) ' +
        'or {same:<role>} (that role’s strike on this leg’s expiry).',
    ),
});

/** `strategy_write` input (MCP) and the PUT body (REST). */
export const strategyWriteShape = {
  id: strategyIdSchema.describe('Writing an existing id replaces that strategy.'),
  name: z.string().trim().min(1).max(80),
  bias: z.enum(['bullish', 'bearish', 'neutral', 'long_volatility', 'short_volatility']),
  premium: z.enum(['credit', 'debit', 'either']),
  risk: z.enum(['defined', 'undefined']),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe('When to use it and which knobs move which legs.'),
  legs: z.array(legSchema).min(1).max(8),
  strike_order: z
    .array(z.tuple([role, role]))
    .max(8)
    .default([])
    .describe(
      'Role pairs whose strikes must rise in that order, e.g. [["short_put","short_call"]].',
    ),
  default_deltas: z
    .array(z.number().min(0.01).max(0.99))
    .min(1)
    .max(8)
    .nullable()
    .default(null)
    .describe(
      'Delta scan when the screener gets no delta, otm_pct or strikes; null builds once from defaults.',
    ),
};
export const strategyWriteSchema = z.object(strategyWriteShape);
export type StrategyWrite = z.infer<typeof strategyWriteSchema>;

export type StoredStrategy = Strategy &
  ReturnType<typeof strategyFacts> & { written_by: string; created_at: string; updated_at: string };

export class StrategyNotFound extends Error {
  constructor(id: string) {
    super(`unknown strategy: ${id} (see strategy_list)`);
  }
}
export class StrategyInvalid extends Error {}
export class StrategiesUnavailable extends Error {
  constructor() {
    super('strategies are not configured (no D1)');
  }
}

interface Row {
  id: string;
  name: string;
  bias: Strategy['bias'];
  premium: Strategy['premium'];
  risk: Strategy['risk'];
  summary: string;
  legs: string;
  strike_order: string;
  default_deltas: string | null;
  written_by: string;
  created_at: string;
  updated_at: string;
}

const fromRow = (r: Row): StoredStrategy => {
  const legs = JSON.parse(r.legs) as Strategy['legs'];
  return {
    ...r,
    legs,
    strike_order: JSON.parse(r.strike_order) as Strategy['strike_order'],
    default_deltas: r.default_deltas ? (JSON.parse(r.default_deltas) as number[]) : null,
    ...strategyFacts({ legs }),
  };
};

const COLUMNS =
  'id, name, bias, premium, risk, summary, legs, strike_order, default_deltas, written_by, created_at, updated_at';

export class Strategies {
  constructor(private readonly db: D1Like) {}

  async list(): Promise<StoredStrategy[]> {
    return (
      await this.db.prepare(`SELECT ${COLUMNS} FROM strategies ORDER BY id`).all<Row>()
    ).results.map(fromRow);
  }

  async read(id: string): Promise<StoredStrategy> {
    const row = await this.db
      .prepare(`SELECT ${COLUMNS} FROM strategies WHERE id = ?`)
      .bind(id)
      .first<Row>();
    if (!row) throw new StrategyNotFound(id);
    return fromRow(row);
  }

  /** Creates the strategy, or replaces the one with this id. `by` is the writer's Access email. */
  async write(input: StrategyWrite, by: string): Promise<StoredStrategy> {
    const problem = strategyProblem(input);
    if (problem) throw new StrategyInvalid(problem);
    const exists = await this.db
      .prepare('SELECT id FROM strategies WHERE id = ?')
      .bind(input.id)
      .first();
    if (!exists) {
      const count = await this.db
        .prepare('SELECT COUNT(*) AS n FROM strategies')
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_STRATEGIES) {
        throw new StrategyInvalid(`at most ${MAX_STRATEGIES} strategies; delete some first`);
      }
    }
    await this.db
      .prepare(
        `INSERT INTO strategies (id, name, bias, premium, risk, summary, legs, strike_order, default_deltas,
           written_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, bias = excluded.bias,
           premium = excluded.premium, risk = excluded.risk, summary = excluded.summary,
           legs = excluded.legs, strike_order = excluded.strike_order,
           default_deltas = excluded.default_deltas, written_by = excluded.written_by,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.id,
        input.name,
        input.bias,
        input.premium,
        input.risk,
        input.summary,
        JSON.stringify(input.legs),
        JSON.stringify(input.strike_order),
        input.default_deltas ? JSON.stringify(input.default_deltas) : null,
        by,
        new Date().toISOString(),
      )
      .run();
    return this.read(input.id);
  }

  async delete(id: string): Promise<void> {
    await this.read(id);
    await this.db.prepare('DELETE FROM strategies WHERE id = ?').bind(id).run();
  }
}

type Env = { Variables: { identity?: AccessIdentity } };

/** REST under `/api/strategies` (signed in). */
export function strategyRoutes(strategies: Strategies) {
  const r = new Hono<Env>();
  const by = (c: Context<Env>) => portfolioOwner(c.get('identity'));

  r.onError((err, c) => {
    if (err instanceof StrategyNotFound) return c.json({ error: err.message }, 404);
    if (err instanceof StrategyInvalid) return c.json({ error: err.message }, 400);
    throw err;
  });

  r.get('/', async (c) => c.json(await strategies.list()));
  r.get('/:id', async (c) => c.json(await strategies.read(c.req.param('id'))));
  r.put('/:id', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = strategyWriteSchema.safeParse(
      body && typeof body === 'object' && !Array.isArray(body)
        ? { ...body, id: c.req.param('id') }
        : null,
    );
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid input',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    }
    return c.json(await strategies.write(parsed.data, by(c)));
  });
  r.delete('/:id', async (c) => {
    await strategies.delete(c.req.param('id'));
    return c.json({ ok: true });
  });
  return r;
}
