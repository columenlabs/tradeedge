/**
 * Internal admin console (`/api/admin/*`, served at `/admin/`). Shared by the
 * analytics-engine routes and the `apps/dataedge` SPA. Dates are `YYYY-MM-DD`, months `YYYY-MM`.
 *
 * Market data (stock bars, 1m source plus roll-ups) and options chains are separate views.
 */

/** Bar granularities in `market_lab`: 1m is the source, the rest are built from it (1d from the daily feed). */
export type BarGranularity = '1m' | '5m' | '15m' | '30m' | '1h' | 'sessions' | '1d_adj' | '1d_raw';

export const BAR_GRANULARITIES: readonly BarGranularity[] = [
  '1m',
  '5m',
  '15m',
  '30m',
  '1h',
  'sessions',
  '1d_adj',
  '1d_raw',
] as const;

/** `alpaca` symbols are queued from the console; `ibkr` series are loaded by hand on the Mac mini. */
export type SymbolSource = 'alpaca' | 'ibkr';

/** What a tracked symbol is loaded at: daily bars only, or daily plus 1-minute bars (and their roll-ups). */
export type BarResolution = '1d' | '1m';

export interface MarketSymbol {
  symbol: string;
  source: SymbolSource;
  /** Registry resolution (a row from before the column existed reads `1m`); null when not registered. */
  resolution: BarResolution | null;
  /** In `market_lab.symbols` (the registry the pipeline backfills from). */
  registered: boolean;
  active: boolean;
  /** Registry start date, else the first 1m bar. */
  start: string | null;
  /**
   * First daily bar when it is later than the registry start (the symbol listed after it):
   * nothing is expected before it. Null otherwise, and for IBKR series.
   */
  listed: string | null;
  first: string | null;
  last: string | null;
}

/** Days present vs NYSE sessions expected in one month. `expected` is 0 where nothing is expected. */
export type CoverageCell = [month: string, days: number, expected: number];

export interface GranularitySummary {
  granularity: BarGranularity;
  /** Present / expected sessions across every symbol it applies to. */
  present: number;
  expected: number;
  /** Symbol-months with fewer days than expected. */
  gapMonths: number;
  /** Roll-ups only: symbol-months whose day count differs from 1m. */
  driftMonths: number;
}

/** `GET /api/admin/market/coverage`. */
export interface MarketCoverage {
  generatedAt: string;
  /** Last finished session counted (sessions before today, US/Pacific). */
  through: string;
  /** Every month from 2016-01 to the current month. */
  months: string[];
  symbols: MarketSymbol[];
  /** granularity → symbol → one cell per month in `months` (same order). */
  grid: Record<BarGranularity, Record<string, CoverageCell[]>>;
  summary: GranularitySummary[];
}

export interface SymbolDay {
  date: string;
  /** Distinct 1m bars that day (all sessions) and in the regular session. */
  bars: number;
  regular: number;
  /** Regular-session minutes on the calendar: 390, or 210 on an early close. */
  expected: number;
}

/** `GET /api/admin/market/symbols/:symbol?year=YYYY`. */
export interface SymbolDetail {
  symbol: MarketSymbol;
  year: number;
  /** Years with any 1m data, ascending. */
  years: number[];
  /** Per granularity: totals since start. */
  totals: { granularity: BarGranularity; days: number; expected: number; rows: number }[];
  /** 1m days of `year` that have bars. */
  days: SymbolDay[];
  /** Weekday NYSE closures and early closes in `year`. */
  closures: string[];
  earlyCloses: string[];
  /** Expected sessions with no 1m bars (since start), newest first, at most 200. */
  missing: string[];
  /**
   * Days of `year` with under half the symbol's typical regular-session bars (its median that year,
   * scaled down on early closes), newest first. A thin symbol skips untraded minutes, so the
   * calendar's 390 is not the bar.
   */
  short: { date: string; regular: number; typical: number }[];
  /** Months where a roll-up's day count differs from 1m. */
  drift: { granularity: BarGranularity; month: string; days: number; expected: number }[];
}

