/**
 * Tax lot math for one account, in one place (Bikram, 2026-10-11: rebuilt from scratch, simple):
 *
 * 1. Each holding takes its open lots from one source: the broker's (`snaptrade`, synced), yours
 *    (`manual`, portfolio_lot_write) or, when neither has any for it, `derived` first-in first-out
 *    from its buys and sells.
 * 2. A stored lot takes its holding's side: long lots for a long holding, short for a short one.
 * 3. Lots and checks cover what is held now. A check is held minus lots, per holding, with the
 *    source that explains the gap. A stock sold out this year whose sells outrun its buys on record
 *    gets a check too (held 0), so a sale with no buy never drops out of the realized total silently.
 * 4. Realized gains and closed lots always come from the buys and sells, first-in first-out. An option
 *    trade sent without its contract lots under the contract its description names, never as shares.
 * 5. Dividends add up per symbol from the dividend transactions: all of them and this year's.
 *
 * Pure: no storage, no network. `portfolio.ts` reads the account and hands everything in.
 */
import type { Transaction } from './portfolio';

/** Where a lot comes from: the broker's (SnapTrade), entered for a manual account, or worked out FIFO. */
export type LotSource = 'snaptrade' | 'manual' | 'derived';

export interface TaxLot {
  symbol: string;
  acquired: string;
  /** Negative for a short lot. */
  quantity: number;
  /** Per share, in USD, fees included. */
  cost: number;
  /** long once held more than a year. */
  term: 'short' | 'long';
  /**
   * Set when the cost is not the lot's own (Bikram, 2026-10-11; RSU and transferred-in lots often
   * come with cost 0): `yours`, set with portfolio_lot_cost_write; `transaction`, the price of that
   * day's transaction; `estimate`, the unadjusted close on the acquired day; `missing`, none of
   * these, so the cost stays 0.
   */
  cost_from?: 'yours' | 'transaction' | 'estimate' | 'missing';
  source: LotSource;
}
/** A lot as stored (broker or manual): the term and source are worked out on read. */
export type StoredLot = Omit<TaxLot, 'term' | 'source' | 'cost_from'>;

/** A cost you set for the lots of one symbol acquired on one day (all of them, or the one of `quantity`). */
export interface LotCost {
  symbol: string;
  acquired: string;
  quantity?: number;
  cost: number;
}

/** A lot, or the part of one, that a later trade closed. */
export interface ClosedLot {
  symbol: string;
  underlying: string;
  expiration: number | null;
  strike: number | null;
  right: 'C' | 'P' | null;
  acquired: string;
  closed: string;
  /** Negative for a short lot. */
  quantity: number;
  /** What was paid in USD, fees included (what a short lot paid to buy back). */
  cost: number;
  /** What was received in USD, fees included (what a short lot was sold for). */
  proceeds: number;
  gain: number;
  /** long when held more than a year. */
  term: 'short' | 'long';
}

/** A holding whose open lots do not add up to the quantity held; `source` is where its lots come from. */
export interface LotCheck {
  symbol: string;
  held: number;
  in_lots: number;
  source: LotSource;
}

/** The close on `date`, or the last one before it within a week; null when there is none. */
export type CloseOn = (symbol: string, date: string) => number | null;

/** What the lot math needs of a held position. */
interface Held {
  symbol: string;
  quantity: number;
  expiration: number | null;
  avg_cost: number | null;
}

/** Dividends one symbol paid into the account, in USD: every one on record and this year's. */
export interface Dividends {
  symbol: string;
  total: number;
  ytd: number;
}

export interface AccountLots {
  lots: TaxLot[];
  checks: LotCheck[];
  realized_ytd: { total: number; short_term: number };
  closed_lots: ClosedLot[];
  dividends: Dividends[];
}

const cents = (v: number) => Math.round(v * 100) / 100;
const shares = (v: number) => Math.round(v * 1e6) / 1e6;
/** YYYY-MM-DD one year earlier. */
const yearBefore = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;
const termOn = (acquired: string, day: string) =>
  acquired < yearBefore(day) ? ('long' as const) : ('short' as const);
const OCC = /\d{6}[CP]\d{8}$/;
/**
 * An option trade the broker sent without its contract (Robinhood: symbol = the underlying, units =
 * contracts, "… ORCL call with strike of $240.00 … to open"). It is no share trade.
 */
const OPTION_TEXT = /\b(call|put)\b.*\bstrike of \$?([\d,.]+)/i;

