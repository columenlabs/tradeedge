import { StrategyShell } from '@/components/app-shell';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';

const DEFAULT_SYMBOL = 'SPY';
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
    throw redirect({ to: '/trades/$symbol', params: { symbol: DEFAULT_SYMBOL } });
  },
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

const portfolioView = createRoute({
  getParentRoute: () => root,
  path: '/portfolio/views/$domain/$id',
  component: lazyRouteComponent(() => import('@/routes/portfolio'), 'PortfolioViewPage'),
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

const routeTree = root.addChildren([
  index,
  board,
  trade,
  chain,
  screenerSymbol,
  screener,
  portfolio,
  portfolioTransactions,
  portfolioTaxLots,
  portfolioView,
  logs,
  logView,
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