/** One session behind a market issue. Short sessions carry the bar counts. */
export interface IssueSession {
  date: string;
  regular?: number;
  typical?: number;
}

/** A symbol's missing sessions (no 1m bars) or short sessions (under half its typical day), all years. */
export interface MarketIssue {
  symbol: string;
  source: SymbolSource;
  kind: 'missing' | 'short';
  /** Sessions affected in all. */
  count: number;
  /** Oldest and newest affected session. */
  since: string;
  latest: string;
  /** Distinct `YYYY-MM` of the affected sessions, ascending: what a re-fetch queues. */
  months: string[];
  /** Newest first, at most 200. */
  sessions: IssueSession[];
  /** Marked handled in the console and nothing new since; null when it still needs you. */
  handled: IssueHandled | null;
}

/** A "Mark handled" on an issue. It lapses once the issue grows (a newer or extra session). */
export interface IssueHandled {
  at: string;
  /** Email or service token that marked it. */
  by: string;
  /** The issue's newest session and count when it was marked. */
  latest: string;
  count: number;
}

/** What `POST /api/admin/market/issues/handled` answers. */
export interface HandledMarkResponse extends IssueHandled {
  symbol: string;
  kind: MarketIssue['kind'];
}

/** `POST /api/admin/market/issues/handled`: mark an IBKR issue as handled as it stands now. */
export interface MarkHandledRequest {
  symbol: string;
  kind: MarketIssue['kind'];
}

/** `GET /api/admin/market/issues`: every missing / short session across symbols, Alpaca first. */
export interface MarketIssues {
  generatedAt: string;
  /** Last finished session counted. */
  through: string;
  issues: MarketIssue[];
}

/** Indicator kinds the pipeline can compute from 1d adjusted bars, with their parameters. */
export const INDICATOR_KINDS = {
  sma: { label: 'Simple moving average', params: { n: [2, 400, 20] } },
  ema: { label: 'Exponential moving average', params: { n: [2, 400, 21] } },
  rsi: { label: 'Relative strength (RSI)', params: { n: [2, 400, 14] } },
  atr: { label: 'Average true range (ATR)', params: { n: [2, 400, 14] } },
  rel_volume: { label: 'Relative volume', params: { n: [2, 400, 20] } },
  high_low_52w: { label: 'Rolling high / low', params: { window: [2, 400, 252] } },
  macd: {
    label: 'MACD',
    params: { fast: [2, 400, 12], slow: [2, 400, 26], signal: [2, 400, 9] },
  },
  bollinger: { label: 'Bollinger bands', params: { n: [2, 400, 20], k: [0.5, 4, 2] } },
} as const satisfies Record<
  string,
  { label: string; params: Record<string, readonly [min: number, max: number, def: number]> }
>;

export type IndicatorKind = keyof typeof INDICATOR_KINDS;

/** Column name the pipeline derives: `rsi_7`, `macd_12_26_9`, `bollinger_20_2`. Param order follows INDICATOR_KINDS. */
export function indicatorName(kind: IndicatorKind, params: Record<string, number>): string {
  const keys = Object.keys(INDICATOR_KINDS[kind].params);
  return [kind, ...keys.map((k) => String(params[k] ?? '').replace('.', 'p'))].join('_');
}

export interface IndicatorRow {
  name: string;
  /** From `market_lab.indicator_specs` when the pipeline has written it; null otherwise. */
  kind: string | null;
  params: Record<string, number> | null;
  /** Values the spec writes to `indicators_1d` (bb_upper, bb_mid, ...); just `name` without a spec row. */
  outputs: string[];
  source: 'code' | 'admin' | null;
  version: number | null;
  /** Symbols with values, of `universe`. */
  symbols: number;
  /** Symbols without values because they have fewer daily bars than the window needs: expected. */
  short: number;
  latest: string | null;
  /** Registered but not computed yet. */
  pending: boolean;
}

/** `GET /api/admin/indicators`. */
export interface AdminIndicators {
  generatedAt: string;
  /** Symbols with 1d adjusted bars (what indicators are computed for). */
  universe: number;
  indicators: IndicatorRow[];
}

