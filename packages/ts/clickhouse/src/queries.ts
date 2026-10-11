/**
 * Query builders over `market_lab.options_chains` (ReplacingMergeTree).
 *
 * `symbol` is the OCC contract (`SPY260629C00500000`); `underlying` is the ticker.
 * The table is partitioned and sorted by `underlying`, so every filter and group
 * here uses `underlying`, never `symbol` (grouping by contract makes millions of
 * groups: 5.9 GiB and 17 s for coverage, measured 2026-10-08).
 *
 * Rules (AGENTS.md):
 *   - always `FINAL` (dedup);
 *   - `expiration` is Int64 YYYYMMDD — compare against `dateToExpInt()` ints;
 *   - `dte` is precomputed — select it, never derive it;
 *   - `snapshot_date` is DateTime64(3, UTC) — convert to US/Pacific before
 *     stripping time.
 */
import { MARKET_TZ, type OptionType, dateToExpInt, expIntToIso } from '@edgedesk/types';
import type { Query } from './client';

export const DEFAULT_DATABASE = 'market_lab';
export const OPTIONS_TABLE = 'options_chains';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function table(database: string): string {
  if (!IDENT_RE.test(database)) throw new Error(`invalid database: ${database}`);
  return `${database}.${OPTIONS_TABLE} FINAL`;
}

/** Market (US/Pacific) day of a snapshot, as Int YYYYMMDD. */
const SNAPSHOT_DAY = `toYYYYMMDD(snapshot_date, '${MARKET_TZ}')`;

/** Call/put column. Its values (C/P or CALL/PUT) are matched on the first letter. */
const RIGHT = 'upperUTF8(substring(toString(option_type), 1, 1))';

/** Columns `normalizeOptionRows` reads. */
export const OPTION_COLUMNS = [
  'underlying',
  'expiration',
  'strike',
  `${RIGHT} AS right`,
  'snapshot_date',
  'quote_timestamp',
  'dte',
  'bid',
  'ask',
  'bid_size',
  'ask_size',
  'last',
  'volume',
  'open_interest',
  'implied_volatility',
  'delta',
  'gamma',
  'theta',
  'vega',
  'rho',
  'underlying_last',
] as const;

/** Int YYYYMMDD | `YYYY-MM-DD` → Int YYYYMMDD. */
function dayInt(d: number | string): number {
  return typeof d === 'number' ? dateToExpInt(expIntToIso(d)) : dateToExpInt(d);
}

/** Underlyings with any history. */
export function underlyingsQuery(database = DEFAULT_DATABASE): Query {
  return {
    sql: `SELECT DISTINCT underlying FROM ${table(database)} ORDER BY underlying`,
    params: {},
  };
}

/** Snapshot market days (Int YYYYMMDD) for one underlying, newest first. */
export function snapshotDatesQuery(underlying: string, database = DEFAULT_DATABASE): Query {
  return {
    sql: [
      `SELECT DISTINCT ${SNAPSHOT_DAY} AS date FROM ${table(database)}`,
      'WHERE underlying = {underlying:String} ORDER BY date DESC',
    ].join(' '),
    params: { underlying },
  };
}

/** Expirations (Int YYYYMMDD) present in one snapshot day, ascending. */
export function expirationsQuery(
  underlying: string,
  date: number | string,
  database = DEFAULT_DATABASE,
): Query {
  return {
    sql: [
      `SELECT DISTINCT expiration FROM ${table(database)}`,
      `WHERE underlying = {underlying:String} AND ${SNAPSHOT_DAY} = {date:UInt32}`,
      'ORDER BY expiration',
    ].join(' '),
    params: { underlying, date: dayInt(date) },
  };
}

export interface ChainQueryParams {
  underlying: string;
  /** Snapshot market day: Int YYYYMMDD or `YYYY-MM-DD`. */
  date: number | string;
  /** Int YYYYMMDD or `YYYY-MM-DD`. */
  expiration: number | string;
  type?: OptionType;
  strikeGte?: number;
  strikeLte?: number;
}

