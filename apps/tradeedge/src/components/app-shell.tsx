import { INTEGRATION_SETTINGS, SyncStatus } from '@/components/integrations';
import { NewTradeProvider, useNewTrade } from '@/components/new-trade';
import {
  type AnyQuote,
  PORTFOLIO_DOMAINS,
  type PortfolioDomain,
  type PostDomain,
  addToWatchlist,
  autopilotQuery,
  deleteLogView,
  deletePortfolioView,
  deletePostView,
  integrationsQuery,
  logViewPath,
  logViewsQuery,
  portfolioViewPath,
  portfolioViewsQuery,
  postViewPath,
  postViewsQuery,
  quotesQuery,
  removeFromWatchlist,
  savePortfolioView,
  savePostView,
  screenersQuery,
  watchlistQuery,
} from '@/lib/api';
import { signedPct, tone } from '@/lib/format';
import { useTradeGroups } from '@/lib/use-trades';
import { cn } from '@/lib/utils';
import { AppShell, NavGroup, SidebarSection, viewIcon } from '@edgedesk/app-shell';
import { Button } from '@edgedesk/app-shell/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@edgedesk/app-shell/ui/dialog';
import { Input } from '@edgedesk/app-shell/ui/input';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Bot,
  Briefcase,
  Grid3x3,
  Hand,
  History,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  ListFilter,
  ListTree,
  type LucideIcon,
  PenLine,
  Plus,
  ShoppingBasket,
  Table2,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';

/** Trades grouped by underlying: a count, and each trade with its chart colour. */
function TradesSection() {
  const { groups, isPending } = useTradeGroups();
  const { open } = useNewTrade();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <SidebarSection
      label="Trades"
      loading={isPending}
      onAdd={() => open({ symbol: path.match(/^\/trades\/([^/]+)/)?.[1] })}
      addLabel="New trade"
      empty="None saved yet"
      items={groups.map(([symbol, list]) => ({
        id: symbol,
        title: symbol,
        to: `/trades/${symbol}`,
        icon: LayoutGrid,
        badge: list.length,
        defaultOpen: true,
        items: list.map((s) => ({
          id: s.id,
          title: s.name,
          to: `/trades/${symbol}/${s.id}`,
          color: s.color,
        })),
      }))}
    />
  );
}

/** Screeners by symbol (Bikram, 2026-10-10): a count, and each screener under it. Agents add them. */
function ScreenersSection() {
  const list = useQuery(screenersQuery());
  const bySymbol = new Map<string, NonNullable<typeof list.data>>();
  for (const s of list.data ?? [])
    bySymbol.set(s.underlying, [...(bySymbol.get(s.underlying) ?? []), s]);
  return (
    <SidebarSection
      label="Screeners"
      loading={list.isPending}
      empty="Ask an agent to add one (screener_write)"
      items={[...bySymbol.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([symbol, screeners]) => ({
          id: symbol,
          title: symbol,
          to: `/screeners/${symbol}`,
          icon: ListFilter,
          badge: screeners.length,
          items: screeners.map((s) => ({
            id: s.id,
            title: s.name,
            to: `/screeners/${symbol}/${s.id}`,
          })),
        }))}
    />
  );
}