/** Where one indicator stands for one symbol. */
export type SymbolIndicatorStatus =
  | 'ok'
  /** Latest value is older than the latest daily bar. */
  | 'behind'
  /** Fewer daily bars than the window needs: expected, nothing to fix. */
  | 'short'
  /** Enough bars but no values: a real gap. */
  | 'missing';

export interface SymbolIndicatorRow {
  name: string;
  outputs: string[];
  params: Record<string, number> | null;
  /** Daily bars the indicator needs before its first value; null when the spec is unknown. */
  needs: number | null;
  /** Rows written (the fewest across `outputs`) and the dates they span. */
  rows: number;
  first: string | null;
  latest: string | null;
  status: SymbolIndicatorStatus;
}

/** `GET /api/admin/market/symbols/:symbol/indicators`. */
export interface SymbolIndicators {
  symbol: string;
  /** False for series with only raw daily bars (index series): indicators are not computed for them. */
  computed: boolean;
  /** Daily adjusted bars stored for the symbol and the dates they span. */
  bars: number;
  first: string | null;
  last: string | null;
  indicators: SymbolIndicatorRow[];
}

/** One daily bar for the chart. */
export interface SymbolBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Indicator output series the Chart tab can draw; the bars endpoint returns only these. */
export const CHART_SERIES = [
  'sma_20',
  'sma_50',
  'sma_200',
  'ema_9',
  'ema_21',
  'ema_50',
  'bb_upper',
  'bb_mid',
  'bb_lower',
  'high_52w',
  'low_52w',
  'rsi_14',
  'macd_line',
  'macd_signal',
  'macd_hist',
  'atr_14',
  'rel_volume_20',
  'vwap_dist_pct',
] as const;
export type ChartSeries = (typeof CHART_SERIES)[number];

/** `GET /api/admin/market/symbols/:symbol/bars`: daily adjusted bars (raw for index series), oldest first. */
export interface SymbolBars {
  symbol: string;
  adjusted: boolean;
  bars: SymbolBar[];
  /** Overlay lines by indicator name, aligned to `bars` by date. */
  overlays: Record<string, { date: string; value: number }[]>;
}

/** One entry of the symbol menu. */
export interface SymbolIndexEntry {
  symbol: string;
  /** Registered with the pipeline (1m or daily) or only an index member. */
  kind: 'registered' | 'member';
  resolution: BarResolution | null;
  source: SymbolSource;
}

/** `GET /api/admin/market/symbol-index`: every symbol with data, for the symbol menu. */
export interface SymbolIndex {
  symbols: SymbolIndexEntry[];
}

/** `POST /api/admin/indicators`. */
export interface AddIndicatorRequest {
  kind: IndicatorKind;
  params: Record<string, number>;
}

/** `POST /api/admin/symbols`. */
export interface AddSymbolRequest {
  symbol: string;
  /** `1d` (default) loads daily bars only; `1m` adds 1-minute bars. A different value on an active symbol switches it. */
  resolution?: BarResolution;
  /** Defaults to 2016-01-04 (the start of history). */
  startDate?: string;
}

/** `GET /api/admin/symbols/lookup/:symbol`. */
export interface SymbolLookup {
  symbol: string;
  found: boolean;
  name: string | null;
  exchange: string | null;
  tradable: boolean;
  /**
   * Why it can't be added from the console: `ibkr` (loaded by hand on the Mac mini) or `alpaca`
   * (registered and active). Null when it can be added, including an inactive registration.
   */
  known: SymbolSource | null;
  /** The listing lookup failed (provider outage or no keys), so `found` is unknown. */
  unavailable: boolean;
}

/** A Dagster run launched from the console (add symbol, add indicator). */
export interface AdminRunLaunched {
  runId: string;
  job: string;
}

export interface ChainsUnderlying {
  underlying: string;
  days: number;
  first: string;
  last: string;
  expirations: number;
  /** Quarter (`YYYY-Qn`) → snapshot days. */
  byQuarter: Record<string, number>;
}

