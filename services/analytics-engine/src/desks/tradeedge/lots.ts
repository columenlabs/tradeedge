/**
 * Tax lot math for one account, in one place (Bikram, 2026-10-11: rebuilt from scratch, simple):
 *
 * 1. Each holding takes its open lots from one source: the broker's (`snaptrade`, synced), yours
 *    (`manual`, portfolio_lot_write) or, when neither has any for it, `derived` first-in first-out
 *    from its buys and sells.
 * 2. A stored lot takes its holding's side: long lots for a long holding, short for a short one.
 * 3. Every share sits in one lot, open or closed (Bikram, 2026-10-12, plan A: matching exists so
 *    realized gains are right). The rows of a share symbol are anchored to what is held now: shares
 *    the history cannot explain (bought before it starts, or a row the broker never sent) open the
 *    history as one lot "before history" with no cost, so a sale with no buy on record closes that lot
 *    instead of opening a short one. Rows that bring in more than is held (shares that left with no row)
 *    take the rest out of the oldest lots, unsold. Derived open lots always add up to what is held.
 * 4. Checks, for every symbol held or sold: `quantity` (red) when the open lots miss what is held,
 *    which only stored lots (the broker's or yours) can do; `cost` (amber) for the shares, open or
 *    sold, with no cost on record, whose gain the realized total leaves out until a cost is set.
 *    A money market fund (a 5-letter ticker ending in XX: FDRXX, SPAXX) is cash: no lots, no check.
 * 5. Realized gains and closed lots always come from the account's rows, first-in first-out, and
 *    every row that moves shares counts: buys and sells, and transfers in and out (another broker,
 *    a journal, a 401(k) fund exchange). A transfer realizes nothing. Shares transferred in carry no
 *    cost (brokers send none). An option trade sent without its contract lots under the contract its
 *    description names, never as shares; options are not anchored (selling one opens a short). Lots
 *    are first-in first-out: wash-sale adjustments are not applied.
 * 6. Dividends add up per symbol from the dividend transactions: all of them and this year's.
 * 7. A stock split splits the derived lots acquired before it (more shares, the same total cost), so
 *    shares bought before a split match the ones sold after it (KLAC 10:1, 2026-06-12). Brokers send
 *    no split row and keep the old trades as printed.
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
  /** long once held more than a year, unless you set it (`term_from: 'yours'`). */
  term: 'short' | 'long';
  term_from?: 'yours';
  /** Shares held before the history starts (no buy on record): no cost until you set one. */
  before_history?: true;
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

/**
 * What you set for the lots of one symbol acquired on one day (all of them, or the one of
 * `quantity`): a cost per share, a term, or both. Kept through syncs.
 */
export interface LotCost {
  symbol: string;
  acquired: string;
  quantity?: number;
  cost?: number;
  /** Long or short term by hand (Bikram, 2026-10-12): it outranks the holding period. */
  term?: 'short' | 'long';
}

/** Your setting of `field` for a lot: the one for its exact size first, then the one for its day. */
function yoursFor<K extends 'cost' | 'term'>(
  costs: LotCost[],
  field: K,
  symbol: string,
  acquired: string,
  quantity?: number,
): LotCost[K] | undefined {
  const set = costs.filter(
    (o) => o.symbol === symbol && o.acquired === acquired && o[field] !== undefined,
  );
  return (set.find(
    (o) =>
      quantity !== undefined &&
      o.quantity !== undefined &&
      Math.abs(o.quantity) === Math.abs(quantity),
  ) ?? set.find((o) => o.quantity === undefined))?.[field];
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
  /** What was paid in USD, fees included (what a short lot paid to buy back); null for shares transferred in. */
  cost: number | null;
  /** What was received in USD, fees included (what a short lot was sold for). */
  proceeds: number;
  /** null when the cost is unknown (shares transferred in). */
  gain: number | null;
  /** long when held more than a year, unless you set it (`term_from: 'yours'`). */
  term: 'short' | 'long';
  term_from?: 'yours';
  /** Shares held before the history starts (no buy on record): `acquired` is the first row's date. */
  before_history?: true;
}

