/**
 * Autopilot (Bikram, 2026-10-12; design /mnt/project-files/baskets/design.md, phase 1): a basket is a
 * name, target weights, a rebalance rule (Monthly, Quarterly or Yearly on the first trading day, plus
 * an optional drift trigger) and a Mode (Off or Suggest). It holds one floating sleeve per account:
 * share counts and its own cash, whose value moves with the market; money moves between baskets only
 * through Move cash. Whatever no sleeve holds is Unassigned.
 *
 * A rebalance targets the basket's total across its sleeves and splits the trades with one rule:
 * sells in tax-free (retirement) accounts first, buys where the cash is. Orders go to one queue:
 * Proposed → Approved → Sent → Filled, or Rejected / Cancelled. An account whose Trading switch
 * (Brokers and accounts) is off, or that cannot trade, gets By hand orders the person places.
 * Nothing sends orders yet: Approved orders wait for the send window (5 min after the open, limit at
 * mid) until sending is switched on.
 *
 * D1 `baskets`, `basket_sleeves` and `basket_orders` (migration 0032), every row sealed by the vault.
 * Today's `position_baskets` tags become baskets with sleeves (whole holdings) on each person's first
 * read; that row is then deleted.
 */
import { parseOccSymbol } from '@edgedesk/providers';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like, D1Statement } from '../../d1';
import { isSessionOpen, isTradingDay, nyParts, secondsUntilOpen } from '../../market-hours';
import { type UserVault, type Vault, withRetry } from '../../vault';
import {
  type Portfolios,
  type Position,
  type TaxType,
  portfolioIdSchema,
  portfolioOwner,
} from './portfolio';

// ── inputs ──

export const basketIdSchema = z.string().regex(/^bk_[0-9a-f]{16}$/, 'basket id (bk_…)');
export const orderIdSchema = z.string().regex(/^od_[0-9a-f]{16}$/, 'order id (od_…)');
const tickerSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9.^/-]{0,14}$/, 'ticker')
  .transform((s) => s.toUpperCase());
const holdingSchema = z
  .string()
  .regex(/^[A-Za-z^][A-Za-z0-9 .^/-]{0,30}$/, 'ticker or OCC symbol')
  .transform((s) => s.toUpperCase());

export const REBALANCE = ['monthly', 'quarterly', 'yearly'] as const;
export type Rebalance = (typeof REBALANCE)[number];
export const DRIFTS = [0, 3, 5, 10] as const;
/** Auto comes later (after a few clean Suggest cycles). */
export const MODES = ['off', 'suggest'] as const;
export type Mode = (typeof MODES)[number];

const sleeveInput = z.object({
  portfolio_id: portfolioIdSchema,
  shares: z
    .record(holdingSchema, z.number().nonnegative().finite())
    .default({})
    .describe('Shares per symbol this sleeve holds, taken from what the account holds unassigned.'),
  cash: z
    .number()
    .nonnegative()
    .finite()
    .default(0)
    .describe("The sleeve's own cash in USD, taken from the account's unassigned cash."),
});

export const basketWriteShape = {
  id: basketIdSchema.optional().describe('Omit to create; else the basket to change.'),
  name: z.string().trim().min(1).max(60).optional().describe('Required to create, e.g. "cyber".'),
  targets: z
    .record(tickerSchema, z.number().min(0).max(100))
    .optional()
    .describe('Target weight per ticker in %, adding up to 100, e.g. {"CRWD": 25, "PANW": 75}.'),
  rebalance: z
    .enum(REBALANCE)
    .optional()
    .describe(
      'When it rebalances: the first trading day of each month, quarter or year (default quarterly).',
    ),
  drift: z
    .union([z.literal(0), z.literal(3), z.literal(5), z.literal(10)])
    .optional()
    .describe(
      'Also rebalance early when any weight drifts more than this many points; 0 = off (default 0).',
    ),
  mode: z
    .enum(MODES)
    .optional()
    .describe(
      'off: track value and drift only. suggest: proposes orders when a rebalance is due (default suggest).',
    ),
  sleeves: z
    .array(sleeveInput)
    .max(50)
    .optional()
    .describe(
      'The whole set of sleeves (one per account): shares and cash in each. Accounts left out leave ' +
        'the basket, their shares and cash going back to Unassigned. Omit to keep the sleeves.',
    ),
};
const basketWriteSchema = z.object(basketWriteShape);
export type BasketWrite = z.infer<typeof basketWriteSchema>;

export const basketMoveShape = {
  portfolio_id: portfolioIdSchema.describe('The account the cash sits in.'),
  from: basketIdSchema.nullable().describe('The basket it leaves; null = Unassigned.'),
  to: basketIdSchema.nullable().describe('The basket it goes to; null = Unassigned.'),
  amount: z.number().positive().finite().describe('USD.'),
  propose: z
    .boolean()
    .default(false)
    .describe('Also propose the buys that bring `to` toward its weights in that account.'),
};
const basketMoveSchema = z.object(basketMoveShape);
export type BasketMove = z.infer<typeof basketMoveSchema>;

export const ORDER_ACTIONS = ['approve', 'reject', 'undo', 'placed', 'cancel'] as const;
export const orderWriteShape = {
  ids: z.array(orderIdSchema).min(1).max(200),
  action: z
    .enum(ORDER_ACTIONS)
    .describe(
      'approve or reject a Proposed order; undo puts an Approved one back to Proposed; placed marks ' +
        'a By hand order as placed (filled); cancel drops an open one.',
    ),
};
const orderWriteSchema = z.object(orderWriteShape);

