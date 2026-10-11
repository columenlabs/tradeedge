/**
 * Black-Scholes pricing and greeks (European, continuous rate, no dividends).
 * Times are in years; `iv` and `r` are decimals.
 */
import type { OptionType } from '@edgedesk/types';

/** Risk-free rate used for every valuation. Shown in the UI next to PoP. */
export const RATE = 0.04;

const SQRT_2PI = Math.sqrt(2 * Math.PI);

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = normPdf(x) * poly;
  return x >= 0 ? 1 - p : p;
}

export function intrinsic(type: OptionType, spot: number, strike: number): number {
  return type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
}

function d1d2(spot: number, strike: number, t: number, iv: number, r: number) {
  const vt = iv * Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (r + (iv * iv) / 2) * t) / vt;
  return { d1, d2: d1 - vt };
}

export function price(
  type: OptionType,
  spot: number,
  strike: number,
  t: number,
  iv: number,
  r = RATE,
): number {
  if (t <= 0 || iv <= 0 || spot <= 0) return intrinsic(type, spot, strike);
  const { d1, d2 } = d1d2(spot, strike, t, iv, r);
  const df = Math.exp(-r * t);
  return type === 'call'
    ? spot * normCdf(d1) - strike * df * normCdf(d2)
    : strike * df * normCdf(-d2) - spot * normCdf(-d1);
}

export interface Greeks {
  delta: number;
  gamma: number;
  /** Per calendar day. */
  theta: number;
  /** Per 1 volatility point (0.01). */
  vega: number;
}

export function greeks(
  type: OptionType,
  spot: number,
  strike: number,
  t: number,
  iv: number,
  r = RATE,
): Greeks {
  if (t <= 0 || iv <= 0 || spot <= 0) {
    const itm = type === 'call' ? spot > strike : spot < strike;
    return { delta: itm ? (type === 'call' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const { d1, d2 } = d1d2(spot, strike, t, iv, r);
  const sqrtT = Math.sqrt(t);
  const df = Math.exp(-r * t);
  const pdf = normPdf(d1);
  const common = (-spot * pdf * iv) / (2 * sqrtT);
  const theta =
    type === 'call'
      ? common - r * strike * df * normCdf(d2)
      : common + r * strike * df * normCdf(-d2);
  return {
    delta: type === 'call' ? normCdf(d1) : normCdf(d1) - 1,
    gamma: pdf / (spot * iv * sqrtT),
    theta: theta / 365,
    vega: (spot * pdf * sqrtT) / 100,
  };
}

/** P(S_T < x) under a lognormal with drift `r` and volatility `iv`. */
export function probBelow(x: number, spot: number, t: number, iv: number, r = RATE): number {
  if (x <= 0) return 0;
  if (t <= 0 || iv <= 0) return spot < x ? 1 : 0;
  return normCdf((Math.log(x / spot) - (r - (iv * iv) / 2) * t) / (iv * Math.sqrt(t)));
}
