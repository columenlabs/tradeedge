/**
 * The EdgeDesk operation registry: one definition per capability, shared by
 * the MCP tools (`/mcp`), the REST routes (`/api`), `/api/openapi.json` and
 * `/llms.txt`. Add or change an operation here and every surface follows.
 */
import { type OptionQuote, dateToExpInt, daysBetween } from '@edgedesk/types';
import { z } from 'zod';
import {
  ScreenerInvalid,
  ScreenerNotFound,
  type Screeners,
  screenerIdSchema,
  screenerInputShape,
} from './desks/tradeedge/screeners';
import { type Strategies, StrategiesUnavailable } from './desks/tradeedge/strategies';
import { type HistoryService, atmStrike, nearestStrikes } from './history';
import type { MarketService } from './market';
import { runEvaluate, runScreen } from './screener';

export const symbol = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9.]{0,9}$/)
  .transform((s) => s.toUpperCase())
  .describe('Ticker, e.g. SPY');

const expiration = z.coerce
  .number()
  .int()
  .min(20000101)
  .max(20991231)
  .describe('Expiration as YYYYMMDD, e.g. 20261016');

const day = z.coerce
  .number()
  .int()
  .min(20000101)
  .max(20991231)
  .describe('Snapshot market day as YYYYMMDD (US/Pacific), e.g. 20260918');

/** Services beyond live market data that an operation may use. */
export interface OpContext {
  history: HistoryService;
  /** D1 strategies the screener builds from. Absent → screener_run is not offered. */
  strategies?: Strategies;
  /** Saved screeners, read by `screener_run {id}` for `owner`. */
  screeners?: Screeners;
  /** The signed-in caller (portfolioOwner), set per request. */
  owner?: string;
}

export interface Operation {
  /** MCP tool name and OpenAPI operationId. */
  id: string;
  title: string;
  description: string;
  method: 'GET' | 'POST';
  /** Hono path under /api, e.g. `/options/:underlying/chain`. */
  path: string;
  /** Input keys taken from the path; the rest come from query (GET) or JSON body (POST). */
  pathParams: string[];
  input: z.ZodRawShape;
  /** One short example input (llms.txt / docs). */
  example: Record<string, unknown>;
  run(market: MarketService, input: Record<string, unknown>, ctx: OpContext): Promise<unknown>;
  /** Backing service this needs. Its MCP tool is only listed when that service is configured. */
  requires?: 'history' | 'strategies';
  /** Optional MCP-only presentation (trim for LLM context). REST always returns the full result. */
  mcpView?(result: unknown): unknown;
}

/** Compact chain row for LLM context: drops nulls and fields already known from the request. */
function compactQuote(q: OptionQuote) {
  const { symbol: _s, underlying: _u, ...rest } = q;
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null));
}

