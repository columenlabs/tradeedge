/**
 * Live options service: provider + market-hours-aware caching.
 *
 * - During the session (options RTH for chains, 4:00–20:00 ET for quotes):
 *   chains keep only a short in-memory TTL / in-flight dedup — data is live;
 *   price quotes are cached 5 min (memory + colo-shared cache; Bikram, 2026-10-09).
 * - Outside the session: cached (memory + colo-shared cache) until the next open.
 * - Expirations: 5 min in memory, 1 h shared, at all times.
 */
import {
  type LiveOptionsProvider,
  type Split,
  type SplitLookup,
  parseOccSymbol,
} from '@edgedesk/providers';
import {
  type OptionChain,
  type OptionQuote,
  type OptionType,
  type UnderlyingQuote,
  dateToExpInt,
  daysBetween,
} from '@edgedesk/types';
import { enrichQuotes } from './enrich';
import { type Session, isSessionOpen, secondsUntilOpen } from './market-hours';
import { type SharedCache, noSharedCache } from './shared-cache';
import { currentStats, timeUpstream } from './telemetry';

export interface ChainParams {
  underlying: string;
  expiration?: number;
  /** When `expiration` is omitted: nearest expiration with dte >= minDte (default 0). */
  minDte?: number;
  type?: OptionType;
  strikeGte?: number;
  strikeLte?: number;
}

export class LiveDataUnavailable extends Error {
  constructor() {
    super('live data not configured');
  }
}

class TtlCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private readonly now: () => number = Date.now) {}

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < ttlMs) {
      const s = currentStats();
      if (s) s.memoryHits++;
      return hit.value as Promise<T>;
    }
    const value = load();
    this.entries.set(key, { at: this.now(), value });
    // Never cache failures.
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  /** A live entry, or undefined (counts a memory hit). */
  peek<T>(key: string, ttlMs: number): Promise<T> | undefined {
    const hit = this.entries.get(key);
    if (!hit || this.now() - hit.at >= ttlMs) return undefined;
    const s = currentStats();
    if (s) s.memoryHits++;
    return hit.value as Promise<T>;
  }

  set(key: string, value: unknown): void {
    this.entries.set(key, { at: this.now(), value: Promise.resolve(value) });
  }
}

export class MarketService {
  private readonly cache: TtlCache;

  constructor(
    private readonly provider: LiveOptionsProvider | null,
    private readonly ttlMs = 2000,
    private readonly now: () => number = Date.now,
    private readonly shared: SharedCache = noSharedCache,
  ) {
    this.cache = new TtlCache(now);
  }

  /** Is `session` trading now (live data → no long-lived caching)? */
  marketOpen(session: Session): boolean {
    return isSessionOpen(session, this.now());
  }

  private async fromUpstream<T>(load: () => Promise<T>): Promise<T> {
    const s = currentStats();
    if (s) s.misses++;
    return timeUpstream(load);
  }

  /** Memory → (off-hours / static) shared cache → upstream. `fresh` skips both caches and refills them. */
  private layered<T>(
    key: string,
    policy: { session: Session; liveTtlS?: number } | { staticTtlS: number },
    load: () => Promise<T>,
    fresh = false,
  ): Promise<T> {
    const { memTtlMs, sharedTtlS } = this.ttls(policy);
    return this.cache.get(key, fresh ? 0 : memTtlMs, async () => {
      if (sharedTtlS === null) return this.fromUpstream(load);
      const hit = fresh ? undefined : await this.shared.get<T>(key).catch(() => undefined);
      if (hit !== undefined) {
        const s = currentStats();
        if (s) s.sharedHits++;
        return hit;
      }
      const value = await this.fromUpstream(load);
      await this.shared.put(key, value, sharedTtlS).catch(() => undefined);
      return value;
    });
  }

