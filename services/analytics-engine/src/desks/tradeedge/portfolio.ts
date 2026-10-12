/**
 * Portfolios: each signed-in user's holdings (D1 `portfolios`, `portfolio_transactions` and
 * `portfolio_lots`, sealed; migrations 0027, 0028). An account is either synced from SnapTrade
 * (`source: snaptrade`, written only by the sync in `snaptrade.ts`) or manual (`source: manual`, for a
 * broker SnapTrade can't reach, like SoFi). Manual accounts are written through the TradeEdge MCP
 * (`portfolio_*`) and the REST routes under `/api/portfolios`; both refuse to write a SnapTrade account
 * or to open a manual account at a broker SnapTrade supports (Bikram, 2026-10-10). A write replaces
 * the whole snapshot: cash, as-of time and positions. Every read and write is scoped to the caller
 * (`owner`), so one user never sees another's portfolio.
 */
import { occSymbol } from '@edgedesk/providers';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import type { HistoryService } from '../../history';
import { type UserVault, type Vault, docWrite, withRetry } from '../../vault';
import {
  type AccountLots,
  type CloseOn,
  type ClosedLot,
  type Dividends,
  type LotCheck,
  type LotCost,
  MOVES,
  type StockSplit,
  type StoredLot,
  type TaxLot,
  accountLots,
  lotAverage,
} from './lots';

const MAX_POSITIONS = 500;

/** Accounts stored before cash went signed held margin as this position; read as negative cash. */
const STORED_MARGIN = 'MARGIN-CASH';

export const portfolioIdSchema = z.string().regex(/^pf_[0-9a-f]{16}$/, 'portfolio id (pf_…)');

const positionSchema = z
  .object({
    underlying: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9.^/-]{0,14}$/, 'ticker')
      .transform((s) => s.toUpperCase()),
    quantity: z.number().finite().describe('Shares or contracts; negative means short.'),
    avg_cost: z.number().finite().nonnegative().optional().describe('Per share, in USD.'),
    expiration: z
      .number()
      .int()
      .min(20000101)
      .max(29991231)
      .optional()
      .describe('Option: YYYYMMDD.'),
    strike: z.number().positive().finite().optional().describe('Option: strike in USD.'),
    right: z.enum(['C', 'P']).optional().describe('Option: C (call) or P (put).'),
  })
  .refine(
    (p) =>
      [p.expiration, p.strike, p.right].every((v) => v === undefined) ||
      [p.expiration, p.strike, p.right].every((v) => v !== undefined),
    { message: 'an option needs expiration, strike and right together; stock has none of them' },
  );

/** `portfolio_write` input (MCP) and the PUT body (REST). */
export const portfolioWriteShape = {
  id: portfolioIdSchema
    .optional()
    .describe('Omit to create, or to update the portfolio with this name.'),
  name: z.string().trim().min(1).max(80).describe('The account, e.g. "Fidelity Roth IRA".'),
  tax_type: z
    .enum(['taxable', 'retirement'])
    .default('taxable')
    .describe('retirement for IRA, Roth, 401k and the like.'),
  broker: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe(
      'The broker, e.g. SoFi Invest. Needed for a new account; one SnapTrade supports is refused.',
    ),
  cash: z.number().finite().default(0).describe('Cash in USD; negative is margin borrowed.'),
  as_of: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('When the snapshot was taken (ISO 8601). Defaults to now.'),
  positions: z.array(positionSchema).max(MAX_POSITIONS),
};
export const portfolioWriteSchema = z.object(portfolioWriteShape);
export type PortfolioWrite = z.infer<typeof portfolioWriteSchema>;

export interface Position {
  symbol: string;
  underlying: string;
  expiration: number | null;
  strike: number | null;
  right: 'C' | 'P' | null;
  quantity: number;
  avg_cost: number | null;
  /** `lots`: the broker sent no average cost, so it is the open lots' (see their `cost_from`). */
  avg_cost_from?: 'lots';
}
export type TaxType = 'taxable' | 'retirement';
/** `snaptrade`: synced from the broker, read-only everywhere. `manual`: a broker SnapTrade can't reach. */
export type PortfolioSource = 'manual' | 'snaptrade';
export interface PortfolioSummary {
  id: string;
  name: string;
  tax_type: TaxType;
  broker: string | null;
  source: PortfolioSource;
  cash: number;
  as_of: string;
  updated_at: string;
  positions: number;
}
export interface Portfolio extends Omit<PortfolioSummary, 'positions'> {
  positions: Position[];
  /** Open tax lots, each with its `source` (`lots.ts`). */
  lots: TaxLot[];
  /** Gains closed this calendar year (trade dates), FIFO against the lots, fees included. */
  realized_ytd: AccountLots['realized_ytd'];
  /** Every lot closed so far, FIFO from the buys and sells, oldest close first; the realized gains in full. */
  closed_lots: ClosedLot[];
  /** Holdings whose open lots do not add up to the held quantity, with where their lots come from. */
  checks: LotCheck[];
  /** Dividends per symbol from the dividend transactions: all on record and this year's. */
  dividends: Dividends[];
}