/** `GET /api/admin/chains` (read-only while ingestion is on hold). */
export interface AdminChains {
  generatedAt: string;
  last: string | null;
  underlyings: ChainsUnderlying[];
  /** Quarters from the first snapshot to the current quarter. */
  quarters: string[];
  /** Missing session runs shared by several underlyings, newest first. */
  gaps: { from: string; to: string; sessions: number; underlyings: string[] }[];
}

export interface AdminLoad {
  /** ISO-8601. */
  at: string;
  kind: string;
  target: string;
  rows: number | null;
  status: string;
}

/** `GET /api/admin/schedules`: one market-data Dagster schedule. Times are ISO-8601 (UTC). */
export interface AdminSchedule {
  name: string;
  /** First line of the schedule's description. */
  description: string | null;
  cron: string;
  timezone: string | null;
  running: boolean;
  /** Next tick; null when stopped. */
  nextRun: string | null;
  lastTick: { at: string; status: 'started' | 'skipped' | 'success' | 'failure' } | null;
}

/** Run states as the console shows them (Dagster's queued, not started and starting read as queued). */
export type PipelineRunStatus = 'queued' | 'running' | 'success' | 'failure' | 'canceled';

/** One Dagster run of a pipeline. */
export interface AdminPipelineRun {
  runId: string;
  status: PipelineRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** Seconds, up to now while running; null before it starts. */
  durationSec: number | null;
}

/**
 * `GET /api/admin/pipelines`: one row per Dagster job, plus one per asset that runs by its own
 * automation condition (no schedule; Dagster starts it when its inputs change).
 */
export interface AdminPipeline {
  /** Job name, or the asset's own name for an automated asset. */
  name: string;
  kind: 'job' | 'auto';
  /** Asset group (`bars`, `replica`, ...); `other` for jobs without assets. */
  domain: string;
  description: string | null;
  /** The job's schedule, if it has one. */
  schedule: {
    name: string;
    cron: string;
    timezone: string | null;
    running: boolean;
    nextRun: string | null;
  } | null;
  /** Automation condition label (`kind: auto` only). */
  automation: string | null;
  /** Asset keys it writes (`bars/stock_bars_1m`). */
  assets: string[];
  lastRun: AdminPipelineRun | null;
  /** Up to 5 latest run states, oldest first. */
  recent: PipelineRunStatus[];
}

export interface AdminPipelines {
  pipelines: AdminPipeline[];
  /** `from` writes an asset that one of `to`'s assets reads. */
  links: { from: string; to: string }[];
}

/** `GET /api/admin/pipelines/:name`: last 10 runs, newest first, and the newest failure's error. */
export interface AdminPipelineDetail {
  name: string;
  runs: AdminPipelineRun[];
  error: { runId: string; message: string } | null;
}

/** `GET /api/admin/health`: one cheap probe each. */
export interface AdminHealth {
  clickhouse: { ok: boolean; latencyMs: number | null };
  dagster: { ok: boolean; latencyMs: number | null } | null;
}

/** Rows and compressed bytes on disk (active parts). */
export interface StorageSize {
  rows: number;
  bytes: number;
}

/** Intraday bar tables listed one by one on the Overview's Intraday card. */
export const INTRADAY_RESOLUTIONS = ['1m', '5m', '15m', '30m', '1h'] as const;
export type IntradayResolution = (typeof INTRADAY_RESOLUTIONS)[number];

/**
 * `GET /api/admin/market/storage`, per data type: `intraday` (1m bars, their roll-ups and the
 * daily bars), `eod` (daily bars, adjusted and raw), `chains` (`options_chains*`), `series`
 * (`series_catalog`, `series_1d`), `indicators` (`indicator_specs`, `indicators_1d`,
 * `member_indicators_1d`), `members` (`index_members`, `stock_bars_1d_split`) and `datasets`
 * (`datasets`, `dataset_records`). `total` is every `market_lab` table; `resolutions` each intraday
 * bar table on its own. `tracked` counts what each data type holds, as its own page counts it: symbols
 * with 1m bars, symbols with daily bars, chain underlyings, active series, indicators, index members
 * and datasets (null when its table cannot be read).
 */
