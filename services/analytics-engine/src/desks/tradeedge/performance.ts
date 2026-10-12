/**
 * Portfolio ▸ Performance (Bikram, 2026-10-12; design /mnt/project-files/holdings-history/design.md):
 * what the selected accounts were worth each day, the money put in, and the time-weighted return next
 * to any symbol's total return. Worked out on each read from the person's own ledger and daily closes;
 * nothing is stored or cached.
 *
 * 1. Shares per symbol per day: walk back from what is held now through the transactions (buys, sells,
 *    transfers), undoing stock splits on their ex-date, so the history always ends at today's holdings.
 *    Options walk forward from their trades instead and leave on expiry (brokers send no expiry row).
 * 2. Cash per day: walk back from today's signed cash through every transaction's amount.
 * 3. Value = shares × that day's close (options × 100 × the end-of-day mark) + cash. A money market
 *    fund (SPAXX) is $1 a share. A holding with no close is left out and named as not priced.
 * 4. Money in: deposits less withdrawals, shares transferred in or out at that day's value, and each
 *    account's value on the day before its first transaction (where its history starts).
 * 5. Return is time-weighted: each day's change less that day's money in, chained, so deposits are no
 *    gain and it compares fairly with a symbol's total return (adjusted closes).
 * 6. Points are daily over the last two years and weekly before, plus every window's start.
 */
import type { DailyCloses, KeyDates } from '@edgedesk/clickhouse';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import { CASH_FUND, MOVES, type StockSplit, contractOf } from './lots';
import { DataEdgeError, type MarketHistory } from './market-history';
import { type Portfolios, type Position, type Transaction, portfolioOwner } from './portfolio';

export const PERFORMANCE_WINDOWS = ['1M', '3M', 'YTD', '1Y', '3Y', '5Y', 'All'] as const;
export type PerformanceWindowKey = (typeof PERFORMANCE_WINDOWS)[number];

export interface PerformancePoint {
  date: string;
  value: number;
  /** Money put in so far, all time. */
  money_in: number;
  /** Time-weighted growth of $1 from the first point. */
  growth: number;
  /** Each compared symbol's total-return close (null before its first). */
  compare: Record<string, number | null>;
}

export interface PerformanceWindow {
  key: PerformanceWindowKey;
  /** The window's base day: the close it is measured from. */
  from: string;
  value: number;
  /** The value on `from` plus the money put in after it. */
  money_in: number;
  gain: number;
  /** Time-weighted return over the window. */
  return: number;
  compare: Record<string, { return: number | null; same_flows: number | null }>;
}

export interface Performance {
  /** The last close. Null when there is nothing to show. */
  as_of: string | null;
  source: MarketHistory['source'];
  compare: string[];
  points: PerformancePoint[];
  windows: PerformanceWindow[];
  /** Where each account's history starts: the day before its first transaction. */
  starts: { account_id: string; name: string; broker: string | null; date: string }[];
  /** Holdings with no close now, each with its share of value (from its cost). */
  unpriced: { symbol: string; account: string; share: number }[];
  key_dates: KeyDates | null;
}

interface LedgerAccount {
  id: string;
  name: string;
  broker: string | null;
  cash: number;
  positions: Position[];
  rows: Transaction[];
}

const DAY = 86_400_000;
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const addMonths = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
/** Monday-start week number (1970-01-01 was a Thursday). */
const weekOf = (iso: string) => Math.floor((Date.parse(`${iso}T00:00:00Z`) / DAY + 3) / 7);
const OCC = /^[A-Z0-9.]{1,6}(\d{6})[CP]\d{8}$/;
/** An option: an OCC contract, or one a broker sent without its expiry (`ORCL 240 C`). */
const isOption = (s: string) => OCC.test(s) || s.includes(' ');
/** An OCC contract's expiration, `YYYY-MM-DD`. */
const expiryOf = (s: string) => {
  const m = OCC.exec(s);
  return m ? `20${m[1]?.slice(0, 2)}-${m[1]?.slice(2, 4)}-${m[1]?.slice(4, 6)}` : null;
};
const round = (v: number, p = 100) => Math.round(v * p) / p;

