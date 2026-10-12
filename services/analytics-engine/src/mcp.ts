/**
 * MCP over Streamable HTTP at `/mcp`. Stateless: one server + transport per
 * request, so it scales horizontally with no session affinity.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity, AccessVerifier } from './access';
import {
  type Integrations,
  alpacaKeyShape,
  snaptradeAccountShape,
  snaptradeKeyShape,
  xShape,
} from './desks/tradeedge/integrations';
import {
  type Portfolios,
  lotCostWriteShape,
  lotWriteShape,
  portfolioIdSchema,
  portfolioOwner,
  portfolioWriteShape,
  transactionDeleteShape,
  transactionListShape,
  transactionWriteShape,
} from './desks/tradeedge/portfolio';
import { type Posts, postListShape } from './desks/tradeedge/posts';
import { type Screeners, screenerIdSchema, screenerWriteShape } from './desks/tradeedge/screeners';
import {
  type Strategies,
  strategyIdSchema,
  strategyWriteShape,
} from './desks/tradeedge/strategies';
import {
  type SymbolFactsService,
  symbolFieldDocs,
  symbolReadShape,
} from './desks/tradeedge/symbols';
import {
  type HoldingTags,
  basketWriteShape,
  sectorWriteShape,
  tagsOf,
} from './desks/tradeedge/tags';
import { type Trades, tradeIdSchema, tradeWriteShape } from './desks/tradeedge/trades';
import { type Watchlist, watchSymbolSchema } from './desks/tradeedge/watchlist';
import {
  type Feedback,
  feedbackOwner,
  registerFeedbackTools,
  withFeedbackFooter,
} from './feedback';
import { HistoryService } from './history';
import type { MarketService } from './market';
import { OPERATIONS, type OpContext, SERVER_INSTRUCTIONS } from './operations';
import { type RateLimiter, rateLimited } from './ratelimit';
import { currentStats } from './telemetry';
import { registerCustomViewTools } from './views/custom-views';
import { type CustomViews, customViewOwner } from './views/store';

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});

/** One MCP tool per registry operation (see operations.ts) whose backing service is configured. */
export function buildMcpServer(
  market: MarketService,
  ctx: OpContext = { history: new HistoryService(null) },
  mine?: McpMine,
  feedback?: { feedback: Feedback; owner: string },
  customViews?: { views: CustomViews; owner: string },
): McpServer {
  const server = new McpServer(
    { name: 'tradeedge', version: '0.4.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  if (feedback) withFeedbackFooter(server, feedback.feedback, feedback.owner);
  const opCtx: OpContext = { ...ctx, owner: mine?.owner };
  for (const op of OPERATIONS) {
    if (op.requires === 'history' && !ctx.history.available) continue;
    if (op.requires === 'strategies' && !ctx.strategies) continue;
    server.registerTool(
      op.id,
      { title: op.title, description: op.description, inputSchema: op.input },
      async (input: Record<string, unknown>) => {
        const result = await op.run(market, input, opCtx);
        return json(op.mcpView ? op.mcpView(result) : result);
      },
    );
  }
  if (mine?.portfolios) registerPortfolioTools(server, mine.portfolios, mine.owner, mine.tags);
  if (mine?.integrations) registerIntegrationTools(server, mine.integrations, mine.owner);
  if (ctx.strategies && mine) registerStrategyTools(server, ctx.strategies, mine.owner);
  if (ctx.screeners && mine) registerScreenerTools(server, ctx.screeners, mine.owner);
  if (mine?.trades) registerTradeTools(server, mine.trades, mine.owner);
  if (mine?.watchlist) registerWatchlistTools(server, mine.watchlist, mine.owner);
  if (mine?.tags) registerTagTools(server, mine.tags, mine.owner);
  if (mine?.symbols) registerSymbolTools(server, mine.symbols, mine.owner);
  if (mine?.posts) registerPostTools(server, mine.posts, mine.owner);
  if (feedback) registerFeedbackTools(server, feedback.feedback, feedback.owner, 'trade');
  if (customViews) registerCustomViewTools(server, customViews.views, customViews.owner, 'trade');
  return server;
}

/** The caller's own TradeEdge data: every tool reads and writes only `owner`'s rows. */
export interface McpMine {
  owner: string;
  portfolios?: Portfolios;
  integrations?: Integrations;
  trades?: Trades;
  watchlist?: Watchlist;
  tags?: HoldingTags;
  symbols?: SymbolFactsService;
  posts?: Posts;
}

function registerPostTools(server: McpServer, posts: Posts, owner: string) {
  server.registerTool(
    'post_list',
    {
      title: 'X posts',
      description:
        'Posts by the X accounts you track (Settings > Integrations > X), newest first, each tagged ' +
        'with symbols (tickers it is about), a macro theme with theme_conf, and sentiment from -1 ' +
        '(very bearish) to +1 (very bullish) with sentiment_conf; null where it was not tagged. ' +
        'Checked every 2 min in market hours and every 4 h outside (Schedules in the app). Filter ' +
        'by symbol, handle or theme; hours looks back (24 by default). Returns {store, posts}: ' +
        'store d1 keeps 30 days, dataedge keeps them for good.',
      inputSchema: postListShape,
    },
    async (q) => json({ store: posts.store, posts: await posts.list(owner, q) }),
  );
}

const SYMBOL_READ_DOC =
  'Facts about tickers that views show as symbol fields, by field key. Robinhood fields are ' +
  "read live with the person's Robinhood sign-in (Settings > Integrations; without it they are " +
  'missing and robinhood.state is not_connected), held five minutes, never saved; DataEdge ' +
  'fields (trailing P/E history, technicals at the last close) come from market data. Funds ' +
  'and ETFs have no P/E or analysts. earnings_next starting with ~ is a date not yet ' +
  'confirmed. Up to 1000 symbols; an option is looked up by its underlying.';

function registerSymbolTools(server: McpServer, symbols: SymbolFactsService, owner: string) {
  server.registerTool(
    'symbol_read',
    {
      title: 'Symbol fields',
      description: `${SYMBOL_READ_DOC} Fields: ${symbolFieldDocs}.`,
      inputSchema: symbolReadShape,
    },
    async (input) => json(await symbols.read(owner, input.symbols)),
  );
}

function registerTagTools(server: McpServer, tags: HoldingTags, owner: string) {
  server.registerTool(
    'sector_write',
    {
      title: 'Label or tag tickers with a sector',
      description:
        'Label or tag tickers with a sector (the holdings label per ticker). A sector belongs to the ticker: every holding of it, in every ' +
        'account, and every option on it shows the same sector. Use it to sort holdings by industry ' +
        'or theme. Several tickers in one call; null clears one. Example: {sectors: {"TQQQ": ' +
        '"Technology", "GLDM": "Gold"}}. portfolio_read shows each position\'s sector; views group ' +
        'and filter by the `sector` field. Returns every sector and basket.',
      inputSchema: sectorWriteShape,
    },
    async ({ sectors }) => json(await tags.setSectors(owner, sectors)),
  );
  server.registerTool(
    'basket_write',
    {
      title: 'Label or tag holdings with a basket',
      description:
        'Label or tag holdings with a basket (the holdings label per position). Put holdings in a basket, e.g. the positions one strategy holds. A basket belongs to a ' +
        'holding: pass tickers (OCC symbols for options) and, to touch one account only, its ' +
        'portfolio_id; without it every account holding the symbols gets the basket. null takes ' +
        'them out. Example: {basket: "9-sig", symbols: ["TQQQ", "GLDM"]}. Reuse a name already in ' +
        "use (portfolio_read shows each position's basket). Views group and filter by the " +
        '`basket` field. Returns every sector and basket.',
      inputSchema: basketWriteShape,
    },
    async (w) => json(await tags.setBasket(owner, w)),
  );
}

function registerStrategyTools(server: McpServer, strategies: Strategies, by: string) {
  server.registerTool(
    'strategy_list',
    {
      title: 'Strategies',
      description:
        'Every strategy screener_run builds (shared by all TradeEdge users): id, name, bias, credit/debit, ' +
        'defined/undefined risk, summary, legs with their strike rules, the strike `roles` accepted in ' +
        '`strikes`, expirations (1, or 2 for calendars/diagonals), uses_width and the default delta scan. ' +
        'Call this first when choosing a strategy or passing explicit strikes.',
      inputSchema: {},
    },
    async () => json(await strategies.list()),
  );
  server.registerTool(
    'strategy_read',
    {
      title: 'Read strategy',
      description: 'One strategy with its legs and strike rules.',
      inputSchema: { id: strategyIdSchema },
    },
    async ({ id }) => json(await strategies.read(id)),
  );
  server.registerTool(
    'strategy_write',
    {
      title: 'Write strategy',
      description:
        'Add a strategy for every TradeEdge user, or replace the one with this id; screener_run can build ' +
        'it straight away. Each option leg has a role (except a `same` leg) and a strike rule: ' +
        '{pick:{delta:0.16},knob:"delta"} picks by abs delta (the screener’s delta / otm_pct override it), ' +
        '{pick:{atm:true},knob:"none"} takes the ATM strike, knob "long_delta" lets long_delta override; ' +
        '{wing:"short_put",dir:"down"} sits `width` dollars past that role; {same:"strike"} reuses that ' +
        'role’s strike (with expiry "back" for calendars). A stock leg is {action, instrument:"stock", qty}. ' +
        'strike_order lists role pairs whose strikes must rise. Read iron_condor with strategy_read for a ' +
        'worked example. Put when to use it and which knob moves which leg in summary.',
      inputSchema: strategyWriteShape,
    },
    async (input) => json(await strategies.write(input, by)),
  );
  server.registerTool(
    'strategy_delete',
    {
      title: 'Delete strategy',
      description:
        'Delete a strategy for every TradeEdge user, with every screener saved under it. Saved trades ' +
        'keep their legs.',
      inputSchema: { id: strategyIdSchema },
    },
    async ({ id }) => {
      await strategies.delete(id);
      return json({ ok: true });
    },
  );
}

function registerScreenerTools(server: McpServer, screeners: Screeners, owner: string) {
  server.registerTool(
    'screener_list',
    {
      title: 'Screeners',
      description:
        'Your saved screeners, optionally for one strategy: id, strategy, name, underlying and the ' +
        'screener_run inputs it keeps. Run one with screener_run {id}.',
      inputSchema: { strategy: strategyIdSchema.optional() },
    },
    async ({ strategy }) => json(await screeners.list(owner, strategy)),
  );
  server.registerTool(
    'screener_read',
    {
      title: 'Read screener',
      description: 'One saved screener with its inputs.',
      inputSchema: { id: screenerIdSchema },
    },
    async ({ id }) => json(await screeners.read(owner, id)),
  );
  server.registerTool(
    'screener_write',
    {
      title: 'Write screener',
      description:
        'Save a screener under a strategy so it can be run again with screener_run {id}. It keeps a name, ' +
        'an underlying and the screener_run inputs (expiration or dte_min/dte_max, delta, otm_pct, width, ' +
        'strikes, filters, sort_by, limit). Without id it updates your screener with the same strategy and ' +
        'name, or creates it. Example: {strategy: "iron_condor", name: "SPY 30-45 DTE 16Δ", underlying: ' +
        '"SPY", inputs: {dte_min: 30, dte_max: 45, delta: 0.16, width: 5, sort_by: "pop"}}.',
      inputSchema: screenerWriteShape,
    },
    async (input) => json(await screeners.write(owner, input, 'agent')),
  );
  server.registerTool(
    'screener_delete',
    {
      title: 'Delete screener',
      description: 'Delete one of your saved screeners. Trades saved from its results stay.',
      inputSchema: { id: screenerIdSchema },
    },
    async ({ id }) => {
      await screeners.delete(owner, id);
      return json({ ok: true });
    },
  );
}

function registerTradeTools(server: McpServer, trades: Trades, owner: string) {
  server.registerTool(
    'trade_list',
    {
      title: 'Trades',
      description:
        'Your saved trades, newest first, optionally for one underlying, with their legs and note. ' +
        'For live metrics (P&L, max loss, breakevens, POP, greeks) pass the legs to trade_evaluate.',
      inputSchema: { underlying: z.string().optional() },
    },
    async ({ underlying }) => json(await trades.list(owner, underlying)),
  );
  server.registerTool(
    'trade_read',
    {
      title: 'Read trade',
      description: 'One saved trade with its legs and note.',
      inputSchema: { id: tradeIdSchema },
    },
    async ({ id }) => json(await trades.read(owner, id)),
  );
  server.registerTool(
    'trade_write',
    {
      title: 'Write trade',
      description:
        'Save a trade so it shows on the TradeEdge board next to the others. Without id it updates ' +
        'your trade with the same underlying and name, or creates it. Legs: action buy|sell, ' +
        'instrument call|put|stock, strike + expiration (YYYYMMDD) for options, qty, and price (entry per ' +
        'share; take it from trade_evaluate, screener_run or the chain), with bid and ask when you have ' +
        'them so the fill lever can price mid to natural. Put the thesis and exits in note.',
      inputSchema: tradeWriteShape,
    },
    async (input) => json(await trades.write(owner, input, 'agent')),
  );
  server.registerTool(
    'trade_delete',
    {
      title: 'Delete trade',
      description: 'Delete one of your saved trades.',
      inputSchema: { id: tradeIdSchema },
    },
    async ({ id }) => {
      await trades.delete(owner, id);
      return json({ ok: true });
    },
  );
}

function registerWatchlistTools(server: McpServer, watchlist: Watchlist, owner: string) {
  server.registerTool(
    'watchlist_list',
    {
      title: 'Watchlist',
      description: 'Underlyings on your live-chain watchlist, in the order they were added.',
      inputSchema: {},
    },
    async () => json(await watchlist.list(owner)),
  );
  server.registerTool(
    'watchlist_write',
    {
      title: 'Add to watchlist',
      description: 'Add underlyings to your watchlist. Ones already on it stay as they are.',
      inputSchema: { symbols: z.array(watchSymbolSchema).min(1).max(100) },
    },
    async ({ symbols }) => json(await watchlist.add(owner, symbols)),
  );
  server.registerTool(
    'watchlist_delete',
    {
      title: 'Remove from watchlist',
      description: 'Remove one underlying from your watchlist.',
      inputSchema: { symbol: watchSymbolSchema },
    },
    async ({ symbol }) => json(await watchlist.remove(owner, symbol)),
  );
}

function registerPortfolioTools(
  server: McpServer,
  portfolios: Portfolios,
  owner: string,
  tags?: HoldingTags,
) {
  server.registerTool(
    'portfolio_list',
    {
      title: 'Portfolios',
      description:
        'Your portfolios (one per brokerage account): id, name, tax_type (taxable or retirement), ' +
        'broker, source (snaptrade: synced from the broker, read-only; manual: a broker SnapTrade ' +
        "can't reach), cash (USD), as_of and how many positions each holds.",
      inputSchema: {},
    },
    async () => json(await portfolios.list(owner)),
  );
  server.registerTool(
    'portfolio_read',
    {
      title: 'Read portfolio',
      description:
        'One portfolio with every position. symbol is the ticker for stock and the OCC symbol for an ' +
        'option; quantity is shares or contracts, negative when short; avg_cost is per share in USD. ' +
        'lots are the open tax lots. Each holding takes its lots from one source, named on every ' +
        "lot as source: snaptrade (the broker's, synced), manual (portfolio_lot_write, manual " +
        'accounts) or, when neither has lots for it, derived (first-in first-out from its buys, ' +
        'sells and transfers). A lot is long or short as its holding is. A lot whose cost is not its own carries cost_from: yours ' +
        "(portfolio_lot_cost_write), transaction (that day's transaction price), estimate (the close on " +
        'the acquired day, because the broker sent 0: set the exact cost with portfolio_lot_cost_write) ' +
        'or missing (cost 0, no price found). A position the broker sent without avg_cost takes its ' +
        "lots' average (avg_cost_from lots). realized_ytd is this year's closed gain, with sold (this " +
        "year's proceeds) and no_cost (the proceeds whose gain is unknown, so the total is partial). " +
        'closed_lots lists every lot closed so far (first-in first-out from the buys, sells and ' +
        'transfers: acquired, closed, quantity, cost, proceeds, gain, term). Every share sits in one ' +
        'lot: the rows of a stock are anchored to what is held now, and shares no row explains (bought ' +
        'before the history starts) form one lot with before_history true, acquired on the first row. ' +
        'cost and gain are null for shares with no cost on record (transferred in, or before the ' +
        'history) until you set one with portfolio_lot_cost_write (that acquired day, no quantity). ' +
        'Lots are first-in first-out: wash sales are not applied. checks, for every symbol held or ' +
        'sold: kind quantity when the open lots do not add up to what is held (held, in_lots, source); ' +
        'kind cost when no_cost shares, open or sold, have no cost on record. Money market funds ' +
        '(FDRXX, SPAXX) are cash and have no lots. dividends lists, per symbol, the dividends paid ' +
        '(total on record, ytd this year). For a quantity check in a manual account, send the missing ' +
        'lots; in a SnapTrade account, run integration_sync. cash is signed: negative is margin ' +
        'borrowed in that account. Each position carries its sector (set ' +
        'with sector_write) and basket (set with basket_write), null when unset.',
      inputSchema: { id: portfolioIdSchema },
    },
    async ({ id }) => {
      const p = await portfolios.read(owner, id);
      if (!tags) return json(p);
      const set = await tags.list(owner);
      return json({
        ...p,
        positions: p.positions.map((x) => ({ ...x, ...tagsOf(set, { ...x, portfolio_id: id }) })),
      });
    },
  );
  server.registerTool(
    'portfolio_write',
    {
      title: 'Write portfolio',
      description:
        'Manual accounts only (a broker SnapTrade cannot reach, e.g. SoFi): replace the account with ' +
        'a full snapshot: cash, as_of and every position (positions left out are removed). Without id ' +
        'it updates your portfolio of that name, or creates it; a new account needs broker, and a ' +
        'broker SnapTrade supports is refused (link it in the app instead). A synced account ' +
        '(source snaptrade) is refused: it changes only through integration_sync. Stock: ' +
        'underlying + quantity. Option: also expiration (YYYYMMDD), strike and right (C or P). ' +
        'Transactions are kept; send them with portfolio_transaction_write. cash is the USD balance, ' +
        'signed: negative is margin borrowed, e.g. cash: -12500 for $12,500 borrowed.',
      inputSchema: portfolioWriteShape,
    },
    async (input) => json(await portfolios.write(owner, input)),
  );
  server.registerTool(
    'portfolio_transaction_list',
    {
      title: 'Portfolio transactions',
      description:
        'Transactions in one portfolio, newest first. Filter by symbol (ticker or OCC symbol) and date range.',
      inputSchema: transactionListShape,
    },
    async (q) => json(await portfolios.listTransactions(owner, q)),
  );
  server.registerTool(
    'portfolio_transaction_write',
    {
      title: 'Write portfolio transactions',
      description:
        "Manual accounts only: upload transactions, up to 1000 per call. Each needs the broker's id: sending a " +
        'row with an id already stored updates it, so uploading the same export twice is safe. kind is ' +
        'buy, sell, dividend, interest, fee, deposit, withdrawal or other (with description); buys and sells need underlying, ' +
        'quantity (positive) and price, plus expiration, strike and right for an option. amount is the ' +
        'cash effect in USD. Returns how many rows were inserted and updated.',
      inputSchema: transactionWriteShape,
    },
    async ({ portfolio_id, transactions }) =>
      json(await portfolios.writeTransactions(owner, portfolio_id, transactions)),
  );
  server.registerTool(
    'portfolio_transaction_delete',
    {
      title: 'Delete portfolio transactions',
      description: "Manual accounts only: delete transactions by the broker's ids.",
      inputSchema: transactionDeleteShape,
    },
    async ({ portfolio_id, ids }) => {
      await portfolios.deleteTransactions(owner, portfolio_id, ids);
      return json({ ok: true });
    },
  );
  server.registerTool(
    'portfolio_lot_write',
    {
      title: 'Write tax lots',
      description:
        "Manual accounts only: replace the account's open tax lots with this full list (an empty " +
        'list goes back to lots worked out from the transactions). Each lot: underlying (plus ' +
        'expiration, strike and right for an option), acquired (YYYY-MM-DD), quantity (negative ' +
        'when short) and cost per share in USD, fees included. Example, a fund bought without a ' +
        'cost basis on record: {portfolio_id, lots: [{underlying: "ARKVX", acquired: "2024-03-14", ' +
        'quantity: 812.4, cost: 24.1}]}. Returns the account as portfolio_read does.',
      inputSchema: lotWriteShape,
    },
    async ({ portfolio_id, lots }) => json(await portfolios.writeLots(owner, portfolio_id, lots)),
  );
  server.registerTool(
    'portfolio_lot_cost_write',
    {
      title: 'Set a lot cost or term',
      description:
        "Any account, SnapTrade's too: set the exact cost per share of one stock's lots acquired on " +
        'one day. Use it where portfolio_read shows a lot with cost_from estimate (the close that day, ' +
        'because the broker sent cost 0, as brokers often do for RSU, ESPP or transferred-in shares) ' +
        'or missing (no cost at all). For RSUs the cost is the value per share on the vest day, on the ' +
        "employer's stock plan statement or W-2. quantity picks one lot when several share a day; " +
        "cost null clears yours. term (short or long) sets the lot's term by hand, for a derived or " +
        'manual lot whose date misses the real holding period; null clears it, and either field left ' +
        'out keeps what was set. Both outrank the broker and survive syncs. Example: ' +
        '{portfolio_id, underlying: "AMZN", acquired: "2025-05-21", cost: 201.12}. Returns the ' +
        'account as portfolio_read does.',
      inputSchema: lotCostWriteShape,
    },
    async (input) => json(await portfolios.writeLotCost(owner, input)),
  );
  server.registerTool(
    'portfolio_delete',
    {
      title: 'Delete portfolio',
      description:
        'Delete one of your portfolios with its positions, transactions and lots. A SnapTrade ' +
        'account comes back on the next sync unless you leave it out first (snaptrade_account_write ' +
        '{import: false}, which also removes it).',
      inputSchema: { id: portfolioIdSchema },
    },
    async ({ id }) => {
      await portfolios.delete(owner, id);
      return json({ ok: true });
    },
  );
}

function registerIntegrationTools(server: McpServer, integrations: Integrations, owner: string) {
  server.registerTool(
    'integration_list',
    {
      title: 'Integrations',
      description:
        'Your integrations (Settings > Integrations in the app). snaptrade: connected, client_id, ' +
        'the consumer key masked, webhook_url (paste it into SnapTrade under Webhooks so changes ' +
        'sync at once), last_sync (counts, skipped positions, errors), last_event, and brokers read ' +
        'live from SnapTrade: each with broken (its login needs signing in again, in the app) and ' +
        'its accounts: id, name, number, import (false = left out of Holdings), tax_type, ' +
        'portfolio_id once synced, trading {via: snaptrade | robinhood | null (read-only), note} and ' +
        'trade (the person lets TradeEdge send orders there; set in the app only). alpaca: connected and the key id masked. ' +
        'x: connected, the twitterapi.io key masked, handles (tracked accounts), credit {usd, paid, ' +
        'bonus} at the last test, last_check {at, ok, posts, error}. robinhood: connected ' +
        '(signed in from the app, Settings > Integrations), connected_at and last_test: the Agentic ' +
        "account masked and approvals (true = each order waits for the person's tap in Robinhood's app).",
      inputSchema: {},
    },
    async () => json(await integrations.status(owner)),
  );
  server.registerTool(
    'integration_write',
    {
      title: 'Connect an integration',
      description:
        'Store your own key for an integration, checked with the service first. snaptrade: your ' +
        'free SnapTrade Personal key, {provider: "snaptrade", client_id, consumer_key} (create it at ' +
        'dashboard.snaptrade.com after turning on two-factor sign-in). Brokers are then linked by a ' +
        'person in the app (Settings > Brokers and accounts > Add broker), never here. alpaca: ' +
        '{provider: "alpaca", key_id, secret_key}; live quotes and option chains then use your key ' +
        'instead of EdgeDesk\'s. x: {provider: "x", api_key?, handles?}: your twitterapi.io key ' +
        '(you pay twitterapi.io directly) and/or the X accounts to track (replaces the list); ' +
        'posts then show in post_list. Returns integration_list.',
      inputSchema: {
        provider: z.enum(['snaptrade', 'alpaca', 'x']),
        api_key: xShape.api_key,
        handles: xShape.handles,
        client_id: snaptradeKeyShape.client_id.optional(),
        consumer_key: snaptradeKeyShape.consumer_key.optional(),
        key_id: alpacaKeyShape.key_id.optional(),
        secret_key: alpacaKeyShape.secret_key.optional(),
      },
    },
    async (input) => {
      if (input.provider === 'x')
        return json(
          await integrations.saveX(owner, { api_key: input.api_key, handles: input.handles }),
        );
      if (input.provider === 'snaptrade') {
        if (!input.client_id || !input.consumer_key)
          throw new Error('snaptrade needs client_id and consumer_key');
        return json(
          await integrations.saveSnapTrade(owner, {
            client_id: input.client_id,
            consumer_key: input.consumer_key,
          }),
        );
      }
      if (!input.key_id || !input.secret_key) throw new Error('alpaca needs key_id and secret_key');
      return json(
        await integrations.saveAlpaca(owner, {
          key_id: input.key_id,
          secret_key: input.secret_key,
        }),
      );
    },
  );
  server.registerTool(
    'integration_delete',
    {
      title: 'Disconnect an integration',
      description:
        'Delete your key for an integration. snaptrade: syncing stops; accounts already synced stay ' +
        "in Holdings. alpaca: live data goes back to EdgeDesk's key. robinhood: its sign-in is " +
        'deleted; connecting again is done in the app. x: the key and tracked accounts are ' +
        'deleted and checks stop.',
      inputSchema: { provider: z.enum(['snaptrade', 'alpaca', 'robinhood', 'x']) },
    },
    async ({ provider }) => {
      if (provider === 'x') await integrations.deleteX(owner);
      else if (provider === 'snaptrade') await integrations.deleteSnapTrade(owner);
      else if (provider === 'alpaca') await integrations.deleteAlpaca(owner);
      else await integrations.deleteRobinhood(owner);
      return json({ ok: true });
    },
  );
  server.registerTool(
    'integration_sync',
    {
      title: 'Sync SnapTrade',
      description:
        'Pull every included SnapTrade account into Holdings now: positions, cash (negative is ' +
        "margin borrowed), the broker's tax lots and transactions. SnapTrade itself " +
        'refreshes from the brokers about once a day, and its webhook syncs on each change. Returns ' +
        'the counts, positions Holdings cannot hold (bonds, futures) and any errors.',
      inputSchema: {},
    },
    async () => json(await integrations.sync(owner)),
  );
  server.registerTool(
    'snaptrade_account_write',
    {
      title: 'Include a SnapTrade account',
      description:
        'Include a SnapTrade account in Holdings or leave it out (import false also removes the ' +
        'synced account), and set its tax type (taxable or retirement; first guessed from the ' +
        "account's name), or rename it (name; null goes back to the broker's name). account_id " +
        'comes from integration_list. Returns integration_list.',
      inputSchema: snaptradeAccountShape,
    },
    async (input) => json(await integrations.setAccount(owner, input)),
  );
}

export interface McpAuth {
  /** Local/dev only: static bearer token. */
  token?: string | null;
  /** Prod: Cloudflare Access (Managed OAuth) JWT verifier. */
  access?: AccessVerifier | null;
  limiter?: RateLimiter;
  /** TradeEdge tools, scoped to the signed-in caller. Each omitted store → its tools not registered. */
  portfolios?: Portfolios;
  /** integration_* tools, and the caller's own Alpaca key for live data. */
  integrations?: Integrations;
  trades?: Trades;
  watchlist?: Watchlist;
  tags?: HoldingTags;
  /** Feedback tools and the reply footer, scoped to the signed-in caller. Omitted → not registered. */
  feedback?: Feedback;
  /** custom_view_* tools, scoped to the signed-in caller. Omitted → not registered. */
  customViews?: CustomViews;
  /** symbol_read. Omitted → not registered. */
  symbols?: SymbolFactsService;
  /** post_list. Omitted → not registered. */
  posts?: Posts;
}

export function mcpRoutes(market: MarketService, auth: McpAuth = {}, ctx?: OpContext) {
  const mcp = new Hono<{ Variables: { identity?: AccessIdentity } }>();
  const { token, access } = auth;

  if (access) {
    mcp.use('*', async (c, next) => {
      const identity = await access.verify(c.req.header('cf-access-jwt-assertion'));
      if (!identity) return c.json({ error: 'unauthorized' }, 401);
      const limited = await rateLimited(auth.limiter, `sub:${identity.sub}`);
      if (limited) return limited;
      c.set('identity', identity);
      await next();
    });
  }

  if (token) {
    mcp.use('*', async (c, next) => {
      if (c.req.header('authorization') !== `Bearer ${token}`) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      await next();
    });
  }

  mcp.all('/', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const owner = portfolioOwner(c.get('identity'));
    const mine = {
      owner,
      portfolios: auth.portfolios,
      integrations: auth.integrations,
      trades: auth.trades,
      watchlist: auth.watchlist,
      tags: auth.tags,
      symbols: auth.symbols,
      posts: auth.posts,
    };
    const feedback = auth.feedback
      ? { feedback: auth.feedback, owner: feedbackOwner(c.get('identity')) }
      : undefined;
    const server = buildMcpServer(
      auth.integrations ? await auth.integrations.marketFor(owner) : market,
      ctx,
      mine,
      feedback,
      auth.customViews
        ? { views: auth.customViews, owner: customViewOwner(c.get('identity')) }
        : undefined,
    );
    await server.connect(transport);
    try {
      const body = (await c.req.raw
        .clone()
        .json()
        .catch(() => undefined)) as { method?: string; params?: { name?: string } } | undefined;
      const stats = currentStats();
      if (stats && body && !Array.isArray(body)) {
        stats.rpc = body.method;
        stats.tool = body.params?.name;
      }
      return await transport.handleRequest(
        c.req.raw,
        body === undefined ? undefined : { parsedBody: body },
      );
    } finally {
      // JSON-response mode has fully resolved by now.
      void server.close();
    }
  });

  return mcp;
}