export interface AdminStorage {
  intraday: StorageSize;
  eod: StorageSize;
  chains: StorageSize;
  series: StorageSize;
  indicators: StorageSize;
  members: StorageSize;
  datasets: StorageSize;
  total: StorageSize;
  resolutions: Record<IntradayResolution, StorageSize>;
  tracked: Record<StorageType, number | null>;
}

/** The data types the Overview shows a card for. */
export type StorageType =
  | 'intraday'
  | 'eod'
  | 'chains'
  | 'series'
  | 'indicators'
  | 'members'
  | 'datasets';

/** Indexes whose members' daily closes are stored (`market_lab.stock_bars_1d_split`). */
export type IndexCode = 'NDX' | 'SPX';

/** Days with a close vs NYSE sessions the member was in an index, in one year. */
export type MemberYear = [year: number, days: number, expected: number];

/** One Nasdaq-100 / S&P 500 member since 2016 (a share line, e.g. GOOG and GOOGL apart). */
export interface IndexMember {
  member: string;
  /** Feed symbols its closes are stored under (an old ticker first, when it was renamed). */
  symbols: string[];
  /** Every index it has been in since 2016. */
  indexes: IndexCode[];
  /** Indexes it is in on the latest session; empty once it has left them all. */
  currentIn: IndexCode[];
  /** First and last session in any index. */
  first: string;
  last: string;
  /** Why the feed has no closes for it at all; null when it has. */
  unpriced: string | null;
  /** Totals over `years`. */
  days: number;
  expected: number;
  years: MemberYear[];
  /** No closes at all, or more than `MEMBER_GAP_ALLOWANCE` sessions missing. */
  needsLook: boolean;
}

/**
 * Sessions a member may miss before it needs a look: a departing member's last session or two
 * often has no close (delisted that morning).
 */
export const MEMBER_GAP_ALLOWANCE = 5;

/** `GET /api/admin/market/members`: daily closes of every index member since 2016. */
export interface AdminMembers {
  generatedAt: string;
  /** False until the pipeline has written `market_lab.index_members`. */
  ready: boolean;
  /** When the membership was last rewritten, and when closes were last fetched (ISO-8601). */
  updatedAt: string | null;
  fetchedAt: string | null;
  members: IndexMember[];
}

/** Page sizes of `GET /api/admin/market/daily`. */
export const DAILY_PAGE_SIZES = [25, 50, 100] as const;

/** `tracked`: registered in the symbols registry; `indices`: IBKR series; `members`: the other daily symbols. */
export type DailyGroup = 'tracked' | 'members' | 'indices';

/** One symbol of the daily tables. `cells` has one entry per month in `AdminDaily.months`. */
export interface DailyRow {
  symbol: string;
  group: DailyGroup;
  /** Registry resolution for a tracked symbol, else null. */
  resolution: BarResolution | null;
  first: string | null;
  last: string | null;
  /** First bar when it is later than 2016-01-04 and the registry start: earlier months are "not listed yet". */
  listed: string | null;
  /** Not tracked and its last bar is over 10 days before `through` (left the universe): shown as stopped, not as gaps. */
  stale: boolean;
  cells: CoverageCell[];
}

/** `GET /api/admin/market/daily?granularity=1d_adj|1d_raw&group=all|…&q=&page=1&size=25`. */
export interface AdminDaily {
  generatedAt: string;
  through: string;
  /** Every month from 2016-01 to the current month. */
  months: string[];
  granularity: '1d_adj' | '1d_raw';
  /** Rows matching `group` and `q`; `page` and `size` are the values used (clamped). */
  total: number;
  page: number;
  size: number;
  /** Every symbol per group, ignoring `group` and `q`. */
  counts: { all: number; tracked: number; members: number; indices: number };
  /** Over every symbol in the requested `group` (ignoring `q`). */
  summary: { present: number; expected: number; gapMonths: number; symbols: number; stale: number };
  /** When the daily closes were last fetched (ISO-8601). */
  fetchedAt: string | null;
  rows: DailyRow[];
}

/** Page sizes of `GET /api/admin/market/series` (same as the daily list). */
export const SERIES_PAGE_SIZES = DAILY_PAGE_SIZES;