  /** How long `policy` keeps a value in memory, and in the shared cache (null: not shared). */
  private ttls(policy: { session: Session; liveTtlS?: number } | { staticTtlS: number }) {
    let memTtlMs: number;
    let sharedTtlS: number | null;
    if ('staticTtlS' in policy) {
      memTtlMs = Math.min(5 * 60_000, policy.staticTtlS * 1000);
      sharedTtlS = policy.staticTtlS;
    } else if (isSessionOpen(policy.session, this.now())) {
      memTtlMs = policy.liveTtlS ? policy.liveTtlS * 1000 : this.ttlMs;
      sharedTtlS = policy.liveTtlS ?? null;
    } else {
      sharedTtlS = secondsUntilOpen(policy.session, this.now());
      memTtlMs = sharedTtlS * 1000;
    }
    return { memTtlMs, sharedTtlS };
  }

  get available(): boolean {
    return this.provider !== null;
  }

  private p(): LiveOptionsProvider {
    if (!this.provider) throw new LiveDataUnavailable();
    return this.provider;
  }

  expirations(underlying: string): Promise<number[]> {
    const u = underlying.toUpperCase();
    return this.layered(`exp:${u}`, { staticTtlS: 3600 }, () => this.p().getExpirations(u));
  }

  /**
   * Stock splits of `symbols` since `from` (the lot math splits older lots by them), cached 1 h like
   * expirations. Empty without a provider that knows splits.
   */
  splits(symbols: string[], from: string): Promise<Split[]> {
    const p = this.provider as (LiveOptionsProvider & Partial<SplitLookup>) | null;
    if (!p?.getSplits || !symbols.length) return Promise.resolve([]);
    const list = [...new Set(symbols.map((s) => s.toUpperCase()))].sort();
    return this.layered(`splits:${from}:${list.join(',')}`, { staticTtlS: 3600 }, () =>
      (p.getSplits as SplitLookup['getSplits'])(list, from),
    );
  }

  /** Price quote, cached 5 min while the session is open (Bikram, 2026-10-09). `fresh` refetches it. */
  quote(symbol: string, fresh = false): Promise<UnderlyingQuote> {
    const s = symbol.toUpperCase();
    return this.layered(
      `quote:${s}`,
      { session: 'stocks', liveTtlS: 300 },
      () => this.p().getUnderlyingQuote(s),
      fresh,
    );
  }

