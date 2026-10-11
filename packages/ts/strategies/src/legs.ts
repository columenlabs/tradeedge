import type { OptionQuote } from '@edgedesk/types';

export type Action = 'buy' | 'sell';

export interface OptionLeg {
  kind: 'option';
  action: Action;
  /** Contracts (×100 shares). */
  qty: number;
  quote: OptionQuote;
}

export interface StockLeg {
  kind: 'stock';
  action: Action;
  shares: number;
  price: number;
}

export type Leg = OptionLeg | StockLeg;

export type Pricing = 'mid' | 'natural';

export const MULTIPLIER = 100;

export const sign = (a: Action) => (a === 'buy' ? 1 : -1);

/** Per-share fill price: mid, or natural (buy at ask, sell at bid). Falls back to last. */
export function entryPrice(leg: OptionLeg, pricing: Pricing): number | null {
  const { bid, ask, mid, last } = leg.quote;
  if (pricing === 'natural') {
    const p = leg.action === 'buy' ? ask : bid;
    if (p !== null && p > 0) return p;
  }
  if (mid !== null && mid > 0) return mid;
  if (bid !== null && ask !== null && ask > 0) return (bid + ask) / 2;
  return last !== null && last > 0 ? last : null;
}