/** Where a series comes from: the prefix of its `series_id` (`calc:NDXA50R`). */
export type SeriesSource = 'calc' | 'stockcharts' | 'fred';

/** Days a series is expected on: NYSE sessions, every calendar day, or the days its FRED siblings publish. */
export type SeriesCalendar = 'sessions' | 'every-day' | 'rates-days';

/** One series of `market_lab.series_catalog`. `cells` has one entry per month in `AdminSeries.months`. */
export interface SeriesRow {
  seriesId: string;
  source: SeriesSource;
  code: string;
  name: string;
  calendar: SeriesCalendar;
  first: string | null;
  last: string | null;
  /** Days with a value. */
  days: number;
  /** First value when it is later than 2016-01-04 (a warm-up or a late start): earlier months are "not listed yet". */
  listed: string | null;
  /** Expected days between the first and the last value that have no value (holes, not being behind). */
  missing: number;
  /** Expected days after `last` up to the last expected day. */
  behindDays: number;
  cells: CoverageCell[];
}

/** `GET /api/admin/market/series?source=all|calc|…&state=all|look&q=&page=1&size=25`. */
export interface AdminSeries {
  generatedAt: string;
  through: string;
  months: string[];
  total: number;
  page: number;
  size: number;
  /** Every series per source, ignoring the filters; `look` is behind schedule or with missing days. */
  counts: { all: number; calc: number; stockcharts: number; fred: number; look: number };
  summary: { series: number; present: number; expected: number; missing: number; behind: number };
  /** When a series value was last written (ISO-8601). */
  fetchedAt: string | null;
  rows: SeriesRow[];
}

/** Most symbol-months one backfill may launch (the API rejects more; the UI splits). */
export const BACKFILL_MAX_PARTITIONS = 600;

/** `POST /api/admin/backfills`: launch a minute-bars backfill for symbol × month. */
/**
 * What a backfill re-loads: `1m` bars per symbol x month (default), `1d` daily bars per symbol (each
 * re-fetches the symbol's full history), or `rollup` months (5m/15m/30m/1h and sessions; only `symbols`
 * when given, else every symbol).
 */
export type BackfillTable = '1m' | '1d' | 'rollup';

/** `POST /api/admin/backfills`. Months are `YYYY-MM`, from 2016-01 to the current month. */
export type BackfillLaunchRequest =
  | { table?: '1m'; symbols: string[]; months: string[] }
  | { table: '1d'; symbols: string[] }
  | { table: 'rollup'; months: string[]; symbols?: string[] };

export type BackfillStatus = 'running' | 'done' | 'failed' | 'canceled';

export interface AdminBackfill {
  id: string;
  title: string;
  status: BackfillStatus;
  /** ISO-8601. */
  createdAt: string;
  endedAt: string | null;
  /** Seconds from start to end; for a running backfill, from start to now. */
  durationSec: number;
  /** Asset keys, e.g. `bars/stock_bars_1m`. */
  assets: string[];
  /**
   * Symbols in the backfill: the `edgedesk/symbols` tag set at launch, else Dagster's `bars/symbol`
   * tag, else the symbol part of each partition key. Empty when `allSymbols`.
   */
  symbols: string[];
  /** Not per symbol: its partitions are times only (roll-ups, breadth) or it has none. */
  allSymbols: boolean;
  total: number;
  done: number;
  running: number;
  failed: number;
  queued: number;
  cancelable: boolean;
  /** `admin` when launched from this console (tagged `edgedesk/source`), else `dagster`. */
  source: 'admin' | 'dagster';
}

/** Backfill list filter: `failed` also takes finished backfills with failed partitions. */
/** Rows per page on the Backfill jobs list; the API and MCP take any 1-100. */
export const BACKFILL_PAGE_SIZES = DAILY_PAGE_SIZES;

export const BACKFILL_FILTERS = ['running', 'failed', 'done'] as const;
export type BackfillFilter = (typeof BACKFILL_FILTERS)[number];

