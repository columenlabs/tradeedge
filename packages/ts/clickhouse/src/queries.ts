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

/**
 * Symbol fields from DataEdge (Bikram, 2026-10-12): each symbol's latest value of each indicator
 * output in `indicators` (`indicators_1d`, last close) and its latest trailing P/E (`series_1d`
 * `pe:<SYMBOL>.trailing`, field `value`), with the day each is from.
 */
export function symbolFactsQuery(
  symbols: string[],
  indicators: string[],
  database = DEFAULT_DATABASE,
): Query {
  if (!IDENT_RE.test(database)) throw new Error(`invalid database: ${database}`);
  return {
    sql: [
      'SELECT symbol, indicator AS field, argMax(value, trading_date) AS value,',
      'toString(max(trading_date)) AS date',
      `FROM ${database}.indicators_1d FINAL`,
      "WHERE symbol IN (SELECT arrayJoin(splitByChar(',', {symbols:String})))",
      "AND indicator IN (SELECT arrayJoin(splitByChar(',', {indicators:String})))",
      'AND trading_date >= today() - 14',
      'GROUP BY symbol, indicator',
      'UNION ALL',
      // `s.` keeps the column apart from the `field` alias, which ClickHouse would read first.
      "SELECT replaceOne(replaceOne(s.series_id, 'pe:', ''), '.trailing', '') AS symbol,",
      "'pe_ttm_daily' AS field, argMax(s.value, s.obs_date) AS value, toString(max(s.obs_date)) AS date",
      `FROM ${database}.series_1d AS s FINAL`,
      "WHERE s.field = 'value' AND s.series_id IN",
      "(SELECT arrayJoin(arrayMap(x -> concat('pe:', x, '.trailing'), splitByChar(',', {symbols:String}))))",
      'AND s.obs_date >= today() - 14',
      'GROUP BY s.series_id',
    ].join(' '),
    params: { symbols: symbols.join(','), indicators: indicators.join(',') },
  };
}

/** DataEdge's symbol list: every symbol with indicators in the last two weeks (~800). */
export function symbolListQuery(database = DEFAULT_DATABASE): Query {
  if (!IDENT_RE.test(database)) throw new Error(`invalid database: ${database}`);
  return {
    sql: `SELECT DISTINCT symbol FROM ${database}.indicators_1d WHERE trading_date >= today() - 14 ORDER BY symbol`,
    params: {},
  };
}

/**
 * Daily closes of `symbols` (tickers) from `from` to `to` (YYYY-MM-DD), unadjusted and total-return
 * adjusted (`stock_bars_1d_raw`, `stock_bars_1d_adj`), plus the daily NAVs of funds the bars miss
 * (`series_1d` `yahoo:<ticker>`, where `adj` is the NAV). A day missing its adjusted close has `adj` 0.
 * TradeEdge's Performance page values holdings with `close` and compares growth with `adj`.
 */
export function dailyClosesQuery(
  symbols: string[],
  from: string,
  to: string,
  database = DEFAULT_DATABASE,
): Query {
  if (!IDENT_RE.test(database)) throw new Error(`invalid database: ${database}`);
  const bars = (t: string) =>
    [
      `SELECT symbol, trading_date, close FROM ${database}.${t} FINAL`,
      "WHERE symbol IN (SELECT arrayJoin(splitByChar(',', {symbols:String})))",
      'AND trading_date BETWEEN {from:Date} AND {to:Date} AND close > 0',
    ].join(' ');
  return {
    sql: [
      'SELECT symbol, date, close, adj, nav FROM (',
      'SELECT r.symbol AS symbol, toString(r.trading_date) AS date, r.close AS close, a.close AS adj, 0 AS nav',
      `FROM (${bars('stock_bars_1d_raw')}) AS r`,
      `LEFT JOIN (${bars('stock_bars_1d_adj')}) AS a`,
      'ON r.symbol = a.symbol AND r.trading_date = a.trading_date',
      'UNION ALL',
      "SELECT replaceOne(series_id, 'yahoo:', '') AS symbol, toString(obs_date) AS date, value AS close, value AS adj, 1 AS nav",
      `FROM ${database}.series_1d FINAL`,
      "WHERE field = 'close' AND series_id IN",
      "(SELECT arrayJoin(arrayMap(s -> concat('yahoo:', s), splitByChar(',', {symbols:String}))))",
      'AND obs_date BETWEEN {from:Date} AND {to:Date} AND value > 0',
      ') ORDER BY symbol, date',
    ].join(' '),
    params: { symbols: symbols.join(','), from, to },
  };
}

/**
 * End-of-day marks of option contracts (OCC symbols, under their `underlyings`) from `from` to `to`:
 * the mid of bid and ask, else the last trade. `snapshot_date` is a UTC midnight, so its UTC date is
 * the session's.
 */
export function optionMarksQuery(
  contracts: string[],
  underlyings: string[],
  from: string,
  to: string,
  database = DEFAULT_DATABASE,
): Query {
  return {
    sql: [
      'SELECT symbol, toString(toDate(snapshot_date)) AS date,',
      'if(bid > 0 AND ask > 0, (bid + ask) / 2, last) AS mark',
      `FROM ${table(database)}`,
      "WHERE underlying IN (SELECT arrayJoin(splitByChar(',', {underlyings:String})))",
      "AND symbol IN (SELECT arrayJoin(splitByChar(',', {contracts:String})))",
      'AND toDate(snapshot_date) BETWEEN {from:Date} AND {to:Date}',
      'ORDER BY symbol, date',
    ].join(' '),
    params: { contracts: contracts.join(','), underlyings: underlyings.join(','), from, to },
  };
}

/** FOMC, CPI and Jobs days (`series_1d` `cal:FOMC`, `cal:CPI`, `cal:NFP`) from `from` to `to`. */
export function keyDatesQuery(from: string, to: string, database = DEFAULT_DATABASE): Query {
  if (!IDENT_RE.test(database)) throw new Error(`invalid database: ${database}`);
  return {
    sql: [
      `SELECT series_id, toString(obs_date) AS date FROM ${database}.series_1d FINAL`,
      "WHERE series_id IN ('cal:FOMC', 'cal:CPI', 'cal:NFP') AND value = 1",
      'AND obs_date BETWEEN {from:Date} AND {to:Date} ORDER BY obs_date',
    ].join(' '),
    params: { from, to },
  };
}
