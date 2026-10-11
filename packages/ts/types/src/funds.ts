// ResearchEdge Funds (Bikram, 2026-10-10): 13F filers ("funds"), their quarter-end holdings and
// the quarter-over-quarter changes. 13F has no trade dates: a change is dated by the quarter end
// and the filing date. Data: ClickHouse `market_lab.fund_holdings_13f` (homelab-pipelines).
import { z } from 'zod';

/** A fund's id is its SEC CIK. */
export const fundIdSchema = z.coerce.number().int().positive().max(9_999_999_999);
export const periodSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'period: yyyy-mm-dd quarter end');

/** What a fund did with a position between its previous filing and this one. */
export const fundActions = ['New', 'Added', 'Held', 'Trimmed', 'Sold'] as const;
export type FundAction = (typeof fundActions)[number];

/** A 13F filer in search results or the ★ list. */
export interface FundSummary {
  id: number;
  name: string;
  city: string;
  state: string;
  /** Newest quarter filed (quarter end) and its filing day. */
  period: string;
  filed: string;
  positions: number;
  value: number;
  followed: boolean;
}

/** One quarter a fund filed: the quarter end, the first filing day, and whether it was amended. */
export interface FundQuarter {
  period: string;
  filed: string;
  amended: boolean;
}

/**
 * One position of a fund in a quarter, with its change since the fund's previous filing. A sold
 * position (gone this quarter) has shares and value 0 and its previous shares. `delta_value` is the
 * share change at the quarter's price (value / shares; the previous price for a sold position).
 */
export interface FundRow {
  fund_id: number;
  fund: string;
  period: string;
  prev_period: string | null;
  filed: string;
  cusip: string;
  /** '' for shares, else 'Put' or 'Call' (options on the stock). */
  put_call: string;
  /** The ticker, or the issuer's name when the CUSIP maps to none. */
  symbol: string;
  issuer: string;
  /** The issuer's SEC industry (SIC description); '' when unknown. */
  sector: string;
  shares: number;
  value: number;
  prev_shares: number;
  prev_value: number;
  delta_shares: number;
  delta_value: number;
  /** % of the fund's 13F value this quarter. */
  pct: number;
  action: FundAction;
}

export interface FundReadResponse {
  fund: FundSummary;
  quarters: FundQuarter[];
}
export interface FundHoldingsResponse {
  period: string;
  prev_period: string | null;
  filed: string;
  rows: FundRow[];
}
export interface FundTransactionsResponse {
  rows: FundRow[];
  /** The quarters the rows span, newest first. */
  quarters: FundQuarter[];
}
/** One quarter of a position, for the details drawer's share history. */
export interface FundPositionPoint {
  period: string;
  shares: number;
  value: number;
}

/** A ★ fund's newest filing on the Funds home. */
export interface FundFiling {
  id: number;
  name: string;
  period: string;
  filed: string;
  positions: number;
  new: number;
  added: number;
  trimmed: number;
  sold: number;
  /** The position with the largest |delta_value|. */
  top_move: { symbol: string; delta_value: number } | null;
}
/** One "Worth knowing" line: a fixed rule over ★ funds' newest filings (no AI). */
export interface FundNote {
  kind: 'most_bought' | 'most_sold' | 'big_bet' | 'turnover' | 'you_hold';
  label: string;
  text: string;
  /** A symbol to open in Crowded stocks, when the line is about one. */
  symbol?: string;
}
export interface FundsHomeResponse {
  /** The latest quarter end and how many ★ funds filed for it. */
  season: { period: string; filed: number; followed: number };
  filings: FundFiling[];
  notes: FundNote[];
}

/** Quarter label: `2026-06-30` -> `Q2 2026`. */
export function quarterLabel(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return `Q${Math.ceil((m ?? 3) / 3)} ${y}`;
}