/** A holding whose open lots do not add up to the quantity held; `source` is where its lots come from. */
export interface LotCheck {
  symbol: string;
  /** `quantity`: the open lots miss what is held. `cost`: some shares, open or sold, have no cost. */
  kind: 'quantity' | 'cost';
  held: number;
  in_lots: number;
  /** Shares with no cost on record, open or sold (`cost` checks). */
  no_cost: number;
  source: LotSource;
}

/** The close on `date`, or the last one before it within a week; null when there is none. */
export type CloseOn = (symbol: string, date: string) => number | null;

/** A stock split: from `date` (the ex-date) on, one old share is `ratio` new ones. */
export interface StockSplit {
  symbol: string;
  date: string;
  ratio: number;
}

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
  /** This year's closed gain; `sold` is this year's proceeds and `no_cost` those whose gain is unknown. */
  realized_ytd: { total: number; short_term: number; sold: number; no_cost: number };
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
/** A share or fund symbol, not an option contract (`ORCL 240 C` or an OCC symbol). */
const isShare = (symbol: string) => !symbol.includes(' ') && !OCC.test(symbol);
/** A money market fund (FDRXX, SPAXX): cash, so no lots and no check. */
const CASH_FUND = /^[A-Z]{3}XX$/;
/** The rows that move shares, and so lots. */
export const MOVES = new Set(['buy', 'sell', 'transfer_in', 'transfer_out']);
/** A row that adds shares (or covers a short). */
const adds = (t: Transaction) => t.kind === 'buy' || t.kind === 'transfer_in';
/**
 * Drops each move in that a move out of the same symbol and size on the same day undoes (a broker's
 * journal between margin and cash): the pair moves nothing, so it never trades one lot for another.
 */
function journals(rows: Transaction[]) {
  const ins = rows.filter((t) => t.kind === 'transfer_in');
  const dropped = new Set<Transaction>();
  for (const out of rows)
    if (out.kind === 'transfer_out') {
      const pair = ins.find(
        (t) =>
          !dropped.has(t) &&
          t.date === out.date &&
          t.symbol === out.symbol &&
          t.expiration === out.expiration &&
          t.strike === out.strike &&
          t.right === out.right &&
          t.quantity === out.quantity,
      );
      if (pair) dropped.add(pair).add(out);
    }
  return rows.filter((t) => !dropped.has(t));
}
/** 1 for a row that should run after a day's share buys and moves in. */
const later = (t: Transaction) => (adds(t) && isShare(t.symbol as string) ? 0 : 1);
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
 */