  /**
   * Price quotes for many tickers and OCC option symbols (Holdings, the watchlist), each cached 5 min
   * while its session is open like `quote`. The ones not cached come from the provider in one call
   * per kind, so a Refresh (`fresh`) of 100 symbols is two upstream calls, not 100.
   * A ticker the provider has no quote for gets its fund NAV from `navs` when it has one (mutual
   * and interval funds like ARKVX; that day's official price, not stale, never cached here).
   * Otherwise the last price we had is kept and the symbol is listed in `stale`; with none ever
   * had, it is null (Bikram, 2026-10-09).
   */
  async quotes(
    symbols: string[],
    fresh = false,
    navs: (tickers: string[]) => Promise<Record<string, UnderlyingQuote>> = async () => ({}),
  ): Promise<{ quotes: Record<string, UnderlyingQuote | OptionQuote | null>; stale: string[] }> {
    const out: Record<string, UnderlyingQuote | OptionQuote | null> = {};
    const kinds = [
      {
        prefix: 'quote:',
        session: 'stocks' as const,
        list: symbols.filter((s) => !parseOccSymbol(s)),
      },
      {
        prefix: 'optquote:',
        session: 'options' as const,
        list: symbols.filter((s) => parseOccSymbol(s)),
      },
    ];
    const missing = await Promise.all(
      kinds.map(async (k) => {
        const { memTtlMs, sharedTtlS } = this.ttls({ session: k.session, liveTtlS: 300 });
        const left: string[] = [];
        await Promise.all(
          k.list.map(async (sym) => {
            const key = k.prefix + sym;
            const mem = fresh
              ? undefined
              : this.cache.peek<UnderlyingQuote | OptionQuote>(key, memTtlMs);
            const hit =
              (await mem?.catch(() => undefined)) ??
              (fresh || sharedTtlS === null
                ? undefined
                : await this.shared.get<UnderlyingQuote | OptionQuote>(key).catch(() => undefined));
            if (hit === undefined) {
              left.push(sym);
              return;
            }
            if (!mem) {
              const s = currentStats();
              if (s) s.sharedHits++;
              this.cache.set(key, hit);
            }
            out[sym] = hit;
          }),
        );
        return { ...k, left, memTtlMs, sharedTtlS };
      }),
    );
    const [stocks, options] = missing as [(typeof missing)[0], (typeof missing)[0]];
    // Option greeks need the underlying's price, so roots ride along in the ticker call.
    const roots = options.left.map((o) => parseOccSymbol(o)?.root as string);
    const tickers = [...new Set([...stocks.left, ...roots.filter((r) => !(r in out))])];
    const fetched: Record<string, UnderlyingQuote> = tickers.length
      ? await this.fromUpstream(() => this.p().getUnderlyingQuotes(tickers)).catch(() => ({}))
      : {};
    const contracts = options.left.length
      ? await this.fromUpstream(() => this.p().getOptionQuotes(options.left)).catch(() => [])
      : [];
    const spotOf = (root: string) =>
      (fetched[root] ?? (out[root] as UnderlyingQuote | null | undefined))?.last ?? null;
    const store = (key: string, value: unknown, sharedTtlS: number | null) => {
      this.cache.set(key, value);
      if (sharedTtlS !== null) void this.shared.put(key, value, sharedTtlS).catch(() => undefined);
    };
    for (const [sym, q] of Object.entries(fetched)) store(`quote:${sym}`, q, stocks.sharedTtlS);
    for (const sym of stocks.left) out[sym] = fetched[sym] ?? null;
    const unpriced = stocks.left.filter((s) => out[s] === null);
    if (unpriced.length) {
      const nav = await navs(unpriced).catch(() => ({}) as Record<string, UnderlyingQuote>);
      for (const sym of unpriced) out[sym] = nav[sym] ?? null;
    }
    for (const sym of options.left) {
      const raw = contracts.find((c) => c.symbol === sym);
      const q = raw ? (enrichQuotes([raw], spotOf(raw.underlying))[0] ?? null) : null;
      out[sym] = q;
      if (q) store(`optquote:${sym}`, q, options.sharedTtlS);
    }
    // No new price: keep the last one we had, whatever its age, and say it is stale.
    const stale: string[] = [];
    await Promise.all(
      [...stocks.left.map((s) => `quote:${s}`), ...options.left.map((s) => `optquote:${s}`)].map(
        async (key) => {
          const sym = key.slice(key.indexOf(':') + 1);
          if (out[sym] !== null) return;
          const last =
            (await this.cache
              .peek<UnderlyingQuote | OptionQuote>(key, Number.POSITIVE_INFINITY)
              ?.catch(() => undefined)) ??
            (await this.shared.get<UnderlyingQuote | OptionQuote>(key).catch(() => undefined));
          if (last === undefined) return;
          out[sym] = last;
          stale.push(sym);
        },
      ),
    );
    return { quotes: out, stale };
  }

  /** The chain's own spot stays live, like the chain. */
  private spot(symbol: string): Promise<UnderlyingQuote> {
    return this.layered(`spot:${symbol}`, { session: 'stocks' }, () =>
      this.p().getUnderlyingQuote(symbol),
    );
  }

  /** Chain for one expiration (nearest active one if omitted). */
  async chain(params: ChainParams): Promise<OptionChain> {
    const underlying = params.underlying.toUpperCase();
    const [expirations, spot] = await Promise.all([
      this.expirations(underlying),
      this.spot(underlying).catch(() => null),
    ]);
    const today = dateToExpInt(new Date());
    const expiration =
      params.expiration ??
      expirations.find((e) => daysBetween(today, e) >= (params.minDte ?? 0)) ??
      expirations[0];
    if (expiration === undefined) {
      return {
        underlying,
        source: 'live',
        asOf: new Date().toISOString(),
        spot,
        expirations,
        quotes: [],
      };
    }
    const { minDte: _m, ...rest } = params;
    const q = { ...rest, underlying, expiration };
    const key = `chain:${underlying}:${expiration}:${q.type ?? ''}:${q.strikeGte ?? ''}:${q.strikeLte ?? ''}`;
    const quotes = await this.layered(key, { session: 'options' }, async () =>
      enrichQuotes(await this.p().getOptionChain(q), spot?.last ?? null),
    );
    return {
      underlying,
      source: 'live',
      asOf: new Date().toISOString(),
      spot,
      expirations,
      quotes,
    };
  }
}
