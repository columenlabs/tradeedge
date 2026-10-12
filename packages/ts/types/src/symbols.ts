// Symbol fields (Bikram, 2026-10-12, /mnt/project-files/symbol-indicators/design.md): facts about a
// ticker that any TradeEdge view can show next to its rows, looked up by symbol (an option by its
// underlying). Robinhood's are read live with the person's own sign-in and never saved; DataEdge's
// (trailing P/E, technicals) are read from market data. One catalog here feeds the app's fields,
// the `/api/symbols` route, `symbol_read` and `custom_view_write`'s field list.

/** Where a symbol field comes from. */
export type SymbolSource = 'robinhood' | 'dataedge';
/** As views format them: `weight` is a plain %, `percent` a signed one. */
export type SymbolFormat = 'number' | 'price' | 'percent' | 'weight' | 'integer' | 'text';

export interface SymbolFieldSpec {
  key: string;
  label: string;
  /** The tree's sub-heading in the view editor. */
  topic: string;
  source: SymbolSource;
  format: SymbolFormat;
  /** Large numbers in short form ($5.6T). */
  compact?: boolean;
  /** How it is made, shown under the field. */
  formula: string;
  /** Text worth grouping and filtering by (industry). */
  category?: boolean;
}

const rh = (
  topic: string,
  key: string,
  label: string,
  format: SymbolFormat,
  formula: string,
  extra: Partial<SymbolFieldSpec> = {},
): SymbolFieldSpec => ({ key, label, topic, source: 'robinhood', format, formula, ...extra });
const de = (
  topic: string,
  key: string,
  label: string,
  format: SymbolFormat,
  formula: string,
): SymbolFieldSpec => ({ key, label, topic, source: 'dataedge', format, formula });

