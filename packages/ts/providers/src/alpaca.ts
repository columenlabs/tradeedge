/**
 * Real-time options client (REST snapshots). Internal only — callers get
 * normalized `OptionQuote`s and never see the vendor.
 *
 * Endpoints:
 *   data:    GET /v1beta1/options/snapshots/{underlying}   (paged, ≤1000/page)
 *            GET /v2/stocks/{symbol}/snapshot
 *   trading: GET /v2/options/contracts                     (expirations)
 */
import {
  type OptionQuote,
  type UnderlyingQuote,
  dateToExpInt,
  daysBetween,
  expIntToIso,
} from '@edgedesk/types';
import { parseOccSymbol } from './occ';
import {
  type AssetInfo,
  type AssetLookup,
  type ChainQuery,
  type LiveOptionsProvider,
  ProviderError,
  type Split,
  type SplitLookup,
} from './types';

type FetchFn = (input: URL | string | Request, init?: RequestInit) => Promise<Response>;

export interface AlpacaConfig {
  keyId: string;
  secretKey: string;
  /** `indicative` (free, delayed-ish) or `opra` (paid, real-time). */
  optionsFeed?: 'indicative' | 'opra';
  /** `iex` (free) or `sip` (paid). */
  stockFeed?: 'iex' | 'sip';
  dataUrl?: string;
  tradingUrl?: string;
  fetch?: FetchFn;
  /** Override "today" (Int YYYYMMDD) for DTE; tests only. */
  today?: () => number;
}

interface RawQuote {
  ap?: number;
  as?: number;
  bp?: number;
  bs?: number;
  t?: string;
}
interface RawTrade {
  p?: number;
  s?: number;
  t?: string;
}
interface RawBar {
  c?: number;
  v?: number;
}
interface RawOptionSnapshot {
  latestQuote?: RawQuote;
  latestTrade?: RawTrade;
  dailyBar?: RawBar;
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number; rho?: number };
  impliedVolatility?: number;
}
interface RawStockSnapshot {
  latestQuote?: RawQuote;
  latestTrade?: RawTrade;
  dailyBar?: RawBar;
  prevDailyBar?: RawBar;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const MAX_PAGES = 50;

export function envAlpacaConfig(env: Record<string, string | undefined>): AlpacaConfig | null {
  // Also accept the legacy Worker binding names (ALPACA_API_KEY / ALPACA_SECRET_KEY).
  const keyId = env.ALPACA_API_KEY_ID ?? env.APCA_API_KEY_ID ?? env.ALPACA_API_KEY;
  const secretKey = env.ALPACA_API_SECRET_KEY ?? env.APCA_API_SECRET_KEY ?? env.ALPACA_SECRET_KEY;
  if (!keyId || !secretKey) return null;
  return {
    keyId,
    secretKey,
    optionsFeed: env.ALPACA_OPTIONS_FEED === 'opra' ? 'opra' : 'indicative',
    stockFeed: env.ALPACA_STOCK_FEED === 'sip' ? 'sip' : 'iex',
    dataUrl: env.ALPACA_DATA_URL,
    tradingUrl: env.ALPACA_TRADING_URL,
  };
}

export class AlpacaClient implements LiveOptionsProvider, AssetLookup, SplitLookup {
  private readonly dataUrl: string;
  private readonly tradingUrl: string;
  private readonly fetchImpl: FetchFn;
  private readonly today: () => number;

  constructor(private readonly cfg: AlpacaConfig) {
    this.dataUrl = cfg.dataUrl ?? 'https://data.alpaca.markets';
    this.tradingUrl = cfg.tradingUrl ?? 'https://paper-api.alpaca.markets';
    // Wrap: Workers throw "Illegal invocation" if fetch is called detached from globalThis.
    this.fetchImpl = cfg.fetch ?? ((input, init) => fetch(input, init));
    this.today = cfg.today ?? (() => dateToExpInt(new Date()));
  }