/** The first index of sorted `days` on or after `date`; `days.length` when after them all. */
function onOrAfter(days: string[], date: string) {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((days[mid] as string) < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A symbol's closes on every day, carried forward from the last one (null before the first). */
function filled(days: string[], closes: { date: string; close: number }[] | undefined) {
  const out: (number | null)[] = new Array(days.length).fill(null);
  if (!closes?.length) return out;
  let j = 0;
  let last: number | null = null;
  for (let i = 0; i < days.length; i++) {
    while (j < closes.length && (closes[j]?.date as string) <= (days[i] as string)) {
      last = closes[j]?.close ?? last;
      j++;
    }
    out[i] = last;
  }
  return out;
}

/** One account's holdings and cash at each day's close, and the transfers that move money. */
function replay(a: LedgerAccount, days: string[], splits: StockSplit[]) {
  const n = days.length;
  const rows = a.rows.map(contractOf);
  const moves = rows.filter((t) => MOVES.has(t.kind) && t.symbol && t.quantity);
  const delta = (t: Transaction) =>
    (t.kind === 'buy' || t.kind === 'transfer_in' ? 1 : -1) * (t.quantity as number);
  // A day's close includes every transaction dated on or before it (a weekend's lands on Monday).
  const eff = (date: string) => onOrAfter(days, date);

  // 1. Shares, walked back from today.
  type Event = { i: number; date: string; split?: StockSplit; t?: Transaction };
  const events: Event[] = [
    ...rows.map((t): Event => ({ i: eff(t.date), date: t.date, t })),
    ...splits
      .filter((s) => moves.some((t) => t.symbol === s.symbol))
      .map((s): Event => ({ i: eff(s.date), date: s.date, split: s })),
  ].sort((x, y) =>
    x.date !== y.date ? (x.date < y.date ? 1 : -1) : x.split ? 1 : y.split ? -1 : 0,
  );
  const shares = new Map<string, number>();
  for (const p of a.positions) if (!isOption(p.symbol)) shares.set(p.symbol, p.quantity);
  let cash = a.cash;
  const held: Map<string, number>[] = new Array(n);
  const cashAt: number[] = new Array(n).fill(0);
  let e = 0;
  const undo = (ev: Event) => {
    if (ev.split) {
      const q = shares.get(ev.split.symbol);
      if (q) shares.set(ev.split.symbol, q / ev.split.ratio);
      return;
    }
    const t = ev.t as Transaction;
    cash -= t.amount;
    if (MOVES.has(t.kind) && t.symbol && t.quantity && !isOption(t.symbol))
      shares.set(t.symbol, (shares.get(t.symbol) ?? 0) - delta(t));
  };
  while (events[e] && (events[e] as Event).i >= n) undo(events[e++] as Event);
  for (let i = n - 1; i >= 0; i--) {
    held[i] = new Map([...shares].filter(([, q]) => Math.abs(q) > 1e-9));
    cashAt[i] = cash;
    while (events[e] && (events[e] as Event).i === i) undo(events[e++] as Event);
  }

  // 1b. Options, walked forward from their trades and anchored to what is held now.
  const options = new Map<string, number>();
  const optionAt: Map<string, number>[] = new Array(n);
  const byDay = new Map<number, Transaction[]>();
  // Trades after the last close are in today's holdings but in no day's.
  const later = new Map<string, number>();
  for (const t of moves)
    if (isOption(t.symbol as string)) {
      const i = eff(t.date);
      if (i >= n) later.set(t.symbol as string, (later.get(t.symbol as string) ?? 0) + delta(t));
      else byDay.set(i, [...(byDay.get(i) ?? []), t]);
    }
  for (let i = 0; i < n; i++) {
    for (const t of byDay.get(i) ?? [])
      options.set(t.symbol as string, (options.get(t.symbol as string) ?? 0) + delta(t));
    for (const [s] of options) {
      const exp = expiryOf(s);
      if (exp && exp < (days[i] as string)) options.delete(s);
    }
    optionAt[i] = new Map([...options].filter(([, q]) => Math.abs(q) > 1e-9));
  }
  for (const p of a.positions) {
    if (!isOption(p.symbol)) continue;
    const gap = p.quantity - (later.get(p.symbol) ?? 0) - (optionAt[n - 1]?.get(p.symbol) ?? 0);
    if (Math.abs(gap) < 1e-9) continue;
    for (let i = 0; i < n; i++) {
      const m = optionAt[i] as Map<string, number>;
      m.set(p.symbol, (m.get(p.symbol) ?? 0) + gap);
    }
  }

  // 2. Money moving in or out: cash deposits and withdrawals, and shares transferred (at value).
  const flows = rows
    .filter(
      (t) =>
        eff(t.date) < n &&
        (t.kind === 'deposit' ||
          t.kind === 'withdrawal' ||
          ((t.kind === 'transfer_in' || t.kind === 'transfer_out') && (!t.symbol || t.quantity))),
    )
    .map((t) => ({
      i: eff(t.date),
      amount: t.symbol ? null : t.amount,
      symbol: t.symbol,
      quantity: t.symbol ? delta(t) : 0,
    }));
  // Its history starts the day before its first transaction (today, with none).
  const first = rows[0]?.date;
  const start = first ? Math.max(0, eff(first) - 1) : n - 1;
  return { held, cashAt, optionAt, flows, start };
}

/** The work, pure: the ledger, the trading days and closes in, the page's numbers out. */
export function computePerformance(input: {
  accounts: LedgerAccount[];
  splits: StockSplit[];
  /** Trading days, ascending. */
  days: string[];
  closes: DailyCloses;
  compare: string[];
  source: MarketHistory['source'];
  keyDates: KeyDates | null;
  replayed?: ReturnType<typeof replay>[];
}): Performance {
  const { accounts, days, closes, compare } = input;
  const n = days.length;
  const empty: Performance = {
    as_of: null,
    source: input.source,
    compare,
    points: [],
    windows: [],
    starts: [],
    unpriced: [],
    key_dates: input.keyDates,
  };
  if (!n || !accounts.length) return empty;
  const replays = input.replayed ?? accounts.map((a) => replay(a, days, input.splits));
  const px = new Map<string, (number | null)[]>();
  const priceOf = (s: string, i: number) => {
    if (CASH_FUND.test(s)) return 1;
    let p = px.get(s);
    if (!p) {
      p = filled(days, closes[s]);
      px.set(s, p);
    }
    return p[i] ?? null;
  };
  const mult = (s: string) => (isOption(s) ? 100 : 1);

  const value = new Array<number>(n).fill(0);
  const flow = new Array<number>(n).fill(0);
  const begin = Math.min(...replays.map((r) => r.start));
  for (const r of replays) {
    for (let i = r.start; i < n; i++) {
      let v = r.cashAt[i] ?? 0;
      for (const m of [r.held[i], r.optionAt[i]])
        for (const [s, q] of m ?? []) v += q * (priceOf(s, i) ?? 0) * mult(s);
      value[i] = (value[i] ?? 0) + v;
      if (i === r.start) flow[i] = (flow[i] ?? 0) + v;
    }
    for (const f of r.flows) {
      if (f.i <= r.start) continue;
      const amount =
        f.amount ?? f.quantity * (priceOf(f.symbol as string, f.i) ?? 0) * mult(f.symbol as string);
      flow[f.i] = (flow[f.i] ?? 0) + amount;
    }
  }

  // Time-weighted growth and money in, from the first day any account starts.
  const growth = new Array<number>(n).fill(1);
  const moneyIn = new Array<number>(n).fill(0);
  for (let i = begin; i < n; i++) {
    const prev = i > begin ? (value[i - 1] as number) : 0;
    // Under a dollar is nothing (an empty account's cash walked back lands on rounding dust).
    const r = prev >= 1 ? ((value[i] as number) - (flow[i] as number)) / prev - 1 : 0;
    growth[i] = (i > begin ? (growth[i - 1] as number) : 1) * (1 + r);
    moneyIn[i] = (i > begin ? (moneyIn[i - 1] as number) : 0) + (flow[i] as number);
  }
  const adj = new Map(
    compare.map((s) => [
      s,
      filled(
        days,
        closes[s]?.map((c) => ({ date: c.date, close: c.adj ?? c.close })),
      ),
    ]),
  );

  // Windows: each measured from the close on or before its start (the history's first day at most).
  const last = n - 1;
  const lastDay = days[last] as string;
  const baseOf = (key: PerformanceWindowKey) => {
    if (key === 'All') return begin;
    const target =
      key === 'YTD'
        ? `${Number(lastDay.slice(0, 4)) - 1}-12-31`
        : addMonths(lastDay, -{ '1M': 1, '3M': 3, '1Y': 12, '3Y': 36, '5Y': 60 }[key]);
    return Math.max(begin, onOrAfter(days, addDays(target, 1)) - 1);
  };
  const windows = PERFORMANCE_WINDOWS.map((key): PerformanceWindow => {
    const a = baseOf(key);
    let put = value[a] as number;
    for (let i = a + 1; i <= last; i++) put += flow[i] as number;
    return {
      key,
      from: days[a] as string,
      value: round(value[last] as number),
      money_in: round(put),
      gain: round((value[last] as number) - put),
      return: round((growth[last] as number) / (growth[a] as number) - 1, 1e6),
      compare: Object.fromEntries(
        compare.map((s) => {
          const p = adj.get(s) as (number | null)[];
          const from = p[a];
          const to = p[last];
          if (!from || !to) return [s, { return: null, same_flows: null }];
          // The same money, put in on the same days, in the symbol instead.
          let units = (value[a] as number) / from;
          for (let i = a + 1; i <= last; i++) {
            const at = p[i];
            if (at && flow[i]) units += (flow[i] as number) / at;
          }
          return [s, { return: round(to / from - 1, 1e6), same_flows: round(units * to) }];
        }),
      ),
    };
  });

  // Daily over the last two years, weekly (each week's last day) before; every window's base kept.
  const daily = addMonths(lastDay, -24);
  const keep = new Set([
    ...windows.map((w) => onOrAfter(days, w.from)),
    ...replays.map((r) => r.start),
  ]);
  const points: PerformancePoint[] = [];
  for (let i = begin; i < n; i++) {
    const d = days[i] as string;
    const next = days[i + 1];
    if (d < daily && next && weekOf(next) === weekOf(d) && !keep.has(i)) continue;
    points.push({
      date: d,
      value: round(value[i] as number),
      money_in: round(moneyIn[i] as number),
      growth: round(growth[i] as number, 1e6),
      compare: Object.fromEntries(compare.map((s) => [s, adj.get(s)?.[i] ?? null])),
    });
  }

  // Holdings with no close in the last ten days, weighed by their cost.
  const stale = addDays(lastDay, -10);
  const recent = (s: string) => CASH_FUND.test(s) || (closes[s]?.at(-1)?.date ?? '') >= stale;
  const unpricedCost = accounts.flatMap((acct) =>
    acct.positions
      .filter((p) => !recent(p.symbol))
      .map((p) => ({
        symbol: p.symbol,
        account: acct.name,
        cost: Math.abs(p.quantity * (p.avg_cost ?? 0) * mult(p.symbol)),
      })),
  );
  const whole = (value[last] as number) + unpricedCost.reduce((s, u) => s + u.cost, 0);
  return {
    ...empty,
    as_of: lastDay,
    points,
    windows,
    starts: accounts
      .map((acct, k) => ({
        account_id: acct.id,
        name: acct.name,
        broker: acct.broker,
        date: days[replays[k]?.start ?? last] as string,
      }))
      .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)),
    unpriced: unpricedCost.map((u) => ({
      symbol: u.symbol,
      account: u.account,
      share: whole > 0 ? round(u.cost / whole, 1e4) : 0,
    })),
  };
}

