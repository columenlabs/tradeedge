/**
 * Multi-leg strategy analytics. Legs may sit on different expiries: the "at expiry" curve is taken at
 * the FRONT expiry, with later legs valued by Black-Scholes at their remaining time.
 */
import type { OptionChain, OptionQuote, OptionType } from '@edgedesk/types';
import { RATE, greeks, price, probBelow } from './bs';

export const MULTIPLIER = 100;
/** Trades open on the first expiry at least this far out: near-dated structures carry almost no premium. */
export const TRADE_MIN_DTE = 25;
/** IV used when a chain has none at all. */
export const DEFAULT_IV = 0.2;

/** ATM implied vol of a chain: used to value legs quoted without IV. */
export function atmIv(chain: OptionChain | undefined): number | null {
  const spot = chain?.spot?.last;
  if (!chain || !spot) return null;
  let best: OptionQuote | null = null;
  for (const q of chain.quotes) {
    if (!(q.iv && q.iv > 0)) continue;
    if (!best || Math.abs(q.strike - spot) < Math.abs(best.strike - spot)) best = q;
  }
  return best?.iv ?? null;
}

/** The ±1σ move of `spot` over `days` calendar days at `iv`. */
export const sigmaMove = (spot: number, iv: number, days: number) =>
  spot * iv * Math.sqrt(Math.max(days, 0) / 365);

/** An option leg, or shares of the underlying (covered calls, collars). */
export type LegType = OptionType | 'stock';

export interface Leg {
  id: string;
  type: LegType;
  /** +1 buy, −1 sell. */
  side: 1 | -1;
  strike: number;
  /** Int YYYYMMDD. */
  expiration: number;
  /** Calendar days to expiration today. */
  dte: number;
  /** Contracts, ≥ 1 (shares for a stock leg). */
  qty: number;
  /** Entry price per share (the mid when added). */
  price: number;
  /** Bid and ask per share when the leg was added: the fill lever prices mid to natural from them. */
  bid?: number;
  ask?: number;
  /** Implied vol from the chain; null for contracts quoted without it. */
  iv: number | null;
}

export interface Curve {
  spot: number;
  expiry: number;
  horizon: number;
}

/** What-if levers shared by the board and the trade page. */
export interface Levers {
  /** Days from today the position is valued on; at or past the front expiry means at expiry. */
  days: number;
  /** Multiplies every leg's IV: 1.2 is IV up 20%. */
  ivScale: number;
  /** 0 fills at mid, 1 at natural (buys at the ask, sells at the bid). */
  fill: number;
}

export interface Analysis {
  /** Cash in (+) or out (−) to open one lot at the lever's fill, in dollars. */
  net: number;
  /** What the fill lever costs against mid, in dollars (≤ 0). */
  slippage: number;
  frontDte: number;
  /** Days the curve's `horizon` is valued at (the days lever, capped at the front expiry). */
  horizon: number;
  curve: Curve[];
  breakevens: number[];
  maxProfit: number | 'unlimited';
  maxLoss: number | 'unlimited';
  /** Probability the position ends above zero at the front expiry. */
  pop: number;
  /** P/L in dollars at underlying `s`, `elapsed` days from now, IV scaled by `ivScale` (default the lever's). */
  pl: (s: number, elapsed: number, ivScale?: number) => number;
  /** ATM IV with the lever applied: used for the probability and the ±1σ band. */
  iv: number;
}

