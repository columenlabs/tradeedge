/**
 * Screener: pick expirations, scan delta / OTM% / width combinations,
 * build legs, evaluate, filter and rank.
 */
import { type OptionQuote, daysBetween } from '@edgedesk/types';
import { type Metrics, analyze } from './analyze';
import { type Leg, MULTIPLIER, type Pricing } from './legs';
import { type Knobs, type Strategy, buildStrategy, strategyFacts } from './strategy';

export type SortKey =
  | 'expected_value'
  | 'pop'
  | 'return_on_risk'
  | 'credit'
  | 'credit_to_width'
  | 'lowest_debit'
  | 'theta';

export interface ScreenRequest {
  /** Strategy id (see strategy_list). */
  strategy: string;
  /** Exact expiration (YYYYMMDD). Otherwise dte_min..dte_max. */
  expiration?: number;
  dte_min?: number;
  dte_max?: number;
  /** How many expirations inside the window to scan (spread evenly). */
  max_expirations?: number;
  /** Back-month window for calendars / diagonals (days). */
  back_dte_min?: number;
  back_dte_max?: number;
  /** Abs delta(s) for the primary legs. */
  delta?: number | number[];
  /** OTM distance(s) as a fraction of spot, e.g. 0.05. */
  otm_pct?: number | number[];
  /** Wing / spread width(s) in $. */
  width?: number | number[];
  long_delta?: number;
  /** Exact strikes by role (see strategy_list). */
  strikes?: Record<string, number>;
  pricing?: Pricing;
  /** Filters (per-share $ for credit/debit). */
  min_credit?: number;
  max_debit?: number;
  min_pop?: number;
  min_return_on_risk?: number;
  max_leg_spread_pct?: number;
  min_leg_volume?: number;
  sort_by?: SortKey;
  limit?: number;
}

export interface ScreenData {
  underlying: string;
  spot: number;
  /** Int YYYYMMDD (US/Pacific). */
  today: number;
  rate?: number;
  expirations: number[];
  chain(expiration: number): Promise<OptionQuote[]>;
}

export interface Candidate extends Metrics {
  strategy: string;
  expiration: number;
  back_expiration?: number;
  dte: number;
  /** Widest short→long strike distance in $ (spreads, condors, lizards). */
  width: number | null;
  credit_to_width: number | null;
  inputs: { delta?: number; otm_pct?: number; width?: number };
}

export interface ScreenResult {
  underlying: string;
  spot: number;
  strategy: string;
  expirations_scanned: number[];
  candidates_evaluated: number;
  candidates_passing: number;
  sort_by: SortKey;
  results: Candidate[];
  assumptions: string[];
}