function ChangeBadge({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return null;
  const t = tone(value);
  return (
    <span className={cn(t === 'gain' && 'text-gain', t === 'loss' && 'text-loss')}>
      {signedPct(value)}
    </span>
  );
}

const changePct = (q: AnyQuote | null | undefined) =>
  q && 'changePct' in q ? q.changePct : undefined;

/** Live chain: the watchlist with today's change. `+` adds an underlying, the trash removes one. */
function WatchlistSection() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery(watchlistQuery());
  const symbols = (list.data ?? []).map((w) => w.symbol);
  const quotes = useQuery(quotesQuery(symbols));
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState('');
  const add = useMutation({
    mutationFn: (s: string) => addToWatchlist([s]),
    onSuccess: (data, s) => {
      qc.setQueryData(watchlistQuery().queryKey, data);
      setOpen(false);
      setSymbol('');
      void navigate({ to: '/chain/$symbol', params: { symbol: s } });
    },
  });
  const remove = useMutation({
    mutationFn: removeFromWatchlist,
    onSuccess: (data) => qc.setQueryData(watchlistQuery().queryKey, data),
  });
  const valid = /^[A-Za-z^][A-Za-z0-9.^/-]{0,14}$/.test(symbol.trim());
  return (
    <>
      <SidebarSection
        label="Live chain"
        items={symbols.map((s) => ({
          id: s,
          title: s,
          to: `/chain/${s}`,
          icon: Table2,
          badge: <ChangeBadge value={changePct(quotes.data?.quotes[s])} />,
        }))}
        loading={list.isPending}
        onAdd={() => setOpen(true)}
        addLabel="Add to watchlist"
        onRemove={(item) => remove.mutate(item.id)}
        removeLabel={(item) => `Remove ${item.title} from the watchlist`}
        empty="Add an underlying to follow its chain"
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) add.mutate(symbol.trim().toUpperCase());
            }}
          >
            <DialogHeader>
              <DialogTitle>Add to watchlist</DialogTitle>
              <DialogDescription>Follow an underlying's live chain.</DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              aria-label="Underlying"
              placeholder="SPY"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="num uppercase"
            />
            {add.isError ? (
              <p role="alert" className="text-xs text-loss">
                {add.error.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="submit" size="sm" disabled={!valid || add.isPending}>
                <Plus />
                Add
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Portfolio: Performance, the app views (All accounts, Transactions; read-only, so no trash), then the person's
 * own views of holdings and transactions, each with its icon. `+` starts a new holdings view.
 */
function PortfolioSection() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const lists = useQueries({ queries: PORTFOLIO_DOMAINS.map((d) => portfolioViewsQuery(d)) });
  const views = lists.flatMap((q) => q.data ?? []);
  const create = useMutation({
    mutationFn: () =>
      savePortfolioView('holdings', {
        name: 'New view',
        shape: 'group',
        formulas: [],
        tiles: [],
        columns: [],
        chips: [],
        icon: null,
        widgets: [],
        group: { fields: [], default: 'underlying' },
        filters: { fields: [], default: [] },
        pivot: null,
        sort: null,
      }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: portfolioViewsQuery('holdings').queryKey });
      void navigate({ to: portfolioViewPath(v) });
    },
  });
  const remove = useMutation({
    mutationFn: ({ domain, id }: { domain: PortfolioDomain; id: string }) =>
      deletePortfolioView(domain, id),
    onSuccess: (_, v) => {
      void qc.invalidateQueries({ queryKey: portfolioViewsQuery(v.domain).queryKey });
      if (path === portfolioViewPath(v)) void navigate({ to: '/portfolio' });
    },
  });
  return (
    <SidebarSection
      label="Portfolio"
      loading={lists.some((q) => q.isPending)}
      onAdd={() => create.mutate()}
      addLabel="New holdings view"
      onRemove={(item) => {
        const v = views.find((x) => `${x.domain}/${x.id}` === item.id);
        if (v) remove.mutate({ domain: v.domain, id: v.id });
      }}
      removeLabel={(item) => `Delete view ${item.title}`}
      items={[
        // Performance (Bikram, 2026-10-12): a fixed page, not a view.
        {
          id: 'performance',
          title: 'Performance',
          to: '/portfolio/performance',
          icon: LineChart,
          fixed: true,
        },
        ...[...views.filter((v) => v.app), ...views.filter((v) => !v.app)].map((v) => ({
          id: `${v.domain}/${v.id}`,
          title: v.name,
          to: portfolioViewPath(v),
          icon: viewIcon(v.config),
          fixed: v.app,
        })),
      ]}
    />
  );
}

