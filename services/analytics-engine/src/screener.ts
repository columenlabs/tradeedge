/**
 * Screener (screener_run) and trade evaluator (trade_evaluate) on top of live chains. Shared by /api and /mcp.
 */
import {
  type Leg,
  type Pricing,
  type ScreenRequest,
  type Strategy,
  analyze,
  screen,
} from '@edgedesk/strategies';
import { type OptionType, dateToExpInt } from '@edgedesk/types';
import type { MarketService } from './market';

async function spotOf(market: MarketService, underlying: string): Promise<number> {
  const q = await market.quote(underlying);
  const spot = q.last ?? (q.bid !== null && q.ask !== null ? (q.bid + q.ask) / 2 : null);
  if (spot === null) throw new Error(`no spot price for ${underlying}`);
  return spot;
}

export async function runScreen(
  market: MarketService,
  underlying: string,
  req: ScreenRequest,
  strategy: Strategy,
) {
  const u = underlying.toUpperCase();
  const [spot, expirations] = await Promise.all([spotOf(market, u), market.expirations(u)]);
  return screen(
    req,
    {
      underlying: u,
      spot,
      today: dateToExpInt(new Date()),
      expirations,
      chain: async (expiration) => (await market.chain({ underlying: u, expiration })).quotes,
    },
    strategy,
  );
}

export interface LegInput {
  action: 'buy' | 'sell';
  instrument: OptionType | 'stock';
  /** Required for options. */
  strike?: number;
  /** Required for options (YYYYMMDD). */
  expiration?: number;
  /** Contracts for options, shares for stock. Default 1 (options) / 100 (stock). */
  qty?: number;
}

export class LegNotFound extends Error {}

export async function runEvaluate(
  market: MarketService,
  underlying: string,
  inputs: LegInput[],
  pricing: Pricing = 'mid',
) {
  const u = underlying.toUpperCase();
  const spot = await spotOf(market, u);
  const chains = new Map<number, Awaited<ReturnType<MarketService['chain']>>['quotes']>();
  const legs: Leg[] = [];
  for (const l of inputs) {
    if (l.instrument === 'stock') {
      legs.push({ kind: 'stock', action: l.action, shares: l.qty ?? 100, price: spot });
      continue;
    }
    if (l.strike === undefined || l.expiration === undefined) {
      throw new LegNotFound('option legs need strike and expiration');
    }
    if (!chains.has(l.expiration)) {
      chains.set(
        l.expiration,
        (await market.chain({ underlying: u, expiration: l.expiration })).quotes,
      );
    }
    const chain = chains.get(l.expiration) ?? [];
    const q = chain.find((c) => c.type === l.instrument && c.strike === l.strike);
    if (!q) {
      const near = chain
        .filter((c) => c.type === l.instrument)
        .map((c) => c.strike)
        .sort((a, b) => Math.abs(a - (l.strike as number)) - Math.abs(b - (l.strike as number)))
        .slice(0, 5);
      throw new LegNotFound(
        `no ${l.instrument} at strike ${l.strike} for ${l.expiration}; nearest: ${near.join(', ') || 'none (bad expiration?)'}`,
      );
    }
    legs.push({ kind: 'option', action: l.action, qty: l.qty ?? 1, quote: q });
  }
  const m = analyze(legs, { spot, today: dateToExpInt(new Date()), pricing });
  if (!m) throw new LegNotFound('could not price one or more legs (no bid/ask/last)');
  return { underlying: u, spot, ...m };
}