/** Every symbol field, in the order the editor lists them. */
export const SYMBOL_FIELDS: SymbolFieldSpec[] = [
  rh('Valuation', 'pe_ttm', 'P/E ttm', 'number', 'Robinhood pe_ratio: price ÷ last 12 months EPS'),
  rh('Valuation', 'pb', 'P/B', 'number', 'Robinhood pb_ratio: price ÷ book value per share'),
  rh('Valuation', 'market_cap', 'Mkt cap', 'price', 'Robinhood market_cap', { compact: true }),
  rh('Valuation', 'shares_outstanding', 'Shares out', 'number', 'Robinhood shares_outstanding', {
    compact: true,
  }),
  rh('Valuation', 'float', 'Float', 'number', 'Robinhood float', { compact: true }),
  rh('Analysts', 'target_mean', 'Target', 'price', 'mean analyst price target'),
  rh('Analysts', 'target_high', 'Target high', 'price', 'highest analyst price target'),
  rh('Analysts', 'target_low', 'Target low', 'price', 'lowest analyst price target'),
  rh('Analysts', 'buy_count', 'Buys', 'integer', 'analysts rating it buy'),
  rh('Analysts', 'hold_count', 'Holds', 'integer', 'analysts rating it hold'),
  rh('Analysts', 'sell_count', 'Sells', 'integer', 'analysts rating it sell'),
  rh('Analysts', 'buy_pct', 'Buy %', 'weight', 'buys ÷ (buys + holds + sells) × 100'),
  rh(
    'Earnings',
    'earnings_next',
    'Earnings',
    'text',
    'next report date (next 90 days); ~ marks a date the company has not confirmed',
  ),
  rh('Earnings', 'earnings_timing', 'Reports', 'text', 'before the open (am) or after (pm)', {
    category: true,
  }),
  rh('Earnings', 'eps_estimate', 'EPS est.', 'number', 'EPS estimate for the next report'),
  rh('Dividends', 'div_yield', 'Div yield', 'weight', 'Robinhood dividend_yield, %'),
  rh('Dividends', 'div_per_share', 'Div / share', 'price', 'Robinhood dividend_per_share'),
  rh('Dividends', 'ex_dividend', 'Ex-div', 'text', 'last or next ex-dividend date'),
  rh('Dividends', 'pay_date', 'Pay date', 'text', 'last or next dividend pay date'),
  rh('Range and volume', 'high_52w', '52w high', 'price', '52-week high'),
  rh('Range and volume', 'low_52w', '52w low', 'price', '52-week low'),
  rh('Range and volume', 'avg_volume_2w', 'Avg vol 2w', 'number', 'average daily volume, 2 weeks', {
    compact: true,
  }),
  rh(
    'Range and volume',
    'avg_volume_30d',
    'Avg vol 30d',
    'number',
    'average daily volume, 30 days',
    { compact: true },
  ),
  // Robinhood's "sector" is Industry here, so it never clashes with your own Sector tag.
  rh('Profile', 'industry', 'Industry', 'text', 'Robinhood industry', { category: true }),
  rh('Profile', 'employees', 'Employees', 'integer', 'Robinhood num_employees', { compact: true }),
  rh('Profile', 'founded', 'Founded', 'text', 'Robinhood year_founded'),
  rh('Profile', 'ceo', 'CEO', 'text', 'Robinhood ceo'),
  de(
    'P/E history',
    'pe_ttm_daily',
    'P/E ttm (daily)',
    'number',
    'DataEdge pe:<SYMBOL>.trailing, latest day: close ÷ trailing 12 months EPS',
  ),
  de('Technicals', 'rsi_14', 'RSI 14', 'number', 'DataEdge indicator rsi_14, last close'),
  de('Technicals', 'sma_20', 'SMA 20', 'price', 'DataEdge indicator sma_20, last close'),
  de('Technicals', 'sma_50', 'SMA 50', 'price', 'DataEdge indicator sma_50, last close'),
  de('Technicals', 'sma_200', 'SMA 200', 'price', 'DataEdge indicator sma_200, last close'),
  de('Technicals', 'ema_9', 'EMA 9', 'price', 'DataEdge indicator ema_9, last close'),
  de('Technicals', 'ema_21', 'EMA 21', 'price', 'DataEdge indicator ema_21, last close'),
  de('Technicals', 'ema_50', 'EMA 50', 'price', 'DataEdge indicator ema_50, last close'),
  de('Technicals', 'macd_line', 'MACD', 'number', 'DataEdge indicator macd (12, 26)'),
  de('Technicals', 'macd_signal', 'MACD signal', 'number', 'DataEdge indicator macd signal (9)'),
  de('Technicals', 'macd_hist', 'MACD hist', 'number', 'DataEdge indicator macd histogram'),
  de('Technicals', 'atr_14', 'ATR 14', 'price', 'DataEdge indicator atr_14, last close'),
  de('Technicals', 'bb_upper', 'Bollinger up', 'price', 'DataEdge bollinger (20, 2) upper'),
  de('Technicals', 'bb_lower', 'Bollinger low', 'price', 'DataEdge bollinger (20, 2) lower'),
  de('Technicals', 'rel_volume_20', 'Rel volume', 'number', 'DataEdge rel_volume_20'),
  de('Technicals', 'vwap_dist_pct', 'VWAP dist %', 'percent', 'DataEdge vwap_dist_pct'),
];

/** The DataEdge indicator outputs read for symbol fields (`indicators_1d.indicator`). */
export const SYMBOL_INDICATORS = SYMBOL_FIELDS.filter(
  (f) => f.source === 'dataedge' && f.key !== 'pe_ttm_daily',
).map((f) => f.key);

/** One symbol's facts by field key; a missing key is no data (an ETF has no P/E). */
export type SymbolFacts = Record<string, number | string | null>;

/**
 * `/api/symbols`: facts per symbol, and how each source fared. `robinhood` is `not_connected`
 * without a sign-in (its columns stay empty with a connect prompt); `dataedge` is `off` on a
 * self-hosted TradeEdge without market data.
 */
export interface SymbolRead {
  symbols: Record<string, SymbolFacts>;
  robinhood: { state: 'ok' | 'not_connected' | 'error'; error?: string; at: string | null };
  dataedge: { state: 'ok' | 'off' | 'error'; error?: string; as_of: string | null };
}

/** Account fields (Bikram, 2026-10-12): any view's rows look these up by their account. */
export const ACCOUNT_FIELD_KEYS = ['account', 'brokerage', 'tax_type', 'trading', 'cash'] as const;
