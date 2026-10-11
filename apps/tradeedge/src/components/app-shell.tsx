import { INTEGRATION_SETTINGS, SyncStatus } from '@/components/integrations';
import { NewTradeProvider, useNewTrade } from '@/components/new-trade';
import {
  type AnyQuote,
  PORTFOLIO_DOMAINS,
  type PortfolioDomain,
  addToWatchlist,
  deletePortfolioView,
  portfolioViewPath,
  portfolioViewsQuery,
  quotesQuery,
  removeFromWatchlist,
  savePortfolioView,
  screenersQuery,
  watchlistQuery,
} from '@/lib/api';
import { signedPct, tone } from '@/lib/format';
import { useTradeGroups } from '@/lib/use-trades';
import { cn } from '@/lib/utils';
import { AppShell, SidebarSection, viewIcon } from '@edgedesk/app-shell';
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
  Briefcase,
  Grid3x3,
  LayoutGrid,
  ListFilter,
  ListTree,
  type LucideIcon,
  Plus,
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
 * Portfolio: the app views (All accounts, Transactions; read-only, so no trash), then the person's
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
      items={[...views.filter((v) => v.app), ...views.filter((v) => !v.app)].map((v) => ({
        id: `${v.domain}/${v.id}`,
        title: v.name,
        to: portfolioViewPath(v),
        icon: viewIcon(v.config),
        fixed: v.app,
      }))}
    />
  );
}

/** TradeEdge inside the shared shell: its sections and the routed page. */
export function StrategyShell() {
  const queryClient = useQueryClient();
  return (
    <NewTradeProvider>
      <AppShell
        desk="trade"
        hideAmounts
        settings={INTEGRATION_SETTINGS}
        status={<SyncStatus />}
        onRefresh={() => queryClient.refetchQueries({ type: 'active' })}
        nav={
          <>
            <TradesSection />
            <ScreenersSection />
            <WatchlistSection />
            <PortfolioSection />
          </>
        }
      >
        <Outlet />
      </AppShell>
    </NewTradeProvider>
  );
}