/** One expiration's chain at one snapshot day. */
export function chainQuery(p: ChainQueryParams, database = DEFAULT_DATABASE): Query {
  const params: Query['params'] = {
    underlying: p.underlying,
    date: dayInt(p.date),
    expiration: dayInt(p.expiration),
  };
  const where = [
    'underlying = {underlying:String}',
    `${SNAPSHOT_DAY} = {date:UInt32}`,
    'expiration = {expiration:Int64}',
  ];
  if (p.type) {
    where.push(`${RIGHT} = {right:String}`);
    params.right = p.type === 'call' ? 'C' : 'P';
  }
  if (p.strikeGte !== undefined) {
    where.push('strike >= {strike_gte:Float64}');
    params.strike_gte = p.strikeGte;
  }
  if (p.strikeLte !== undefined) {
    where.push('strike <= {strike_lte:Float64}');
    params.strike_lte = p.strikeLte;
  }
  return {
    sql:
      `SELECT ${OPTION_COLUMNS.join(', ')} FROM ${table(database)} ` +
      `WHERE ${where.join(' AND ')} ORDER BY strike, right`,
    params,
  };
}

/** Per-underlying coverage: rows, snapshot days, date range, expirations. */
export function coverageQuery(database = DEFAULT_DATABASE): Query {
  return {
    sql: [
      'SELECT underlying, count() AS rows,',
      `uniqExact(${SNAPSHOT_DAY}) AS snapshots,`,
      `min(${SNAPSHOT_DAY}) AS first_date, max(${SNAPSHOT_DAY}) AS last_date,`,
      'uniqExact(expiration) AS expirations,',
      'min(expiration) AS first_expiration, max(expiration) AS last_expiration',
      `FROM ${table(database)} GROUP BY underlying ORDER BY underlying`,
    ].join(' '),
    params: {},
  };
}

/**
 * The two newest daily NAVs of each fund in `symbols` (comma-separated tickers), from the
 * `yahoo:<ticker>` series homelab-pipelines writes (`bars/fund_nav_1d`): funds the live
 * feed cannot quote, like ARKVX.
 */
export function fundNavsQuery(symbols: string[], database = DEFAULT_DATABASE): Query {
  return {
    sql: [
      "SELECT replaceOne(series_id, 'yahoo:', '') AS symbol, toString(obs_date) AS date, value",
      `FROM ${database}.series_1d FINAL`,
      "WHERE field = 'close' AND series_id IN",
      "(SELECT arrayJoin(arrayMap(s -> concat('yahoo:', s), splitByChar(',', {symbols:String}))))",
      'ORDER BY symbol, obs_date DESC LIMIT 2 BY symbol',
    ].join(' '),
    params: { symbols: symbols.join(',') },
  };
}

/**
 * Unadjusted daily closes of `symbols` (comma-separated tickers) from `from` to `to` (YYYY-MM-DD),
 * from `stock_bars_1d_raw` (homelab-pipelines): what a share traded at that day, as a broker
 * values a lot received then.
 */
export function rawClosesQuery(
  symbols: string[],
  from: string,
  to: string,
  database = DEFAULT_DATABASE,
): Query {
  if (!IDENT_RE.test(database)) throw new Error(`invalid database: ${database}`);
  return {
    sql: [
      'SELECT symbol, toString(trading_date) AS date, close',
      `FROM ${database}.stock_bars_1d_raw FINAL`,
      "WHERE symbol IN (SELECT arrayJoin(splitByChar(',', {symbols:String})))",
      'AND trading_date BETWEEN {from:Date} AND {to:Date} AND close > 0',
      'ORDER BY symbol, trading_date',
    ].join(' '),
    params: { symbols: symbols.join(','), from, to },
  };
}