const arr = <T>(v: T | T[] | undefined): T[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

const nice = (x: number) =>
  x < 5 ? Math.max(0.5, Math.round(x * 2) / 2) : x < 25 ? Math.round(x) : Math.round(x / 5) * 5;

export function defaultWidths(spot: number): number[] {
  return [...new Set([0.01, 0.02, 0.03].map((f) => nice(spot * f)))];
}

function pickExpirations(req: ScreenRequest, data: ScreenData): number[] {
  if (req.expiration) return data.expirations.includes(req.expiration) ? [req.expiration] : [];
  const lo = req.dte_min ?? 21;
  const hi = req.dte_max ?? 60;
  const dte = (e: number) => daysBetween(data.today, e);
  let inRange = data.expirations.filter((e) => dte(e) >= lo && dte(e) <= hi);
  if (!inRange.length) {
    const mid = (lo + hi) / 2;
    const nearest = [...data.expirations].sort(
      (a, b) => Math.abs(dte(a) - mid) - Math.abs(dte(b) - mid),
    )[0];
    inRange = nearest ? [nearest] : [];
  }
  const n = Math.max(1, Math.min(req.max_expirations ?? 3, 6));
  if (inRange.length <= n) return inRange;
  const picked = new Set<number>();
  for (let i = 0; i < n; i++)
    picked.add(inRange[Math.round((i * (inRange.length - 1)) / (n - 1 || 1))] as number);
  return [...picked];
}

function backFor(front: number, req: ScreenRequest, data: ScreenData): number | undefined {
  const fDte = daysBetween(data.today, front);
  const lo = req.back_dte_min ?? fDte + 21;
  const hi = req.back_dte_max ?? fDte + 70;
  const later = data.expirations.filter((e) => e > front);
  const dte = (e: number) => daysBetween(data.today, e);
  return (
    later.find((e) => dte(e) >= lo && dte(e) <= hi) ?? later.find((e) => dte(e) >= lo) ?? later[0]
  );
}

/** Widest distance from each short option to the nearest long option of the same type/expiry. */
function structureWidth(legs: Leg[]): number | null {
  let w: number | null = null;
  for (const s of legs) {
    if (s.kind !== 'option' || s.action !== 'sell') continue;
    let best: number | null = null;
    for (const l of legs) {
      if (l.kind !== 'option' || l.action !== 'buy') continue;
      if (l.quote.type !== s.quote.type || l.quote.expiration !== s.quote.expiration) continue;
      const d = Math.abs(l.quote.strike - s.quote.strike);
      if (d > 0 && (best === null || d < best)) best = d;
    }
    if (best !== null) w = w === null ? best : Math.max(w, best);
  }
  return w;
}

function strategyNotes(def: Strategy, legs: Leg[], m: Metrics, spot: number): string[] {
  const notes: string[] = [];
  const opts = legs.filter((l) => l.kind === 'option');
  const spreadWidth = (type: 'call' | 'put') => {
    const s = opts.find((l) => l.action === 'sell' && l.quote.type === type);
    const b = opts.find((l) => l.action === 'buy' && l.quote.type === type);
    return s && b ? Math.abs(s.quote.strike - b.quote.strike) : null;
  };
  if (def.id === 'jade_lizard') {
    const w = spreadWidth('call');
    if (w !== null) {
      notes.push(
        m.net_premium_per_share >= w
          ? 'no upside risk: credit ≥ call-spread width'
          : `upside risk remains: credit ${m.net_premium_per_share} < call-spread width ${w}`,
      );
    }
  }
  if (def.id === 'reverse_jade_lizard') {
    const w = spreadWidth('put');
    if (w !== null) {
      notes.push(
        m.net_premium_per_share >= w
          ? 'no downside risk: credit ≥ put-spread width'
          : `downside risk remains: credit ${m.net_premium_per_share} < put-spread width ${w}`,
      );
    }
  }
  if (def.id.startsWith('zebra_')) {
    let extr = 0;
    for (const l of opts) {
      const q = l.quote;
      const px = m.legs.find((v) => v.symbol === q.symbol)?.price ?? 0;
      const intrinsic = Math.max(0, q.type === 'call' ? spot - q.strike : q.strike - spot);
      extr += (l.action === 'buy' ? 1 : -1) * l.qty * (px - intrinsic);
    }
    notes.push(
      `net extrinsic paid ${Math.round(extr * MULTIPLIER * 100) / 100} $ (≈0 is the ZEBRA goal)`,
    );
  }
  return notes;
}

const SORTS: Record<SortKey, (c: Candidate) => number> = {
  expected_value: (c) => c.expected_value,
  pop: (c) => c.pop,
  return_on_risk: (c) => c.return_on_risk ?? Number.NEGATIVE_INFINITY,
  credit: (c) => c.net_premium,
  credit_to_width: (c) => c.credit_to_width ?? Number.NEGATIVE_INFINITY,
  lowest_debit: (c) => c.net_premium,
  theta: (c) => c.greeks.theta,
};

/** Screens one strategy, already loaded (the caller reads it from D1 by `req.strategy`). */
export async function screen(
  req: ScreenRequest,
  data: ScreenData,
  def: Strategy,
): Promise<ScreenResult> {
  const facts = strategyFacts(def);
  const sortBy: SortKey = req.sort_by ?? 'expected_value';
  const limit = Math.max(1, Math.min(req.limit ?? 5, 25));
  const pricing = req.pricing ?? 'mid';

  const exps = pickExpirations(req, data);
  const hasStrikes = req.strikes && Object.keys(req.strikes).length > 0;
  const otm = arr(req.otm_pct);
  const deltas = arr(req.delta);
  const primary: Knobs[] = otm
    ? otm.map((otmPct) => ({ otmPct }))
    : deltas
      ? deltas.map((delta) => ({ delta }))
      : hasStrikes || !def.default_deltas
        ? [{}]
        : def.default_deltas.map((delta) => ({ delta }));
  const widths: (number | undefined)[] = facts.uses_width
    ? (arr(req.width) ?? defaultWidths(data.spot))
    : [undefined];

  const seen = new Set<string>();
  const all: Candidate[] = [];
  let evaluated = 0;
  for (const exp of exps) {
    const chain = await data.chain(exp);
    const back = facts.expirations === 2 ? backFor(exp, req, data) : undefined;
    const backChain = back ? await data.chain(back) : undefined;
    for (const p of primary) {
      for (const width of widths) {
        const knobs: Knobs = { ...p, width, longDelta: req.long_delta, strikes: req.strikes };
        const legs = buildStrategy(
          def,
          { spot: data.spot, today: data.today, rate: data.rate, chain, back: backChain },
          knobs,
        );
        if (!legs) continue;
        const key = legs
          .map((l) =>
            l.kind === 'stock' ? `S${l.shares}` : `${l.action}${l.qty}${l.quote.symbol}`,
          )
          .join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        evaluated++;
        const m = analyze(legs, { spot: data.spot, today: data.today, rate: data.rate, pricing });
        if (!m) continue;
        const w = structureWidth(legs);
        m.notes.push(...strategyNotes(def, legs, m, data.spot));
        all.push({
          strategy: def.id,
          expiration: exp,
          ...(back ? { back_expiration: back } : {}),
          dte: daysBetween(data.today, exp),
          width: w,
          credit_to_width: w ? Math.round((m.net_premium_per_share / w) * 10_000) / 10_000 : null,
          inputs: { delta: p.delta, otm_pct: p.otmPct, width },
          ...m,
        });
      }
    }
  }

  const passing = all.filter((c) => {
    const ps = c.net_premium_per_share;
    if (req.min_credit !== undefined && ps < req.min_credit) return false;
    if (req.max_debit !== undefined && -ps > req.max_debit) return false;
    if (req.min_pop !== undefined && c.pop < req.min_pop) return false;
    if (req.min_return_on_risk !== undefined && (c.return_on_risk ?? 0) < req.min_return_on_risk)
      return false;
    if (
      req.max_leg_spread_pct !== undefined &&
      c.liquidity.worst_leg_spread_pct !== null &&
      c.liquidity.worst_leg_spread_pct > req.max_leg_spread_pct
    )
      return false;
    if (
      req.min_leg_volume !== undefined &&
      (c.liquidity.min_leg_volume === null || c.liquidity.min_leg_volume < req.min_leg_volume)
    )
      return false;
    return true;
  });
  const key = SORTS[sortBy];
  passing.sort((a, b) => key(b) - key(a));

  return {
    underlying: data.underlying,
    spot: data.spot,
    strategy: def.id,
    expirations_scanned: exps,
    candidates_evaluated: evaluated,
    candidates_passing: passing.length,
    sort_by: sortBy,
    results: passing.slice(0, limit),
    assumptions: [
      `prices at ${pricing}${pricing === 'mid' ? ' (natural = buy at ask, sell at bid)' : ''}`,
      'dollar figures are per 1 structure (options ×100 shares); net_premium > 0 = credit',
      'P&L / POP / expected value measured at the front expiry under a lognormal model using the legs’ implied vol',
      'no commissions, dividends or early assignment modelled',
    ],
  };
}
