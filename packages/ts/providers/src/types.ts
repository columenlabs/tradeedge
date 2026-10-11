import type { OptionQuote, OptionType, UnderlyingQuote } from '@edgedesk/types';

export interface ChainQuery {
  underlying: string;
  /** Int YYYYMMDD. Omit for all expirations (expensive on large chains). */
  expiration?: number;
  type?: OptionType;
  strikeGte?: number;
  strikeLte?: number;
}

/** A real-time options data source. Implementations must not leak vendor names. */
export interface LiveOptionsProvider {
  getOptionChain(q: ChainQuery): Promise<OptionQuote[]>;
  /** Active expirations, ascending, Int YYYYMMDD. */
  getExpirations(underlying: string): Promise<number[]>;
  getUnderlyingQuote(symbol: string): Promise<UnderlyingQuote>;
  /** Many tickers in as few upstream calls as the provider allows; missing tickers are left out. */
  getUnderlyingQuotes(symbols: string[]): Promise<Record<string, UnderlyingQuote>>;
  /** Many option contracts (OCC symbols) in as few upstream calls as the provider allows. */
  getOptionQuotes(symbols: string[]): Promise<OptionQuote[]>;
}

/** A listed US equity or ETF, as the live provider knows it. */
export interface AssetInfo {
  symbol: string;
  name: string | null;
  exchange: string | null;
  /** Listed and active (not delisted). */
  active: boolean;
  tradable: boolean;
}

/** Looks a ticker up; `null` when it has no listing. Throws `ProviderError` when the provider fails. */
export interface AssetLookup {
  getAsset(symbol: string): Promise<AssetInfo | null>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
