/**
 * Raw `options_chains` rows → shared `OptionQuote`s. The one place CH column
 * names map onto API shapes.
 */
import type { OptionQuote, OptionType } from '@edgedesk/types';

/** A row as `FORMAT JSON` returns it (Int64 may arrive as a string). */
export type RawOptionRow = Record<string, unknown>;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 0 means "no quote" in EOD rows. */
function price(v: unknown): number | null {
  const n = num(v);
  return n === null || n <= 0 ? null : n;
}

function optionType(v: unknown): OptionType | null {
  const c = String(v ?? '')
    .trim()
    .charAt(0)
    .toUpperCase();
  return c === 'C' ? 'call' : c === 'P' ? 'put' : null;
}

/** 20260918, 'C', 500 → `SPY260918C00500000`. */
export function occSymbol(root: string, expiration: number, type: OptionType, strike: number) {
  const strikeMilli = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${root}${String(expiration).slice(2)}${type === 'call' ? 'C' : 'P'}${strikeMilli}`;
}

/** CH `DateTime64(3, UTC)` text (`2026-09-18 07:00:00.000`) → ISO-8601. */
export function chTimeToIso(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  const iso = `${v.replace(' ', 'T')}${/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? '' : 'Z'}`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Normalize `options_chains` rows. Rows missing a usable expiration, strike or
 * right are dropped. IV/greeks are the stored (feed) values.
 */
export function normalizeOptionRows(rows: RawOptionRow[]): OptionQuote[] {
  const out: OptionQuote[] = [];
  for (const r of rows) {
    const underlying = String(r.underlying ?? '').toUpperCase();
    const expiration = num(r.expiration);
    const strike = num(r.strike);
    const type = optionType(r.right);
    if (!underlying || expiration === null || strike === null || type === null) continue;
    const bid = price(r.bid);
    const ask = price(r.ask);
    out.push({
      symbol: occSymbol(underlying, expiration, type, strike),
      underlying,
      expiration,
      dte: num(r.dte) ?? 0,
      type,
      strike,
      bid,
      ask,
      bidSize: num(r.bid_size),
      askSize: num(r.ask_size),
      mid: bid !== null && ask !== null ? Math.round(((bid + ask) / 2) * 10_000) / 10_000 : null,
      last: price(r.last),
      volume: num(r.volume),
      openInterest: num(r.open_interest),
      iv: price(r.implied_volatility),
      delta: num(r.delta),
      gamma: num(r.gamma),
      theta: num(r.theta),
      vega: num(r.vega),
      rho: num(r.rho),
      quoteTime: chTimeToIso(r.quote_timestamp) ?? chTimeToIso(r.snapshot_date),
      greeksSource: 'provider',
    });
  }
  return out;
}

/** Underlying price stored on the rows (`underlying_last`), or null. */
export function underlyingLast(rows: RawOptionRow[]): number | null {
  for (const r of rows) {
    const v = price(r.underlying_last);
    if (v !== null) return v;
  }
  return null;
}
