import { refreshHeaders } from '@edgedesk/app-shell';
import type { OptionChain, OptionQuote, UnderlyingQuote } from '@edgedesk/types';
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
 * Sector (per ticker, every account and every option on it) and Basket (per holding; no account
 * means every account) on holdings (Bikram, 2026-10-09). Agents set them via MCP sector_write and
 * basket_write.
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
/** Puts symbols in a basket (null takes them out); no portfolio_id means every account. */
export const writeBasket = (w: {
  basket: string | null;
  symbols: string[];
  portfolio_id?: string;
}) => send<TagSet>('POST', '/api/v1/tags/baskets', w);
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
}
export interface TaxLot {
  symbol: string;
  acquired: string;
  quantity: number;
  cost: number;
  term: 'short' | 'long';
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
  cost: number;
  proceeds: number;
  gain: number;
  term: 'short' | 'long';
}
export interface Portfolio extends Omit<PortfolioSummary, 'positions'> {
  positions: Position[];
  lots: TaxLot[];
  /** broker (SnapTrade), yours (entered for a manual account) or transactions (FIFO). */
  lots_source: 'broker' | 'yours' | 'transactions';
  realized_ytd: { total: number; short_term: number };
  /** Every lot closed so far, FIFO from the buys and sells. */
  closed_lots: ClosedLot[];
  /** Holdings whose open lots miss the held quantity. */
  checks: { symbol: string; held: number; in_lots: number }[];
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

/** The portfolio's view domains: holdings rows and transaction rows. */
export type PortfolioDomain = 'holdings' | 'transactions' | 'closed_lots';
export const PORTFOLIO_DOMAINS: PortfolioDomain[] = ['holdings', 'transactions', 'closed_lots'];
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
export const portfolioViewPath = (v: { app?: boolean; domain: string; id: string }) =>
  v.app
    ? v.domain === 'transactions'
      ? '/portfolio/transactions'
      : v.domain === 'closed_lots'
        ? '/portfolio/closed-lots'
        : '/portfolio'
    : `/portfolio/views/${v.domain}/${v.id}`;
export const deletePortfolioView = (domain: PortfolioDomain, id: string) =>
  send<{ deleted: string }>('DELETE', `/api/v1/custom-views/${domain}/${enc(id)}`);

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
  name: string;
  number: string;
  import: boolean;
  tax_type: TaxType;
  portfolio_id: string | null;
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
      /** Null when read without asking SnapTrade (`live` false). */
      brokers: SnapTradeBroker[] | null;
      /** SnapTrade could not be reached. */
      error: string | null;
    };
export interface IntegrationsStatus {
  snaptrade: SnapTradeStatus;
  alpaca: { connected: false } | { connected: true; key_id: string; saved_at: string };
}
/** `live` false reads only what is stored (the header's sync status), without asking SnapTrade. */
export const integrationsQuery = (live = true) =>
  queryOptions({
    queryKey: ['integrations', live ? 'live' : 'stored'],
    queryFn: () => getJson<IntegrationsStatus>(`/api/v1/integrations${live ? '' : '?live=0'}`),
    staleTime: live ? 30_000 : 60_000,
  });
export const saveSnapTradeKey = (key: { client_id: string; consumer_key: string }) =>
  send<IntegrationsStatus>('PUT', '/api/v1/integrations/snaptrade', key);
export const deleteSnapTradeKey = () =>
  send<{ ok: true }>('DELETE', '/api/v1/integrations/snaptrade');
export const syncSnapTrade = () =>
  send<SyncReport>('POST', '/api/v1/integrations/snaptrade/sync', {});
/** SnapTrade's own portal: a new broker, or `reconnect` (a broker id) to sign in again. */
export const snaptradePortal = (reconnect?: string) =>
  send<{ url: string }>('POST', '/api/v1/integrations/snaptrade/portal', { reconnect });
export const setSnapTradeAccount = (id: string, change: { import?: boolean; tax_type?: TaxType }) =>
  send<IntegrationsStatus>('PUT', `/api/v1/integrations/snaptrade/accounts/${enc(id)}`, change);
export const saveAlpacaKey = (key: { key_id: string; secret_key: string }) =>
  send<IntegrationsStatus>('PUT', '/api/v1/integrations/alpaca', key);
export const deleteAlpacaKey = () => send<{ ok: true }>('DELETE', '/api/v1/integrations/alpaca');

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