const MAX_TRANSACTIONS = 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const transactionSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe("The broker's id for this row. Sending the same id again updates it."),
    date: z.string().regex(ISO_DATE, 'YYYY-MM-DD').describe('Trade date (YYYY-MM-DD).'),
    kind: z
      .enum([
        'buy',
        'sell',
        'transfer_in',
        'transfer_out',
        'dividend',
        'interest',
        'fee',
        'deposit',
        'withdrawal',
        'other',
      ])
      .describe(
        'transfer_in / transfer_out: shares moved in from or out to another account, no sale (a broker transfer, a journal, a 401(k) fund exchange).',
      ),
    underlying: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9.^/-]{0,14}$/, 'ticker')
      .transform((s) => s.toUpperCase())
      .optional(),
    expiration: z.number().int().min(20000101).max(29991231).optional(),
    strike: z.number().positive().finite().optional(),
    right: z.enum(['C', 'P']).optional(),
    quantity: z
      .number()
      .positive()
      .finite()
      .optional()
      .describe('Buy, sell and transfer: shares or contracts, always positive.'),
    price: z.number().finite().nonnegative().optional().describe('Buy and sell: per share, USD.'),
    fees: z.number().finite().nonnegative().default(0),
    amount: z
      .number()
      .finite()
      .describe('Cash effect in USD: negative for a buy, fee or withdrawal, positive otherwise.'),
    description: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        "The broker's text for the row, e.g. for kind other (an option expiring, a split).",
      ),
  })
  .refine(
    (t) =>
      [t.expiration, t.strike, t.right].every((v) => v === undefined) ||
      [t.expiration, t.strike, t.right].every((v) => v !== undefined),
    { message: 'an option needs expiration, strike and right together' },
  )
  .refine(
    (t) =>
      (t.kind !== 'buy' && t.kind !== 'sell') ||
      (t.underlying !== undefined && t.quantity !== undefined && t.price !== undefined),
    { message: 'a buy or sell needs underlying, quantity and price' },
  );

/** `portfolio_transaction_write` input (MCP) and the POST body (REST). */
export const transactionWriteShape = {
  portfolio_id: portfolioIdSchema,
  transactions: z.array(transactionSchema).min(1).max(MAX_TRANSACTIONS),
};
export const transactionListShape = {
  portfolio_id: portfolioIdSchema,
  symbol: z
    .string()
    .transform((s) => s.toUpperCase())
    .optional()
    .describe('Ticker, or OCC symbol for one option.'),
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TRANSACTIONS).default(200),
};
export const transactionDeleteShape = {
  portfolio_id: portfolioIdSchema,
  ids: z.array(z.string().min(1).max(120)).min(1).max(MAX_TRANSACTIONS),
};
export type TransactionInput = z.infer<typeof transactionSchema>;

export interface Transaction {
  id: string;
  date: string;
  kind: TransactionInput['kind'];
  symbol: string | null;
  underlying: string | null;
  expiration: number | null;
  strike: number | null;
  right: 'C' | 'P' | null;
  quantity: number | null;
  price: number | null;
  fees: number;
  amount: number;
  description?: string | null;
}

/** Stock: the ticker. Option: the OCC symbol (`QQQ261120P00480000`). */
export function positionSymbol(p: z.infer<typeof positionSchema>): string {
  if (p.expiration === undefined || p.strike === undefined || !p.right) return p.underlying;
  return occSymbol({
    root: p.underlying,
    expiration: p.expiration,
    type: p.right === 'C' ? 'call' : 'put',
    strike: p.strike,
  });
}

export class PortfolioNotFound extends Error {
  constructor() {
    super('portfolio not found');
  }
}
export class PortfolioInvalid extends Error {}
/** A write the rules refuse: a SnapTrade account, or a manual account at a broker SnapTrade supports. */
export class PortfolioLocked extends Error {}

const LOCKED =
  'This account syncs from SnapTrade, so its holdings, transactions and lots change only at the ' +
  'broker. Sync it from Settings ▸ Integrations (or integration_sync).';

/**
 * The broker name SnapTrade lists for `broker` (`Fidelity` for "Fidelity Investments"), or null when
 * SnapTrade can't reach it. Throws when SnapTrade's list can't be read.
 */
export type SnapTradeBrokerCheck = (broker: string) => Promise<string | null>;

const lotSchema = z
  .object({
    underlying: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9.^/-]{0,14}$/, 'ticker')
      .transform((s) => s.toUpperCase()),
    expiration: z.number().int().min(20000101).max(29991231).optional(),
    strike: z.number().positive().finite().optional(),
    right: z.enum(['C', 'P']).optional(),
    acquired: z.string().regex(ISO_DATE, 'YYYY-MM-DD').describe('When the lot was bought.'),
    quantity: z.number().finite().describe('Shares or contracts; negative for a short lot.'),
    cost: z.number().finite().nonnegative().describe('Per share, in USD, fees included.'),
  })
  .refine(
    (l) =>
      [l.expiration, l.strike, l.right].every((v) => v === undefined) ||
      [l.expiration, l.strike, l.right].every((v) => v !== undefined),
    { message: 'an option needs expiration, strike and right together' },
  );
