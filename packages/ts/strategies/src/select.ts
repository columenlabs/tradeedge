/** Strike pickers over one expiration's chain. */
import { type OptionQuote, type OptionType, daysBetween } from '@edgedesk/types';
import { bsGreeks, impliedVol } from './bs';

export interface PickContext {
  spot: number;
  today: number;
  rate?: number;
}

/** A leg's IV: quoted, else implied from its mid. */
export function ivOf(q: OptionQuote, ctx: PickContext): number | null {
  if (q.iv !== null && q.iv > 0) return q.iv;
  const t = daysBetween(ctx.today, q.expiration) / 365;
  const px = q.mid ?? (q.bid !== null && q.ask !== null ? (q.bid + q.ask) / 2 : q.last);
  if (!px || t <= 0) return null;
  return impliedVol(px, { type: q.type, spot: ctx.spot, strike: q.strike, t, rate: ctx.rate });
}

/** Signed delta: quoted, else Black–Scholes from IV (so 0DTE / greek-less quotes still select). */
export function deltaOf(q: OptionQuote, ctx: PickContext): number | null {
  if (q.delta !== null) return q.delta;
  const iv = ivOf(q, ctx);
  const t = daysBetween(ctx.today, q.expiration) / 365;
  if (iv === null) return null;
  return bsGreeks({
    type: q.type,
    spot: ctx.spot,
    strike: q.strike,
    t: Math.max(t, 0.5 / 365),
    iv,
    rate: ctx.rate,
  }).delta;
}

const tradable = (q: OptionQuote) =>
  (q.bid !== null && q.ask !== null && q.ask > 0) || (q.last ?? 0) > 0;

export type Selector = { strike: number } | { otmPct: number } | { delta: number } | { atm: true };

/** Nearest contract of `type` to the selector. `delta` is an absolute value (0.16 = 16Δ call or −16Δ put). */
export function pick(
  chain: OptionQuote[],
  type: OptionType,
  sel: Selector,
  ctx: PickContext,
): OptionQuote | null {
  const side = chain.filter((q) => q.type === type && tradable(q));
  if (!side.length) return null;
  let score: (q: OptionQuote) => number;
  if ('strike' in sel) score = (q) => Math.abs(q.strike - sel.strike);
  else if ('otmPct' in sel) {
    const target = type === 'call' ? ctx.spot * (1 + sel.otmPct) : ctx.spot * (1 - sel.otmPct);
    score = (q) => Math.abs(q.strike - target);
  } else if ('delta' in sel) {
    const target = Math.abs(sel.delta);
    score = (q) => {
      const d = deltaOf(q, ctx);
      return d === null ? Number.POSITIVE_INFINITY : Math.abs(Math.abs(d) - target);
    };
  } else score = (q) => Math.abs(q.strike - ctx.spot);
  let best: OptionQuote | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const q of side) {
    const s = score(q);
    if (s < bestScore) {
      best = q;
      bestScore = s;
    }
  }
  return bestScore === Number.POSITIVE_INFINITY ? null : best;
}

/** The contract `width` dollars beyond `from` in `dir` (+1 higher strike, −1 lower), strictly past `from`. */
export function wing(
  chain: OptionQuote[],
  type: OptionType,
  from: number,
  width: number,
  dir: 1 | -1,
): OptionQuote | null {
  const target = from + dir * width;
  let best: OptionQuote | null = null;
  for (const q of chain) {
    if (q.type !== type || !tradable(q) || (q.strike - from) * dir <= 0) continue;
    if (!best || Math.abs(q.strike - target) < Math.abs(best.strike - target)) best = q;
  }
  return best;
}

/** Same type, exact strike (for multi-expiry structures). */
export function atStrike(
  chain: OptionQuote[],
  type: OptionType,
  strike: number,
): OptionQuote | null {
  return chain.find((q) => q.type === type && q.strike === strike && tradable(q)) ?? null;
}
