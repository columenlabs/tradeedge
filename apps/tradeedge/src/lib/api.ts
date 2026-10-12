import { refreshHeaders } from '@edgedesk/app-shell';
import type { OptionChain, OptionQuote, UnderlyingQuote } from '@edgedesk/types';
import type { SymbolRead } from '@edgedesk/types/symbols';
import type { CustomView, CustomViewConfig } from '@edgedesk/types/views';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GET as JSON; during the header's Refresh it carries the refresh token, so the server skips its cache. */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json', ...refreshHeaders() } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const expirationsQuery = (underlying: string) =>
  queryOptions({
    queryKey: ['expirations', underlying],
    queryFn: async () => {
      const r = await getJson<{
        underlying: string;
        expirations: { expiration: number; dte: number }[];
      }>(`/api/v1/options/${enc(underlying)}/expirations`);
      return { underlying: r.underlying, expirations: r.expirations.map((e) => e.expiration) };
    },
    staleTime: 5 * 60_000,
  });

export const chainQuery = (underlying: string, expiration: number | null) =>
  queryOptions({
    queryKey: ['chain', underlying, expiration],
    queryFn: () =>
      getJson<OptionChain>(
        `/api/v1/options/${enc(underlying)}/chain?near_money_pct=100${expiration ? `&expiration=${expiration}` : ''}`,
      ),
    enabled: expiration !== null,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

/** The server caches price quotes 5 min during the session, so refresh no faster. */
const QUOTE_TTL_MS = 5 * 60_000;

/** Latest quotes for many symbols in one request (Holdings): one call per refresh, not one per symbol. */
/** Tickers come back as `UnderlyingQuote`, OCC option symbols as `OptionQuote`. */
export type AnyQuote = UnderlyingQuote | OptionQuote;
/** Prices by symbol; `stale` lists the ones the server kept from an earlier fetch. */
export const fetchQuotes = (symbols: string[]) =>
  getJson<{ quotes: Record<string, AnyQuote | null>; stale: string[] }>(
    `/api/v1/quotes?symbols=${symbols.map(enc).join(',')}`,
  );
/** Keeps showing the last prices while a new symbol list loads. */
export const quotesQuery = (symbols: string[]) =>
  queryOptions({
    queryKey: ['quotes', symbols],
    queryFn: () => fetchQuotes(symbols),
    enabled: symbols.length > 0,
    staleTime: QUOTE_TTL_MS,
    refetchInterval: QUOTE_TTL_MS,
    placeholderData: keepPreviousData,
  });

export type StreamState =
  | { status: 'connecting'; chain: OptionChain | null }
  | { status: 'live'; chain: OptionChain }
  | { status: 'error'; chain: OptionChain | null; error: string };

/** Subscribes to `/api/v1/options/:underlying/stream` (SSE). */
export function useChainStream(underlying: string, expiration: number | null): StreamState {
  const [state, setState] = useState<StreamState>({ status: 'connecting', chain: null });

  useEffect(() => {
    setState({ status: 'connecting', chain: null });
    const qs = expiration ? `?expiration=${expiration}` : '';
    const es = new EventSource(`/api/v1/options/${enc(underlying)}/stream${qs}`);
    es.addEventListener('chain', (e) => {
      setState({ status: 'live', chain: JSON.parse((e as MessageEvent).data) as OptionChain });
    });
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data;
      const error = data ? (JSON.parse(data) as { error: string }).error : 'Connection lost';
      setState((s) => ({ status: 'error', chain: s.chain, error }));
    });
    return () => es.close();
  }, [underlying, expiration]);

  return state;
}

async function send<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, err?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

// ── Saved trades, watchlist and portfolios (D1, one set per signed-in person) ──

export interface SavedLeg {
  action: 'buy' | 'sell';
  instrument: 'call' | 'put' | 'stock';
  strike?: number;
  expiration?: number;
  qty: number;
  price?: number;
  bid?: number;
  ask?: number;
}
export interface Trade {
  id: string;
  underlying: string;
  name: string;
  legs: SavedLeg[];
  note: string | null;
  written_by: 'agent' | 'person';
  created_at: string;
  updated_at: string;
}
export type TradeInput = Pick<Trade, 'underlying' | 'name' | 'legs'> & {
  note?: string;
};

export const tradesQuery = () =>
  queryOptions({
    queryKey: ['trades'],
    queryFn: () => getJson<Trade[]>('/api/v1/trades'),
    staleTime: 30_000,
  });

export const saveTrade = (input: TradeInput, id?: string) =>
  id
    ? send<Trade>('PUT', `/api/v1/trades/${enc(id)}`, input)
    : send<Trade>('POST', '/api/v1/trades', input);

export const deleteTrade = (id: string) =>
  send<{ ok: true }>('DELETE', `/api/v1/trades/${enc(id)}`);

export interface WatchItem {
  symbol: string;
  added_at: string;
}
export const watchlistQuery = () =>
  queryOptions({
    queryKey: ['watchlist'],
    queryFn: () => getJson<WatchItem[]>('/api/v1/watchlist'),
    staleTime: 60_000,
  });
/**
 * Sector (per ticker, every account and every option on it) on holdings (Bikram, 2026-10-09), and
 * which Autopilot basket's sleeve holds each holding. Agents set them via MCP sector_write and
 * basket_*.
 */