/** `portfolio_lot_cost_write` input (MCP) and the PUT body (REST). */
export const lotCostWriteShape = {
  portfolio_id: portfolioIdSchema,
  underlying: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9.^/-]{0,14}$/, 'ticker')
    .transform((s) => s.toUpperCase())
    .describe('The stock or fund ticker.'),
  acquired: z.string().regex(ISO_DATE, 'YYYY-MM-DD').describe("The lot's acquired day."),
  quantity: z
    .number()
    .finite()
    .optional()
    .describe('Only the lot of this size that day; leave out for every lot that day.'),
  cost: z
    .number()
    .finite()
    .nonnegative()
    .nullable()
    .optional()
    .describe('Per share, in USD; null clears your cost; leave out to keep it.'),
  term: z
    .enum(['short', 'long'])
    .nullable()
    .optional()
    .describe(
      'Short or long term by hand, outranking the holding period; null clears yours; leave out to keep it.',
    ),
};
export type LotCostWrite = z.infer<z.ZodObject<typeof lotCostWriteShape>>;
/** `portfolio_lot_write` input (MCP) and the PUT body (REST): every open lot of a manual account. */
export const lotWriteShape = {
  portfolio_id: portfolioIdSchema,
  lots: z.array(lotSchema).max(MAX_POSITIONS * 4),
};
export type LotInput = z.infer<typeof lotSchema>;

/** One SnapTrade account as the sync hands it over (`snaptrade.ts`). */
export interface SyncedAccount {
  snaptrade_account_id: string;
  name: string;
  tax_type: TaxType;
  broker: string;
  cash: number;
  positions: z.input<typeof positionSchema>[];
  /** The broker's lots; null when SnapTrade sent none (FIFO from transactions then). */
  lots: LotInput[] | null;
  transactions: TransactionInput[];
}