  async getOptionChain(q: ChainQuery): Promise<OptionQuote[]> {
    const underlying = q.underlying.toUpperCase();
    const params: Record<string, string> = {
      feed: this.cfg.optionsFeed ?? 'indicative',
      limit: '1000',
    };
    if (q.expiration) params.expiration_date = expIntToIso(q.expiration);
    if (q.type) params.type = q.type;
    if (q.strikeGte !== undefined) params.strike_price_gte = String(q.strikeGte);
    if (q.strikeLte !== undefined) params.strike_price_lte = String(q.strikeLte);

    const today = this.today();
    const out: OptionQuote[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get<{
        snapshots?: Record<string, RawOptionSnapshot>;
        next_page_token?: string | null;
      }>(this.dataUrl, `/v1beta1/options/snapshots/${encodeURIComponent(underlying)}`, {
        ...params,
        ...(pageToken ? { page_token: pageToken } : {}),
      });
      for (const [symbol, snap] of Object.entries(body.snapshots ?? {})) {
        const quote = normalizeOptionSnapshot(symbol, underlying, snap, today);
        if (quote) out.push(quote);
      }
      if (!body.next_page_token) break;
      pageToken = body.next_page_token;
    }
    return out.sort(
      (a, b) => a.expiration - b.expiration || a.strike - b.strike || a.type.localeCompare(b.type),
    );
  }

  async getExpirations(underlying: string): Promise<number[]> {
    const exps = new Set<number>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get<{
        option_contracts?: { expiration_date: string }[];
        next_page_token?: string | null;
      }>(this.tradingUrl, '/v2/options/contracts', {
        underlying_symbols: underlying.toUpperCase(),
        status: 'active',
        expiration_date_gte: expIntToIso(this.today()),
        limit: '10000',
        ...(pageToken ? { page_token: pageToken } : {}),
      });
      for (const c of body.option_contracts ?? []) exps.add(dateToExpInt(c.expiration_date));
      if (!body.next_page_token) break;
      pageToken = body.next_page_token;
    }
    return [...exps].sort((a, b) => a - b);
  }

  async getUnderlyingQuote(symbol: string): Promise<UnderlyingQuote> {
    const sym = symbol.toUpperCase();
    const s = await this.get<RawStockSnapshot>(
      this.dataUrl,
      `/v2/stocks/${encodeURIComponent(sym)}/snapshot`,
      { feed: this.cfg.stockFeed ?? 'iex' },
    );
    return normalizeStockSnapshot(sym, s);
  }

  /** Many tickers in one call per 100 (`/v2/stocks/snapshots`); a ticker with no snapshot is left out. */
  async getUnderlyingQuotes(symbols: string[]): Promise<Record<string, UnderlyingQuote>> {
    const out: Record<string, UnderlyingQuote> = {};
    for (const part of chunks(
      symbols.map((s) => s.toUpperCase()),
      100,
    )) {
      const body = await this.get<Record<string, RawStockSnapshot | null>>(
        this.dataUrl,
        '/v2/stocks/snapshots',
        { symbols: part.join(','), feed: this.cfg.stockFeed ?? 'iex' },
      );
      for (const [sym, snap] of Object.entries(body)) {
        if (snap) out[sym] = normalizeStockSnapshot(sym, snap);
      }
    }
    return out;
  }