export const OPERATIONS: Operation[] = [
  {
    id: 'underlying_quote',
    title: 'Underlying quote',
    description: 'Latest price, bid/ask and daily change for a stock or ETF.',
    method: 'GET',
    path: '/quotes/:symbol',
    pathParams: ['symbol'],
    input: { symbol },
    example: { symbol: 'SPY' },
    run: (m, i) => m.quote(i.symbol as string),
  },
  {
    id: 'options_expirations',
    title: 'Option expirations',
    description:
      'Active option expirations for an underlying, ascending, each with its dte (calendar days to expiry, US/Pacific).',
    method: 'GET',
    path: '/options/:underlying/expirations',
    pathParams: ['underlying'],
    input: { underlying: symbol },
    example: { underlying: 'SPY' },
    async run(m, i) {
      const u = i.underlying as string;
      const today = dateToExpInt(new Date());
      const exps = await m.expirations(u);
      return {
        underlying: u,
        expirations: exps.map((e) => ({ expiration: e, dte: daysBetween(today, e) })),
      };
    },
  },
  {
    id: 'options_chain',
    title: 'Live option chain',
    description:
      'Live option chain for one expiration with bid/ask/mid, volume, iv and greeks (greeksSource: provider | model). ' +
      'Without `expiration`, uses the nearest expiration with dte >= min_dte. ' +
      'Strikes: `strike_min`/`strike_max` if given, else within ±near_money_pct of spot (default 10; 100 = whole chain).',
    method: 'GET',
    path: '/options/:underlying/chain',
    pathParams: ['underlying'],
    input: {
      underlying: symbol,
      expiration: expiration.optional(),
      min_dte: z.coerce
        .number()
        .int()
        .min(0)
        .max(3650)
        .default(0)
        .describe('Used only when expiration is omitted. 1 skips same-day (0DTE) expiries.'),
      type: z.enum(['call', 'put']).optional(),
      near_money_pct: z.coerce
        .number()
        .min(0.5)
        .max(100)
        .default(10)
        .describe(
          'Keep strikes within ±this % of spot (ignored when strike_min/strike_max is set).',
        ),
      strike_min: z.coerce.number().positive().optional(),
      strike_max: z.coerce.number().positive().optional(),
    },
    example: { underlying: 'SPY', min_dte: 1, near_money_pct: 5 },
    async run(m, i) {
      const u = i.underlying as string;
      let strikeGte = i.strike_min as number | undefined;
      let strikeLte = i.strike_max as number | undefined;
      if (strikeGte === undefined && strikeLte === undefined) {
        const spot = (await m.quote(u).catch(() => null))?.last ?? null;
        const pct = i.near_money_pct as number;
        if (spot !== null && pct < 100) {
          strikeGte = Math.floor(spot * (1 - pct / 100));
          strikeLte = Math.ceil(spot * (1 + pct / 100));
        }
      }
      return m.chain({
        underlying: u,
        expiration: i.expiration as number | undefined,
        minDte: i.min_dte as number,
        type: i.type as 'call' | 'put' | undefined,
        strikeGte,
        strikeLte,
      });
    },
    mcpView(result) {
      const chain = result as Awaited<ReturnType<MarketService['chain']>>;
      return {
        ...chain,
        expirations: chain.expirations.slice(0, 12),
        quotes: chain.quotes.map(compactQuote),
      };
    },
  },
  {
    id: 'screener_run',
    title: 'Run a screener',
    description: [
      'Find and rank concrete trades for one strategy (strategy_list) on one underlying using the live chain.',
      'Run a saved screener with `id` alone (screener_list), or give `underlying`, `strategy` and the inputs below.',
      'HOW LEGS ARE CHOSEN (first match wins per leg): `strikes` (exact, by role) > `otm_pct` > `delta` > strategy default.',
      '`delta` is an absolute value applied to the legs whose strike rule has knob delta, usually the short legs (0.16 = 16Δ call and −16Δ put). ' +
        'Pass an array to scan several (e.g. [0.1,0.16,0.2,0.3]). Omit to use the strategy default scan.',
      '`otm_pct` = distance from spot as a fraction (0.05 = 5% OTM); array allowed.',
      '`width` = wing/spread width in $ of strike (spreads, condors, butterflies, lizards); array allowed; ' +
        'default ≈ 1%, 2%, 3% of spot.',
      'Expirations: `expiration` (YYYYMMDD) or a window `dte_min`..`dte_max` (default 21..60), up to `max_expirations` (default 3). ' +
        'Calendars/diagonals also take `back_dte_min`/`back_dte_max`.',
      'Filters: min_credit / max_debit ($ per share), min_pop (0-1), min_return_on_risk, max_leg_spread_pct (0-1), min_leg_volume.',
      '`sort_by`: expected_value (default) | pop | return_on_risk | credit | credit_to_width | lowest_debit | theta.',
      'Each result: legs (action, qty, call/put/stock, strike, expiration, price, bid/ask, delta, iv, symbol), ' +
        'net_premium ($, + credit / − debit), max_profit / max_loss ($, null = unlimited), breakevens, pop, ' +
        'expected_value, return_on_risk, capital_required, width, credit_to_width, net greeks (delta in shares, ' +
        'theta $/day, vega $/vol pt), liquidity, notes.',
      'Strategies, their roles and defaults: strategy_list. Save these inputs under a strategy with screener_write; ' +
        'save a result you like as a trade with trade_write.',
    ].join('\n'),
    method: 'POST',
    path: '/screeners/run',
    pathParams: [],
    input: {
      id: screenerIdSchema
        .optional()
        .describe('A saved screener (screener_list). Give it alone: its saved inputs are used.'),
      underlying: symbol.optional(),
      strategy: z.string().optional().describe('Strategy id from strategy_list, e.g. iron_condor.'),
      ...screenerInputShape,
    },
    example: {
      underlying: 'SPY',
      strategy: 'iron_condor',
      delta: [0.1, 0.16],
      width: [5, 10],
      dte_min: 30,
      dte_max: 45,
      sort_by: 'pop',
    },
    requires: 'strategies',
    run: async (m, { id, underlying, strategy, ...inputs }, ctx) => {
      if (!ctx.strategies) throw new StrategiesUnavailable();
      let run: { underlying: string; strategy: string; inputs: Record<string, unknown> };
      if (id !== undefined) {
        if (
          underlying !== undefined ||
          strategy !== undefined ||
          Object.values(inputs).some((v) => v !== undefined)
        ) {
          throw new ScreenerInvalid('give a saved screener `id` alone, or the inputs without `id`');
        }
        if (!ctx.screeners || ctx.owner === undefined) throw new ScreenerNotFound();
        const saved = await ctx.screeners.read(ctx.owner, id as string);
        run = { underlying: saved.underlying, strategy: saved.strategy, inputs: saved.inputs };
      } else {
        if (underlying === undefined || strategy === undefined) {
          throw new ScreenerInvalid(
            '`underlying` and `strategy` are required without a saved `id`',
          );
        }
        run = { underlying: underlying as string, strategy: strategy as string, inputs };
      }
      const def = await ctx.strategies.read(run.strategy);
      return runScreen(m, run.underlying, { ...run.inputs, strategy: run.strategy } as never, def);
    },
  },
  {
    id: 'trade_evaluate',
    title: 'Evaluate a trade',
    description:
      'Price and analyze any explicit set of legs (to check a specific trade, or one no strategy builds). ' +
      'Each leg: action buy|sell, instrument call|put|stock, strike + expiration (YYYYMMDD) for options, qty ' +
      '(contracts; shares for stock, default 100). Strikes must exist in the chain — on a miss the error lists the nearest. ' +
      'Returns the same metrics as screener_run results. Save it to the board with trade_write.',
    method: 'POST',
    path: '/trades/evaluate',
    pathParams: [],
    input: {
      underlying: symbol,
      legs: z
        .array(
          z.object({
            action: z.enum(['buy', 'sell']),
            instrument: z.enum(['call', 'put', 'stock']),
            strike: z.number().positive().optional(),
            expiration: expiration.optional(),
            qty: z.number().int().positive().max(10_000).optional(),
          }),
        )
        .min(1)
        .max(8),
      pricing: z.enum(['mid', 'natural']).default('mid'),
    },
    example: {
      underlying: 'SPY',
      legs: [
        { action: 'sell', instrument: 'put', strike: 700, expiration: 20261120 },
        { action: 'buy', instrument: 'put', strike: 695, expiration: 20261120 },
      ],
    },
    run: (m, i) =>
      runEvaluate(m, i.underlying as string, i.legs as never, i.pricing as 'mid' | 'natural'),
  },
  {
    id: 'history_coverage',
    title: 'Historical data coverage',
    description:
      'Which underlyings have end-of-day option history, with row counts, snapshot-day counts, ' +
      'first/last snapshot day and expiration range (all YYYYMMDD).',
    method: 'GET',
    path: '/history/coverage',
    pathParams: [],
    input: {},
    example: {},
    requires: 'history',
    run: async (_m, _i, { history }) => ({ coverage: await history.coverage() }),
  },
  {
    id: 'history_underlyings',
    title: 'Historical underlyings',
    description: 'Underlyings that have end-of-day option history.',
    method: 'GET',
    path: '/history/underlyings',
    pathParams: [],
    input: {},
    example: {},
    requires: 'history',
    run: async (_m, _i, { history }) => ({ underlyings: await history.underlyings() }),
  },
  {
    id: 'history_dates',
    title: 'Historical snapshot days',
    description:
      'End-of-day snapshot days (YYYYMMDD, US/Pacific) stored for an underlying, newest first.',
    method: 'GET',
    path: '/history/:underlying/dates',
    pathParams: ['underlying'],
    input: { underlying: symbol },
    example: { underlying: 'SPY' },
    requires: 'history',
    async run(_m, i, { history }) {
      const u = i.underlying as string;
      return { underlying: u, dates: await history.dates(u) };
    },
  },
  {
    id: 'history_expirations',
    title: 'Historical expirations',
    description: 'Expirations (YYYYMMDD, ascending) present in one snapshot day for an underlying.',
    method: 'GET',
    path: '/history/:underlying/expirations',
    pathParams: ['underlying'],
    input: { underlying: symbol, date: day },
    example: { underlying: 'SPY', date: 20260918 },
    requires: 'history',
    async run(_m, i, { history }) {
      const u = i.underlying as string;
      const date = i.date as number;
      return { underlying: u, date, expirations: await history.expirations(u, date) };
    },
  },
  {
    id: 'options_chain_history',
    title: 'Historical option chain',
    description:
      'End-of-day option chain (source: history) for one underlying on one snapshot day: bid/ask/mid, ' +
      'last, volume, openInterest, iv, greeks and dte as of that day; `spot` is the underlying price stored with the snapshot. ' +
      'Without `date`, uses the latest snapshot; without `expiration`, the nearest one on that day. ' +
      '`atmStrike` is the strike nearest spot (put-call parity if spot is missing). The MCP view keeps the 20 strikes nearest atmStrike ' +
      '(REST returns the whole chain); pass strike_min/strike_max to pick a different window.',
    method: 'GET',
    path: '/history/:underlying/chain',
    pathParams: ['underlying'],
    input: {
      underlying: symbol,
      date: day.optional(),
      expiration: expiration.optional(),
      type: z.enum(['call', 'put']).optional(),
      strike_min: z.coerce.number().positive().optional(),
      strike_max: z.coerce.number().positive().optional(),
    },
    example: { underlying: 'SPY', date: 20260918 },
    requires: 'history',
    async run(_m, i, { history }) {
      const chain = await history.chain({
        underlying: i.underlying as string,
        date: i.date as number | undefined,
        expiration: i.expiration as number | undefined,
        type: i.type as 'call' | 'put' | undefined,
        strikeGte: i.strike_min as number | undefined,
        strikeLte: i.strike_max as number | undefined,
      });
      return { ...chain, atmStrike: atmStrike(chain.quotes, chain.spot?.last ?? null) };
    },
    mcpView(result) {
      const chain = result as Awaited<ReturnType<HistoryService['chain']>> & {
        atmStrike: number | null;
      };
      return {
        ...chain,
        expirations: chain.expirations.slice(0, 24),
        quotes: nearestStrikes(chain.quotes, chain.atmStrike, 20).map(compactQuote),
      };
    },
  },
];

