/**
 * Black–Scholes (no dividends). Used to value legs that expire after the
 * evaluation horizon, to fill missing greeks, and for probability maths.
 */
import type { OptionType } from '@edgedesk/types';

export const DEFAULT_RATE = 0.04;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |err| < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export const normPdf = (x: number) => Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);

export interface BsInput {
  type: OptionType;
  spot: number;
  strike: number;
  /** Years to expiry. */
  t: number;
  /** Annualized volatility, decimal. */
  iv: number;
  rate?: number;
}

export function bsPrice({ type, spot, strike, t, iv, rate = DEFAULT_RATE }: BsInput): number {
  if (t <= 0 || iv <= 0) return Math.max(0, type === 'call' ? spot - strike : strike - spot);
  const sq = iv * Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * t) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-rate * t);
  return type === 'call'
    ? spot * normCdf(d1) - strike * df * normCdf(d2)
    : strike * df * normCdf(-d2) - spot * normCdf(-d1);
}

export interface Greeks {
  delta: number;
  gamma: number;
  /** Per calendar day. */
  theta: number;
  /** Per 1 vol point (0.01). */
  vega: number;
}

export function bsGreeks({ type, spot, strike, t, iv, rate = DEFAULT_RATE }: BsInput): Greeks {
  if (t <= 0 || iv <= 0) {
    const itm = type === 'call' ? spot > strike : spot < strike;
    return { delta: itm ? (type === 'call' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sq = iv * Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * t) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-rate * t);
  const gamma = normPdf(d1) / (spot * sq);
  const vega = (spot * normPdf(d1) * Math.sqrt(t)) / 100;
  const common = -(spot * normPdf(d1) * iv) / (2 * Math.sqrt(t));
  const theta =
    type === 'call'
      ? (common - rate * strike * df * normCdf(d2)) / 365
      : (common + rate * strike * df * normCdf(-d2)) / 365;
  return { delta: type === 'call' ? normCdf(d1) : normCdf(d1) - 1, gamma, theta, vega };
}

/** Implied vol by bisection; null when the price is outside no-arbitrage bounds. */
export function impliedVol(price: number, input: Omit<BsInput, 'iv'>): number | null {
  const intrinsic = Math.max(
    0,
    input.type === 'call' ? input.spot - input.strike : input.strike - input.spot,
  );
  if (!(price > intrinsic) || input.t <= 0) return null;
  let lo = 0.001;
  let hi = 5;
  if (bsPrice({ ...input, iv: hi }) < price) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice({ ...input, iv: mid }) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
