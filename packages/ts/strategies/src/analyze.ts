/**
 * Evaluate a set of legs: net premium, P&L at the horizon (earliest expiry),
 * max profit/loss, breakevens, probability of profit, expected value, greeks,
 * liquidity. Legs expiring after the horizon are valued with Black–Scholes.
 */
import { daysBetween, expIntToIso } from '@edgedesk/types';
import { DEFAULT_RATE, bsGreeks, bsPrice, normCdf } from './bs';
import { type Leg, MULTIPLIER, type OptionLeg, type Pricing, entryPrice, sign } from './legs';
import { ivOf } from './select';

export interface AnalyzeContext {
  spot: number;
  /** Int YYYYMMDD (US/Pacific). */
  today: number;
  rate?: number;
  pricing?: Pricing;
}

export interface LegView {
  action: 'buy' | 'sell';
  qty: number;
  instrument: 'call' | 'put' | 'stock';
  strike?: number;
  expiration?: number;
  dte?: number;
  price: number;
  bid?: number | null;
  ask?: number | null;
  delta?: number | null;
  iv?: number | null;
  volume?: number | null;
  symbol?: string;
}

export interface Metrics {
  legs: LegView[];
  /** $ per 1 unit of the structure; positive = credit received, negative = debit paid. */
  net_premium: number;
  /** Per-share equivalent of net_premium for 1-lot structures (net_premium / 100). */
  net_premium_per_share: number;
  /** Evaluation horizon: earliest option expiry. */
  horizon: number;
  horizon_dte: number;
  /** $ per unit at the horizon; null = unlimited. */
  max_profit: number | null;
  max_loss: number | null;
  breakevens: number[];
  /** Probability the structure is profitable at the horizon (lognormal, horizon IV). */
  pop: number;
  expected_value: number;
  /** max_profit / |max_loss| when both are finite. */
  return_on_risk: number | null;
  /** Capital at risk: |max_loss| when finite. */
  capital_required: number | null;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  liquidity: { worst_leg_spread_pct: number | null; min_leg_volume: number | null };
  iv_used: number;
  notes: string[];
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function analyze(legs: Leg[], ctx: AnalyzeContext): Metrics | null {
  const rate = ctx.rate ?? DEFAULT_RATE;
  const pricing = ctx.pricing ?? 'mid';
  const opts = legs.filter((l): l is OptionLeg => l.kind === 'option');
  if (!opts.length && !legs.length) return null;

  const horizon = opts.length ? Math.min(...opts.map((l) => l.quote.expiration)) : ctx.today;
  const hDte = Math.max(0, daysBetween(ctx.today, horizon));
  const tH = Math.max(hDte, 0.5) / 365;

  // Entry prices + IVs.
  const entries: number[] = [];
  const ivs: (number | null)[] = [];
  for (const l of legs) {
    if (l.kind === 'stock') {
      entries.push(l.price);
      ivs.push(null);
      continue;
    }
    const p = entryPrice(l, pricing);
    if (p === null) return null;
    entries.push(p);
    ivs.push(ivOf(l.quote, { spot: ctx.spot, today: ctx.today, rate }));
  }

  // Distribution vol: mean IV of legs expiring at the horizon (short legs first).
  const horizonIvs = legs
    .map((l, i) => ({ l, iv: ivs[i] }))
    .filter((x) => x.l.kind === 'option' && x.l.quote.expiration === horizon && x.iv)
    .sort((a, b) => (a.l.action === 'sell' ? -1 : 1) - (b.l.action === 'sell' ? -1 : 1));
  const sigma =
    horizonIvs.length > 0
      ? horizonIvs.reduce((s, x) => s + (x.iv as number), 0) / horizonIvs.length
      : 0.25;

  const units = (l: Leg) => (l.kind === 'stock' ? l.shares : l.qty * MULTIPLIER);

  const netPremium = legs.reduce(
    (s, l, i) => s - sign(l.action) * (entries[i] as number) * units(l),
    0,
  );

  const valueAt = (S: number, l: Leg, i: number): number => {
    if (l.kind === 'stock') return S;
    const q = l.quote;
    if (q.expiration === horizon)
      return Math.max(0, q.type === 'call' ? S - q.strike : q.strike - S);
    const t = daysBetween(horizon, q.expiration) / 365;
    // US equity options are American: never worth less than intrinsic.
    const intrinsic = Math.max(0, q.type === 'call' ? S - q.strike : q.strike - S);
    return Math.max(
      intrinsic,
      bsPrice({ type: q.type, spot: S, strike: q.strike, t, iv: ivs[i] ?? sigma, rate }),
    );
  };
  const pnl = (S: number) =>
    legs.reduce(
      (s, l, i) => s + sign(l.action) * (valueAt(S, l, i) - (entries[i] as number)) * units(l),
      0,
    );

  // Max profit / loss over a wide linear grid, plus tail slope for unlimited detection.
  const strikes = opts.map((l) => l.quote.strike);
  const hi = Math.max(ctx.spot * 3, ...strikes.map((k) => k * 1.5));
  const N = 240;
  let maxP = Number.NEGATIVE_INFINITY;
  let maxL = Number.POSITIVE_INFINITY;
  const lin: { S: number; v: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const S = (hi * i) / N;
    const v = pnl(S);
    lin.push({ S, v });
    maxP = Math.max(maxP, v);
    maxL = Math.min(maxL, v);
  }
  for (const k of strikes) {
    const v = pnl(k);
    maxP = Math.max(maxP, v);
    maxL = Math.min(maxL, v);
  }
  const tailSlope = (pnl(hi * 4) - pnl(hi * 2)) / (hi * 2);
  const unlimitedProfit = tailSlope > 0.5;
  const unlimitedLoss = tailSlope < -0.5;

  // Breakevens: sign changes on a fine grid around spot.
  const lo2 = ctx.spot * 0.4;
  const hi2 = Math.max(ctx.spot * 1.8, ...strikes.map((k) => k * 1.2));
  const breakevens: number[] = [];
  const M = 600;
  let prevS = lo2;
  let prevV = pnl(lo2);
  for (let i = 1; i <= M; i++) {
    const S = lo2 + ((hi2 - lo2) * i) / M;
    const v = pnl(S);
    if ((prevV <= 0 && v > 0) || (prevV > 0 && v <= 0)) {
      breakevens.push(round(prevS + ((0 - prevV) * (S - prevS)) / (v - prevV)));
    }
    prevS = S;
    prevV = v;
  }

  // POP (exact, between breakevens) + EV (midpoint rule) under lognormal(spot, sigma, tH).
  const sd = sigma * Math.sqrt(tH);
  const mu = Math.log(ctx.spot) + (rate - (sigma * sigma) / 2) * tH;
  const cdfAt = (x: number) => (x <= 0 ? 0 : normCdf((Math.log(x) - mu) / sd));
  const edges = [0, ...breakevens, Number.POSITIVE_INFINITY];
  let popExact = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i] as number;
    const b = edges[i + 1] as number;
    const probe =
      b === Number.POSITIVE_INFINITY
        ? Math.max(a * 1.05, ctx.spot)
        : a === 0
          ? b * 0.95
          : (a + b) / 2;
    if (pnl(probe) > 0) popExact += (b === Number.POSITIVE_INFINITY ? 1 : cdfAt(b)) - cdfAt(a);
  }
  const K = 240;
  let ev = 0;
  const z0 = -6;
  const z1 = 6;
  for (let i = 0; i < K; i++) {
    const za = z0 + ((z1 - z0) * i) / K;
    const zb = z0 + ((z1 - z0) * (i + 1)) / K;
    const w = normCdf(zb) - normCdf(za);
    const S = Math.exp(mu + sd * ((za + zb) / 2));
    const v = pnl(S);
    ev += w * v;
  }

  // Greeks ($-weighted per unit: delta in shares).
  const g = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  legs.forEach((l, i) => {
    if (l.kind === 'stock') {
      g.delta += sign(l.action) * l.shares;
      return;
    }
    const q = l.quote;
    const t = Math.max(daysBetween(ctx.today, q.expiration), 0.5) / 365;
    const bs = bsGreeks({
      type: q.type,
      spot: ctx.spot,
      strike: q.strike,
      t,
      iv: ivs[i] ?? sigma,
      rate,
    });
    const m = sign(l.action) * l.qty * MULTIPLIER;
    g.delta += m * (q.delta ?? bs.delta);
    g.gamma += m * (q.gamma ?? bs.gamma);
    g.theta += m * (q.theta ?? bs.theta);
    g.vega += m * (q.vega ?? bs.vega);
  });

  // Liquidity.
  let worst: number | null = null;
  let minVol: number | null = null;
  for (const l of opts) {
    const { bid, ask, volume } = l.quote;
    if (bid !== null && ask !== null && ask > 0) {
      const m = (bid + ask) / 2;
      const pct = m > 0 ? (ask - bid) / m : 1;
      worst = worst === null ? pct : Math.max(worst, pct);
    }
    if (volume !== null) minVol = minVol === null ? volume : Math.min(minVol, volume);
  }

  const maxProfit = unlimitedProfit ? null : round(maxP);
  const maxLoss = unlimitedLoss ? null : round(maxL);
  const notes: string[] = [];
  if (opts.some((l) => l.quote.iv === null))
    notes.push('some legs had no quoted IV; implied from mid');
  if (opts.some((l) => l.quote.expiration !== horizon))
    notes.push(
      `P&L measured at ${expIntToIso(horizon)} (front expiry); later legs valued with Black–Scholes at their IV`,
    );

  return {
    legs: legs.map((l, i): LegView => {
      if (l.kind === 'stock')
        return { action: l.action, qty: l.shares, instrument: 'stock', price: round(l.price) };
      const q = l.quote;
      return {
        action: l.action,
        qty: l.qty,
        instrument: q.type,
        strike: q.strike,
        expiration: q.expiration,
        dte: q.dte,
        price: round(entries[i] as number),
        bid: q.bid,
        ask: q.ask,
        delta: q.delta === null ? null : round(q.delta, 3),
        iv: ivs[i] === null ? null : round(ivs[i] as number, 4),
        volume: q.volume,
        symbol: q.symbol,
      };
    }),
    net_premium: round(netPremium),
    net_premium_per_share: round(netPremium / MULTIPLIER, 4),
    horizon,
    horizon_dte: hDte,
    max_profit: maxProfit,
    max_loss: maxLoss,
    breakevens,
    pop: round(popExact, 4),
    expected_value: round(ev),
    return_on_risk:
      maxProfit !== null && maxLoss !== null && maxLoss < 0 ? round(maxProfit / -maxLoss, 4) : null,
    capital_required: maxLoss !== null && maxLoss < 0 ? round(-maxLoss) : null,
    greeks: {
      delta: round(g.delta, 2),
      gamma: round(g.gamma, 4),
      theta: round(g.theta, 2),
      vega: round(g.vega, 2),
    },
    liquidity: {
      worst_leg_spread_pct: worst === null ? null : round(worst, 4),
      min_leg_volume: minVol,
    },
    iv_used: round(sigma, 4),
    notes,
  };
}