const newId = () => {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return `pf_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
};

/** An account as sealed in D1 `portfolios.data`. */
type StoredPortfolio = Omit<PortfolioSummary, 'id' | 'positions'> & {
  positions: Position[];
  /** The SnapTrade account a synced account mirrors. */
  snaptrade_account_id?: string | null;
  /** Lot costs you set (portfolio_lot_cost_write); kept across syncs and snapshot writes. */
  lot_costs?: LotCost[];
};

/** One trade month of an account's transactions, as sealed in D1 `portfolio_transactions`. */
interface Bucket {
  bucket: string;
  version: number;
  rows: Transaction[];
}

const byDateThenId = (a: Transaction, b: Transaction) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const newestFirst = (a: Transaction, b: Transaction) => byDateThenId(b, a);

/** YYYY-MM-DD `n` days later (earlier when negative). */
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** An account in full: its positions with their lots, checks and realized gains (`lots.ts`). */
const full = (
  head: Omit<Portfolio, 'lots' | 'realized_ytd' | 'closed_lots' | 'checks' | 'dividends'> & {
    lot_costs?: LotCost[];
  },
  rows: Transaction[],
  stored: StoredLot[] | null,
  close: CloseOn = () => null,
  splits: StockSplit[] = [],
): Portfolio => {
  const { lot_costs: costs = [], ...rest } = head;
  const math = accountLots({
    held: rest.positions,
    stored,
    storedSource: rest.source === 'snaptrade' ? 'snaptrade' : 'manual',
    rows,
    costs,
    close,
    splits,
  });
  return {
    ...rest,
    positions: rest.positions.map((p) => {
      const avg = lotAverage(p, math.lots);
      return avg === null ? p : { ...p, avg_cost: avg, avg_cost_from: 'lots' as const };
    }),
    ...math,
  };
};

const toPosition = (p: z.infer<typeof positionSchema>): Position => ({
  symbol: positionSymbol(p),
  underlying: p.underlying,
  expiration: p.expiration ?? null,
  strike: p.strike ?? null,
  right: p.right ?? null,
  quantity: p.quantity,
  avg_cost: p.avg_cost ?? null,
});

const sortPositions = (a: Position, b: Position) =>
  a.underlying !== b.underlying
    ? a.underlying < b.underlying
      ? -1
      : 1
    : a.symbol < b.symbol
      ? -1
      : a.symbol > b.symbol
        ? 1
        : 0;

function checkedPositions(input: z.infer<typeof positionSchema>[]): Position[] {
  const positions = input.map(toPosition).sort(sortPositions);
  const seen = new Set<string>();
  for (const p of positions) {
    if (seen.has(p.symbol)) throw new PortfolioInvalid(`duplicate position ${p.symbol.trim()}`);
    seen.add(p.symbol);
  }
  return positions;
}

const toLot = (l: LotInput): StoredLot => ({
  symbol: positionSymbol({ ...l, quantity: l.quantity }),
  acquired: l.acquired,
  quantity: l.quantity,
  cost: Math.round(l.cost * 1e4) / 1e4,
});

const toTransaction = (t: TransactionInput): Transaction => ({
  id: t.id,
  date: t.date,
  kind: t.kind,
  symbol: t.underlying
    ? positionSymbol({ ...t, underlying: t.underlying, quantity: t.quantity ?? 0 })
    : null,
  underlying: t.underlying ?? null,
  expiration: t.expiration ?? null,
  strike: t.strike ?? null,
  right: t.right ?? null,
  quantity: t.quantity ?? null,
  price: t.price ?? null,
  fees: t.fees,
  amount: t.amount,
  description: t.description ?? null,
});

/**
 * Every row is sealed with the owner's vault (src/vault.ts): an account (with its positions) is one
 * blob, its transactions one blob per trade month, its lots one blob. Filters, sorting and lots run
 * here after opening.
 */
export class Portfolios {
  constructor(
    private readonly db: D1Like,
    private readonly vault: Vault,
    /** Without it (local dev, tests) a manual account may name any broker. */
    private readonly snaptradeBroker?: SnapTradeBrokerCheck,
    /** Prices lots a broker sent without a cost; without it (self-host, tests) they stay at 0. */
    private readonly history?: HistoryService,
    /** Stock splits since a date (the live feed); without it derived lots are never split. */
    private readonly splitsSince?: (symbols: string[], from: string) => Promise<StockSplit[]>,
  ) {}

  private async accounts(v: UserVault, id?: string) {
    const q = id
      ? this.db
          .prepare('SELECT id, data FROM portfolios WHERE owner = ? AND id = ?')
          .bind(v.owner, id)
      : this.db.prepare('SELECT id, data FROM portfolios WHERE owner = ?').bind(v.owner);
    const { results } = await q.all<{ id: string; data: string }>();
    const open = await Promise.all(
      results.map(async (r) => {
        const stored = await v.open<StoredPortfolio>(`portfolios:${r.id}`, r.data);
        const margin = stored.positions.filter((p) => p.underlying === STORED_MARGIN);
        return {
          id: r.id,
          ...stored,
          cash: margin.reduce((sum, p) => sum + p.quantity, stored.cash),
          positions: stored.positions.filter((p) => p.underlying !== STORED_MARGIN),
          source: stored.source ?? 'manual',
        };
      }),
    );
    return open.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Transaction months by account id. */
  private async buckets(v: UserVault, id?: string): Promise<Map<string, Bucket[]>> {
    const { results } = await this.db
      .prepare(
        `SELECT t.portfolio_id, t.bucket, t.data, t.version FROM portfolio_transactions t
           JOIN portfolios p ON p.id = t.portfolio_id
          WHERE p.owner = ?${id ? ' AND p.id = ?' : ''}`,
      )
      .bind(...(id ? [v.owner, id] : [v.owner]))
      .all<{ portfolio_id: string; bucket: string; data: string; version: number }>();
    const out = new Map<string, Bucket[]>();
    await Promise.all(
      results.map(async (r) => {
        const rows = await v.open<Transaction[]>(
          `portfolio_transactions:${r.portfolio_id}:${r.bucket}`,
          r.data,
        );
        const list = out.get(r.portfolio_id) ?? [];
        list.push({ bucket: r.bucket, version: Number(r.version), rows });
        out.set(r.portfolio_id, list);
      }),
    );
    return out;
  }

  /** Stored lots by account id, with each blob's version. */
  private async storedLots(
    v: UserVault,
    id?: string,
  ): Promise<Map<string, { lots: StoredLot[]; version: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT l.portfolio_id, l.data, l.version FROM portfolio_lots l
           JOIN portfolios p ON p.id = l.portfolio_id
          WHERE p.owner = ?${id ? ' AND p.id = ?' : ''}`,
      )
      .bind(...(id ? [v.owner, id] : [v.owner]))
      .all<{ portfolio_id: string; data: string; version: number }>();
    const out = new Map<string, { lots: StoredLot[]; version: number }>();
    await Promise.all(
      results.map(async (r) =>
        out.set(r.portfolio_id, {
          lots: await v.open<StoredLot[]>(`portfolio_lots:${r.portfolio_id}`, r.data),
          version: Number(r.version),
        }),
      ),
    );
    return out;
  }

  async list(owner: string): Promise<PortfolioSummary[]> {
    const v = await this.vault.for(owner);
    return (await this.accounts(v)).map(
      ({ positions, snaptrade_account_id: _, lot_costs: __, ...head }) => ({
        ...head,
        positions: positions.length,
      }),
    );
  }

  async read(owner: string, id: string): Promise<Portfolio> {
    const v = await this.vault.for(owner);
    const [account] = await this.accounts(v, id);
    if (!account) throw new PortfolioNotFound();
    const { snaptrade_account_id: _, ...head } = account;
    const [months, lots] = await Promise.all([this.buckets(v, id), this.storedLots(v, id)]);
    const [one] = await this.priced([
      [head, (months.get(id) ?? []).flatMap((m) => m.rows), lots.get(id)?.lots ?? null],
    ]);
    return one as Portfolio;
  }

  /**
   * Accounts in full. Lots left without a cost are priced from that day's close in one ClickHouse
   * read; market data is read on each call, never stored (data rules).
   */
  private async priced(
    input: [Parameters<typeof full>[0], Transaction[], StoredLot[] | null][],
  ): Promise<Portfolio[]> {
    const splits = await this.splitsOf(input.flatMap(([, rows]) => rows));
    const first = input.map(([h, rows, stored]) => full(h, rows, stored, undefined, splits));
    const missing = first.flatMap((p) => p.lots.filter((l) => l.cost_from === 'missing'));
    if (!missing.length || !this.history?.available) return first;
    const dates = missing.map((l) => l.acquired).sort();
    const from = addDays(dates[0] as string, -7);
    const closes = await this.history
      .rawCloses([...new Set(missing.map((l) => l.symbol))], from, dates.at(-1) as string)
      .catch((err) => {
        console.error('lot cost closes', err);
        return {} as Record<string, { date: string; close: number }[]>;
      });
    const close: CloseOn = (symbol, date) => {
      const before = (closes[symbol] ?? []).filter((c) => c.date <= date);
      const last = before.at(-1);
      return last && last.date >= addDays(date, -7) ? last.close : null;
    };
    return input.map(([h, rows, stored], i) =>
      first[i]?.lots.some((l) => l.cost_from === 'missing')
        ? full(h, rows, stored, close, splits)
        : (first[i] as Portfolio),
    );
  }

  /** The splits of every stock bought or sold, since the first such trade (one feed call, cached). */
  private async splitsOf(rows: Transaction[]): Promise<StockSplit[]> {
    const stock = rows.filter(
      (t) =>
        MOVES.has(t.kind) &&
        t.symbol &&
        t.expiration === null &&
        !t.right &&
        !t.symbol.includes(' '),
    );
    if (!this.splitsSince || !stock.length) return [];
    const from = stock.map((t) => t.date).sort()[0] as string;
    return this.splitsSince([...new Set(stock.map((t) => t.symbol as string))], from).catch(
      (err) => {
        console.error('lot splits', err);
        return [];
      },
    );
  }

  /** Every portfolio of the owner in full, in three queries (Holdings loads them in one request). */
  async readAll(owner: string): Promise<Portfolio[]> {
    const v = await this.vault.for(owner);
    const [heads, months, lots] = await Promise.all([
      this.accounts(v),
      this.buckets(v),
      this.storedLots(v),
    ]);
    return this.priced(
      heads.map(({ snaptrade_account_id: _, ...head }) => [
        head,
        (months.get(head.id) ?? []).flatMap((m) => m.rows),
        lots.get(head.id)?.lots ?? null,
      ]),
    );
  }

  /** The owner's account, or not found. */
  private async own(v: UserVault, id: string) {
    const [account] = await this.accounts(v, id);
    if (!account) throw new PortfolioNotFound();
    return account;
  }

  /** The owner's manual account: a SnapTrade account is refused. */
  private async manual(v: UserVault, id: string) {
    const account = await this.own(v, id);
    if (account.source === 'snaptrade') throw new PortfolioLocked(LOCKED);
    return account;
  }

  private async store(v: UserVault, id: string, nameKey: string, stored: StoredPortfolio) {
    await this.db
      .prepare(
        `INSERT INTO portfolios (id, owner, name_key, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name_key = excluded.name_key, data = excluded.data`,
      )
      .bind(id, v.owner, nameKey, await v.seal(`portfolios:${id}`, stored))
      .run();
  }

  /**
   * A manual account: replaces the whole snapshot. Without `id`, updates the owner's portfolio of
   * that name or creates it. Refused for a SnapTrade account, and for a broker SnapTrade supports.
   */
  async write(owner: string, input: PortfolioWrite): Promise<Portfolio> {
    const v = await this.vault.for(owner);
    const positions = checkedPositions(input.positions);
    const nameKey = await v.index(`portfolio:${input.name}`);
    const byName = await this.db
      .prepare('SELECT id FROM portfolios WHERE owner = ? AND name_key = ?')
      .bind(v.owner, nameKey)
      .first<{ id: string }>();
    let id = input.id;
    if (id) {
      await this.manual(v, id);
      if (byName && byName.id !== id) throw new PortfolioInvalid('another portfolio has that name');
    } else id = byName?.id ?? newId();
    const existing = input.id || byName ? await this.manual(v, id) : null;
    const broker = input.broker ?? existing?.broker ?? null;
    if (!broker)
      throw new PortfolioInvalid('broker is required for a new account (e.g. SoFi Invest)');
    if (broker !== existing?.broker && this.snaptradeBroker) {
      const hit = await this.snaptradeBroker(broker).catch(() => {
        throw new PortfolioInvalid(
          "SnapTrade's broker list can't be read right now, so the broker can't be checked. Try again.",
        );
      });
      if (hit)
        throw new PortfolioLocked(
          `${hit} is supported by SnapTrade: add it under Settings ▸ Brokers and accounts instead of adding it by hand.`,
        );
    }
    await this.store(v, id, nameKey, {
      name: input.name,
      tax_type: input.tax_type,
      broker,
      source: 'manual',
      cash: input.cash,
      as_of: input.as_of ? new Date(input.as_of).toISOString() : new Date().toISOString(),
      updated_at: new Date().toISOString(),
      positions,
      ...(existing?.lot_costs ? { lot_costs: existing.lot_costs } : {}),
    });
    return this.read(owner, id);
  }

  /**
   * The SnapTrade sync's write (`snaptrade.ts`), the only writer of a SnapTrade account: the snapshot,
   * the broker's lots and the transactions (upserted by SnapTrade's ids). Returns the account id.
   */
  async syncAccount(owner: string, input: SyncedAccount): Promise<string> {
    const v = await this.vault.for(owner);
    const all = await this.accounts(v);
    const mine = all.find((a) => a.snaptrade_account_id === input.snaptrade_account_id);
    const id = mine?.id ?? newId();
    const taken = (name: string) => all.some((a) => a.name === name && a.id !== id);
    const name = taken(input.name)
      ? `${input.name} ••${input.snaptrade_account_id.slice(-4)}`
      : input.name;
    const now = new Date().toISOString();
    await this.store(v, id, await v.index(`portfolio:${name}`), {
      name,
      tax_type: mine?.tax_type ?? input.tax_type,
      broker: input.broker,
      source: 'snaptrade',
      snaptrade_account_id: input.snaptrade_account_id,
      cash: input.cash,
      as_of: now,
      updated_at: now,
      positions: checkedPositions(positionSchema.array().parse(input.positions)),
      ...(mine?.lot_costs ? { lot_costs: mine.lot_costs } : {}),
    });
    await this.saveLots(v, id, input.lots ? input.lots.map(toLot) : null);
    if (input.transactions.length) await this.upsertTransactions(v, id, input.transactions);
    return id;
  }

  /** The SnapTrade accounts already in Holdings: SnapTrade account id → portfolio id. */
  async syncedAccounts(owner: string): Promise<Map<string, { id: string; tax_type: TaxType }>> {
    const v = await this.vault.for(owner);
    return new Map(
      (await this.accounts(v)).flatMap((a) =>
        a.snaptrade_account_id
          ? [[a.snaptrade_account_id, { id: a.id, tax_type: a.tax_type }] as const]
          : [],
      ),
    );
  }

  /** Renames a synced account (Bikram, 2026-10-11): the person's own name, kept across syncs. */
  async rename(owner: string, id: string, name: string): Promise<void> {
    const v = await this.vault.for(owner);
    if ((await this.accounts(v)).some((a) => a.name === name && a.id !== id))
      throw new PortfolioInvalid('another account has that name');
    const { id: _, ...stored } = await this.own(v, id);
    await this.store(v, id, await v.index(`portfolio:${name}`), { ...stored, name });
  }

  /**
   * Tax type of a synced account (`snaptrade_account_write`): not a holding, so it stays the person's
   * call. Anything else on a SnapTrade account comes from the broker.
   */
  async setTaxType(owner: string, id: string, taxType: TaxType): Promise<void> {
    const v = await this.vault.for(owner);
    const { id: _, ...stored } = await this.own(v, id);
    await this.store(v, id, await v.index(`portfolio:${stored.name}`), {
      ...stored,
      tax_type: taxType,
    });
  }

  /**
   * Sets (or, with null, clears) your cost and term for one symbol's lots acquired on one day, on
   * any account, SnapTrade's too: a broker often has no cost for RSU or transferred-in shares, and a
   * derived lot's date can miss the real holding period. Both outrank the lot's own and survive syncs.
   */
  async writeLotCost(owner: string, input: LotCostWrite): Promise<Portfolio> {
    const v = await this.vault.for(owner);
    const { id, ...stored } = await this.own(v, input.portfolio_id);
    const symbol = input.underlying;
    const same = (o: LotCost) =>
      o.symbol === symbol && o.acquired === input.acquired && o.quantity === input.quantity;
    const prev = (stored.lot_costs ?? []).find(same);
    const rest = (stored.lot_costs ?? []).filter((o) => !same(o));
    // Each field: a value sets it, null clears it, left out keeps what was set.
    const cost =
      input.cost === undefined
        ? prev?.cost
        : input.cost === null
          ? undefined
          : Math.round(input.cost * 1e4) / 1e4;
    const term = input.term === undefined ? prev?.term : (input.term ?? undefined);
    const lot_costs =
      cost === undefined && term === undefined
        ? rest
        : [
            ...rest,
            {
              symbol,
              acquired: input.acquired,
              ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
              ...(cost !== undefined ? { cost } : {}),
              ...(term ? { term } : {}),
            },
          ];
    await this.store(v, id, await v.index(`portfolio:${stored.name}`), { ...stored, lot_costs });
    return this.read(owner, id);
  }

  /** Replaces a manual account's lots (all of them); an empty list goes back to FIFO lots. */
  async writeLots(owner: string, portfolioId: string, lots: LotInput[]): Promise<Portfolio> {
    const v = await this.vault.for(owner);
    await this.manual(v, portfolioId);
    await this.saveLots(v, portfolioId, lots.length ? lots.map(toLot) : null);
    return this.read(owner, portfolioId);
  }

  private saveLots(v: UserVault, portfolioId: string, lots: StoredLot[] | null) {
    return withRetry(async () => {
      const prev = (await this.storedLots(v, portfolioId)).get(portfolioId);
      if (!lots) {
        if (prev)
          await this.db
            .prepare('DELETE FROM portfolio_lots WHERE portfolio_id = ?')
            .bind(portfolioId)
            .run();
        return;
      }
      const sorted = [...lots].sort((a, b) =>
        a.symbol !== b.symbol ? (a.symbol < b.symbol ? -1 : 1) : a.acquired < b.acquired ? -1 : 1,
      );
      if (prev && JSON.stringify(prev.lots) === JSON.stringify(sorted)) return;
      await docWrite(
        this.db,
        'portfolio_lots',
        { portfolio_id: portfolioId },
        await v.seal(`portfolio_lots:${portfolioId}`, sorted),
        prev?.version ?? 0,
      ).run();
    });
  }

  /** Writes the months whose rows changed; a month another write changed meanwhile retries the call. */
  private async saveMonths(
    v: UserVault,
    portfolioId: string,
    months: Bucket[],
    rows: Map<string, Transaction>,
  ) {
    const byMonth = new Map<string, Transaction[]>();
    for (const t of rows.values()) {
      const m = t.date.slice(0, 7);
      byMonth.set(m, [...(byMonth.get(m) ?? []), t]);
    }
    const old = new Map(months.map((m) => [m.bucket, m]));
    const keys = new Map<string, string>();
    for (const m of byMonth.keys()) keys.set(await v.index(`month:${m}`), m);
    const stmts = [];
    for (const bucket of new Set([...old.keys(), ...keys.keys()])) {
      const month = keys.get(bucket);
      const next = (month ? (byMonth.get(month) ?? []) : []).sort(byDateThenId);
      const prev = old.get(bucket);
      if (prev && JSON.stringify([...prev.rows].sort(byDateThenId)) === JSON.stringify(next))
        continue;
      const aad = `portfolio_transactions:${portfolioId}:${bucket}`;
      stmts.push(
        docWrite(
          this.db,
          'portfolio_transactions',
          { portfolio_id: portfolioId, bucket },
          await v.seal(aad, next),
          prev?.version ?? 0,
        ),
      );
    }
    if (stmts.length) await this.db.batch(stmts);
  }

  private upsertTransactions(v: UserVault, portfolioId: string, input: TransactionInput[]) {
    const ids = new Set<string>();
    for (const t of input) {
      if (ids.has(t.id)) throw new PortfolioInvalid(`duplicate transaction id ${t.id}`);
      ids.add(t.id);
    }
    return withRetry(async () => {
      const months = (await this.buckets(v, portfolioId)).get(portfolioId) ?? [];
      const rows = new Map(months.flatMap((m) => m.rows.map((t) => [t.id, t] as const)));
      const updated = input.filter((t) => rows.has(t.id)).length;
      for (const t of input) rows.set(t.id, toTransaction(t));
      await this.saveMonths(v, portfolioId, months, rows);
      return { inserted: input.length - updated, updated };
    });
  }

  /** Manual accounts: upserts by the broker's id, so an export uploaded twice changes nothing the second time. */
  async writeTransactions(
    owner: string,
    portfolioId: string,
    input: TransactionInput[],
  ): Promise<{ inserted: number; updated: number }> {
    const v = await this.vault.for(owner);
    await this.manual(v, portfolioId);
    return this.upsertTransactions(v, portfolioId, input);
  }

  /** Newest first. */
  async listTransactions(
    owner: string,
    q: { portfolio_id: string; symbol?: string; from?: string; to?: string; limit: number },
  ): Promise<Transaction[]> {
    const v = await this.vault.for(owner);
    await this.own(v, q.portfolio_id);
    const months = (await this.buckets(v, q.portfolio_id)).get(q.portfolio_id) ?? [];
    return months
      .flatMap((m) => m.rows)
      .filter(
        (t) =>
          (!q.symbol || t.symbol === q.symbol || t.underlying === q.symbol) &&
          (!q.from || t.date >= q.from) &&
          (!q.to || t.date <= q.to),
      )
      .sort(newestFirst)
      .slice(0, q.limit);
  }

  /** Every account's latest `limit` transactions, each with its account id, newest first. */
  async listAllTransactions(
    owner: string,
    limit: number,
  ): Promise<(Transaction & { portfolio_id: string })[]> {
    const v = await this.vault.for(owner);
    const months = await this.buckets(v);
    return [...months.entries()]
      .flatMap(([portfolio_id, list]) =>
        list
          .flatMap((m) => m.rows)
          .sort(newestFirst)
          .slice(0, limit)
          .map((t) => ({ portfolio_id, ...t })),
      )
      .sort(newestFirst);
  }

  /** Manual accounts only. */
  async deleteTransactions(owner: string, portfolioId: string, ids: string[]) {
    const v = await this.vault.for(owner);
    await this.manual(v, portfolioId);
    const drop = new Set(ids);
    await withRetry(async () => {
      const months = (await this.buckets(v, portfolioId)).get(portfolioId) ?? [];
      const rows = new Map(
        months.flatMap((m) => m.rows.filter((t) => !drop.has(t.id)).map((t) => [t.id, t] as const)),
      );
      await this.saveMonths(v, portfolioId, months, rows);
    });
  }

  /**
   * Deletes an account with its positions, transactions and lots. A SnapTrade account comes back on
   * the next sync unless its import is turned off (`snaptrade_account_write`).
   */
  async delete(owner: string, id: string): Promise<void> {
    const v = await this.vault.for(owner);
    await this.own(v, id);
    await this.db.batch([
      this.db.prepare('DELETE FROM portfolio_lots WHERE portfolio_id = ?').bind(id),
      this.db.prepare('DELETE FROM portfolio_transactions WHERE portfolio_id = ?').bind(id),
      this.db.prepare('DELETE FROM portfolios WHERE id = ? AND owner = ?').bind(id, v.owner),
    ]);
  }
}