  /** Many option contracts (OCC symbols) in one call per 100 (`/v1beta1/options/snapshots`). */
  async getOptionQuotes(symbols: string[]): Promise<OptionQuote[]> {
    const today = this.today();
    const out: OptionQuote[] = [];
    for (const part of chunks(symbols, 100)) {
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await this.get<{
          snapshots?: Record<string, RawOptionSnapshot>;
          next_page_token?: string | null;
        }>(this.dataUrl, '/v1beta1/options/snapshots', {
          symbols: part.join(','),
          feed: this.cfg.optionsFeed ?? 'indicative',
          limit: '1000',
          ...(pageToken ? { page_token: pageToken } : {}),
        });
        for (const [symbol, snap] of Object.entries(body.snapshots ?? {})) {
          const root = parseOccSymbol(symbol)?.root;
          const quote = root ? normalizeOptionSnapshot(symbol, root, snap, today) : null;
          if (quote) out.push(quote);
        }
        if (!body.next_page_token) break;
        pageToken = body.next_page_token;
      }
    }
    return out;
  }

  async getSplits(symbols: string[], from: string): Promise<Split[]> {
    type Raw = { symbol?: string; ex_date?: string; new_rate?: number; old_rate?: number };
    const out: Split[] = [];
    for (const list of chunks(symbols, 100)) {
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await this.get<{
          corporate_actions?: { forward_splits?: Raw[]; reverse_splits?: Raw[] };
          next_page_token?: string | null;
        }>(this.dataUrl, '/v1/corporate-actions', {
          symbols: list.join(','),
          types: 'forward_split,reverse_split',
          start: from,
          limit: '1000',
          ...(pageToken ? { page_token: pageToken } : {}),
        });
        const ca = body.corporate_actions ?? {};
        for (const r of [...(ca.forward_splits ?? []), ...(ca.reverse_splits ?? [])]) {
          const ratio = (r.new_rate ?? 0) / (r.old_rate ?? 0);
          if (r.symbol && r.ex_date && Number.isFinite(ratio) && ratio > 0 && ratio !== 1)
            out.push({ symbol: r.symbol.toUpperCase(), date: r.ex_date.slice(0, 10), ratio });
        }
        if (!body.next_page_token) break;
        pageToken = body.next_page_token;
      }
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  async getAsset(symbol: string): Promise<AssetInfo | null> {
    let body: {
      symbol?: string;
      name?: string;
      exchange?: string;
      status?: string;
      tradable?: boolean;
    };
    try {
      body = await this.get(this.tradingUrl, `/v2/assets/${encodeURIComponent(symbol)}`, {});
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null;
      throw err;
    }
    return {
      symbol: body.symbol ?? symbol,
      name: body.name ?? null,
      exchange: body.exchange ?? null,
      active: body.status === 'active',
      tradable: !!body.tradable,
    };
  }

  private async get<T>(base: string, path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, {
      headers: {
        'APCA-API-KEY-ID': this.cfg.keyId,
        'APCA-API-SECRET-KEY': this.cfg.secretKey,
        accept: 'application/json',
      },
    });
    if (!res.ok) {
      // Don't echo upstream bodies — they name the vendor.
      throw new ProviderError(`live data request failed (${res.status})`, res.status);
    }
    return (await res.json()) as T;
  }
}

const chunks = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

function normalizeStockSnapshot(symbol: string, s: RawStockSnapshot): UnderlyingQuote {
  const last = num(s.latestTrade?.p) ?? num(s.dailyBar?.c);
  const prevClose = num(s.prevDailyBar?.c);
  const change = last !== null && prevClose !== null ? last - prevClose : null;
  return {
    symbol,
    last,
    bid: num(s.latestQuote?.bp),
    ask: num(s.latestQuote?.ap),
    prevClose,
    change,
    changePct: change !== null && prevClose ? change / prevClose : null,
    time: s.latestTrade?.t ?? s.latestQuote?.t ?? null,
  };
}

export function normalizeOptionSnapshot(
  symbol: string,
  underlying: string,
  s: RawOptionSnapshot,
  today: number,
): OptionQuote | null {
  const occ = parseOccSymbol(symbol);
  if (!occ) return null;
  const bid = num(s.latestQuote?.bp);
  const ask = num(s.latestQuote?.ap);
  return {
    symbol,
    underlying,
    expiration: occ.expiration,
    dte: daysBetween(today, occ.expiration),
    type: occ.type,
    strike: occ.strike,
    bid,
    ask,
    bidSize: num(s.latestQuote?.bs),
    askSize: num(s.latestQuote?.as),
    mid: bid !== null && ask !== null && ask > 0 ? (bid + ask) / 2 : null,
    last: num(s.latestTrade?.p),
    volume: num(s.dailyBar?.v),
    iv: num(s.impliedVolatility),
    delta: num(s.greeks?.delta),
    gamma: num(s.greeks?.gamma),
    theta: num(s.greeks?.theta),
    vega: num(s.greeks?.vega),
    rho: num(s.greeks?.rho),
    quoteTime: s.latestQuote?.t ?? null,
  };
}