/** Such a trade as the contract it names, `ORCL 240 C` (no expiry is sent), so it lots on its own. */
function contractOf(t: Transaction): Transaction {
  const m = t.expiration === null && !t.right ? OPTION_TEXT.exec(t.description ?? '') : null;
  if (!m) return t;
  const right = (m[1] as string).toLowerCase() === 'call' ? ('C' as const) : ('P' as const);
  const strike = Number((m[2] as string).replace(/,/g, ''));
  const underlying = t.underlying ?? (t.symbol as string);
  return { ...t, symbol: `${underlying} ${strike} ${right}`, underlying, strike, right };
}
/** A gap smaller than the 4 decimals quantities show in is the broker's rounding, not a mismatch. */
const CHECK_STEP = 0.0001;

/**
 * Every open lot, check and realized gain of one account.
 * `skip` is a symbol left out of the lots and checks (margin cash).
 */
export function accountLots(a: {
  held: Held[];
  /** The account's stored lots (null when none were ever stored). */
  stored: StoredLot[] | null;
  storedSource: 'snaptrade' | 'manual';
  rows: Transaction[];
  costs: LotCost[];
  close: CloseOn;
  skip: string;
  today?: Date;
}): AccountLots {
  const today = (a.today ?? new Date()).toISOString().slice(0, 10);
  const trades = a.rows
    .filter((t) => (t.kind === 'buy' || t.kind === 'sell') && t.symbol && t.quantity)
    .map(contractOf)
    .sort((x, y) => (x.date === y.date ? (x.id < y.id ? -1 : 1) : x.date < y.date ? -1 : 1));
  const fifo = firstInFirstOut(trades, today);

  const held = new Map(a.held.map((p) => [p.symbol, p.quantity]));
  const stored = group(a.stored ?? []);
  const derived = group(fifo.open);
  // Lots belong to what is held now: buys and sells of anything else (a cash sweep fund, a sold
  // position whose buy predates the history) leave no open lot and no check.
  const symbols = [...held.keys()].filter((s) => s !== a.skip).sort();
  // An account with neither stored lots nor trades has nothing to check against.
  const checked = (a.stored?.length ?? 0) > 0 || trades.length > 0;

  const lots: TaxLot[] = [];
  const checks: LotCheck[] = [];
  for (const symbol of symbols) {
    const h = held.get(symbol) ?? 0;
    const own = stored.get(symbol);
    const source: LotSource = own
      ? a.storedSource
      : derived.has(symbol)
        ? 'derived'
        : a.stored?.length
          ? a.storedSource
          : 'derived';
    const mine = own
      ? own.map((l) => ({ ...l, quantity: sideOf(h, l.quantity) }))
      : (derived.get(symbol) ?? []);
    for (const l of mine) lots.push(costed({ ...l, term: termOn(l.acquired, today), source }, a));
    const inLots = shares(mine.reduce((s, l) => s + l.quantity, 0));
    if (checked && Math.abs(h - inLots) >= CHECK_STEP)
      checks.push({ symbol, held: h, in_lots: inLots, source });
  }
  // Sold out this year with more sold than bought on record: the missing buy hides a gain or loss.
  const year = today.slice(0, 4);
  for (const [symbol, open] of derived) {
    if (held.has(symbol) || symbol === a.skip || OCC.test(symbol) || symbol.includes(' ')) continue;
    const left = shares(open.reduce((s, l) => s + l.quantity, 0));
    const soldThisYear = trades.some(
      (t) => t.symbol === symbol && t.kind === 'sell' && t.date.startsWith(year),
    );
    if (left <= -CHECK_STEP && soldThisYear)
      checks.push({ symbol, held: 0, in_lots: left, source: 'derived' });
  }
  return {
    lots,
    checks,
    realized_ytd: fifo.realized,
    closed_lots: fifo.closed,
    dividends: dividendsOf(a.rows, year),
  };
}

/** Dividends per symbol: every one on record and this year's. */
function dividendsOf(rows: Transaction[], year: string): Dividends[] {
  const out = new Map<string, Dividends>();
  for (const t of rows) {
    const symbol = t.symbol ?? t.underlying;
    if (t.kind !== 'dividend' || !symbol || !t.amount) continue;
    const d = out.get(symbol) ?? { symbol, total: 0, ytd: 0 };
    d.total += t.amount;
    if (t.date.startsWith(year)) d.ytd += t.amount;
    out.set(symbol, d);
  }
  return [...out.values()].map((d) => ({ ...d, total: cents(d.total), ytd: cents(d.ytd) }));
}