/** Who owns what: a person by email, a service token by its client id, local dev as `local`. */
export function portfolioOwner(identity?: { email?: string; sub: string; serviceToken?: string }) {
  if (!identity) return 'local';
  if (identity.email) return identity.email.toLowerCase();
  return `token:${identity.serviceToken ?? identity.sub}`;
}

/** REST under `/api/portfolios` (signed in; `identity` is set by the `/api` middleware). */
export function portfolioRoutes(portfolios: Portfolios) {
  const r = new Hono<{ Variables: { identity?: AccessIdentity } }>();
  const owner = (c: { get(k: 'identity'): AccessIdentity | undefined }) =>
    portfolioOwner(c.get('identity'));
  const invalid = (issues: z.ZodIssue[]) => ({
    error: 'invalid input',
    issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });

  r.onError((err, c) => {
    if (err instanceof PortfolioNotFound) return c.json({ error: err.message }, 404);
    if (err instanceof PortfolioInvalid) return c.json({ error: err.message }, 400);
    if (err instanceof PortfolioLocked) return c.json({ error: err.message }, 403);
    throw err;
  });

  // `?include=positions`: every portfolio in full (positions, lots, realized, checks) in one request.
  r.get('/', async (c) =>
    c.json(
      c.req.query('include') === 'positions'
        ? await portfolios.readAll(owner(c))
        : await portfolios.list(owner(c)),
    ),
  );
  // Every account's latest transactions (`limit` per account) in one request: the Transactions view.
  r.get('/transactions', async (c) => {
    const limit = transactionListShape.limit.safeParse(c.req.query('limit'));
    if (!limit.success) return c.json(invalid(limit.error.issues), 400);
    return c.json(await portfolios.listAllTransactions(owner(c), limit.data));
  });
  r.get('/:id', async (c) => {
    const id = portfolioIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'portfolio not found' }, 404);
    return c.json(await portfolios.read(owner(c), id.data));
  });
  const write = (id?: string) => async (c: Context) => {
    const body = await c.req.json().catch(() => null);
    const parsed = portfolioWriteSchema.safeParse(
      body && typeof body === 'object' && !Array.isArray(body) ? { ...body, id } : null,
    );
    if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
    return c.json(await portfolios.write(owner(c), parsed.data));
  };
  r.post('/', (c) => write()(c));
  r.put('/:id', (c) => {
    const id = portfolioIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'portfolio not found' }, 404);
    return write(id.data)(c);
  });
  r.delete('/:id', async (c) => {
    const id = portfolioIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'portfolio not found' }, 404);
    await portfolios.delete(owner(c), id.data);
    return c.json({ ok: true });
  });

  const listSchema = z.object(transactionListShape);
  const writeTx = z.object(transactionWriteShape);
  const deleteTx = z.object(transactionDeleteShape);
  const body = async (c: Context) => {
    const b = await c.req.json().catch(() => null);
    return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
  };
  r.get('/:id/transactions', async (c) => {
    const parsed = listSchema.safeParse({ ...c.req.query(), portfolio_id: c.req.param('id') });
    if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
    return c.json(await portfolios.listTransactions(owner(c), parsed.data));
  });
  r.post('/:id/transactions', async (c) => {
    const parsed = writeTx.safeParse({ ...(await body(c)), portfolio_id: c.req.param('id') });
    if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
    const { portfolio_id, transactions } = parsed.data;
    return c.json(await portfolios.writeTransactions(owner(c), portfolio_id, transactions));
  });
  const writeLotCost = z.object(lotCostWriteShape);
  r.put('/:id/lot-costs', async (c) => {
    const parsed = writeLotCost.safeParse({ ...(await body(c)), portfolio_id: c.req.param('id') });
    if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
    return c.json(await portfolios.writeLotCost(owner(c), parsed.data));
  });
  const writeLots = z.object(lotWriteShape);
  r.put('/:id/lots', async (c) => {
    const parsed = writeLots.safeParse({ ...(await body(c)), portfolio_id: c.req.param('id') });
    if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
    return c.json(await portfolios.writeLots(owner(c), parsed.data.portfolio_id, parsed.data.lots));
  });
  r.delete('/:id/transactions', async (c) => {
    const parsed = deleteTx.safeParse({ ...(await body(c)), portfolio_id: c.req.param('id') });
    if (!parsed.success) return c.json(invalid(parsed.error.issues), 400);
    await portfolios.deleteTransactions(owner(c), parsed.data.portfolio_id, parsed.data.ids);
    return c.json({ ok: true });
  });
  return r;
}