let seq = 0;
export const legId = () => `leg-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function legFromQuote(q: OptionQuote, side: 1 | -1, qty = 1): Leg {
  return {
    id: legId(),
    type: q.type,
    side,
    strike: q.strike,
    expiration: q.expiration,
    dte: q.dte,
    qty,
    price: q.mid ?? q.last ?? 0,
    bid: q.bid ?? undefined,
    ask: q.ask ?? undefined,
    iv: q.iv,
  };
}

const years = (days: number) => Math.max(days, 0) / 365;

/** Dollars per unit of `price`: 100 per contract, 1 per share. */
export const multiplierOf = (l: Leg) => (l.type === 'stock' ? 1 : MULTIPLIER);

/** Entry price per share at a fill between mid (0) and natural (1). */
export function fillPrice(l: Leg, fill: number): number {
  const natural = l.side > 0 ? l.ask : l.bid;
  return natural === undefined ? l.price : l.price + fill * (natural - l.price);
}

/** Cash to open, in dollars: negative for a debit. */
export const openingCash = (legs: Leg[], fill = 0) =>
  -legs.reduce((a, l) => a + l.side * l.qty * multiplierOf(l) * fillPrice(l, fill), 0);

export function frontDteOf(legs: Leg[]): number {
  const options = legs.filter((l) => l.type !== 'stock');
  return options.length ? Math.min(...options.map((l) => l.dte)) : 0;
}

export function analyze(
  legs: Leg[],
  spot: number,
  opts: Levers & { fallbackIv: number; points?: number; range?: [number, number] },
): Analysis | null {
  if (legs.length === 0 || !(spot > 0)) return null;
  const options = legs.filter((l) => l.type !== 'stock');
  const baseIv = (l: Leg) => (l.iv && l.iv > 0 ? l.iv : opts.fallbackIv);
  const cost = -openingCash(legs, opts.fill);
  const pl = (s: number, elapsed: number, ivScale = opts.ivScale) => {
    let v = 0;
    for (const l of legs) {
      const each =
        l.type === 'stock'
          ? s
          : price(l.type, s, l.strike, years(l.dte - elapsed), Math.max(baseIv(l) * ivScale, 0.01));
      v += l.side * l.qty * multiplierOf(l) * each;
    }
    return v - cost;
  };

  const frontDte = frontDteOf(legs);
  const horizon = Math.min(Math.max(opts.days, 0), frontDte);
  const iv = Math.max(opts.fallbackIv * opts.ivScale, 0.01);

  // Price grid: the requested range, or wide enough for every strike and ±4σ of the front expiry.
  const strikes = options.length ? options.map((l) => l.strike) : [spot];
  const sigma = iv * Math.sqrt(Math.max(years(frontDte), 1 / 365));
  const lo =
    opts.range?.[0] ??
    Math.max(0.01, Math.min(spot * Math.exp(-4 * sigma), Math.min(...strikes) * 0.97));
  const hi = opts.range?.[1] ?? Math.max(spot * Math.exp(4 * sigma), Math.max(...strikes) * 1.03);
  const n = opts.points ?? 240;
  const grid = Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
  for (const k of strikes) if (k > lo && k < hi) grid.push(k);
  grid.sort((a, b) => a - b);

  const curve: Curve[] = grid.map((s) => ({
    spot: s,
    expiry: pl(s, frontDte),
    horizon: pl(s, horizon),
  }));

  // Breakevens and bounds look past the drawn range, so they do not change with the range lever.
  const wideLo = Math.max(0.01, Math.min(spot * 0.2, Math.min(...strikes) * 0.5));
  const wideHi = Math.max(spot * 3, Math.max(...strikes) * 2);
  const wide = [
    ...Array.from({ length: 801 }, (_, i) => wideLo + ((wideHi - wideLo) * i) / 800),
    ...strikes,
  ].sort((a, b) => a - b);
  const atExpiry = wide.map((s) => ({ s, v: pl(s, frontDte) }));
  const breakevens: number[] = [];
  for (let i = 1; i < atExpiry.length; i++) {
    const a = atExpiry[i - 1] as { s: number; v: number };
    const b = atExpiry[i] as { s: number; v: number };
    if (a.v === 0) breakevens.push(a.s);
    else if (Math.sign(a.v) !== Math.sign(b.v) && b.v !== 0) {
      breakevens.push(a.s + ((b.s - a.s) * -a.v) / (b.v - a.v));
    }
  }

  const values = atExpiry.map((c) => c.v);
  values.push(pl(0.01, frontDte));
  // Unbounded to the upside when P/L keeps changing linearly far above the grid.
  const far1 = pl(wideHi * 3, frontDte);
  const far2 = pl(wideHi * 4, frontDte);
  const slope = far2 - far1;
  const eps = 0.5;
  const maxProfit = slope > eps ? 'unlimited' : Math.max(...values, far2);
  const maxLoss = slope < -eps ? 'unlimited' : Math.min(...values, far2);

  const t = years(frontDte);
  const cdf = (x: number) => probBelow(x, spot, t, iv, RATE);
  let pop = 0;
  const first = atExpiry[0];
  if (first && first.v > 0) pop += cdf(first.s);
  for (let i = 1; i < atExpiry.length; i++) {
    const a = atExpiry[i - 1] as { s: number; v: number };
    const b = atExpiry[i] as { s: number; v: number };
    if ((a.v + b.v) / 2 > 0) pop += cdf(b.s) - cdf(a.s);
  }
  const last = atExpiry.at(-1);
  if (last && last.v > 0) pop += 1 - cdf(last.s);

  return {
    net: -cost,
    slippage: openingCash(legs, opts.fill) - openingCash(legs, 0),
    frontDte,
    horizon,
    curve,
    breakevens,
    maxProfit,
    maxLoss,
    pop: Math.min(Math.max(pop, 0), 1),
    pl,
    iv,
  };
}

/**
 * Position greeks at underlying `s` on day `elapsed`, by finite differences of the P/L: delta in
 * shares, theta in dollars per day, vega in dollars per IV point.
 */
export function greeksAt(a: Analysis, s: number, elapsed: number, ivScale: number, baseIv: number) {
  // On the expiry itself the greeks are gone, so read them for today instead.
  const today = elapsed >= a.frontDte;
  const at = today ? 0 : elapsed;
  const left = a.frontDte - at;
  const v = (x: number, d: number, k = ivScale) => a.pl(x, d, k);
  return {
    delta: v(s + 0.5, at) - v(s - 0.5, at),
    theta: left > 0 ? v(s, at + 1) - v(s, at) : 0,
    vega: left > 0 ? v(s, at, ivScale + 0.01 / baseIv) - v(s, at) : 0,
    /** True when read for today because the value-on date is the expiry. */
    today,
  };
}

/** Per-leg delta at today's spot, signed by side, per share (a share leg counts 1). */
export function legDelta(l: Leg, spot: number, fallbackIv: number): number {
  if (l.type === 'stock') return l.side;
  const iv = l.iv && l.iv > 0 ? l.iv : fallbackIv;
  return l.side * greeks(l.type, spot, l.strike, years(l.dte), iv).delta;
}

// ── Strategies a new trade starts from ─────────────────────────────────────────

export type StrategyId =
  | 'iron-condor'
  | 'put-credit'
  | 'call-debit'
  | 'straddle'
  | 'butterfly'
  | 'calendar';

export interface Strategy {
  id: StrategyId;
  label: string;
  /** Payoff glyph, 28×14 polyline points. */
  glyph: string;
  /** Needs a second, later expiry. */
  needsBack?: boolean;
}

export const STRATEGIES: Strategy[] = [
  { id: 'iron-condor', label: 'Iron condor', glyph: '2,12 7,12 10,4 18,4 21,12 26,12' },
  { id: 'put-credit', label: 'Put credit spread', glyph: '2,12 10,12 18,4 26,4' },
  { id: 'call-debit', label: 'Call debit spread', glyph: '2,12 10,12 18,4 26,4' },
  { id: 'straddle', label: 'Long straddle', glyph: '2,2 14,12 26,2' },
  { id: 'butterfly', label: 'Butterfly', glyph: '2,11 9,11 14,3 19,11 26,11' },
  { id: 'calendar', label: 'Calendar', glyph: '2,12 9,9 14,3 19,9 26,12', needsBack: true },
];

const fmtK = (k: number) => (Number.isInteger(k) ? String(k) : k.toFixed(1));

/**
 * Builds a strategy from one expiry's quotes (and a later expiry's for a calendar). Short legs sit
 * near ±1σ of spot at that expiry; wings are about 1.75% of spot wide, on strikes the chain lists.
 * Returns the legs and a name like "Iron condor 550/595".
 */
export function buildStrategy(
  id: StrategyId,
  spot: number,
  iv: number,
  front: OptionQuote[],
  back: OptionQuote[] = [],
): { legs: Leg[]; name: string } | null {
  const strikes = [...new Set(front.map((q) => q.strike))].sort((a, b) => a - b);
  if (strikes.length < 3 || !front[0]) return null;
  const nearest = (x: number) =>
    strikes.reduce((b, k) => (Math.abs(k - x) < Math.abs(b - x) ? k : b), strikes[0] as number);
  const move = sigmaMove(spot, iv, front[0].dte);
  const wing = Math.max(spot * 0.0175, 1);
  const atm = nearest(spot);
  const find = (qs: OptionQuote[], type: OptionType, k: number) =>
    qs.find((q) => q.type === type && q.strike === k);
  const leg = (qs: OptionQuote[], type: OptionType, k: number, side: 1 | -1, qty = 1) => {
    const q = find(qs, type, k);
    return q ? legFromQuote(q, side, qty) : null;
  };
  const shortPut = nearest(spot - move);
  const shortCall = nearest(spot + move);
  const longPut = nearest(shortPut - wing);
  const longCall = nearest(shortCall + wing);
  const above = nearest(atm + wing);
  const below = nearest(atm - wing);

  const spec: Record<StrategyId, () => [(Leg | null)[], string]> = {
    'iron-condor': () => [
      [
        leg(front, 'put', longPut, 1),
        leg(front, 'put', shortPut, -1),
        leg(front, 'call', shortCall, -1),
        leg(front, 'call', longCall, 1),
      ],
      `Iron condor ${fmtK(shortPut)}/${fmtK(shortCall)}`,
    ],
    'put-credit': () => [
      [leg(front, 'put', shortPut, -1), leg(front, 'put', longPut, 1)],
      `Put credit spread ${fmtK(shortPut)}/${fmtK(longPut)}`,
    ],
    'call-debit': () => [
      [leg(front, 'call', atm, 1), leg(front, 'call', nearest(atm + 2 * wing), -1)],
      `Call debit spread ${fmtK(atm)}/${fmtK(nearest(atm + 2 * wing))}`,
    ],
    straddle: () => [
      [leg(front, 'call', atm, 1), leg(front, 'put', atm, 1)],
      `Long straddle ${fmtK(atm)}`,
    ],
    butterfly: () => [
      [leg(front, 'call', below, 1), leg(front, 'call', atm, -1, 2), leg(front, 'call', above, 1)],
      `Butterfly ${fmtK(below)}/${fmtK(atm)}/${fmtK(above)}`,
    ],
    calendar: () => [
      [leg(front, 'call', atm, -1), leg(back, 'call', atm, 1)],
      `Calendar ${fmtK(atm)}`,
    ],
  };
  const [legs, name] = spec[id]();
  return legs.every((l): l is Leg => l !== null) ? { legs, name } : null;
}