/** True when a backfill belongs under `filter`; no filter matches every backfill. */
export const backfillMatches = (b: AdminBackfill, filter?: BackfillFilter) =>
  !filter ||
  (filter === 'running' && b.status === 'running') ||
  (filter === 'failed' && (b.status === 'failed' || b.failed > 0)) ||
  (filter === 'done' && b.status === 'done' && b.failed === 0);

/**
 * `GET /api/admin/backfills?limit=&cursor=&status=`: one page, newest first. Pass `nextCursor` as
 * `cursor` for the next (older) page; null on the last page.
 */
export interface AdminBackfillPage {
  backfills: AdminBackfill[];
  nextCursor: string | null;
}

export interface AdminBackfillPartition {
  /** Dagster partition key, e.g. `2019-03-01|NVDA`. */
  name: string;
  symbol: string;
  /** `YYYY-MM` the partition falls in (a data set's first month); `all` for a symbol's daily bars; '' when unknown. */
  month: string;
  /** The grid column: `YYYY-MM` for monthly partitions, `YYYY-MM-DD` for daily, else the key (`2014q1`). */
  period: string;
  state: 'done' | 'running' | 'failed' | 'queued';
  runId: string | null;
  /** Seconds the latest run took (so far, if running); null when it has not started. */
  durationSec: number | null;
}

export interface AdminBackfillDetail extends AdminBackfill {
  /** Symbols are exact here, taken from the partition names. */
  partitions: AdminBackfillPartition[];
}

export interface AdminBackfillLogLine {
  /** ISO-8601. */
  at: string;
  level: string;
  /** Dagster step, e.g. `bars__stock_bars_1m`; null for run-level events. */
  step: string | null;
  message: string;
}

/** Tail of one run's Dagster event log. */
export interface AdminBackfillLogs {
  /** Null when no partition has started a run yet. */
  runId: string | null;
  /** The partition the run covers, e.g. `2019-03-01|NVDA`. */
  partition: string | null;
  lines: AdminBackfillLogLine[];
  /** Older lines were left out. */
  truncated: boolean;
  /** The log is longer than the server reads, so `lines` end before the run's newest events. */
  incomplete: boolean;
}

// ---- Pushed datasets (`/api/admin/datasets`) ------------------------------------------------

export const DATASET_VALUE_KINDS = ['text', 'number'] as const;
export type DatasetValueKind = (typeof DATASET_VALUE_KINDS)[number];
export const DATASET_FREQUENCIES = [
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'irregular',
] as const;
export type DatasetFrequency = (typeof DATASET_FREQUENCIES)[number];
/** Most records one push may carry. */
export const DATASET_PUSH_MAX = 1000;
/** Most records one read returns. */
export const DATASET_READ_MAX = 1000;

/** A dataset's catalog entry: what it holds and what its key, value and metadata mean. */
export interface Dataset {
  id: string;
  name: string;
  description: string;
  keyMeans: string;
  valueKind: DatasetValueKind;
  /** Number datasets: 'usd', 'percent', ...; '' when none. */
  unit: string;
  frequency: DatasetFrequency;
  /** Text datasets: an example metadata object; null when none. */
  metadataExample: Record<string, unknown> | null;
  /** Who may write it: an admin email or a pusher name. */
  owner: string;
  /** ISO-8601. */
  updatedAt: string;
}

export interface DatasetStats {
  records: number;
  keys: number;
  /** ISO date or time of the oldest / newest record; null when empty. */
  first: string | null;
  last: string | null;
}

export interface DatasetDetail extends Dataset {
  stats: DatasetStats;
  /** Number datasets: how a view or strategy reads one key, e.g. `est_eps:NVDA`. */
  seriesIdExample: string | null;
}

/** One record as read back. Number records have `field`; text records have `metadata`. */
export interface DatasetRecord {
  key: string;
  /** Text: ISO time. Number: ISO date. */
  at: string;
  value: string | number;
  field?: string;
  metadata?: Record<string, unknown>;
  /** ISO-8601. */
  availableAt: string;
}

export interface DatasetRecords {
  dataset: string;
  records: DatasetRecord[];
  /** More records match than `limit`. */
  more: boolean;
}

export interface DatasetPushResult {
  dataset: string;
  written: number;
  keys: number;
}
