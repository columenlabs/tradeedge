/** Saved trades (D1) ↔ the page's legs. Saved legs carry no IV; the chain adds it. */
import { daysBetween } from '@edgedesk/types';
import type { OptionQuote } from '@edgedesk/types';
import type { SavedLeg } from './api';
import { todayPT } from './calendar';
import { type Leg, legId } from './strategy';

/** Calendar days from today (US/Pacific) to an Int YYYYMMDD expiration. */
export const daysTo = (expiration: number) => Math.max(0, daysBetween(todayPT(), expiration));

const cents = (v: number) => Math.round(v * 100) / 100;

export function toLegs(saved: SavedLeg[]): Leg[] {
  return saved.map((s) => {
    const side = s.action === 'buy' ? 1 : -1;
    const quotes = { price: s.price ?? Number.NaN, bid: s.bid, ask: s.ask };
    if (s.instrument === 'stock') {
      return {
        id: legId(),
        type: 'stock',
        side,
        strike: 0,
        expiration: 0,
        dte: 0,
        qty: s.qty,
        iv: null,
        ...quotes,
      };
    }
    const expiration = s.expiration ?? todayPT();
    return {
      id: legId(),
      type: s.instrument,
      side,
      strike: s.strike ?? 0,
      expiration,
      dte: daysTo(expiration),
      qty: s.qty,
      iv: null,
      ...quotes,
    };
  });
}

export function toSaved(legs: Leg[]): SavedLeg[] {
  return legs.map((l) => {
    const action = l.side > 0 ? 'buy' : 'sell';
    const quotes = {
      price: cents(l.price),
      ...(l.bid !== undefined ? { bid: cents(l.bid) } : {}),
      ...(l.ask !== undefined ? { ask: cents(l.ask) } : {}),
    };
    return l.type === 'stock'
      ? { action, instrument: 'stock', qty: l.qty, ...quotes }
      : {
          action,
          instrument: l.type,
          strike: l.strike,
          expiration: l.expiration,
          qty: l.qty,
          ...quotes,
        };
  });
}

/** The live quote for a leg's contract, if the chain lists it. */
export const quoteFor = (l: Leg, quotes: OptionQuote[]) =>
  l.type === 'stock'
    ? undefined
    : quotes.find(
        (q) => q.type === l.type && q.strike === l.strike && q.expiration === l.expiration,
      );

/**
 * Fills what a saved leg lacks from the live chain: IV and days to expiry always; the entry price
 * (the live mid) when an agent left it out; and bid and ask, as the live spread around the entry,
 * when the leg was saved without them. Shares take the spot.
 */
export function hydrate(legs: Leg[], quotes: OptionQuote[], spot: number | null): Leg[] {
  return legs.map((l) => {
    if (l.type === 'stock') {
      return Number.isNaN(l.price) && spot ? { ...l, price: spot } : l;
    }
    const q = quoteFor(l, quotes);
    if (!q) return Number.isNaN(l.price) ? { ...l, price: 0 } : l;
    const price = Number.isNaN(l.price) ? (q.mid ?? q.last ?? 0) : l.price;
    const half = q.bid !== null && q.ask !== null ? (q.ask - q.bid) / 2 : 0;
    return {
      ...l,
      iv: q.iv,
      dte: q.dte,
      price,
      bid: l.bid ?? Math.max(price - half, 0),
      ask: l.ask ?? price + half,
    };
  });
}