export const ORDER_STATUSES = [
  'proposed',
  'approved',
  'sent',
  'filled',
  'rejected',
  'cancelled',
  'by_hand',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
const OPEN: OrderStatus[] = ['proposed', 'approved', 'by_hand'];

export const assignShape = {
  basket: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .nullable()
    .describe("The basket's name (a new name makes a basket, Mode off); null = Unassigned."),
  symbol: holdingSchema,
  portfolio_id: portfolioIdSchema,
};
const assignSchema = z.object(assignShape);
const draftSchema = z.object({
  targets: z.record(tickerSchema, z.number().min(0).max(100)),
  sleeves: z.array(sleeveInput).max(50),
});

// ── stored rows ──

interface BasketDoc {
  name: string;
  targets: Record<string, number>;
  rebalance: Rebalance;
  drift: number;
  mode: Mode;
  created_at: string;
  updated_at: string;
  /** YYYY-MM-DD of the last proposal (or creation): a calendar rebalance is due once per period. */
  rebalanced_on: string;
  /** YYYY-MM-DD Suggest last proposed by itself, so a rejected rebalance isn't re-proposed that day. */
  auto_proposed_on: string | null;
}
interface SleeveDoc {
  shares: Record<string, number>;
  cash: number;
}
interface OrderDoc {
  basket_id: string;
  basket: string;
  portfolio_id: string;
  account: string;
  side: 'buy' | 'sell';
  symbol: string;
  qty: number;
  /** The price the order was sized at (mid when proposed): its estimate. */
  price: number;
  status: OrderStatus;
  via: 'snaptrade' | 'robinhood' | null;
  /** The send window (ISO) for an order Autopilot sends; null for By hand. */
  send_at: string | null;
  created_at: string;
  updated_at: string;
}
interface Row<T> {
  data: T;
  version: number;
}
interface State {
  v: UserVault;
  baskets: Map<string, Row<BasketDoc>>;
  sleeves: Map<string, Row<SleeveDoc>>;
  orders: Map<string, Row<OrderDoc>>;
}
const sleeveKey = (basketId: string, portfolioId: string) => `${basketId}|${portfolioId}`;
const splitKey = (k: string) => k.split('|') as [string, string];

// ── views ──

export interface Account {
  id: string;
  name: string;
  tax_type: TaxType;
  /** How orders reach it; null = read-only (orders are By hand). */
  via: 'snaptrade' | 'robinhood' | null;
  /** The person's Trading switch. */
  trade: boolean;
  /** Orders send from here: a route and the switch on. */
  tradeable: boolean;
}
export interface BasketRow {
  symbol: string;
  shares: number;
  value: number;
  target: number;
  now: number;
  drift: number;
  /** Accounts whose sleeve holds it. */
  accounts: string[];
}
export interface SleeveView {
  portfolio_id: string;
  account: string;
  tax_type: TaxType;
  tradeable: boolean;
  via: Account['via'];
  shares: Record<string, number>;
  cash: number;
  value: number;
}
export interface BasketView {
  id: string;
  name: string;
  targets: Record<string, number>;
  rebalance: Rebalance;
  drift: number;
  mode: Mode;
  created_at: string;
  updated_at: string;
  value: number;
  cash: number;
  /** Cash as a % of the basket (its target is 0). */
  cash_now: number;
  rows: BasketRow[];
  /** The largest |drift| in points, and the signed drift it has. */
  max_drift: number;
  worst_drift: number;
  due: 'calendar' | 'drift' | null;
  next_rebalance: string;
  sleeves: SleeveView[];
  open_orders: number;
  /** Every sleeve's account can trade (Mode Auto needs it, later). */
  can_auto: boolean;
}
export interface UnassignedView {
  portfolio_id: string;
  account: string;
  cash: number;
  holdings: { symbol: string; shares: number; value: number }[];
  value: number;
}
export interface Overview {
  baskets: BasketView[];
  unassigned: UnassignedView[];
  accounts: Account[];
  /** Next send window (ISO): 5 minutes after the open. */
  next_window: string;
  /** Symbols the live feed had no price for (valued at 0). */
  unpriced: string[];
  queue: number;
  to_place: number;
}
export interface OrderView extends OrderDoc {
  id: string;
}

export class BasketNotFound extends Error {
  constructor() {
    super('basket not found');
  }
}
export class OrderNotFound extends Error {
  constructor() {
    super('order not found');
  }
}
export class AutopilotInvalid extends Error {}

/** Prices for symbols (tickers, OCC options): mid, else last; null when the feed has none. */
export type PriceFeed = (symbols: string[]) => Promise<Record<string, number | null>>;

const hexId = (prefix: string) =>
  `${prefix}_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const isOption = (s: string) => Boolean(parseOccSymbol(s));
/** Contract multiplier: options are 100 shares. */
const mult = (s: string) => (isOption(s) ? 100 : 1);
/** Rebalances trade stocks only: never options or the margin line. */
const tradable = (s: string) => !isOption(s);

// ── trading calendar ──

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: number) =>
  `${Math.floor(d / 10000)}-${pad(Math.floor(d / 100) % 100)}-${pad(d % 100)}`;
const intOf = (iso: string) => Number(iso.slice(0, 10).replaceAll('-', ''));
function tradingDay(y: number, m: number, d: number) {
  const date = y * 10000 + m * 100 + d;
  return isTradingDay({ date, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), minutes: 0 });
}
/** The first trading day on or after the 1st of month `m` (1-12) of `y`, as YYYYMMDD. */
function firstTradingDay(y: number, m: number): number {
  for (let d = 1; d <= 10; d++) if (tradingDay(y, m, d)) return y * 10000 + m * 100 + d;
  return y * 10000 + m * 100 + 1;
}
const STEP: Record<Rebalance, number> = { monthly: 1, quarterly: 3, yearly: 12 };
/** The first trading day of the period holding `today`, and of the next one. */
export function periodStarts(rebalance: Rebalance, today: number) {
  const y = Math.floor(today / 10000);
  const m = Math.floor(today / 100) % 100;
  const step = STEP[rebalance];
  const m0 = Math.floor((m - 1) / step) * step + 1;
  const cur = firstTradingDay(y, m0);
  const nm = m0 + step;
  const next = nm > 12 ? firstTradingDay(y + 1, nm - 12) : firstTradingDay(y, nm);
  return { cur, next };
}
const todayInt = () => nyParts(Date.now()).date;

/** The next send window: 5 minutes after the next regular open (ISO). */
export function nextWindow(now = Date.now()): string {
  const Q = 15 * 60_000;
  const from = now - 5 * 60_000;
  let t = from;
  // Past today's window while the session is open: the next session's.
  if (isSessionOpen('options', t))
    while (isSessionOpen('options', t)) t = (Math.floor(t / Q) + 1) * Q;
  t += secondsUntilOpen('options', t) * 1000;
  return new Date(Math.round(t / 60_000) * 60_000 + 5 * 60_000).toISOString();
}

// ── the rebalance rule ──

interface PlanSleeve {
  portfolio_id: string;
  tax_type: TaxType;
  shares: Record<string, number>;
  cash: number;
}
export interface PlannedOrder {
  portfolio_id: string;
  side: 'buy' | 'sell';
  symbol: string;
  qty: number;
  price: number;
}
/**
 * Trades that bring a basket's total to its target weights: sells come out of retirement accounts
 * first (no tax), then taxable ones; buys go where the cash is (the sleeve with the most cash first).
 * Whole shares only; held symbols with no target are sold. `sells` false proposes buys only.
 */
export function planRebalance(
  sleeves: PlanSleeve[],
  targets: Record<string, number>,
  price: (s: string) => number | null,
  sells = true,
): PlannedOrder[] {
  const work = sleeves.map((s) => ({ ...s, shares: { ...s.shares } }));
  const value = (s: (typeof work)[number]) =>
    s.cash + Object.entries(s.shares).reduce((t, [k, q]) => t + q * (price(k) ?? 0) * mult(k), 0);
  const total = work.reduce((t, s) => t + value(s), 0);
  if (total <= 0) return [];
  const held = new Set(work.flatMap((s) => Object.keys(s.shares).filter((k) => s.shares[k])));
  const keys = [...new Set([...Object.keys(targets), ...held])].filter(
    (k) => tradable(k) && (price(k) ?? 0) > 0,
  );
  const diffs = keys.map((k) => {
    const have = work.reduce((t, s) => t + (s.shares[k] ?? 0), 0);
    return { k, d: ((targets[k] ?? 0) / 100) * total - have * (price(k) as number) };
  });
  const out: PlannedOrder[] = [];
  if (sells) {
    const order = [...work].sort((a, b) =>
      a.tax_type === b.tax_type ? 0 : a.tax_type === 'retirement' ? -1 : 1,
    );
    for (const { k, d } of diffs) {
      if (d >= 0) continue;
      const px = price(k) as number;
      let left = Math.floor(-d / px);
      for (const s of order) {
        if (left <= 0) break;
        const q = Math.min(Math.floor(s.shares[k] ?? 0), left);
        if (q <= 0) continue;
        out.push({ portfolio_id: s.portfolio_id, side: 'sell', symbol: k, qty: q, price: px });
        s.shares[k] = (s.shares[k] ?? 0) - q;
        s.cash += q * px;
        left -= q;
      }
    }
  }
  for (const { k, d } of [...diffs].sort((a, b) => b.d - a.d)) {
    if (d <= 0) continue;
    const px = price(k) as number;
    let left = Math.floor(d / px);
    for (const s of [...work].sort((a, b) => b.cash - a.cash)) {
      if (left <= 0) break;
      const q = Math.min(left, Math.floor(s.cash / px));
      if (q <= 0) continue;
      out.push({ portfolio_id: s.portfolio_id, side: 'buy', symbol: k, qty: q, price: px });
      s.shares[k] = (s.shares[k] ?? 0) + q;
      s.cash -= q * px;
      left -= q;
    }
  }
  return out;
}

// ── the store ──

type Holdings = Awaited<ReturnType<Portfolios['holdings']>>;
interface Legacy {
  symbol: string;
  portfolio_id: string | null;
  basket: string;
}

export class Autopilot {
  constructor(
    private readonly db: D1Like,
    private readonly vault: Vault,
    private readonly portfolios: Portfolios,
    /** How orders reach each account; without it (no SnapTrade) every order is By hand. */
    private readonly tradeable?: (
      owner: string,
    ) => Promise<Map<string, { via: 'snaptrade' | 'robinhood' | null; trade: boolean }>>,
  ) {}

  private async load(owner: string): Promise<State> {
    const v = await this.vault.for(owner);
    const [b, s, o] = await Promise.all([
      this.db
        .prepare('SELECT id, data, version FROM baskets WHERE owner = ?')
        .bind(v.owner)
        .all<{ id: string; data: string; version: number }>(),
      this.db
        .prepare(
          `SELECT s.basket_id, s.portfolio_id, s.data, s.version FROM basket_sleeves s
             JOIN baskets b ON b.id = s.basket_id WHERE b.owner = ?`,
        )
        .bind(v.owner)
        .all<{ basket_id: string; portfolio_id: string; data: string; version: number }>(),
      this.db
        .prepare('SELECT id, data, version FROM basket_orders WHERE owner = ? ORDER BY at DESC')
        .bind(v.owner)
        .all<{ id: string; data: string; version: number }>(),
    ]);
    const open = async <T>(aad: string, data: string, version: number): Promise<Row<T>> => ({
      data: await v.open<T>(aad, data),
      version: Number(version),
    });
    return {
      v,
      baskets: new Map(
        await Promise.all(
          b.results.map(
            async (r) =>
              [r.id, await open<BasketDoc>(`baskets:${r.id}`, r.data, r.version)] as const,
          ),
        ),
      ),
      sleeves: new Map(
        await Promise.all(
          s.results.map(
            async (r) =>
              [
                sleeveKey(r.basket_id, r.portfolio_id),
                await open<SleeveDoc>(
                  `basket_sleeves:${r.basket_id}:${r.portfolio_id}`,
                  r.data,
                  r.version,
                ),
              ] as const,
          ),
        ),
      ),
      orders: new Map(
        await Promise.all(
          o.results.map(
            async (r) =>
              [r.id, await open<OrderDoc>(`basket_orders:${r.id}`, r.data, r.version)] as const,
          ),
        ),
      ),
    };
  }

  // Writes: each guarded by its row's version, all in one batch (a lost race rolls it all back).
  private cas(
    table: string,
    where: string,
    key: unknown[],
    data: string,
    version: number,
    extra = '',
  ) {
    return this.db
      .prepare(
        `UPDATE ${table} SET data = ?${extra}, version = CASE WHEN version = ? THEN version + 1 END
          WHERE ${where}`,
      )
      .bind(data, version, ...key);
  }
  private async putBasket(st: State, id: string, doc: BasketDoc, version: number) {
    const data = await st.v.seal(`baskets:${id}`, doc);
    const nameKey = await st.v.index(`basket:${doc.name.toLowerCase()}`);
    if (version === 0)
      return this.db
        .prepare('INSERT INTO baskets (id, owner, name_key, data, version) VALUES (?, ?, ?, ?, 1)')
        .bind(id, st.v.owner, nameKey, data);
    return this.db
      .prepare(
        `UPDATE baskets SET data = ?, name_key = ?, version = CASE WHEN version = ? THEN version + 1 END
          WHERE id = ? AND owner = ?`,
      )
      .bind(data, nameKey, version, id, st.v.owner);
  }
  private async putSleeve(st: State, basketId: string, portfolioId: string, doc: SleeveDoc) {
    const have = st.sleeves.get(sleeveKey(basketId, portfolioId));
    const data = await st.v.seal(`basket_sleeves:${basketId}:${portfolioId}`, doc);
    if (!have)
      return this.db
        .prepare(
          'INSERT INTO basket_sleeves (basket_id, portfolio_id, data, version) VALUES (?, ?, ?, 1)',
        )
        .bind(basketId, portfolioId, data);
    return this.cas(
      'basket_sleeves',
      'basket_id = ? AND portfolio_id = ?',
      [basketId, portfolioId],
      data,
      have.version,
    );
  }
  private delSleeve(basketId: string, portfolioId: string) {
    return this.db
      .prepare('DELETE FROM basket_sleeves WHERE basket_id = ? AND portfolio_id = ?')
      .bind(basketId, portfolioId);
  }
  private async putOrder(st: State, id: string, doc: OrderDoc) {
    const have = st.orders.get(id);
    const data = await st.v.seal(`basket_orders:${id}`, doc);
    if (!have)
      return this.db
        .prepare('INSERT INTO basket_orders (id, owner, at, data, version) VALUES (?, ?, ?, ?, 1)')
        .bind(id, st.v.owner, Date.parse(doc.created_at), data);
    return this.cas('basket_orders', 'id = ? AND owner = ?', [id, st.v.owner], data, have.version);
  }
  private async run(stmts: D1Statement[]) {
    for (let i = 0; i < stmts.length; i += 50) await this.db.batch(stmts.slice(i, i + 50));
  }

  /** Read, change, write, retried when another write got there first. */
  private mutate<T>(owner: string, fn: (st: State) => Promise<{ stmts: D1Statement[]; out: T }>) {
    return withRetry(async () => {
      const st = await this.load(owner);
      const { stmts, out } = await fn(st);
      // One batch keeps the version checks all-or-nothing.
      if (stmts.length) await this.db.batch(stmts);
      return out;
    });
  }

  // ── legacy tags ──

  /** Turns the person's old `position_baskets` tags into baskets with sleeves (whole holdings), once. */
  private async migrateTags(owner: string, holdings: Holdings) {
    const v = await this.vault.for(owner);
    const row = await this.db
      .prepare('SELECT data FROM position_baskets WHERE owner = ?')
      .bind(v.owner)
      .first<{ data: string }>();
    if (!row) return;
    const tags = await v.open<Legacy[]>(`position_baskets:${v.owner}`, row.data);
    await this.mutate(owner, async (st) => {
      const stmts: D1Statement[] = [];
      const now = new Date().toISOString();
      const byName = new Map([...st.baskets].map(([id, b]) => [b.data.name.toLowerCase(), id]));
      const sleeves = new Map<string, SleeveDoc>();
      for (const t of tags) {
        let id = byName.get(t.basket.toLowerCase());
        if (!id) {
          id = hexId('bk');
          byName.set(t.basket.toLowerCase(), id);
          const doc: BasketDoc = {
            name: t.basket,
            targets: {},
            rebalance: 'quarterly',
            drift: 0,
            mode: 'off',
            created_at: now,
            updated_at: now,
            rebalanced_on: now.slice(0, 10),
            auto_proposed_on: null,
          };
          stmts.push(await this.putBasket(st, id, doc, 0));
        }
        for (const a of holdings) {
          if (t.portfolio_id !== null && t.portfolio_id !== a.id) continue;
          const p = a.positions.find((x) => holdingSymbol(x) === t.symbol);
          if (!p || p.quantity <= 0) continue;
          const key = sleeveKey(id, a.id);
          const sl = sleeves.get(key) ?? st.sleeves.get(key)?.data ?? { shares: {}, cash: 0 };
          sleeves.set(key, { ...sl, shares: { ...sl.shares, [t.symbol]: p.quantity } });
        }
      }
      for (const [key, doc] of sleeves) {
        const [b, p] = splitKey(key);
        stmts.push(await this.putSleeve(st, b, p, doc));
      }
      stmts.push(this.db.prepare('DELETE FROM position_baskets WHERE owner = ?').bind(v.owner));
      return { stmts, out: null };
    });
  }

  // ── reading ──

  private async context(owner: string, price: PriceFeed) {
    const holdings = await this.portfolios.holdings(owner);
    await this.migrateTags(owner, holdings);
    const [st, routes] = await Promise.all([
      this.load(owner),
      this.tradeable ? this.tradeable(owner).catch(() => new Map()) : Promise.resolve(new Map()),
    ]);
    const accounts: Account[] = holdings.map((a) => {
      const r = routes.get(a.id) as { via: Account['via']; trade: boolean } | undefined;
      return {
        id: a.id,
        name: a.name,
        tax_type: a.tax_type,
        via: r?.via ?? null,
        trade: r?.trade ?? false,
        tradeable: Boolean(r?.via && r.trade),
      };
    });
    const symbols = new Set<string>();
    for (const a of holdings) for (const p of a.positions) symbols.add(holdingSymbol(p));
    for (const b of st.baskets.values())
      for (const k of Object.keys(b.data.targets)) symbols.add(k);
    for (const s of st.sleeves.values()) for (const k of Object.keys(s.data.shares)) symbols.add(k);
    const prices = symbols.size ? await price([...symbols]) : {};
    const px = (s: string) => prices[s] ?? null;
    return { st, holdings, accounts, px, unpriced: [...symbols].filter((s) => !prices[s]) };
  }

  /**
   * Each sleeve as it stands: its shares capped at what the account still holds (a sale at the
   * broker takes shares out of the oldest basket's sleeve last), its cash as stored.
   */
  private effective(st: State, holdings: Holdings) {
    const held = new Map<string, number>();
    for (const a of holdings)
      for (const p of a.positions) held.set(`${a.id}|${holdingSymbol(p)}`, p.quantity);
    const order = [...st.baskets].sort((a, b) =>
      a[1].data.created_at < b[1].data.created_at ? -1 : 1,
    );
    const used = new Map<string, number>();
    const out = new Map<string, SleeveDoc>();
    for (const [bid] of order)
      for (const [key, row] of st.sleeves) {
        const [b, p] = splitKey(key);
        if (b !== bid) continue;
        const shares: Record<string, number> = {};
        for (const [k, q] of Object.entries(row.data.shares)) {
          const hk = `${p}|${k}`;
          const left = Math.max(0, (held.get(hk) ?? 0) - (used.get(hk) ?? 0));
          const take = Math.min(q, left);
          used.set(hk, (used.get(hk) ?? 0) + take);
          if (take > 0) shares[k] = take;
        }
        out.set(key, { shares, cash: row.data.cash });
      }
    return { sleeves: out, used };
  }

  private view(
    st: State,
    id: string,
    sleeves: Map<string, SleeveDoc>,
    accounts: Account[],
    px: (s: string) => number | null,
    today: number,
  ): BasketView {
    const b = (st.baskets.get(id) as Row<BasketDoc>).data;
    const acct = new Map(accounts.map((a) => [a.id, a]));
    const mine = [...sleeves].filter(([k]) => splitKey(k)[0] === id);
    const val = (k: string, q: number) => q * (px(k) ?? 0) * mult(k);
    const sv: SleeveView[] = mine.map(([k, s]) => {
      const p = splitKey(k)[1];
      const a = acct.get(p);
      return {
        portfolio_id: p,
        account: a?.name ?? p,
        tax_type: a?.tax_type ?? 'taxable',
        tradeable: a?.tradeable ?? false,
        via: a?.via ?? null,
        shares: s.shares,
        cash: round(s.cash),
        value: round(s.cash + Object.entries(s.shares).reduce((t, [x, q]) => t + val(x, q), 0)),
      };
    });
    const cash = sv.reduce((t, s) => t + s.cash, 0);
    const total = sv.reduce((t, s) => t + s.value, 0);
    const syms = [
      ...new Set([...Object.keys(b.targets), ...sv.flatMap((s) => Object.keys(s.shares))]),
    ];
    const rows: BasketRow[] = syms.map((k) => {
      const shares = sv.reduce((t, s) => t + (s.shares[k] ?? 0), 0);
      const value = val(k, shares);
      const target = b.targets[k] ?? 0;
      const now = total ? (value / total) * 100 : 0;
      return {
        symbol: k,
        shares,
        value: round(value),
        target,
        now: round(now),
        drift: round(total ? now - target : 0),
        accounts: sv.filter((s) => s.shares[k]).map((s) => s.portfolio_id),
      };
    });
    const hasTargets = Object.keys(b.targets).length > 0;
    const worst = rows.reduce((w, r) => (Math.abs(r.drift) > Math.abs(w) ? r.drift : w), 0);
    const { cur, next } = periodStarts(b.rebalance, today);
    const due: BasketView['due'] =
      !hasTargets || total <= 0
        ? null
        : today >= cur && intOf(b.rebalanced_on) < cur
          ? 'calendar'
          : b.drift > 0 && Math.abs(worst) > b.drift
            ? 'drift'
            : null;
    const open = [...st.orders.values()].filter(
      (o) => o.data.basket_id === id && OPEN.includes(o.data.status),
    ).length;
    return {
      id,
      name: b.name,
      targets: b.targets,
      rebalance: b.rebalance,
      drift: b.drift,
      mode: b.mode,
      created_at: b.created_at,
      updated_at: b.updated_at,
      value: round(total),
      cash: round(cash),
      cash_now: round(total ? (cash / total) * 100 : 0),
      rows,
      max_drift: round(Math.abs(worst)),
      worst_drift: round(worst),
      due,
      next_rebalance: isoOf(today >= cur && intOf(b.rebalanced_on) < cur ? cur : next),
      sleeves: sv,
      open_orders: open,
      can_auto: sv.length > 0 && sv.every((s) => s.tradeable),
    };
  }

  /** Every basket with its sleeves, drift and rebalance state, plus Unassigned per account. */
  async overview(owner: string, price: PriceFeed): Promise<Overview> {
    let ctx = await this.context(owner, price);
    // Suggest: a due basket with nothing open proposes its own orders, once a day.
    const today = todayInt();
    const { sleeves } = this.effective(ctx.st, ctx.holdings);
    const due = [...ctx.st.baskets.keys()].filter((id) => {
      const b = ctx.st.baskets.get(id) as Row<BasketDoc>;
      if (b.data.mode !== 'suggest' || b.data.auto_proposed_on === isoOf(today)) return false;
      const v = this.view(ctx.st, id, sleeves, ctx.accounts, ctx.px, today);
      return v.due !== null && v.open_orders === 0;
    });
    if (due.length) {
      for (const id of due) await this.propose(owner, id, ctx, { auto: true });
      ctx = { ...ctx, st: await this.load(owner) };
    }
    return this.build(ctx);
  }

  private build(ctx: Awaited<ReturnType<Autopilot['context']>>): Overview {
    const { st, holdings, accounts, px } = ctx;
    const today = todayInt();
    const { sleeves, used } = this.effective(st, holdings);
    const baskets = [...st.baskets.keys()]
      .map((id) => this.view(st, id, sleeves, accounts, px, today))
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const sleeveCash = new Map<string, number>();
    for (const [k, s] of sleeves) {
      const p = splitKey(k)[1];
      sleeveCash.set(p, (sleeveCash.get(p) ?? 0) + s.cash);
    }
    const unassigned: UnassignedView[] = holdings.map((a) => {
      const list = a.positions
        .map((p) => {
          const s = holdingSymbol(p);
          const shares = p.quantity - (used.get(`${a.id}|${s}`) ?? 0);
          return { symbol: s, shares, value: round(shares * (px(s) ?? 0) * mult(s)) };
        })
        .filter((h) => h.shares !== 0);
      const cash = round(a.cash - (sleeveCash.get(a.id) ?? 0));
      return {
        portfolio_id: a.id,
        account: a.name,
        cash,
        holdings: list,
        value: round(cash + list.reduce((t, h) => t + h.value, 0)),
      };
    });
    const orders = [...st.orders.values()].map((o) => o.data);
    return {
      baskets,
      unassigned,
      accounts,
      next_window: nextWindow(),
      unpriced: ctx.unpriced,
      queue: orders.filter((o) => o.status === 'proposed' || o.status === 'approved').length,
      to_place: orders.filter((o) => o.status === 'by_hand').length,
    };
  }

  async read(owner: string, id: string, price: PriceFeed) {
    const o = await this.overview(owner, price);
    const b = o.baskets.find((x) => x.id === id);
    if (!b) throw new BasketNotFound();
    return {
      ...b,
      unassigned: o.unassigned,
      accounts: o.accounts,
      next_window: o.next_window,
    };
  }

  /**
   * The trades a rebalance would propose now, without queuing them; with `extra`, the buys Move cash
   * would propose in that account after moving that much in.
   */
  async preview(
    owner: string,
    id: string,
    price: PriceFeed,
    extra?: { portfolio_id: string; cash: number },
  ) {
    const ctx = await this.context(owner, price);
    if (!ctx.st.baskets.has(id)) throw new BasketNotFound();
    const planned = this.plan(ctx, id, !extra, extra);
    return this.labelled(
      ctx,
      extra ? planned.filter((o) => o.portfolio_id === extra.portfolio_id) : planned,
    );
  }

  /** The trades a basket being set up would start with (setup step 3), saving nothing. */
  async draft(owner: string, input: z.infer<typeof draftSchema>, price: PriceFeed) {
    const ctx = await this.context(owner, price);
    const tax = new Map(ctx.accounts.map((a) => [a.id, a.tax_type]));
    const sleeves = input.sleeves.map((s) => ({
      portfolio_id: s.portfolio_id,
      tax_type: tax.get(s.portfolio_id) ?? ('taxable' as TaxType),
      shares: s.shares,
      cash: s.cash,
    }));
    return this.labelled(ctx, planRebalance(sleeves, input.targets, ctx.px, true));
  }

  private labelled(ctx: Awaited<ReturnType<Autopilot['context']>>, planned: PlannedOrder[]) {
    return planned.map((o) => {
      const a = ctx.accounts.find((x) => x.id === o.portfolio_id);
      return { ...o, account: a?.name ?? o.portfolio_id, by_hand: !a?.tradeable };
    });
  }

  private plan(
    ctx: Awaited<ReturnType<Autopilot['context']>>,
    id: string,
    sells: boolean,
    extra?: { portfolio_id: string; cash: number },
  ) {
    const b = ctx.st.baskets.get(id) as Row<BasketDoc>;
    if (!Object.keys(b.data.targets).length) return [];
    const { sleeves } = this.effective(ctx.st, ctx.holdings);
    const tax = new Map(ctx.accounts.map((a) => [a.id, a.tax_type]));
    const mine = [...sleeves]
      .filter(([k]) => splitKey(k)[0] === id)
      .map(([k, s]) => {
        const p = splitKey(k)[1];
        return {
          portfolio_id: p,
          tax_type: tax.get(p) ?? ('taxable' as TaxType),
          shares: s.shares,
          cash: s.cash + (extra?.portfolio_id === p ? extra.cash : 0),
        };
      });
    if (extra && !mine.some((s) => s.portfolio_id === extra.portfolio_id))
      mine.push({
        portfolio_id: extra.portfolio_id,
        tax_type: tax.get(extra.portfolio_id) ?? 'taxable',
        shares: {},
        cash: extra.cash,
      });
    return planRebalance(mine, b.data.targets, ctx.px, sells);
  }

  /** Writes `planned` as the basket's orders, cancelling the ones it had open. */
  private async queue(st: State, id: string, planned: PlannedOrder[], accounts: Account[]) {
    const stmts: D1Statement[] = [];
    const now = new Date().toISOString();
    const b = st.baskets.get(id) as Row<BasketDoc>;
    for (const [oid, o] of st.orders)
      if (o.data.basket_id === id && OPEN.includes(o.data.status))
        stmts.push(
          await this.putOrder(st, oid, { ...o.data, status: 'cancelled', updated_at: now }),
        );
    const window = nextWindow();
    for (const p of planned) {
      const a = accounts.find((x) => x.id === p.portfolio_id);
      const send = Boolean(a?.tradeable);
      stmts.push(
        await this.putOrder(st, hexId('od'), {
          basket_id: id,
          basket: b.data.name,
          portfolio_id: p.portfolio_id,
          account: a?.name ?? p.portfolio_id,
          side: p.side,
          symbol: p.symbol,
          qty: p.qty,
          price: round(p.price, 4),
          status: send ? 'proposed' : 'by_hand',
          via: a?.via ?? null,
          send_at: send ? window : null,
          created_at: now,
          updated_at: now,
        }),
      );
    }
    return stmts;
  }

  /** Proposes a rebalance's orders (replacing the basket's open ones). Returns them. */
  async rebalance(owner: string, id: string, price: PriceFeed) {
    const ctx = await this.context(owner, price);
    if (!ctx.st.baskets.has(id)) throw new BasketNotFound();
    if (!Object.keys((ctx.st.baskets.get(id) as Row<BasketDoc>).data.targets).length)
      throw new AutopilotInvalid("set the basket's target weights first");
    return this.propose(owner, id, ctx, { auto: false });
  }

  private async propose(
    owner: string,
    id: string,
    ctx: Awaited<ReturnType<Autopilot['context']>>,
    opts: { auto: boolean },
  ) {
    const planned = this.plan(ctx, id, true);
    await this.mutate(owner, async (st) => {
      const b = st.baskets.get(id);
      if (!b) throw new BasketNotFound();
      const today = isoOf(todayInt());
      const stmts = await this.queue(st, id, planned, ctx.accounts);
      stmts.push(
        await this.putBasket(
          st,
          id,
          {
            ...b.data,
            rebalanced_on: today,
            auto_proposed_on: opts.auto ? today : b.data.auto_proposed_on,
          },
          b.version,
        ),
      );
      return { stmts, out: null };
    });
    return this.orders(owner, { basket_id: id, open: true });
  }

  // ── writing ──

  /** Creates or changes a basket; `sleeves` (when given) replaces its sleeves. */
  async write(owner: string, input: BasketWrite, price: PriceFeed): Promise<BasketView> {
    const ctx = await this.context(owner, price);
    const targets = input.targets;
    if (targets && Object.keys(targets).length) {
      const sum = Object.values(targets).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) > 0.05)
        throw new AutopilotInvalid(`target weights add up to ${round(sum, 1)}%; make them 100%`);
    }
    const id = await this.mutate(owner, async (st) => {
      const now = new Date().toISOString();
      const have = input.id ? st.baskets.get(input.id) : undefined;
      if (input.id && !have) throw new BasketNotFound();
      const name = input.name ?? have?.data.name;
      if (!name) throw new AutopilotInvalid('a new basket needs a name');
      const clash = [...st.baskets].find(
        ([bid, b]) => bid !== input.id && b.data.name.toLowerCase() === name.toLowerCase(),
      );
      if (clash)
        throw new AutopilotInvalid(`you already have a basket named ${clash[1].data.name}`);
      const bid = input.id ?? hexId('bk');
      const doc: BasketDoc = {
        name,
        targets: targets ?? have?.data.targets ?? {},
        rebalance: input.rebalance ?? have?.data.rebalance ?? 'quarterly',
        drift: input.drift ?? have?.data.drift ?? 0,
        mode: input.mode ?? have?.data.mode ?? 'suggest',
        created_at: have?.data.created_at ?? now,
        updated_at: now,
        rebalanced_on: have?.data.rebalanced_on ?? now.slice(0, 10),
        auto_proposed_on: have?.data.auto_proposed_on ?? null,
      };
      const stmts = [await this.putBasket(st, bid, doc, have?.version ?? 0)];
      if (input.sleeves)
        stmts.push(...(await this.setSleeves(st, ctx.holdings, bid, input.sleeves)));
      return { stmts, out: bid };
    });
    return this.read(owner, id, price);
  }

  /** Replaces a basket's sleeves, checking each against what the account has unassigned. */
  private async setSleeves(
    st: State,
    holdings: Holdings,
    bid: string,
    list: z.infer<typeof sleeveInput>[],
  ) {
    const stmts: D1Statement[] = [];
    const others = new Map(st.sleeves);
    for (const k of others.keys()) if (splitKey(k)[0] === bid) others.delete(k);
    const { sleeves: eff } = this.effective({ ...st, sleeves: others }, holdings);
    const seen = new Set<string>();
    for (const s of list) {
      if (seen.has(s.portfolio_id)) throw new AutopilotInvalid('one sleeve per account');
      seen.add(s.portfolio_id);
      const a = holdings.find((x) => x.id === s.portfolio_id);
      if (!a) throw new AutopilotInvalid(`no account ${s.portfolio_id}`);
      for (const [k, q] of Object.entries(s.shares)) {
        if (q <= 0) continue;
        const held = a.positions.find((p) => holdingSymbol(p) === k)?.quantity ?? 0;
        const taken = [...eff]
          .filter(([key]) => splitKey(key)[1] === a.id)
          .reduce((t, [, x]) => t + (x.shares[k] ?? 0), 0);
        if (q > held - taken + 1e-9)
          throw new AutopilotInvalid(
            `${a.name} has ${round(held - taken, 4)} ${k} unassigned; ${q} asked`,
          );
      }
      const otherCash = [...eff]
        .filter(([key]) => splitKey(key)[1] === a.id)
        .reduce((t, [, x]) => t + x.cash, 0);
      if (s.cash > a.cash - otherCash + 0.005)
        throw new AutopilotInvalid(
          `${a.name} has $${round(a.cash - otherCash)} unassigned cash; $${s.cash} asked`,
        );
      const shares = Object.fromEntries(Object.entries(s.shares).filter(([, q]) => q > 0));
      stmts.push(await this.putSleeve(st, bid, s.portfolio_id, { shares, cash: s.cash }));
    }
    for (const k of st.sleeves.keys()) {
      const [b, p] = splitKey(k);
      if (b === bid && !seen.has(p)) stmts.push(this.delSleeve(b, p));
    }
    return stmts;
  }

  /** Deletes a basket: its shares and cash go back to Unassigned, its open orders are cancelled. */
  async delete(owner: string, id: string) {
    await this.mutate(owner, async (st) => {
      if (!st.baskets.has(id)) throw new BasketNotFound();
      const now = new Date().toISOString();
      const stmts: D1Statement[] = [];
      for (const [oid, o] of st.orders)
        if (o.data.basket_id === id && OPEN.includes(o.data.status))
          stmts.push(
            await this.putOrder(st, oid, { ...o.data, status: 'cancelled', updated_at: now }),
          );
      stmts.push(
        this.db.prepare('DELETE FROM baskets WHERE id = ? AND owner = ?').bind(id, st.v.owner),
      );
      return { stmts, out: null };
    });
  }

  /** Moves cash between a basket's sleeve and another (or Unassigned) inside one account. */
  async move(owner: string, m: BasketMove, price: PriceFeed) {
    if (m.from === m.to) throw new AutopilotInvalid('from and to are the same');
    const ctx = await this.context(owner, price);
    const a = ctx.holdings.find((x) => x.id === m.portfolio_id);
    if (!a) throw new AutopilotInvalid(`no account ${m.portfolio_id}`);
    for (const b of [m.from, m.to]) if (b && !ctx.st.baskets.has(b)) throw new BasketNotFound();
    const planned =
      m.propose && m.to ? this.plan(ctx, m.to, false, { portfolio_id: a.id, cash: m.amount }) : [];
    await this.mutate(owner, async (st) => {
      const { sleeves } = this.effective(st, ctx.holdings);
      const stmts: D1Statement[] = [];
      if (m.from) {
        const s = sleeves.get(sleeveKey(m.from, a.id));
        if (!s || s.cash + 0.005 < m.amount)
          throw new AutopilotInvalid(`that sleeve has $${round(s?.cash ?? 0)} cash`);
        const stored = (st.sleeves.get(sleeveKey(m.from, a.id)) as Row<SleeveDoc>).data;
        stmts.push(
          await this.putSleeve(st, m.from, a.id, {
            ...stored,
            cash: round(stored.cash - m.amount),
          }),
        );
      } else {
        const inSleeves = [...sleeves]
          .filter(([k]) => splitKey(k)[1] === a.id)
          .reduce((t, [, s]) => t + s.cash, 0);
        if (a.cash - inSleeves + 0.005 < m.amount)
          throw new AutopilotInvalid(`${a.name} has $${round(a.cash - inSleeves)} unassigned cash`);
      }
      if (m.to) {
        const stored = st.sleeves.get(sleeveKey(m.to, a.id))?.data ?? { shares: {}, cash: 0 };
        stmts.push(
          await this.putSleeve(st, m.to, a.id, { ...stored, cash: round(stored.cash + m.amount) }),
        );
        if (m.propose) {
          // Buys for this account only; the basket's other open orders are replaced.
          stmts.push(
            ...(await this.queue(
              st,
              m.to,
              planned.filter((o) => o.portfolio_id === a.id),
              ctx.accounts,
            )),
          );
        }
      }
      return { stmts, out: null };
    });
    return this.overview(owner, price);
  }

  /**
   * The holdings table's Basket cell: moves one holding (every share of it the account holds) into
   * the named basket's sleeve, making the basket when the name is new; null puts it back in Unassigned.
   */
  async assign(owner: string, input: z.infer<typeof assignSchema>) {
    const holdings = await this.portfolios.holdings(owner);
    await this.migrateTags(owner, holdings);
    const a = holdings.find((x) => x.id === input.portfolio_id);
    if (!a) throw new AutopilotInvalid(`no account ${input.portfolio_id}`);
    const qty = a.positions.find((p) => holdingSymbol(p) === input.symbol)?.quantity ?? 0;
    await this.mutate(owner, async (st) => {
      const stmts: D1Statement[] = [];
      const now = new Date().toISOString();
      let target: string | null = null;
      if (input.basket) {
        const name = input.basket;
        target =
          [...st.baskets].find(([, b]) => b.data.name.toLowerCase() === name.toLowerCase())?.[0] ??
          null;
        if (!target) {
          target = hexId('bk');
          stmts.push(
            await this.putBasket(
              st,
              target,
              {
                name,
                targets: {},
                rebalance: 'quarterly',
                drift: 0,
                mode: 'off',
                created_at: now,
                updated_at: now,
                rebalanced_on: now.slice(0, 10),
                auto_proposed_on: null,
              },
              0,
            ),
          );
        }
      }
      for (const [k, row] of st.sleeves) {
        const [b, p] = splitKey(k);
        if (p !== a.id || b === target || !(input.symbol in row.data.shares)) continue;
        const { [input.symbol]: _, ...rest } = row.data.shares;
        stmts.push(await this.putSleeve(st, b, p, { ...row.data, shares: rest }));
      }
      if (target && qty > 0) {
        const stored = st.sleeves.get(sleeveKey(target, a.id))?.data ?? { shares: {}, cash: 0 };
        stmts.push(
          await this.putSleeve(st, target, a.id, {
            ...stored,
            shares: { ...stored.shares, [input.symbol]: qty },
          }),
        );
      }
      return { stmts, out: null };
    });
  }

  /** The holdings Basket field: every symbol a sleeve holds, by account (whole holdings view). */
  async tags(owner: string) {
    const holdings = await this.portfolios.holdings(owner);
    await this.migrateTags(owner, holdings);
    const st = await this.load(owner);
    const { sleeves } = this.effective(st, holdings);
    const out: { symbol: string; portfolio_id: string | null; basket: string }[] = [];
    for (const [k, s] of sleeves) {
      const [b, p] = splitKey(k);
      const name = st.baskets.get(b)?.data.name;
      if (name)
        for (const sym of Object.keys(s.shares))
          out.push({ symbol: sym, portfolio_id: p, basket: name });
    }
    return out;
  }

  // ── orders ──

  async orders(
    owner: string,
    q: { status?: OrderStatus[]; basket_id?: string; open?: boolean } = {},
  ): Promise<OrderView[]> {
    const st = await this.load(owner);
    return [...st.orders]
      .map(([id, o]) => ({ id, ...o.data }))
      .filter(
        (o) =>
          (!q.status || q.status.includes(o.status)) &&
          (!q.basket_id || o.basket_id === q.basket_id) &&
          (!q.open || OPEN.includes(o.status)),
      );
  }

  async order(owner: string, id: string): Promise<OrderView> {
    const st = await this.load(owner);
    const o = st.orders.get(id);
    if (!o) throw new OrderNotFound();
    return { id, ...o.data };
  }

  /** Approve, reject, undo, placed (By hand) or cancel. Placed moves the shares into the sleeve. */
  async act(owner: string, ids: string[], action: (typeof ORDER_ACTIONS)[number]) {
    const from: Record<typeof action, OrderStatus[]> = {
      approve: ['proposed'],
      reject: ['proposed'],
      undo: ['approved'],
      placed: ['by_hand'],
      cancel: OPEN,
    };
    const to: Record<typeof action, OrderStatus> = {
      approve: 'approved',
      reject: 'rejected',
      undo: 'proposed',
      placed: 'filled',
      cancel: 'cancelled',
    };
    await this.mutate(owner, async (st) => {
      const now = new Date().toISOString();
      const stmts: D1Statement[] = [];
      const sleeves = new Map<string, SleeveDoc>();
      for (const id of ids) {
        const o = st.orders.get(id);
        if (!o) throw new OrderNotFound();
        if (!from[action].includes(o.data.status))
          throw new AutopilotInvalid(`order ${id} is ${o.data.status.replace('_', ' ')}`);
        stmts.push(await this.putOrder(st, id, { ...o.data, status: to[action], updated_at: now }));
        if (action === 'placed' && st.baskets.has(o.data.basket_id)) {
          const key = sleeveKey(o.data.basket_id, o.data.portfolio_id);
          const s = sleeves.get(key) ?? st.sleeves.get(key)?.data ?? { shares: {}, cash: 0 };
          const sign = o.data.side === 'buy' ? 1 : -1;
          const q = Math.max(0, (s.shares[o.data.symbol] ?? 0) + sign * o.data.qty);
          sleeves.set(key, {
            shares: { ...s.shares, [o.data.symbol]: q },
            cash: round(s.cash - sign * o.data.qty * o.data.price),
          });
        }
      }
      for (const [k, s] of sleeves) {
        const [b, p] = splitKey(k);
        stmts.push(await this.putSleeve(st, b, p, s));
      }
      return { stmts, out: null };
    });
    return Promise.all(ids.map((id) => this.order(owner, id)));
  }
}

/** A position's holdings symbol: the ticker, or the OCC symbol for an option. */
const holdingSymbol = (p: Position) => p.symbol;

// ── REST ──

type Env = { Variables: { identity?: AccessIdentity } };
const invalid = (issues: z.ZodIssue[]) => ({
  error: 'invalid input',
  issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
});

/**
 * REST (signed in): `/api/baskets` and `/api/orders`. MCP mirrors them (basket_*, order_*).
 * `priceFor` gives the caller's live feed (their own Alpaca key when set).
 */
export function autopilotRoutes(ap: Autopilot, priceFor: (owner: string) => PriceFeed) {
  const owner = (c: Context<Env>) => portfolioOwner(c.get('identity'));
  const errors = (r: Hono<Env>) =>
    r.onError((err, c) => {
      if (err instanceof BasketNotFound || err instanceof OrderNotFound)
        return c.json({ error: err.message }, 404);
      if (err instanceof AutopilotInvalid) return c.json({ error: err.message }, 400);
      throw err;
    });
  const baskets = new Hono<Env>();
  errors(baskets);
  baskets.get('/', async (c) => c.json(await ap.overview(owner(c), priceFor(owner(c)))));
  baskets.post('/', async (c) => {
    const body = basketWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    return c.json(await ap.write(owner(c), { ...body.data, id: undefined }, priceFor(owner(c))));
  });
  baskets.post('/move', async (c) => {
    const body = basketMoveSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    return c.json(await ap.move(owner(c), body.data, priceFor(owner(c))));
  });
  baskets.post('/assign', async (c) => {
    const body = assignSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    await ap.assign(owner(c), body.data);
    return c.json({ ok: true });
  });
  baskets.get('/:id', async (c) =>
    c.json(await ap.read(owner(c), c.req.param('id'), priceFor(owner(c)))),
  );
  baskets.post('/draft', async (c) => {
    const body = draftSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    return c.json(await ap.draft(owner(c), body.data, priceFor(owner(c))));
  });
  baskets.get('/:id/preview', async (c) => {
    const pid = c.req.query('portfolio_id');
    const cash = Number(c.req.query('cash'));
    const extra =
      pid && Number.isFinite(cash) && cash >= 0 ? { portfolio_id: pid, cash } : undefined;
    return c.json(await ap.preview(owner(c), c.req.param('id'), priceFor(owner(c)), extra));
  });
  baskets.put('/:id', async (c) => {
    const body = basketWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    return c.json(
      await ap.write(owner(c), { ...body.data, id: c.req.param('id') }, priceFor(owner(c))),
    );
  });
  baskets.delete('/:id', async (c) => {
    await ap.delete(owner(c), c.req.param('id'));
    return c.json({ ok: true });
  });
  baskets.post('/:id/rebalance', async (c) =>
    c.json(await ap.rebalance(owner(c), c.req.param('id'), priceFor(owner(c)))),
  );

  const orders = new Hono<Env>();
  errors(orders);
  orders.get('/', async (c) => {
    const status = c.req.query('status')?.split(',').filter(Boolean) as OrderStatus[] | undefined;
    if (status?.some((s) => !ORDER_STATUSES.includes(s)))
      return c.json({ error: `status: ${ORDER_STATUSES.join(', ')}` }, 400);
    return c.json(await ap.orders(owner(c), { status, basket_id: c.req.query('basket_id') }));
  });
  orders.get('/:id', async (c) => c.json(await ap.order(owner(c), c.req.param('id'))));
  orders.post('/', async (c) => {
    const body = orderWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    return c.json(await ap.act(owner(c), body.data.ids, body.data.action));
  });
  return { baskets, orders };
}

/** Prices from a quotes response: mid when both sides are there, else last. */
export function priceFeed(
  quotes: (symbols: string[]) => Promise<{
    quotes: Record<
      string,
      { last?: number | null; bid?: number | null; ask?: number | null; mid?: number | null } | null
    >;
  }>,
): PriceFeed {
  return async (symbols) => {
    const { quotes: q } = await quotes(symbols);
    return Object.fromEntries(
      symbols.map((s) => {
        const x = q[s];
        const mid =
          x?.mid ?? (x?.bid && x?.ask && x.bid > 0 && x.ask > 0 ? (x.bid + x.ask) / 2 : null);
        return [s, mid ?? x?.last ?? null];
      }),
    );
  };
}
