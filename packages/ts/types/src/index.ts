/**
 * Shared domain types. Single source of truth for:
 *   - User tiers (Free / Starter / Pro)
 *   - Credit units + cost table
 *   - API request/response schemas (mirrored as Zod runtime validators)
 *   - Firestore collection shapes (referenced by firestore-schema)
 */

export * from './admin';
export * from './dates';

export type Tier = 'free' | 'starter' | 'pro';

export interface UserProfile {
  uid: string;
  email: string;
  tier: Tier;
  createdAt: string;
}

export interface CreditLedgerEntry {
  uid: string;
  delta: number;
  reason: string;
  at: string;
}

// ── Options market data ────────────────────────────────────────────────
// Provider-agnostic shapes. Never leak upstream provider names through
// these types — API/MCP consumers see `source`, not a vendor.

export type OptionType = 'call' | 'put';

/** Where a quote came from: `live` = real-time provider, `history` = ClickHouse. */
export type QuoteSource = 'live' | 'history';

export interface OptionGreeks {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
}

export interface OptionQuote extends OptionGreeks {
  /** OCC symbol, e.g. `SPY260918C00500000`. */
  symbol: string;
  underlying: string;
  /** Int YYYYMMDD — matches ClickHouse `expiration` column. */
  expiration: number;
  /** Calendar days to expiration, measured from today in US/Pacific. */
  dte: number;
  type: OptionType;
  strike: number;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  mid: number | null;
  last: number | null;
  volume: number | null;
  /** Present on `history` quotes (EOD open interest). */
  openInterest?: number | null;
  iv: number | null;
  /** ISO-8601 timestamp of the latest quote. */
  quoteTime: string | null;
  /**
   * Where iv/greeks came from: `provider` (quoted upstream) or `model`
   * (implied from mid with Black–Scholes, e.g. 0DTE where upstream omits them).
   */
  greeksSource?: 'provider' | 'model';
}

export interface UnderlyingQuote {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  time: string | null;
}

export interface OptionChain {
  underlying: string;
  source: QuoteSource;
  /** ISO-8601 time the chain was assembled server-side. */
  asOf: string;
  spot: UnderlyingQuote | null;
  /** `history` only: the snapshot market day (Int YYYYMMDD, US/Pacific). */
  snapshotDate?: number;
  expirations: number[];
  quotes: OptionQuote[];
}

/** What history holds for one underlying. Dates/expirations are Int YYYYMMDD. */
export interface HistoryCoverage {
  underlying: string;
  rows: number;
  snapshots: number;
  firstDate: number | null;
  lastDate: number | null;
  expirations: number;
  firstExpiration: number | null;
  lastExpiration: number | null;
}

/** Request header the AppShell's Refresh sends: the server drops its cached reads once per token. */
export const REFRESH_HEADER = 'x-edgedesk-refresh';
