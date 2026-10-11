/**
 * Strategies: the reusable structure a trade starts from (iron condor, jade lizard, ...).
 * A strategy is data (D1 `strategies`, migrations 0017 and 0022): each leg names how its strike is chosen, and one
 * builder turns a strategy plus a chain and knobs into concrete legs. Agents add strategies with strategy_write.
 */
import type { OptionQuote, OptionType } from '@edgedesk/types';
import type { Leg } from './legs';
import { type PickContext, type Selector, atStrike, pick, wing } from './select';

export type Bias = 'bullish' | 'bearish' | 'neutral' | 'long_volatility' | 'short_volatility';

export interface Knobs {
  /** Abs delta for the strategy's primary legs (0.16 = 16Δ). */
  delta?: number;
  /** Distance OTM as a fraction of spot (0.05 = 5% OTM) for the primary legs. */
  otmPct?: number;
  /** Wing / spread width in $ of strike. */
  width?: number;
  /** Abs delta for legs picked by `long_delta` (ZEBRA / PMCC long leg). */
  longDelta?: number;
  /** Exact strikes by role name. */
  strikes?: Record<string, number>;
}

export interface BuildContext extends PickContext {
  /** Front / only expiration's chain. */
  chain: OptionQuote[];
  /** Back expiration's chain (calendars, diagonals). */
  back?: OptionQuote[];
}

/**
 * How a leg's strike is chosen. An explicit strike for the leg's role always wins.
 * - pick: the knob `delta` (otm_pct / delta) or `long_delta` overrides the default (`delta` or ATM);
 *   `none` always takes the default.
 * - wing: `width` dollars past the strike of role `from`, up (higher) or down (lower).
 * - same: the same strike as role `from`, on this leg's own expiry.
 */
export type StrikeRule =
  | { pick: { delta: number } | { atm: true }; knob: 'delta' | 'long_delta' | 'none' }
  | { wing: string; dir: 'up' | 'down' }
  | { same: string };

export interface StrategyLeg {
  action: 'buy' | 'sell';
  instrument: OptionType | 'stock';
  /** Contracts for options, shares for stock. */
  qty: number;
  /** Options: the front (only) expiry or the later back expiry. */
  expiry?: 'front' | 'back';
  /** Name for `strikes` and for other legs' `wing` / `same`. Needed by every option leg but a `same` leg. */
  role?: string;
  /** Options only. */
  strike?: StrikeRule;
}

export interface Strategy {
  id: string;
  name: string;
  bias: Bias;
  premium: 'credit' | 'debit' | 'either';
  risk: 'defined' | 'undefined';
  summary: string;
  legs: StrategyLeg[];
  /** Pairs of roles whose strikes must rise in that order, e.g. [["short_put","short_call"]]. */
  strike_order: [string, string][];
  /** Delta scan the screener runs when no delta, otm_pct or strikes is given; null = one build from defaults. */
  default_deltas: number[] | null;
}

/** Facts read off the legs: roles accepted in `strikes`, expiries needed, whether `width` applies. */
export function strategyFacts(s: Pick<Strategy, 'legs'>) {
  return {
    roles: s.legs.flatMap((l) => (l.role ? [l.role] : [])),
    expirations: s.legs.some((l) => l.expiry === 'back') ? (2 as const) : (1 as const),
    uses_width: s.legs.some((l) => l.strike !== undefined && 'wing' in l.strike),
  };
}

const dep = (r: StrikeRule | undefined) =>
  r === undefined ? null : 'wing' in r ? r.wing : 'same' in r ? r.same : null;

/** Why a strategy cannot be built, or null when it is sound. */
export function strategyProblem(s: Pick<Strategy, 'legs' | 'strike_order'>): string | null {
  const roles = new Map<string, StrategyLeg>();
  for (const l of s.legs) {
    if (l.instrument === 'stock') {
      if (l.strike || l.role || l.expiry) return 'a stock leg has no strike, role or expiry';
      continue;
    }
    if (!l.strike) return 'every option leg needs a strike rule';
    if (!l.role && !('same' in l.strike)) return 'every option leg but a `same` leg needs a role';
    if (l.role) {
      if (roles.has(l.role)) return `role ${l.role} is used twice`;
      roles.set(l.role, l);
    }
  }
  for (const l of s.legs) {
    const from = dep(l.strike);
    if (from === null) continue;
    const base = roles.get(from);
    if (!base) return `unknown role ${from}`;
    if (base.instrument === 'stock') return `role ${from} is a stock leg`;
  }
  // Every chain of wing / same references must end at a pick (no cycles).
  for (const l of s.legs) {
    const seen = new Set<string>();
    let cur: StrategyLeg | undefined = l;
    while (cur) {
      const from = dep(cur.strike);
      if (from === null) break;
      if (seen.has(from)) return `roles ${[...seen].join(', ')} refer to each other`;
      seen.add(from);
      cur = roles.get(from);
    }
  }
  for (const [lo, hi] of s.strike_order) {
    if (!roles.has(lo) || !roles.has(hi))
      return `strike_order names an unknown role (${lo}, ${hi})`;
  }
  return null;
}

/** Legs for a strategy on this chain, or null when the chain cannot fill it. */
export function buildStrategy(s: Strategy, ctx: BuildContext, k: Knobs): Leg[] | null {
  const byRole = new Map(s.legs.flatMap((l) => (l.role ? [[l.role, l] as const] : [])));
  const picked = new Map<StrategyLeg, OptionQuote | null>();
  const quoteOf = (l: StrategyLeg): OptionQuote | null => {
    if (picked.has(l)) return picked.get(l) ?? null;
    picked.set(l, null); // guards a cycle strategyProblem missed
    const chain = l.expiry === 'back' ? ctx.back : ctx.chain;
    const type = l.instrument as OptionType;
    const rule = l.strike;
    let q: OptionQuote | null = null;
    if (chain && rule) {
      const exact = l.role ? k.strikes?.[l.role] : undefined;
      if (exact !== undefined) q = pick(chain, type, { strike: exact }, ctx);
      else if ('pick' in rule) {
        let sel: Selector = 'delta' in rule.pick ? { delta: rule.pick.delta } : { atm: true };
        if (rule.knob === 'long_delta' && k.longDelta !== undefined) sel = { delta: k.longDelta };
        if (rule.knob === 'delta') {
          if (k.otmPct !== undefined) sel = { otmPct: k.otmPct };
          else if (k.delta !== undefined) sel = { delta: k.delta };
        }
        q = pick(chain, type, sel, ctx);
      } else {
        const base = byRole.get('wing' in rule ? rule.wing : rule.same);
        const from = base ? quoteOf(base) : null;
        if (from && 'same' in rule) q = atStrike(chain, type, from.strike);
        if (from && 'wing' in rule && k.width !== undefined)
          q = wing(chain, type, from.strike, k.width, rule.dir === 'up' ? 1 : -1);
      }
    }
    picked.set(l, q);
    return q;
  };
  const legs: Leg[] = [];
  for (const l of s.legs) {
    if (l.instrument === 'stock') {
      legs.push({ kind: 'stock', action: l.action, shares: l.qty, price: ctx.spot });
      continue;
    }
    const q = quoteOf(l);
    if (!q) return null;
    legs.push({ kind: 'option', action: l.action, qty: l.qty, quote: q });
  }
  for (const [lo, hi] of s.strike_order) {
    const a = byRole.get(lo);
    const b = byRole.get(hi);
    const qa = a ? picked.get(a) : null;
    const qb = b ? picked.get(b) : null;
    if (!qa || !qb || qa.strike >= qb.strike) return null;
  }
  return legs;
}