export function accountLots(a: {
  held: Held[];
  /** The account's stored lots (null when none were ever stored). */
  stored: StoredLot[] | null;
  storedSource: 'snaptrade' | 'manual';
  rows: Transaction[];
  costs: LotCost[];
  close: CloseOn;
  /** Stock splits of the symbols traded, any order. */
  splits?: StockSplit[];
  today?: Date;
}): AccountLots {
  const today = (a.today ?? new Date()).toISOString().slice(0, 10);
  const trades = journals(
    a.rows.filter((t) => MOVES.has(t.kind) && t.symbol && t.quantity && !CASH_FUND.test(t.symbol)),
  )
    .map(contractOf)
    // Shares that come in on a day go before those that leave it: an RSU vest's sell-to-cover
    // closes the vest's own lot, never a short one the vest then covers.
    .sort(
      (x, y) =>
        (x.date < y.date ? -1 : x.date > y.date ? 1 : 0) ||
        later(x) - later(y) ||
        (x.id < y.id ? -1 : 1),
    );
  const held = new Map(a.held.map((p) => [p.symbol, p.quantity]));
  const fifo = firstInFirstOut(trades, today, a.splits ?? [], held, a.costs);

  const stored = group(a.stored ?? []);
  const derived = group(fifo.open);
  // Open lots belong to what is held now; a cash sweep fund has none.
  const counted = (s: string) => !CASH_FUND.test(s);
  const symbols = [...held.keys()].filter(counted).sort();
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
    for (const l of mine) {
      const term = yoursFor(a.costs, 'term', symbol, l.acquired, l.quantity);
      lots.push(
        costed(
          {
            ...l,
            term: term ?? termOn(l.acquired, today),
            ...(term ? { term_from: 'yours' as const } : {}),
            source,
          },
          a,
        ),
      );
    }
    const inLots = shares(mine.reduce((s, l) => s + l.quantity, 0));
    if (checked && Math.abs(h - inLots) >= CHECK_STEP)
      checks.push({ symbol, kind: 'quantity', held: h, in_lots: inLots, no_cost: 0, source });
  }
  // Shares with no cost on record, held or sold: their gain is unknown (rule 4).
  const noCost = new Map<string, number>();
  const add = (symbol: string, q: number) => noCost.set(symbol, (noCost.get(symbol) ?? 0) + q);
  for (const c of fifo.closed) if (c.gain === null) add(c.symbol, Math.abs(c.quantity));
  for (const l of lots) if (l.cost_from === 'missing') add(l.symbol, Math.abs(l.quantity));
  for (const [symbol, q] of [...noCost].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (!counted(symbol) || shares(q) < CHECK_STEP) continue;
    const inLots = shares(
      lots.filter((l) => l.symbol === symbol).reduce((s, l) => s + l.quantity, 0),
    );
    const source = lots.find((l) => l.symbol === symbol)?.source ?? 'derived';
    checks.push({
      symbol,
      kind: 'cost',
      held: held.get(symbol) ?? 0,
      in_lots: inLots,
      no_cost: shares(q),
      source,
    });
  }
  const year = today.slice(0, 4);
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
  const mine = yoursFor(a.costs, 'cost', l.symbol, l.acquired, l.quantity);
  if (mine !== undefined) return { ...l, cost: mine, cost_from: 'yours' };
  if (l.before_history) return { ...l, cost: 0, cost_from: 'missing' };
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
function firstInFirstOut(
  trades: Transaction[],
  today: string,
  splits: StockSplit[],
  held: Map<string, number>,
  costs: LotCost[],
) {
  // `unknown`: shares whose cost the broker never sent (transferred in, or before the history).
  const open = new Map<string, (StoredLot & { unknown?: true })[]>();
  // Each symbol's splits, oldest first; one is applied to the open lots once a trade (or today)
  // is on or after its date.
  const pending = group(
    [...splits].filter((x) => x.date <= today).sort((x, y) => (x.date < y.date ? -1 : 1)),
  );
  // Your cost for an unknown lot (every lot that day of that symbol), else it stays unknown.
  const yours = (symbol: string, acquired: string) =>
    costs.find(
      (o) =>
        o.symbol === symbol &&
        o.acquired === acquired &&
        o.quantity === undefined &&
        o.cost !== undefined,
    );
  // Rule 3: each share symbol starts from the shares its rows cannot explain against what is held
  // now, as one lot before the history, in the units of the first row's day.
  const gone = new Map<string, number>();
  for (const [symbol, rows] of group(trades as (Transaction & { symbol: string })[])) {
    if (!isShare(symbol)) continue;
    const due = pending.get(symbol) ?? [];
    const after = (day: string) => due.filter((x) => x.date > day).reduce((r, x) => r * x.ratio, 1);
    const net = rows.reduce(
      (s, t) => s + (adds(t) ? 1 : -1) * (t.quantity as number) * after(t.date),
      0,
    );
    const gap = (held.get(symbol) ?? 0) - net;
    const first = (rows[0] as Transaction).date;
    // Splits on or before the first row's day are already in every row's units.
    pending.set(
      symbol,
      due.filter((x) => x.date > first),
    );
    if (Math.abs(gap) < CHECK_STEP) continue;
    // Rows that bring in more than is held: shares left with no row (a fee paid in coin, a move out
    // the broker never sent). They leave the oldest lots after the walk; nothing is sold.
    if (gap < 0 && (held.get(symbol) ?? 0) >= 0) {
      gone.set(symbol, -gap);
      continue;
    }
    const cost = yours(symbol, first);
    open.set(symbol, [
      {
        symbol,
        acquired: first,
        quantity: shares(gap / after(first)),
        cost: cost?.cost ?? 0,
        before_history: true,
        ...(cost ? {} : { unknown: true as const }),
      },
    ]);
  }
  const splitUpTo = (symbol: string, day: string) => {
    const due = pending.get(symbol);
    while (due?.[0] && due[0].date <= day) {
      const { ratio } = due.shift() as StockSplit;
      for (const lot of open.get(symbol) ?? []) {
        lot.quantity = shares(lot.quantity * ratio);
        lot.cost = Math.round((lot.cost / ratio) * 1e4) / 1e4;
      }
    }
  };
  const year = today.slice(0, 4);
  const realized = { total: 0, short_term: 0 };
  const sold = { total: 0, unknown: 0 };
  const closed: ClosedLot[] = [];
  for (const t of trades) {
    const symbol = t.symbol as string;
    const qty = t.quantity as number;
    const sign = adds(t) ? 1 : -1;
    const moved = t.kind === 'transfer_in' || t.kind === 'transfer_out';
    const mult = t.expiration || t.right ? 100 : 1;
    const perShare = (t.price ?? 0) + (sign * t.fees) / (qty * mult);
    if (mult === 1) splitUpTo(symbol, t.date);
    const lots = open.get(symbol) ?? [];
    let left = sign * qty;
    while (left !== 0 && lots[0] && Math.sign(lots[0].quantity) !== Math.sign(left)) {
      const lot = lots[0];
      const take = Math.min(Math.abs(lot.quantity), Math.abs(left));
      // A transfer out moves the shares away: nothing is sold, nothing realized.
      if (!moved) {
        const gain = lot.unknown
          ? null
          : Math.sign(lot.quantity) * (perShare - lot.cost) * take * mult;
        const mine = yoursFor(costs, 'term', symbol, lot.acquired, take);
        const term = mine ?? termOn(lot.acquired, t.date);
        if (gain !== null && t.date.startsWith(year)) {
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
          cost: lot.unknown && lot.quantity > 0 ? null : cents(paid * take * mult),
          proceeds: cents(got * take * mult),
          gain: gain === null ? null : cents(gain),
          term,
          ...(mine ? { term_from: 'yours' as const } : {}),
          ...(lot.before_history ? { before_history: true as const } : {}),
        });
        if (t.date.startsWith(year)) {
          sold.total += Math.abs(got * take * mult);
          if (gain === null) sold.unknown += Math.abs(got * take * mult);
        }
      }
      lot.quantity = shares(lot.quantity - Math.sign(lot.quantity) * take);
      left = shares(left - Math.sign(left) * take);
      if (lot.quantity === 0) lots.shift();
    }
    // The rest opens a lot. Shares sent out beyond the lots on record open a short one that a
    // later move in covers (Fidelity sends one move as several rows: out, out, journal, in), so a
    // share symbol's rows always add up to what is held; an option's just leave.
    if (left !== 0 && (t.kind !== 'transfer_out' || isShare(symbol))) {
      // No cost on record: shares moved, or a buy at 0 (an RSU vest, whose cost is its value).
      const costless = moved || (t.kind === 'buy' && !t.price && mult === 1);
      const mine = costless ? yours(symbol, t.date) : undefined;
      lots.push({
        symbol,
        acquired: t.date,
        quantity: left,
        cost: costless ? (mine?.cost ?? 0) : Math.round(perShare * 1e4) / 1e4,
        ...(costless && !mine ? { unknown: true as const } : {}),
      });
    }
    open.set(symbol, lots);
  }
  for (const symbol of open.keys()) if (isShare(symbol)) splitUpTo(symbol, today);
  for (const [symbol, extra] of gone) {
    const lots = open.get(symbol) ?? [];
    let left = extra;
    while (left > 0 && lots[0] && lots[0].quantity > 0) {
      const take = Math.min(lots[0].quantity, left);
      lots[0].quantity = shares(lots[0].quantity - take);
      left = shares(left - take);
      if (lots[0].quantity === 0) lots.shift();
    }
  }
  return {
    open: [...open.values()].flat().map(({ unknown: _, ...l }) => l),
    realized: {
      total: cents(realized.total),
      short_term: cents(realized.short_term),
      sold: cents(sold.total),
      no_cost: cents(sold.unknown),
    },
    closed,
  };
}
