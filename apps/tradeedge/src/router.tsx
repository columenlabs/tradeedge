import { StrategyShell } from '@/components/app-shell';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';

const expOf = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 19000101 && n < 21000101 ? n : undefined;
};

/** Strikes shown around the money on the chain page. */
export const STRIKE_COUNTS = [10, 20, 40] as const;
const strikesOf = (v: unknown) => {
  const n = Number(v);
  return (STRIKE_COUNTS as readonly number[]).includes(n) ? n : undefined;
};

const root = createRootRoute({ component: StrategyShell });

const index = createRoute({
  getParentRoute: () => root,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/dashboard' });
  },
});

// Dashboard (Bikram, 2026-10-12): the TradeEdge home page; its first tab is Calendar.
const dashboard = createRoute({
  getParentRoute: () => root,
  path: '/dashboard',
  component: lazyRouteComponent(() => import('@/routes/dashboard'), 'DashboardPage'),
});

const board = createRoute({
  getParentRoute: () => root,
  path: '/trades/$symbol',
  component: lazyRouteComponent(() => import('@/routes/board'), 'BoardPage'),
});

const trade = createRoute({
  getParentRoute: () => root,
  path: '/trades/$symbol/$id',
  component: lazyRouteComponent(() => import('@/routes/trade'), 'TradePage'),
});

const chain = createRoute({
  getParentRoute: () => root,
  path: '/chain/$symbol',
  validateSearch: (s: Record<string, unknown>): { exp?: number; strikes?: number } => ({
    exp: expOf(s.exp),
    strikes: strikesOf(s.strikes),
  }),
  component: lazyRouteComponent(() => import('@/routes/chain'), 'ChainPage'),
});

const screenerSymbol = createRoute({
  getParentRoute: () => root,
  path: '/screeners/$symbol',
  component: lazyRouteComponent(() => import('@/routes/screeners'), 'ScreenerSymbolPage'),
});

const screener = createRoute({
  getParentRoute: () => root,
  path: '/screeners/$symbol/$id',
  component: lazyRouteComponent(() => import('@/routes/screeners'), 'ScreenerPage'),
});

const portfolio = createRoute({
  getParentRoute: () => root,
  path: '/portfolio',
  component: lazyRouteComponent(() => import('@/routes/portfolio'), 'AllAccountsPage'),
});

const portfolioPerformance = createRoute({
  getParentRoute: () => root,
  path: '/portfolio/performance',
  component: lazyRouteComponent(() => import('@/routes/performance'), 'PerformancePage'),
});

const portfolioTransactions = createRoute({
  getParentRoute: () => root,
  path: '/portfolio/transactions',
  component: lazyRouteComponent(() => import('@/routes/portfolio'), 'TransactionsPage'),
});

const portfolioTaxLots = createRoute({
  getParentRoute: () => root,
  path: '/portfolio/tax-lots',
  // `?show=open|closed` opens it on those lots (the Realized YTD tile links to the closed ones).
  validateSearch: (s: Record<string, unknown>): { show?: 'open' | 'closed' } =>
    s.show === 'open' || s.show === 'closed' ? { show: s.show } : {},
  component: lazyRouteComponent(() => import('@/routes/portfolio'), 'TaxLotsPage'),
});

const portfolioAccounts = createRoute({
  getParentRoute: () => root,
  path: '/portfolio/accounts',
  component: lazyRouteComponent(() => import('@/routes/portfolio'), 'AccountsPage'),
});

// Symbols (Bikram, 2026-10-12): stock screens, views over your symbols.
const symbols = createRoute({
  getParentRoute: () => root,
  path: '/symbols',
  component: lazyRouteComponent(() => import('@/routes/portfolio'), 'SymbolsPage'),
});

const symbolView = createRoute({
  getParentRoute: () => root,
  path: '/symbols/views/$id',
  component: lazyRouteComponent(() => import('@/routes/portfolio'), 'SymbolViewPage'),
});

const portfolioView = createRoute({
  getParentRoute: () => root,
  path: '/portfolio/views/$domain/$id',
  component: lazyRouteComponent(() => import('@/routes/portfolio'), 'PortfolioViewPage'),
});

// Autopilot (Bikram, 2026-10-12): baskets with sleeves, and the orders they propose.
const autopilot = createRoute({
  getParentRoute: () => root,
  path: '/autopilot',
  component: lazyRouteComponent(() => import('@/routes/autopilot'), 'AutopilotPage'),
});

const basketNew = createRoute({
  getParentRoute: () => root,
  path: '/baskets/new',
  component: lazyRouteComponent(() => import('@/routes/autopilot'), 'NewBasketPage'),
});

const basket = createRoute({
  getParentRoute: () => root,
  path: '/baskets/$id',
  component: lazyRouteComponent(() => import('@/routes/autopilot'), 'BasketPage'),
});

const basketEdit = createRoute({
  getParentRoute: () => root,
  path: '/baskets/$id/edit',
  component: lazyRouteComponent(() => import('@/routes/autopilot'), 'EditBasketPage'),
});

const ordersQueue = createRoute({
  getParentRoute: () => root,
  path: '/orders/queue',
  component: lazyRouteComponent(() => import('@/routes/autopilot'), 'QueuePage'),
});

const ordersToPlace = createRoute({
  getParentRoute: () => root,
  path: '/orders/to-place',
  component: lazyRouteComponent(() => import('@/routes/autopilot'), 'ToPlacePage'),
});

const ordersHistory = createRoute({
  getParentRoute: () => root,
  path: '/orders/history',
  // `?show=all` lists every order; else the last 30 days' fills.
  validateSearch: (s: Record<string, unknown>): { show?: 'all' } =>
    s.show === 'all' ? { show: 'all' } : {},
  component: lazyRouteComponent(() => import('@/routes/autopilot'), 'HistoryPage'),
});

const logs = createRoute({
  getParentRoute: () => root,
  path: '/logs',
  component: lazyRouteComponent(() => import('@/routes/logs'), 'LogsPage'),
});

const logView = createRoute({
  getParentRoute: () => root,
  path: '/logs/views/$id',
  component: lazyRouteComponent(() => import('@/routes/logs'), 'LogViewPage'),
});

const postsView = createRoute({
  getParentRoute: () => root,
  path: '/posts/$id',
  component: lazyRouteComponent(() => import('@/routes/posts'), 'PostsAppViewPage'),
});

const postView = createRoute({
  getParentRoute: () => root,
  path: '/posts/views/$domain/$id',
  component: lazyRouteComponent(() => import('@/routes/posts'), 'PostViewPage'),
});

const schedules = createRoute({
  getParentRoute: () => root,
  path: '/schedules',
  component: lazyRouteComponent(() => import('@/routes/schedules'), 'SchedulesPage'),
});

const routeTree = root.addChildren([
  index,
  dashboard,
  board,
  trade,
  chain,
  screenerSymbol,
  screener,
  portfolio,
  portfolioPerformance,
  portfolioTransactions,
  portfolioTaxLots,
  portfolioAccounts,
  portfolioView,
  symbols,
  symbolView,
  autopilot,
  basketNew,
  basket,
  basketEdit,
  ordersQueue,
  ordersToPlace,
  ordersHistory,
  logs,
  logView,
  postsView,
  postView,
  schedules,
]);

export const router = createRouter({
  routeTree,
  basepath: '/app',
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