/** A stock position the broker sent without an average cost takes its open lots' average. */
export function lotAverage(p: Held, lots: TaxLot[]): number | null {
  if ((p.avg_cost ?? 0) > 0 || p.expiration !== null) return null;
  const mine = lots.filter((l) => l.symbol === p.symbol);
  const qty = mine.reduce((s, l) => s + l.quantity, 0);
  if (!mine.length || !qty || mine.some((l) => l.cost <= 0)) return null;
  return Math.round((mine.reduce((s, l) => s + l.cost * l.quantity, 0) / qty) * 1e4) / 1e4;
}

/** A lot's size on its holding's side: short for a short holding, else long. */
const sideOf = (held: number, quantity: number) =>
  held < 0 ? -Math.abs(quantity) : Math.abs(quantity);

function group<T extends { symbol: string }>(rows: T[]) {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(r.symbol, [...(out.get(r.symbol) ?? []), r]);
  return out;
}

/**
 * A lot's cost, first that has one (Bikram, 2026-10-11): yours, the lot's own when not 0, the price
 * of a transaction of that symbol on the acquired day, the close that day (an estimate). Options
 * keep their own cost.
 */
function costed(l: TaxLot, a: { costs: LotCost[]; rows: Transaction[]; close: CloseOn }): TaxLot {
  const mine =
    a.costs.find(
      (o) => o.symbol === l.symbol && o.acquired === l.acquired && o.quantity === l.quantity,
    ) ??
    a.costs.find(
      (o) => o.symbol === l.symbol && o.acquired === l.acquired && o.quantity === undefined,
    );
  if (mine) return { ...l, cost: mine.cost, cost_from: 'yours' };
  if (l.cost > 0 || OCC.test(l.symbol)) return l;
  const same = a.rows.filter(
    (t) =>
      t.symbol === l.symbol && t.expiration === null && t.date === l.acquired && (t.price ?? 0) > 0,
  );
  const tx = same.find((t) => t.quantity === Math.abs(l.quantity)) ?? same[0];
  if (tx?.price) return { ...l, cost: tx.price, cost_from: 'transaction' };
  const est = a.close(l.symbol, l.acquired);
  return est ? { ...l, cost: est, cost_from: 'estimate' } : { ...l, cost_from: 'missing' };
}

/**
 * Open lots per symbol from the buys and sells: a trade first closes opposite lots oldest-first, the
 * rest opens a new lot. Closing part of a lot realizes its gain; short-term when held a year or less.
 */
function firstInFirstOut(trades: Transaction[], today: string) {
  const open = new Map<string, StoredLot[]>();
  const year = today.slice(0, 4);
  const realized = { total: 0, short_term: 0 };
  const closed: ClosedLot[] = [];
  for (const t of trades) {
    const symbol = t.symbol as string;
    const qty = t.quantity as number;
    const sign = t.kind === 'buy' ? 1 : -1;
    const mult = t.expiration || t.right ? 100 : 1;
    const perShare = (t.price ?? 0) + (sign * t.fees) / (qty * mult);
    const lots = open.get(symbol) ?? [];
    let left = sign * qty;
    while (left !== 0 && lots[0] && Math.sign(lots[0].quantity) !== Math.sign(left)) {
      const lot = lots[0];
      const take = Math.min(Math.abs(lot.quantity), Math.abs(left));
      const gain = Math.sign(lot.quantity) * (perShare - lot.cost) * take * mult;
      const term = termOn(lot.acquired, t.date);
      if (t.date.startsWith(year)) {
        realized.total += gain;
        if (term === 'short') realized.short_term += gain;
      }
      const [paid, got] = lot.quantity > 0 ? [lot.cost, perShare] : [perShare, lot.cost];
      closed.push({
        symbol,
        underlying: t.underlying ?? symbol,
        expiration: t.expiration,
        strike: t.strike,
        right: t.right,
        acquired: lot.acquired,
        closed: t.date,
        quantity: Math.sign(lot.quantity) * take,
        cost: cents(paid * take * mult),
        proceeds: cents(got * take * mult),
        gain: cents(gain),
        term,
      });
      lot.quantity = shares(lot.quantity - Math.sign(lot.quantity) * take);
      left = shares(left - Math.sign(left) * take);
      if (lot.quantity === 0) lots.shift();
    }
    if (left !== 0)
      lots.push({
        symbol,
        acquired: t.date,
        quantity: left,
        cost: Math.round(perShare * 1e4) / 1e4,
      });
    open.set(symbol, lots);
  }
  return {
    open: [...open.values()].flat(),
    realized: { total: cents(realized.total), short_term: cents(realized.short_term) },
    closed,
  };
}