/**
 * Symbols (Bikram, 2026-10-12): stock screens, views over your holdings' and watchlist's symbols
 * (and DataEdge's list): My symbols, then the person's own. `+` starts a new screen.
 */
function SymbolsSection() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const list = useQuery(portfolioViewsQuery('symbols'));
  const views = list.data ?? [];
  const listKey = portfolioViewsQuery('symbols').queryKey;
  const create = useMutation({
    mutationFn: () =>
      savePortfolioView('symbols', {
        name: 'New screen',
        shape: 'table',
        formulas: [],
        tiles: [],
        columns: ['symbol', 'in', 'industry', 'market_cap', 'pe_ttm', 'buy_pct', 'earnings_next'],
        chips: [],
        icon: null,
        widgets: [],
        group: { fields: [], default: null },
        filters: { fields: [], default: [] },
        pivot: null,
        sort: null,
      }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: listKey });
      void navigate({ to: portfolioViewPath(v) });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deletePortfolioView('symbols', id),
    onSuccess: (_, id) => {
      void qc.invalidateQueries({ queryKey: listKey });
      if (path === portfolioViewPath({ domain: 'symbols', id })) void navigate({ to: '/symbols' });
    },
  });
  return (
    <SidebarSection
      label="Symbols"
      loading={list.isPending}
      onAdd={() => create.mutate()}
      addLabel="New stock screen"
      onRemove={(item) => remove.mutate(item.id)}
      removeLabel={(item) => `Delete view ${item.title}`}
      items={[...views.filter((v) => v.app), ...views.filter((v) => !v.app)].map((v) => ({
        id: v.id,
        title: v.name,
        to: portfolioViewPath(v),
        icon: viewIcon(v.config),
        fixed: v.app,
      }))}
    />
  );
}

/**
 * Autopilot (Bikram, 2026-10-12): Overview, one item per basket (a dot when a rebalance is due, a
 * hand in Suggest mode), then Autopilot queue, To place and Order history. `+` starts a new basket.
 * Marked [WIP] until it has a working setup; a self-hosted copy (no built-in DataEdge) shows only
 * the name (Bikram, 2026-10-12).
 */
function AutopilotSection() {
  const navigate = useNavigate();
  const integrations = useQuery(integrationsQuery(false));
  const hosted = integrations.data?.dataedge.built_in === true;
  const overview = useQuery({ ...autopilotQuery(), enabled: hosted });
  const o = overview.data;
  const count = (n: number | undefined, warn = false) =>
    n ? <span className={cn(warn && 'text-warning')}>{n}</span> : undefined;
  if (!integrations.isPending && !hosted)
    return <SidebarSection label="Autopilot [WIP]" items={[]} />;
  return (
    <SidebarSection
      label="Autopilot [WIP]"
      loading={integrations.isPending || overview.isPending}
      onAdd={() => void navigate({ to: '/baskets/new' })}
      addLabel="New basket"
      items={[
        { id: 'overview', title: 'Overview', to: '/autopilot', icon: LayoutDashboard },
        ...(o?.baskets ?? []).map((b) => ({
          id: b.id,
          title: b.name,
          to: `/baskets/${b.id}`,
          icon: ShoppingBasket,
          badge: b.due ? (
            <span aria-label="Rebalance due" className="size-2 rounded-full bg-warning" />
          ) : b.mode === 'suggest' ? (
            <Hand aria-label="Suggest" className="size-3.5 text-muted-foreground" />
          ) : undefined,
        })),
        {
          id: 'queue',
          title: 'Autopilot queue',
          to: '/orders/queue',
          icon: Bot,
          badge: count(o?.queue),
        },
        {
          id: 'to-place',
          title: 'To place',
          to: '/orders/to-place',
          icon: PenLine,
          badge: count(o?.to_place, true),
        },
        { id: 'history', title: 'Order history', to: '/orders/history', icon: History },
      ]}
    />
  );
}