export class PerformanceUnavailable extends Error {}

/** Reads the ledger and the closes it needs, then works the numbers out. */
export class PerformanceService {
  constructor(
    private readonly portfolios: Portfolios,
    /** The person's closes: the suite's own, or their DataEdge key's (self-host). */
    private readonly historyFor: (owner: string) => Promise<MarketHistory | null>,
  ) {}

  async read(
    owner: string,
    q: { accounts?: string[]; compare: string[]; today?: string },
  ): Promise<Performance> {
    const history = await this.historyFor(owner);
    if (!history) throw new PerformanceUnavailable('Connect DataEdge for price history.');
    const ledger = await this.portfolios.ledger(owner);
    const accounts = q.accounts
      ? ledger.accounts.filter((a) => q.accounts?.includes(a.id))
      : ledger.accounts;
    const today = q.today ?? new Date().toISOString().slice(0, 10);
    const firstRow = accounts
      .map((a) => a.rows[0]?.date)
      .filter((d): d is string => !!d)
      .sort()[0];
    const from = addDays(firstRow ?? today, -10);
    // The trading days come with the compared symbols: SPY's, which every history has.
    const head = [...new Set(['SPY', ...q.compare])];
    const [calendar, keyDates] = await Promise.all([
      history.closes(head, from, today),
      history.keyDates?.(from, today).catch(() => null) ?? Promise.resolve(null),
    ]);
    const days = [
      ...new Set(
        (calendar.SPY?.length ? calendar.SPY : Object.values(calendar).flat()).map((c) => c.date),
      ),
    ].sort();
    const splits = ledger.splits;
    const replayed = accounts.map((a) => replay(a, days, splits));
    // Each holding's closes from the first day it is held, in a few reads (one per starting year).
    const span = new Map<string, number>();
    const need = (s: string, i: number) => {
      if (!CASH_FUND.test(s) && !s.includes(' ')) span.set(s, Math.min(span.get(s) ?? i, i));
    };
    for (const r of replayed) {
      for (let i = r.start; i < days.length; i++)
        for (const m of [r.held[i], r.optionAt[i]]) for (const [s] of m ?? []) need(s, i);
      for (const f of r.flows) if (f.symbol) need(f.symbol, f.i);
    }
    const byYear = new Map<string, string[]>();
    for (const [s, i] of span) {
      if (head.includes(s)) continue;
      const y = (days[i] ?? today).slice(0, 4);
      byYear.set(y, [...(byYear.get(y) ?? []), s]);
    }
    const parts = await Promise.all(
      [...byYear].map(([y, symbols]) =>
        history.closes(
          symbols,
          addDays(`${y}-01-01`, -10) < from ? from : addDays(`${y}-01-01`, -10),
          today,
        ),
      ),
    );
    return computePerformance({
      accounts,
      splits,
      days,
      closes: Object.assign({}, calendar, ...parts),
      compare: q.compare,
      source: history.source,
      keyDates,
      replayed,
    });
  }
}

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const performanceQuery = z.object({
  accounts: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v.split(',').filter(Boolean)))
    .pipe(
      z
        .array(z.string().regex(/^pf_[0-9a-f]{16}$/))
        .max(100)
        .optional(),
    ),
  compare: z
    .string()
    .default('SPY')
    .transform((v) => [...new Set(v.toUpperCase().split(',').filter(Boolean))])
    .pipe(z.array(z.string().regex(SYMBOL, 'ticker')).max(5)),
});

/** REST under `/api/portfolios/performance` (signed in). */
export function performanceRoutes(svc: PerformanceService) {
  const r = new Hono<{ Variables: { identity?: AccessIdentity } }>();
  r.onError((err, c) => {
    if (err instanceof PerformanceUnavailable) return c.json({ error: err.message }, 409);
    if (err instanceof DataEdgeError) return c.json({ error: err.message }, 502);
    throw err;
  });
  // `?accounts=pf_…,pf_…` (default every account) and `?compare=SPY,QQQ` (up to 5).
  r.get('/', async (c) => {
    const parsed = performanceQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json(
        {
          error: 'invalid input',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    return c.json(await svc.read(portfolioOwner(c.get('identity')), parsed.data));
  });
  return r;
}