export const SERVER_INSTRUCTIONS =
  'EdgeDesk is one suite of three desks. DataEdge (data.edgedesk.app) ingests and curates market data; ' +
  'ResearchEdge (research.edgedesk.app) works on historical data: it backtests playbooks (their variants over any window) and runs experiments on that data; TradeEdge (this ' +
  'server) works on live data: it is where what works becomes live trades, income, hedges and portfolios. Test an idea that ' +
  'needs history in ResearchEdge; an options structure you already trust can go straight into TradeEdge. ' +
  'Strategies are the reusable structures (iron condor, jade lizard, ...): strategy_list shows them with their ' +
  'strike roles and defaults, and strategy_write adds a new one (or replaces one) for every desk user. A strategy ' +
  'has screeners: screener_run builds a strategy on the live chain and ranks concrete trades, and screener_write ' +
  'saves your screener inputs (underlying, DTE window, delta, width, filters) under a strategy, e.g. ' +
  '{strategy: "iron_condor", name: "SPY 30-45 DTE 16Δ", underlying: "SPY", inputs: {dte_min: 30, dte_max: 45, ' +
  'delta: 0.16, width: 5}}; screener_run {id} runs it again. A trade is a concrete position: trade_evaluate prices ' +
  'any explicit legs, and trade_write saves one to the TradeEdge board. ' +
  'Conventions: expirations are YYYYMMDD integers; ' +
  'dte = calendar days to expiration (US/Pacific); iv is a decimal (0.18 = 18%); ' +
  'greeks are per share (multiply by 100 for one contract); prices are per share in USD. ' +
  'Same-day (0DTE) contracts have model-implied iv/greeks (greeksSource: model) or none — pass min_dte: 1 to options_chain ' +
  'to skip them. Start with underlying_quote for spot, then options_expirations, then options_chain. ' +
  'Screener dollar figures are per 1 structure ' +
  '(options ×100); net_premium > 0 is a credit; pop / expected_value are model estimates at the front expiry. ' +
  'Historical end-of-day chains (when available): history_coverage lists what is stored, history_dates the snapshot days, ' +
  'then options_chain_history for one day + expiration (with iv, greeks and open interest). ' +
  'Your holdings: portfolio_list and portfolio_read. Accounts come two ways. Brokers SnapTrade ' +
  'reaches (Fidelity, IBKR, Robinhood, tastytrade, ...) sync from SnapTrade with your own free ' +
  'Personal key: integration_write {provider: "snaptrade", client_id, consumer_key} stores it, ' +
  'integration_list shows the linked brokers and accounts, integration_sync pulls them now, and ' +
  'snaptrade_account_write includes or leaves out an account or sets its tax type. A person links ' +
  'each broker in the app (Settings > Integrations); a synced account (source snaptrade) is never ' +
  "written by hand. For a broker SnapTrade can't reach (SoFi), keep a manual account: " +
  'portfolio_write (replaces the whole snapshot), portfolio_transaction_write and ' +
  'portfolio_lot_write (its tax lots); adding one for a broker SnapTrade supports is refused. ' +
  'integration_write {provider: "alpaca", key_id, secret_key} makes live quotes and chains use ' +
  'your own Alpaca key. ' +
  'Track margin cash per account as a position: underlying "MARGIN-CASH", quantity = minus the ' +
  'margin borrowed in USD, avg_cost 1, e.g. {underlying: "MARGIN-CASH", quantity: -12500, avg_cost: 1}; ' +
  'it is always priced at $1, so its value is the debt and it never shows a gain or loss. ' +
  'Tag holdings two ways. A sector belongs to a ticker, shared by every account and option on it: ' +
  'sector_write {sectors: {"TQQQ": "Technology"}}. A basket belongs to a holding, e.g. the positions ' +
  'one strategy holds: basket_write {basket: "9-sig", symbols: ["TQQQ", "GLDM"]} (add portfolio_id ' +
  'for one account only). portfolio_read shows both on each position. People edit the same Sector ' +
  'and Basket cells in the app. ' +
  'Views: custom_view_* saves how a holdings or transactions page looks, the same settings ' +
  "as the app's Edit view dialog: shape (table, group or pivot), columns, chips (a text field as a " +
  'badge in its own column, or inline on the Symbol), the group and filters it opens with, formula ' +
  'columns (e.g. market_value / group_sum("market_value") * 100) and summary tiles. Use one when a ' +
  'person wants a lasting table, e.g. options only grouped by basket; custom_view_write explains ' +
  'every part with an example and lists the field keys. ' +
  'The market-data and screener tools are also REST endpoints: ' +
  'see https://trade.edgedesk.app/api/openapi.json (sign-in required).';