/**
 * Posts (Bikram, 2026-10-12): what the tracked X accounts post. The app views Feed, By symbol and
 * Macro, then the person's own. `+` starts a new view of posts.
 */
function PostsSection() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const list = useQuery(postViewsQuery());
  const views = list.data ?? [];
  const listKey = postViewsQuery().queryKey;
  const create = useMutation({
    mutationFn: () =>
      savePostView('posts', {
        name: 'New view',
        shape: 'table',
        formulas: [],
        tiles: [],
        columns: ['at', 'handle', 'text', 'symbols', 'theme', 'sentiment'],
        chips: [],
        icon: null,
        widgets: [],
        group: { fields: [], default: null },
        filters: { fields: [], default: [] },
        pivot: null,
        sort: { key: 'at', desc: true },
      }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: listKey });
      void navigate({ to: postViewPath(v) });
    },
  });
  const remove = useMutation({
    mutationFn: (v: { domain: PostDomain; id: string }) => deletePostView(v.domain, v.id),
    onSuccess: (_, v) => {
      void qc.invalidateQueries({ queryKey: listKey });
      if (path === postViewPath(v)) void navigate({ to: '/posts/$id', params: { id: 'feed' } });
    },
  });
  return (
    <SidebarSection
      label="Posts"
      loading={list.isPending}
      onAdd={() => create.mutate()}
      addLabel="New view of posts"
      onRemove={(item) => {
        const v = views.find((x) => `${x.domain}/${x.id}` === item.id);
        if (v) remove.mutate(v);
      }}
      removeLabel={(item) => `Delete view ${item.title}`}
      items={views.map((v) => ({
        id: `${v.domain}/${v.id}`,
        title: v.name,
        to: postViewPath(v),
        icon: viewIcon(v.config),
        fixed: v.app,
      }))}
    />
  );
}

/**
 * Logs (Bikram, 2026-10-11): shown only once the person has views of their own over the `logs`
 * domain; the Logs app view itself opens from the profile menu.
 */
function LogsSection() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const list = useQuery(logViewsQuery());
  const views = list.data ?? [];
  const remove = useMutation({
    mutationFn: (id: string) => deleteLogView(id),
    onSuccess: (_, id) => {
      void qc.invalidateQueries({ queryKey: logViewsQuery().queryKey });
      if (path === logViewPath({ id })) void navigate({ to: '/logs' });
    },
  });
  if (!views.some((v) => !v.app)) return null;
  return (
    <SidebarSection
      label="Logs"
      onRemove={(item) => remove.mutate(item.id)}
      removeLabel={(item) => `Delete view ${item.title}`}
      items={[...views.filter((v) => v.app), ...views.filter((v) => !v.app)].map((v) => ({
        id: v.id,
        title: v.name,
        to: logViewPath(v),
        icon: viewIcon(v.config),
        fixed: v.app,
      }))}
    />
  );
}

/** TradeEdge inside the shared shell: its sections and the routed page. */
export function StrategyShell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <NewTradeProvider>
      <AppShell
        desk="trade"
        hideAmounts
        settings={INTEGRATION_SETTINGS}
        status={<SyncStatus />}
        onRefresh={() => queryClient.refetchQueries({ type: 'active' })}
        onLogs={() => void navigate({ to: '/logs' })}
        onSchedules={() => void navigate({ to: '/schedules' })}
        nav={
          <>
            <NavGroup items={[{ title: 'Dashboard', to: '/dashboard', icon: LayoutGrid }]} />
            <TradesSection />
            <ScreenersSection />
            <WatchlistSection />
            <AutopilotSection />
            <PortfolioSection />
            <SymbolsSection />
            <PostsSection />
            <LogsSection />
          </>
        }
      >
        <Outlet />
      </AppShell>
    </NewTradeProvider>
  );
}