export interface TagSet {
  sectors: Record<string, string>;
  baskets: { symbol: string; portfolio_id: string | null; basket: string }[];
}
export const tagsQuery = () =>
  queryOptions({
    queryKey: ['tags'],
    queryFn: () => getJson<TagSet>('/api/v1/tags'),
    staleTime: 60_000,
  });
/** Ticker → sector; null clears it. */
export const writeSectors = (sectors: Record<string, string | null>) =>
  send<TagSet>('POST', '/api/v1/tags/sectors', { sectors });
/** Moves one holding (every share the account holds) into a basket's sleeve; a new name makes the
 *  basket (Mode off), null puts it back in Unassigned. */
export const assignBasket = (w: { basket: string | null; symbol: string; portfolio_id: string }) =>
  send<{ ok: true }>('POST', '/api/v1/baskets/assign', w);

// ── Autopilot (Bikram, 2026-10-12): baskets with one sleeve per account, and their orders ──

export type Rebalance = 'monthly' | 'quarterly' | 'yearly';
export type BasketMode = 'off' | 'suggest';
export type OrderStatus =
  | 'proposed'
  | 'approved'
  | 'sent'
  | 'filled'
  | 'rejected'
  | 'cancelled'
  | 'by_hand';
export type OrderAction = 'approve' | 'reject' | 'undo' | 'placed' | 'cancel';
export interface AutopilotAccount {
  id: string;
  name: string;
  tax_type: 'taxable' | 'retirement';
  via: 'snaptrade' | 'robinhood' | null;
  trade: boolean;
  tradeable: boolean;
}
export interface BasketRow {
  symbol: string;
  shares: number;
  value: number;
  target: number;
  now: number;
  drift: number;
  accounts: string[];
}
export interface Sleeve {
  portfolio_id: string;
  account: string;
  tax_type: 'taxable' | 'retirement';
  tradeable: boolean;
  via: AutopilotAccount['via'];
  shares: Record<string, number>;
  cash: number;
  value: number;
}
export interface Basket {
  id: string;
  name: string;
  targets: Record<string, number>;
  rebalance: Rebalance;
  drift: number;
  mode: BasketMode;
  created_at: string;
  updated_at: string;
  value: number;
  cash: number;
  cash_now: number;
  rows: BasketRow[];
  max_drift: number;
  worst_drift: number;
  due: 'calendar' | 'drift' | null;
  next_rebalance: string;
  sleeves: Sleeve[];
  open_orders: number;
  can_auto: boolean;
}
export interface Unassigned {
  portfolio_id: string;
  account: string;
  cash: number;
  holdings: { symbol: string; shares: number; value: number }[];
  value: number;
}
export interface AutopilotOverview {
  baskets: Basket[];
  unassigned: Unassigned[];
  accounts: AutopilotAccount[];
  next_window: string;
  unpriced: string[];
  queue: number;
  to_place: number;
}
export interface Order {
  id: string;
  basket_id: string;
  basket: string;
  portfolio_id: string;
  account: string;
  side: 'buy' | 'sell';
  symbol: string;
  qty: number;
  price: number;
  status: OrderStatus;
  via: AutopilotAccount['via'];
  send_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface PlannedOrder {
  portfolio_id: string;
  account: string;
  side: 'buy' | 'sell';
  symbol: string;
  qty: number;
  price: number;
  by_hand: boolean;
}
export interface BasketInput {
  name?: string;
  targets?: Record<string, number>;
  rebalance?: Rebalance;
  drift?: number;
  mode?: BasketMode;
  sleeves?: { portfolio_id: string; shares: Record<string, number>; cash: number }[];
}

export const autopilotQuery = () =>
  queryOptions({
    queryKey: ['autopilot'],
    queryFn: () => getJson<AutopilotOverview>('/api/v1/baskets'),
    staleTime: 30_000,
  });
export const ordersQuery = () =>
  queryOptions({
    queryKey: ['autopilot', 'orders'],
    queryFn: () => getJson<Order[]>('/api/v1/orders'),
    staleTime: 30_000,
  });
export const basketPreviewQuery = (id: string, enabled = true) =>
  queryOptions({
    queryKey: ['autopilot', 'preview', id],
    queryFn: () => getJson<PlannedOrder[]>(`/api/v1/baskets/${id}/preview`),
    enabled,
  });
/** The buys Move cash would propose in one account after moving `cash` in. */
export const movePreviewQuery = (id: string, portfolio_id: string, cash: number, enabled = true) =>
  queryOptions({
    queryKey: ['autopilot', 'preview', id, portfolio_id, cash],
    queryFn: () =>
      getJson<PlannedOrder[]>(
        `/api/v1/baskets/${id}/preview?portfolio_id=${encodeURIComponent(portfolio_id)}&cash=${cash}`,
      ),
    enabled,
    placeholderData: keepPreviousData,
  });
/** The trades a basket being set up would start with; saves nothing. */
export const draftBasket = (d: {
  targets: Record<string, number>;
  sleeves: NonNullable<BasketInput['sleeves']>;
}) => send<PlannedOrder[]>('POST', '/api/v1/baskets/draft', d);
export const createBasket = (b: BasketInput & { name: string }) =>
  send<Basket>('POST', '/api/v1/baskets', b);
export const updateBasket = (id: string, b: BasketInput) =>
  send<Basket>('PUT', `/api/v1/baskets/${id}`, b);
export const deleteBasket = (id: string) => send<{ ok: true }>('DELETE', `/api/v1/baskets/${id}`);
export const rebalanceBasket = (id: string) =>
  send<Order[]>('POST', `/api/v1/baskets/${id}/rebalance`, {});
export const moveCash = (m: {
  portfolio_id: string;
  from: string | null;
  to: string | null;
  amount: number;
  propose: boolean;
}) => send<AutopilotOverview>('POST', '/api/v1/baskets/move', m);
export const actOnOrders = (ids: string[], action: OrderAction) =>
  send<Order[]>('POST', '/api/v1/orders', { ids, action });

export const addToWatchlist = (symbols: string[]) =>
  send<WatchItem[]>('POST', '/api/v1/watchlist', { symbols });
export const removeFromWatchlist = (symbol: string) =>
  send<WatchItem[]>('DELETE', `/api/v1/watchlist/${enc(symbol)}`);

export type TaxType = 'taxable' | 'retirement';
export interface PortfolioSummary {
  id: string;
  name: string;
  tax_type: TaxType;
  broker: string | null;
  /** snaptrade: synced from the broker, read-only; manual: a broker SnapTrade can't reach. */
  source: 'snaptrade' | 'manual';
  cash: number;
  as_of: string;
  updated_at: string;
  positions: number;
}
export interface Position {
  symbol: string;
  underlying: string;
  expiration: number | null;
  strike: number | null;
  right: 'C' | 'P' | null;
  quantity: number;
  avg_cost: number | null;
  /** `lots`: the broker sent none, so it is the open lots' average. */
  avg_cost_from?: 'lots';
}
export interface TaxLot {
  symbol: string;
  acquired: string;
  quantity: number;
  cost: number;
  term: 'short' | 'long';
  /** `yours` when you set the term by hand. */
  term_from?: 'yours';
  /** Set when the cost is not the lot's own: yours, a transaction's price, the close that day, or none. */
  cost_from?: 'yours' | 'transaction' | 'estimate' | 'missing';
  /** Shares held before the history starts (no buy on record): no cost until you set one. */
  before_history?: true;
  /** Where the holding's lots come from: the broker (SnapTrade), entered (manual) or FIFO (derived). */
  source: LotSource;
}
/** A lot, or part of one, a later trade closed; cost, proceeds and gain in USD, fees included. */
export interface ClosedLot {
  symbol: string;
  underlying: string;
  expiration: number | null;
  strike: number | null;
  right: 'C' | 'P' | null;
  acquired: string;
  closed: string;
  /** Negative for a short lot. */
  quantity: number;
  /** null for shares transferred in: brokers send no cost with them. */
  cost: number | null;
  proceeds: number;
  /** null when the cost is unknown. */
  gain: number | null;
  term: 'short' | 'long';
  /** `yours` when you set the term by hand. */
  term_from?: 'yours';
  /** Shares held before the history starts: `acquired` is the first row's day. */
  before_history?: true;
}
export type LotSource = 'snaptrade' | 'derived' | 'manual';
export interface LotCheck {
  symbol: string;
  kind: 'quantity' | 'cost';
  held: number;
  in_lots: number;
  /** Shares, open or sold, with no cost on record. */
  no_cost: number;
  source: LotSource;
}
export interface Portfolio extends Omit<PortfolioSummary, 'positions'> {
  positions: Position[];
  lots: TaxLot[];
  /** This year's closed gain; `sold` is this year's proceeds, `no_cost` those whose gain is unknown. */
  realized_ytd: { total: number; short_term: number; sold: number; no_cost: number };
  /** Every lot closed so far, FIFO from the buys and sells. */
  closed_lots: ClosedLot[];
  /** Per symbol held or sold: `quantity` when open lots miss what is held, `cost` when shares have no cost. */
  checks: LotCheck[];
  /** Dividends per symbol, in USD: every one on record and this year's. */
  dividends: { symbol: string; total: number; ytd: number }[];
}
export interface Transaction {
  id: string;
  date: string;
  kind: string;
  symbol: string | null;
  underlying: string | null;
  expiration: number | null;
  strike: number | null;
  right: 'C' | 'P' | null;
  quantity: number | null;
  price: number | null;
  fees: number;
  amount: number;
  description?: string | null;
}

export const PERFORMANCE_WINDOWS = ['1M', '3M', 'YTD', '1Y', '3Y', '5Y', 'All'] as const;
export type PerformanceWindowKey = (typeof PERFORMANCE_WINDOWS)[number];
/** Portfolio ▸ Performance: worked out on each read from your transactions and daily closes. */
export interface Performance {
  as_of: string | null;
  source: 'built-in' | 'dataedge';
  compare: string[];
  points: {
    date: string;
    value: number;
    money_in: number;
    /** Time-weighted growth of $1 from the first point. */
    growth: number;
    /** Each compared symbol's total-return close. */
    compare: Record<string, number | null>;
  }[];
  windows: {
    key: PerformanceWindowKey;
    from: string;
    value: number;
    money_in: number;
    gain: number;
    return: number;
    compare: Record<string, { return: number | null; same_flows: number | null }>;
  }[];
  starts: { account_id: string; name: string; broker: string | null; date: string }[];
  unpriced: { symbol: string; account: string; share: number }[];
  key_dates: Record<'fomc' | 'cpi' | 'jobs', string[]> | null;
}
/** Every account, without positions (Performance's filter). */
export const portfoliosQuery = () =>
  queryOptions({
    queryKey: ['portfolios', 'list'],
    queryFn: () => getJson<PortfolioSummary[]>('/api/v1/portfolios'),
    staleTime: 60_000,
  });
export const performanceQuery = (accounts: string[] | null, compare: string[]) =>
  queryOptions({
    queryKey: ['performance', accounts, compare],
    queryFn: () =>
      getJson<Performance>(
        `/api/v1/portfolios/performance?compare=${enc(compare.join(','))}${accounts ? `&accounts=${enc(accounts.join(','))}` : ''}`,
      ),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: (n, err) => !(err instanceof ApiError && err.status === 409) && n < 2,
  });

/** Every account in full (positions, lots, realized, checks) in one request: Holdings. */
export const holdingsAccountsQuery = () =>
  queryOptions({
    queryKey: ['portfolios', 'positions'],
    queryFn: () => getJson<Portfolio[]>('/api/v1/portfolios?include=positions'),
    staleTime: 60_000,
  });
export const transactionsQuery = (portfolioId: string, symbol?: string) =>
  queryOptions({
    queryKey: ['transactions', portfolioId, symbol ?? null],
    queryFn: () =>
      getJson<Transaction[]>(
        `/api/v1/portfolios/${enc(portfolioId)}/transactions?${symbol ? `symbol=${enc(symbol)}&limit=50` : 'limit=200'}`,
      ),
    staleTime: 60_000,
  });

/** Every account's latest 200 transactions in one request, each with its account id (Transactions). */
export const allTransactionsQuery = () =>
  queryOptions({
    queryKey: ['transactions', 'all'],
    queryFn: () =>
      getJson<(Transaction & { portfolio_id: string })[]>(
        '/api/v1/portfolios/transactions?limit=200',
      ),
    staleTime: 60_000,
  });

// ── Portfolio views (the shared custom view store): app views first, then the person's own ──

/**
 * The portfolio's view domains: holdings, transactions, tax lots and accounts (the Portfolio
 * section), and symbols (stock screens, the Symbols section; Bikram, 2026-10-12).
 */
export type PortfolioDomain = 'holdings' | 'transactions' | 'tax_lots' | 'accounts' | 'symbols';
export const PORTFOLIO_DOMAINS: PortfolioDomain[] = [
  'holdings',
  'transactions',
  'tax_lots',
  'accounts',
];
export type PortfolioView = CustomView & { domain: PortfolioDomain };

export const portfolioViewsQuery = (domain: PortfolioDomain) =>
  queryOptions({
    queryKey: ['custom-views', domain],
    queryFn: async () =>
      (await getJson<{ custom_views: PortfolioView[] }>(`/api/v1/custom-views?domain=${domain}`))
        .custom_views,
    staleTime: 60_000,
  });
/** Creates a view, or replaces one of the person's own when `id` is given. */
export const savePortfolioView = (
  domain: PortfolioDomain,
  { name, ...config }: CustomViewConfig,
  id?: string,
) =>
  send<PortfolioView>('POST', '/api/v1/custom-views', {
    domain,
    ...(id ? { id } : {}),
    name,
    config,
  });
/** Where a view opens: the app views at their own paths, a person's under `/portfolio/views`. */
export const portfolioViewPath = (v: { app?: boolean; domain: string; id: string }) => {
  if (v.domain === 'symbols') return v.app ? '/symbols' : `/symbols/views/${v.id}`;
  if (!v.app) return `/portfolio/views/${v.domain}/${v.id}`;
  return v.domain === 'transactions'
    ? '/portfolio/transactions'
    : v.domain === 'tax_lots'
      ? '/portfolio/tax-lots'
      : v.domain === 'accounts'
        ? '/portfolio/accounts'
        : '/portfolio';
};

// ── Symbol fields (Bikram, 2026-10-12): live from the person's Robinhood sign-in, plus DataEdge ──

/** Facts per symbol (P/E, analysts, earnings, technicals); nothing is saved, the server holds 5 minutes. */
export const symbolsQuery = (symbols: string[]) =>
  queryOptions({
    queryKey: ['symbols', symbols.join(',')],
    queryFn: () => send<SymbolRead>('POST', '/api/v1/symbols', { symbols }),
    enabled: symbols.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
/** DataEdge's symbol list, for the Symbols rows' `in:DataEdge`. */
export const dataedgeSymbolsQuery = (on = true) =>
  queryOptions({
    queryKey: ['symbols', 'dataedge'],
    queryFn: async () => (await getJson<{ symbols: string[] }>('/api/v1/symbols/dataedge')).symbols,
    enabled: on,
    staleTime: 60 * 60_000,
  });
export const deletePortfolioView = (domain: PortfolioDomain, id: string) =>
  send<{ deleted: string }>('DELETE', `/api/v1/custom-views/${domain}/${enc(id)}`);

// ── Logs (Bikram, 2026-10-11): the person's own activity, newest first ──

export type LogCategory =
  | 'snaptrade'
  | 'mcp'
  | 'user'
  | 'backend'
  | 'x'
  | 'news'
  | 'earnings'
  | 'schedules';
export interface LogEntry {
  id: string;
  at: string;
  category: LogCategory;
  what: string;
  ok: boolean;
  ms?: number;
  detail?: string;
}
export const logsQuery = () =>
  queryOptions({
    queryKey: ['logs'],
    queryFn: async () => (await getJson<{ logs: LogEntry[] }>('/api/v1/logs?limit=1000')).logs,
    staleTime: 15_000,
  });

/** Views of the `logs` domain: the Logs app view, then the person's own. */
export type LogView = CustomView & { domain: 'logs' };
export const logViewsQuery = () =>
  queryOptions({
    queryKey: ['custom-views', 'logs'],
    queryFn: async () =>
      (await getJson<{ custom_views: LogView[] }>('/api/v1/custom-views?domain=logs')).custom_views,
    staleTime: 60_000,
  });
export const saveLogView = ({ name, ...config }: CustomViewConfig, id?: string) =>
  send<LogView>('POST', '/api/v1/custom-views', {
    domain: 'logs',
    ...(id ? { id } : {}),
    name,
    config,
  });
export const deleteLogView = (id: string) =>
  send<{ deleted: string }>('DELETE', `/api/v1/custom-views/logs/${enc(id)}`);
/** The Logs app view opens at `/logs`, a person's own log views under `/logs/views`. */
export const logViewPath = (v: { app?: boolean; id: string }) =>
  v.app ? '/logs' : `/logs/views/${v.id}`;

// ── Screeners (Bikram, 2026-10-10): saved screener_run inputs, kept by agents through the MCP ──

export interface Screener {
  id: string;
  strategy: string;
  name: string;
  underlying: string;
  inputs: Record<string, unknown>;
  written_by: 'agent' | 'person';
  created_at: string;
  updated_at: string;
}

export interface StrategySummary {
  id: string;
  name: string;
}

export interface ScreenLeg {
  action: 'buy' | 'sell';
  qty: number;
  instrument: 'call' | 'put' | 'stock';
  strike?: number;
  expiration?: number;
  price: number;
  bid?: number | null;
  ask?: number | null;
  delta?: number | null;
}

/** One ranked trade from screener_run; dollars are per 1 structure. */
export interface ScreenCandidate {
  legs: ScreenLeg[];
  expiration: number;
  dte: number;
  net_premium: number;
  max_profit: number | null;
  max_loss: number | null;
  pop: number;
  expected_value: number;
  return_on_risk: number | null;
  width: number | null;
  greeks: { delta: number; theta: number };
}

export interface ScreenResult {
  underlying: string;
  spot: number;
  candidates_passing: number;
  results: ScreenCandidate[];
}

export const screenersQuery = () =>
  queryOptions({
    queryKey: ['screeners'],
    queryFn: () => getJson<Screener[]>('/api/v1/screeners'),
    staleTime: 30_000,
  });

export const strategiesQuery = () =>
  queryOptions({
    queryKey: ['strategies'],
    queryFn: () => getJson<StrategySummary[]>('/api/v1/strategies'),
    staleTime: 5 * 60_000,
  });

/** Runs a saved screener on the live chain (no cache in the session, so it runs on demand). */
export const screenerRunQuery = (id: string) =>
  queryOptions({
    queryKey: ['screener-run', id],
    queryFn: () => send<ScreenResult>('POST', '/api/v1/screeners/run', { id }),
    staleTime: 60_000,
    retry: false,
  });

// ── Integrations (Settings ▸ Integrations): each person's own SnapTrade and Alpaca keys ──

export interface SyncReport {
  at: string;
  ok: boolean;
  accounts: number;
  positions: number;
  transactions: number;
  skipped: string[];
  errors: string[];
}
export interface SnapTradeAccount {
  id: string;
  /** The person's own name for it, else the broker's. */
  name: string;
  broker_name: string;
  number: string;
  import: boolean;
  tax_type: TaxType;
  portfolio_id: string | null;
  /** Who can send its orders (null: read-only) and why (Bikram, 2026-10-12). */
  trading: { via: 'snaptrade' | 'robinhood' | null; note: string };
  /** The person lets TradeEdge send orders here (baskets' autopilot); off by default. */
  trade: boolean;
}
export interface SnapTradeBroker {
  id: string;
  name: string;
  broken: boolean;
  accounts: SnapTradeAccount[];
}
export type SnapTradeStatus =
  | { connected: false }
  | {
      connected: true;
      client_id: string;
      consumer_key: string;
      saved_at: string;
      webhook_url: string;
      last_sync: SyncReport | null;
      last_event: { at: string; type: string } | null;
      last_test: KeyTest | null;
      /** Null when read without asking SnapTrade (`live` false). */
      brokers: SnapTradeBroker[] | null;
      /** SnapTrade could not be reached. */
      error: string | null;
    };
/** Where Performance reads daily closes: built in (the suite), else the person's DataEdge key. */
export type DataEdgeStatus =
  | { built_in: true; connected: true }
  | { built_in: false; connected: false }
  | {
      built_in: false;
      connected: true;
      url: string;
      client_id: string;
      saved_at: string;
      last_test: KeyTest | null;
    };
/** A check for new posts or news: when, whether it worked and how many it stored. */
export interface PostCheck {
  at: string;
  ok: boolean;
  posts: number;
  error: string | null;
}
export interface IntegrationsStatus {
  dataedge: DataEdgeStatus;
  snaptrade: SnapTradeStatus;
  alpaca:
    | { connected: false }
    | {
        connected: true;
        key_id: string;
        saved_at: string;
        last_test: KeyTest | null;
        /** The last news check (Check news). */
        last_news: PostCheck | null;
      };
  robinhood: RobinhoodStatus;
  x: XStatus;
  ntfy: NtfyStatus;
  email: EmailStatus;
  webhooks: WebhookTarget[];
  events: NotifyEventStatus[];
}
/** twitterapi.io credit in dollars: paid (never expires) and the sign-up bonus (31 days). */
export interface XCredit {
  at: string;
  usd: number;
  paid: number;
  bonus: number;
}
export type XStatus =
  | { connected: false }
  | {
      connected: true;
      api_key: string;
      handles: string[];
      saved_at: string;
      credit: XCredit | null;
      last_test: KeyTest | null;
      last_check: PostCheck | null;
    };
/** A webhook target (Bikram, 2026-10-12); `url` is masked. */
export interface WebhookTarget {
  id: string;
  name: string;
  url: string;
  /** Headers sent with each post; values masked. */
  headers: { name: string; value: string }[];
  created_at: string;
  last_test: KeyTest | null;
}
/** One event and the targets (`ntfy`, `email` or a webhook id) it is turned off for. */
export interface NotifyEventStatus {
  key: string;
  label: string;
  detail: string;
  off: string[];
}
/** Notifications (Bikram, 2026-10-12): the person's own ntfy.sh topic, which their phone's ntfy app subscribes to. */
export type NtfyStatus =
  | { connected: false }
  | {
      connected: true;
      server: string;
      topic: string;
      /** The person's ntfy.sh access token, masked; null until they add one. */
      token: string | null;
      created_at: string;
      last_test: KeyTest | null;
    };
/** Email notifications to the person's sign-in address; `available` false where the server can't send email. */
export type EmailStatus =
  | { available: boolean; connected: false }
  | {
      available: boolean;
      connected: true;
      address: string;
      created_at: string;
      last_test: KeyTest | null;
    };
/** A key's last test: one cheap read with it (Bikram, 2026-10-12). */
export interface KeyTest {
  at: string;
  ok: boolean;
  /** What the read returned when it worked, e.g. `3 accounts` or `SPY $512.30`. */
  detail: string | null;
  error: string | null;
}
export interface RobinhoodTest {
  at: string;
  ok: boolean;
  /** The Agentic account, masked. */
  account: string | null;
  /** true: each order waits for the person's tap in Robinhood's app. */
  approvals: boolean | null;
  error: string | null;
}
export type RobinhoodStatus =
  | { connected: false }
  | { connected: true; connected_at: string; last_test: RobinhoodTest | null };
/** `live` false reads only what is stored (the header's sync status), without asking SnapTrade. */
export const integrationsQuery = (live = true) =>
  queryOptions({
    queryKey: ['integrations', live ? 'live' : 'stored'],
    queryFn: () => getJson<IntegrationsStatus>(`/api/v1/integrations${live ? '' : '?live=0'}`),
    staleTime: live ? 30_000 : 60_000,
  });
export const saveSnapTradeKey = (key: { client_id: string; consumer_key: string }) =>
  send<IntegrationsStatus>('PUT', '/api/v1/integrations/snaptrade', key);
export const testSnapTrade = () =>
  send<IntegrationsStatus>('POST', '/api/v1/integrations/snaptrade/test', {});
export const deleteSnapTradeKey = () =>
  send<{ ok: true }>('DELETE', '/api/v1/integrations/snaptrade');
export const syncSnapTrade = () =>
  send<SyncReport>('POST', '/api/v1/integrations/snaptrade/sync', {});
/** SnapTrade's own portal: a new broker, or `reconnect` (a broker id) to sign in again. */
export const snaptradePortal = (reconnect?: string) =>
  send<{ url: string }>('POST', '/api/v1/integrations/snaptrade/portal', { reconnect });
export const setSnapTradeAccount = (
  id: string,
  change: { import?: boolean; tax_type?: TaxType; name?: string | null },
) => send<IntegrationsStatus>('PUT', `/api/v1/integrations/snaptrade/accounts/${enc(id)}`, change);
/** Lets TradeEdge send orders to an account, or stops it (app only). */
export const setAccountTrade = (id: string, trade: boolean) =>
  send<IntegrationsStatus>('PUT', `/api/v1/integrations/snaptrade/accounts/${enc(id)}/trade`, {
    trade,
  });
export const saveDataEdgeKey = (key: { url: string; client_id: string; client_secret: string }) =>
  send<IntegrationsStatus>('PUT', '/api/v1/integrations/dataedge', key);
export const testDataEdge = () =>
  send<IntegrationsStatus>('POST', '/api/v1/integrations/dataedge/test', {});
export const deleteDataEdgeKey = () =>
  send<{ ok: true }>('DELETE', '/api/v1/integrations/dataedge');
export const saveAlpacaKey = (key: { key_id: string; secret_key: string }) =>
  send<IntegrationsStatus>('PUT', '/api/v1/integrations/alpaca', key);
export const testAlpaca = () =>
  send<IntegrationsStatus>('POST', '/api/v1/integrations/alpaca/test', {});
export const deleteAlpacaKey = () => send<{ ok: true }>('DELETE', '/api/v1/integrations/alpaca');
/** Robinhood's sign-in page for this person (opened in a new tab; it ends on a localhost address). */
export const connectRobinhood = () =>
  send<{ url: string }>('POST', '/api/v1/integrations/robinhood/connect', {});
/** Finishes a sign-in with the localhost address Robinhood sent the browser to. */
export const finishRobinhood = (url: string) =>
  send<IntegrationsStatus>('POST', '/api/v1/integrations/robinhood/finish', { url });
export const testRobinhood = () =>
  send<IntegrationsStatus>('POST', '/api/v1/integrations/robinhood/test', {});
export const deleteRobinhood = () => send<{ ok: true }>('DELETE', '/api/v1/integrations/robinhood');
/** The person's twitterapi.io key and/or tracked X accounts (the list replaces the old one). */
export const saveX = (change: { api_key?: string; handles?: string[] }) =>
  send<IntegrationsStatus>('PUT', '/api/v1/integrations/x', change);
export const testX = () => send<IntegrationsStatus>('POST', '/api/v1/integrations/x/test', {});
export const deleteX = () => send<{ ok: true }>('DELETE', '/api/v1/integrations/x');

// ── Posts (Bikram, 2026-10-12): what the tracked X accounts post, tagged ──

/** Where a post came from: a tracked X account, or Alpaca's news (Benzinga). */
export const POST_SOURCES = { x: 'X', alpaca: 'Alpaca', sec: 'SEC' } as const;
export type PostSource = keyof typeof POST_SOURCES;

export const THEMES = {
  fed_rates: 'Fed and rates',
  inflation: 'Inflation',
  jobs: 'Jobs',
  earnings: 'Earnings',
  oil: 'Oil',
  crypto: 'Crypto',
  geopolitics: 'Geopolitics',
  ai_semis: 'AI and semis',
  credit: 'Credit',
} as const;
export type Theme = keyof typeof THEMES;
export interface Post {
  id: string;
  source: PostSource;
  url: string;
  at: string;
  /** The X account (no @), or the news publisher (`benzinga`). */
  handle: string;
  name: string;
  text: string;
  symbols: string[];
  theme: Theme | null;
  theme_conf: number | null;
  /** −1 very bearish … +1 very bullish. */
  sentiment: number | null;
  sentiment_conf: number | null;
  /** Later posts of the same news, folded into this one, oldest first. */
  repeats?: Post[];
}
export interface PostsPage {
  /** `d1`: kept 30 days; `dataedge`: kept for good. */
  store: 'd1' | 'dataedge';
  kept: string;
  posts: Post[];
}
/** The last 7 days of posts (the views filter and group them on the client). */
export const postsQuery = () =>
  queryOptions({
    queryKey: ['posts'],
    queryFn: () => getJson<PostsPage>('/api/v1/posts?hours=168&limit=2000'),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
/**
 * Feed and Macro read one row per post (`posts`), By symbol one per post and symbol
 * (`post_symbols`), Earnings one per symbol's next report (`earnings`).
 */
export const POST_DOMAINS = ['posts', 'post_symbols', 'earnings'] as const;
export type PostDomain = (typeof POST_DOMAINS)[number];
export type PostView = CustomView & { domain: PostDomain };
/** Both domains' views: the app views first (Feed, By symbol, Macro), then the person's own. */
export const postViewsQuery = () =>
  queryOptions({
    queryKey: ['custom-views', 'posts'],
    queryFn: async () => {
      const lists = await Promise.all(
        POST_DOMAINS.map(
          async (d) =>
            (await getJson<{ custom_views: PostView[] }>(`/api/v1/custom-views?domain=${d}`))
              .custom_views,
        ),
      );
      const all = lists.flat();
      const order = ['feed', 'by-symbol', 'macro', 'earnings'];
      return [
        ...all.filter((v) => v.app).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
        ...all.filter((v) => !v.app),
      ];
    },
    staleTime: 60_000,
  });
export const savePostView = (
  domain: PostDomain,
  { name, ...config }: CustomViewConfig,
  id?: string,
) =>
  send<PostView>('POST', '/api/v1/custom-views', {
    domain,
    ...(id ? { id } : {}),
    name,
    config,
  });
export const deletePostView = (domain: PostDomain, id: string) =>
  send<{ deleted: string }>('DELETE', `/api/v1/custom-views/${domain}/${enc(id)}`);
/** One symbol's next report and its last 8-K one-liner (Robinhood calendar + SEC). */
export interface EarningsRow {
  symbol: string;
  date: string;
  verified: boolean;
  timing: string | null;
  eps_estimate: number | null;
  last: { date: string; line: string; url: string; at: string } | null;
}
export interface EarningsPage {
  connected: boolean;
  refreshed_at: string | null;
  rows: EarningsRow[];
}
export const earningsQuery = () =>
  queryOptions({
    queryKey: ['earnings'],
    queryFn: () => getJson<EarningsPage>('/api/v1/earnings'),
    staleTime: 60_000,
  });
// ── Dashboard ▸ Calendar (Bikram, 2026-10-12): earnings, ex-dividend and macro days ──

export type CalendarKind = 'earnings' | 'dividend' | 'macro';
export interface CalendarEvent {
  date: string;
  kind: CalendarKind;
  symbol: string;
  held: boolean;
  watched: boolean;
  timing: string | null;
  at: string | null;
  verified: boolean;
  eps_estimate: number | null;
  amount: number | null;
  result: { line: string; url: string; at: string } | null;
  note: string | null;
}
export interface CalendarSource {
  state: 'ok' | 'not_connected' | 'error';
  error?: string;
}
export interface CalendarRead {
  from: string;
  to: string;
  events: CalendarEvent[];
  earnings: CalendarSource & { refreshed_at: string | null };
  dividends: CalendarSource;
  macro: CalendarSource;
}
export const calendarQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: ['calendar', from, to],
    queryFn: () => getJson<CalendarRead>(`/api/v1/calendar?from=${from}&to=${to}`),
    staleTime: 5 * 60_000,
  });
/** App views open at `/posts/<id>`, a person's own at `/posts/views/<domain>/<id>`. */
export const postViewPath = (v: { app?: boolean; id: string; domain: PostDomain }) =>
  v.app ? `/posts/${v.id}` : `/posts/views/${v.domain}/${v.id}`;

// ── Schedules (Bikram, 2026-10-12): work TradeEdge runs on its own, changeable by the person ──

export type ScheduleId =
  | 'x_market'
  | 'x_outside'
  | 'news_market'
  | 'news_outside'
  | 'posts_prune'
  | 'earnings_calendar'
  | 'earnings';
export interface Schedule {
  id: ScheduleId;
  name: string;
  on: boolean;
  /** Minutes between runs. */
  every: number;
  from: string;
  to: string;
  days: number[];
  tz: string;
  last: { at: string; ok: boolean; detail: string } | null;
  next: string | null;
  /** Why it can't run now (X not connected). */
  waiting: string | null;
}
export type ScheduleChange = Partial<
  Pick<Schedule, 'on' | 'every' | 'from' | 'to' | 'days' | 'tz'>
>;
export const schedulesQuery = () =>
  queryOptions({
    queryKey: ['schedules'],
    queryFn: async () => (await getJson<{ schedules: Schedule[] }>('/api/v1/schedules')).schedules,
    staleTime: 30_000,
  });
export const saveSchedule = (id: ScheduleId, change: ScheduleChange) =>
  send<{ schedules: Schedule[] }>('PUT', `/api/v1/schedules/${id}`, change);
export const runSchedule = (id: ScheduleId) =>
  send<{ run: Schedule['last']; schedules: Schedule[] }>('POST', `/api/v1/schedules/${id}/run`, {});
export const createNtfy = () => send<IntegrationsStatus>('POST', '/api/v1/integrations/ntfy', {});
export const saveNtfyToken = (token: string) =>
  send<IntegrationsStatus>('PUT', '/api/v1/integrations/ntfy/token', { token });
export const testNtfy = () =>
  send<IntegrationsStatus>('POST', '/api/v1/integrations/ntfy/test', {});
export const deleteNtfy = () => send<{ ok: true }>('DELETE', '/api/v1/integrations/ntfy');
export const createEmail = () => send<IntegrationsStatus>('POST', '/api/v1/integrations/email', {});
export const testEmail = () =>
  send<IntegrationsStatus>('POST', '/api/v1/integrations/email/test', {});
export const deleteEmail = () => send<{ ok: true }>('DELETE', '/api/v1/integrations/email');
export const addWebhook = (hook: {
  name: string;
  url: string;
  headers?: { name: string; value: string }[];
}) => send<IntegrationsStatus>('POST', '/api/v1/integrations/webhooks', hook);
export const testWebhook = (id: string) =>
  send<IntegrationsStatus>('POST', `/api/v1/integrations/webhooks/${enc(id)}/test`, {});
export const deleteWebhook = (id: string) =>
  send<{ ok: true }>('DELETE', `/api/v1/integrations/webhooks/${enc(id)}`);
export const setNotifyEvent = (event: string, target: string, on: boolean) =>
  send<IntegrationsStatus>('PUT', `/api/v1/integrations/events/${enc(event)}`, { target, on });

// ── Manual accounts (brokers SnapTrade can't reach) ──

export interface PositionInput {
  underlying: string;
  quantity: number;
  avg_cost?: number;
  expiration?: number;
  strike?: number;
  right?: 'C' | 'P';
}
export interface ManualAccountInput {
  id?: string;
  name: string;
  broker?: string;
  tax_type: TaxType;
  cash: number;
  positions: PositionInput[];
}
export const writeManualAccount = (a: ManualAccountInput) =>
  a.id
    ? send<Portfolio>('PUT', `/api/v1/portfolios/${enc(a.id)}`, a)
    : send<Portfolio>('POST', '/api/v1/portfolios', a);
export const deletePortfolio = (id: string) =>
  send<{ ok: true }>('DELETE', `/api/v1/portfolios/${enc(id)}`);
export interface LotInput {
  underlying: string;
  acquired: string;
  quantity: number;
  cost: number;
}
/** Your cost per share and term for a symbol's lots acquired on one day (null clears; left out keeps). */
export const writeLotCost = (
  portfolioId: string,
  cost: {
    underlying: string;
    acquired: string;
    cost?: number | null;
    term?: 'short' | 'long' | null;
  },
) => send<Portfolio>('PUT', `/api/v1/portfolios/${enc(portfolioId)}/lot-costs`, cost);
export const writeLots = (portfolioId: string, lots: LotInput[]) =>
  send<Portfolio>('PUT', `/api/v1/portfolios/${enc(portfolioId)}/lots`, { lots });
export interface TransactionInput {
  id: string;
  date: string;
  kind: string;
  underlying?: string;
  quantity?: number;
  price?: number;
  fees?: number;
  amount: number;
  expiration?: number;
  strike?: number;
  right?: 'C' | 'P';
  description?: string;
}
export const writeTransactions = (portfolioId: string, transactions: TransactionInput[]) =>
  send<{ inserted: number; updated: number }>(
    'POST',
    `/api/v1/portfolios/${enc(portfolioId)}/transactions`,
    { transactions },
  );
