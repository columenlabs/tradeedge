/**
 * History service over `@edgedesk/clickhouse`. Snapshots are EOD and
 * immutable once written, so reads are cached for a few minutes (with the
 * same in-flight dedup as live data).
 */
import { ClickHouseClient, type FetchLike, HistoryStore } from '@edgedesk/clickhouse';
import type {
  HistoryCoverage,
  OptionChain,
  OptionQuote,
  OptionType,
  UnderlyingQuote,
} from '@edgedesk/types';
import type { Config } from './config';

/** Workers VPC service binding (only `fetch` is used). */
export interface VpcService {
  fetch: FetchLike;
}

/**
 * Build the ClickHouse client from config. With a VPC service `binding` the URL only
 * sets the Host header (the service fixes host + port). Null when unconfigured.
 */
export function createClickHouseClient(cfg: Config, binding?: VpcService): ClickHouseClient | null {
  const ch = cfg.clickhouse;
  if (!ch || (!binding && !ch.url)) return null;
  return new ClickHouseClient({
    url: ch.url ?? 'http://clickhouse:8123',
    user: ch.user,
    password: ch.password,
    database: ch.database,
    fetch: binding ? (input, init) => binding.fetch(input, init) : undefined,
  });
}

/** Build the history service from config. Off when unconfigured. */
export function createHistory(cfg: Config, binding?: VpcService): HistoryService {
  const client = createClickHouseClient(cfg, binding);
  return new HistoryService(client ? new HistoryStore(client) : null);
}

export interface HistoryChainParams {
  underlying: string;
  /** Snapshot day, Int YYYYMMDD. Latest if omitted. */
  date?: number;
  /** Int YYYYMMDD. Nearest at the snapshot if omitted. */
  expiration?: number;
  type?: OptionType;
  strikeGte?: number;
  strikeLte?: number;
}

export class HistoryUnavailable extends Error {
  constructor() {
    super('history not configured');
  }
}

const TTL_MS = 5 * 60_000;

export class HistoryService {
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private readonly store: HistoryStore | null,
    private readonly now: () => number = Date.now,
  ) {}

  get available(): boolean {
    return this.store !== null;
  }

  private s(): HistoryStore {
    if (!this.store) throw new HistoryUnavailable();
    return this.store;
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: this.now(), value });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }

  /** Uncached round-trip; `latencyMs` on success. */
  async health(): Promise<{ ok: boolean; configured: boolean; latencyMs?: number }> {
    if (!this.store) return { ok: false, configured: false };
    try {
      return { ok: true, configured: true, latencyMs: await this.store.ping() };
    } catch (err) {
      console.error('history health', err);
      return { ok: false, configured: true };
    }
  }

  underlyings(): Promise<string[]> {
    return this.cached('underlyings', () => this.s().underlyings());
  }

  dates(underlying: string): Promise<number[]> {
    return this.cached(`dates:${underlying}`, () => this.s().dates(underlying));
  }

  expirations(underlying: string, date: number): Promise<number[]> {
    return this.cached(`exp:${underlying}:${date}`, () => this.s().expirations(underlying, date));
  }

  /** Daily NAVs of funds the live feed cannot quote (ARKVX). Not cached: market data is
   *  read from ClickHouse on each call, never copied. Empty when history is off. */
  fundNavs(symbols: string[]): Promise<Record<string, UnderlyingQuote>> {
    return this.store ? this.store.fundNavs(symbols) : Promise.resolve({});
  }

  /** Unadjusted daily closes (lot costs the broker left at 0). Not cached, like fundNavs. Empty when
   *  history is off. */
  rawCloses(
    symbols: string[],
    from: string,
    to: string,
  ): Promise<Record<string, { date: string; close: number }[]>> {
    return this.store ? this.store.rawCloses(symbols, from, to) : Promise.resolve({});
  }

  coverage(): Promise<HistoryCoverage[]> {
    return this.cached('coverage', () => this.s().coverage());
  }

  async chain(p: HistoryChainParams): Promise<OptionChain> {
    const underlying = p.underlying.toUpperCase();
    const date = p.date ?? (await this.dates(underlying))[0];
    const empty = (expirations: number[], snapshotDate?: number): OptionChain => ({
      underlying,
      source: 'history',
      asOf: new Date(this.now()).toISOString(),
      spot: null,
      snapshotDate,
      expirations,
      quotes: [],
    });
    if (date === undefined) return empty([]);
    const expirations = await this.expirations(underlying, date);
    const expiration = p.expiration ?? expirations[0];
    if (expiration === undefined) return empty(expirations, date);
    const key = `chain:${underlying}:${date}:${expiration}:${p.type ?? ''}:${p.strikeGte ?? ''}:${p.strikeLte ?? ''}`;
    const { quotes, spot } = await this.cached(key, () =>
      this.s().chain({
        underlying,
        date,
        expiration,
        type: p.type,
        strikeGte: p.strikeGte,
        strikeLte: p.strikeLte,
      }),
    );
    const spotQuote =
      spot === null
        ? null
        : {
            symbol: underlying,
            last: spot,
            bid: null,
            ask: null,
            prevClose: null,
            change: null,
            changePct: null,
            time: quotes[0]?.quoteTime ?? null,
          };
    return { ...empty(expirations, date), spot: spotQuote, quotes };
  }
}

/**
 * Strike where call and put prices are closest (put-call parity ≈ ATM).
 * Fallback for snapshots without a stored underlying price.
 */
export function parityAtm(quotes: OptionQuote[]): number | null {
  const px = (q: OptionQuote) => q.mid ?? q.last;
  const calls = new Map<number, number>();
  for (const q of quotes) {
    const p = px(q);
    if (q.type === 'call' && p !== null) calls.set(q.strike, p);
  }
  let best: { strike: number; gap: number } | null = null;
  for (const q of quotes) {
    const c = calls.get(q.strike);
    const p = px(q);
    if (q.type !== 'put' || c === undefined || p === null) continue;
    const gap = Math.abs(c - p);
    if (!best || gap < best.gap) best = { strike: q.strike, gap };
  }
  return best?.strike ?? null;
}

/** Keep the `n` strikes nearest `center` (the first `n` if no center), in strike order. */
export function nearestStrikes(quotes: OptionQuote[], center: number | null, n: number) {
  const strikes = [...new Set(quotes.map((q) => q.strike))];
  if (center !== null) strikes.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
  const keep = new Set(strikes.slice(0, n));
  return quotes.filter((q) => keep.has(q.strike));
}

/** ATM strike: nearest to `spot` when known, else by put-call parity. */
export function atmStrike(quotes: OptionQuote[], spot: number | null): number | null {
  if (spot === null) return parityAtm(quotes);
  let best: number | null = null;
  for (const q of quotes)
    if (best === null || Math.abs(q.strike - spot) < Math.abs(best - spot)) best = q.strike;
  return best;
}
