/**
 * Autopilot (Bikram, 2026-10-12, phase 1): baskets with target weights, a rebalance rule and a Mode,
 * each holding one floating sleeve per account (shares + cash); money moves only through Move cash.
 * Rebalances propose orders: tradeable accounts' wait in Autopilot queue for Approve, the rest land
 * in To place for the person to place by hand. Nothing is sent to a broker yet.
 */
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  type AutopilotOverview,
  type Basket,
  type BasketMode,
  type Order,
  type OrderAction,
  type PlannedOrder,
  type Rebalance,
  actOnOrders,
  autopilotQuery,
  basketPreviewQuery,
  createBasket,
  deleteBasket,
  draftBasket,
  moveCash,
  movePreviewQuery,
  ordersQuery,
  quotesQuery,
  rebalanceBasket,
  updateBasket,
} from '@/lib/api';
import { DASH, num, usdPlain } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ErrorNote } from '@/routes/chain';
import {
  ConfirmDelete,
  type CustomViewConfig,
  CustomViewPage,
  Page,
  StatusItem,
  Tile,
  TileRow,
  TileToggleGroup,
  type ViewDomain,
  maskAmount,
  useAmountsHidden,
  usePrefs,
} from '@edgedesk/app-shell';
import { Checkbox } from '@edgedesk/app-shell/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@edgedesk/app-shell/ui/dialog';
import { Label } from '@edgedesk/app-shell/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@edgedesk/app-shell/ui/select';
import { Switch } from '@edgedesk/app-shell/ui/switch';
import { customViewConfigSchema } from '@edgedesk/types/views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowLeftRight,
  Bot,
  CalendarClock,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Clock,
  Hand,
  Hash,
  Info,
  ListChecks,
  ListPlus,
  Lock,
  PanelRightOpen,
  PenLine,
  Pencil,
  Plus,
  Scale,
  ShoppingBasket,
  Tag,
  Target,
  Trash2,
  TrendingUp,
  TriangleAlert,
  Undo2,
  Wallet,
  X,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

// ── shared bits ──

export const REBALANCE_LABEL: Record<Rebalance, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};
const PERIOD: Record<Rebalance, string> = {
  monthly: 'month',
  quarterly: 'quarter',
  yearly: 'year',
};
const MODE_LABEL: Record<BasketMode, string> = { off: 'Off', suggest: 'Suggest' };
const MODE_NOTE: Record<BasketMode, string> = {
  off: 'Tracks value and drift only; no orders.',
  suggest:
    'When a rebalance is due it proposes orders: tradeable accounts wait in Autopilot queue for your Approve, read-only ones go to To place.',
};
const DRIFT_OPTIONS = [0, 3, 5, 10] as const;
const STATUS_LABEL: Record<Order['status'], string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  sent: 'Sent',
  filled: 'Filled',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  by_hand: 'By hand',
};
const VIA_LABEL = { snaptrade: 'SnapTrade', robinhood: 'Robinhood' } as const;

/** Masks a dollar amount while Hide amounts is on. */
function useMoney() {
  const hidden = useAmountsHidden();
  return (v: number | null | undefined) => (hidden ? maskAmount(usdPlain(v)) : usdPlain(v));
}

/** `Mon 06:35 PDT` in the time zone the status bar shows. */
function useWhen() {
  const { timeZone } = usePrefs();
  return (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString('en-US', {
          timeZone,
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZoneName: 'short',
        })
      : DASH;
}

/** `Jan 2, 2027` for a YYYY-MM-DD date. */
const dateLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** Drift in points: `+2.1 pts`, red past the basket's trigger. */
function Drift({ value, limit }: { value: number | null; limit: number }) {
  if (value === null) return <span className="num text-muted-foreground">{DASH}</span>;
  const over = limit > 0 && Math.abs(value) > limit;
  return (
    <span className={cn('num whitespace-nowrap', over && 'text-warning font-medium')}>
      {value > 0 ? '+' : value < 0 ? '−' : ''}
      {num(Math.abs(value), 1)} pts
    </span>
  );
}

function Side({ side }: { side: 'buy' | 'sell' }) {
  return (
    <span className={cn('font-semibold', side === 'buy' ? 'text-gain' : 'text-loss')}>
      {side === 'buy' ? 'Buy' : 'Sell'}
    </span>
  );
}

function StatusBadge({ status }: { status: Order['status'] }) {
  const icon = {
    proposed: Hand,
    approved: Check,
    sent: Clock,
    filled: CheckCheck,
    rejected: X,
    cancelled: X,
    by_hand: PenLine,
  }[status];
  const Icon = icon;
  return (
    <Badge
      variant={status === 'approved' ? 'default' : status === 'by_hand' ? 'outline' : 'secondary'}
      className={cn('font-normal', status === 'by_hand' && 'border-warning text-warning')}
    >
      <Icon />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

function TradingBadge({ via, tradeable }: { via: Order['via']; tradeable: boolean }) {
  return tradeable && via ? (
    <Badge variant="secondary" className="font-normal">
      {VIA_LABEL[via]}
    </Badge>
  ) : (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      By hand
    </Badge>
  );
}

function Hint({ icon: Icon = Info, children }: { icon?: typeof Info; children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

const amountOf = (o: { side: 'buy' | 'sell'; qty: number; price: number }) =>
  (o.side === 'sell' ? -1 : 1) * o.qty * o.price;

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: autopilotQuery().queryKey });
  void qc.invalidateQueries({ queryKey: ['tags'] });
}

// ── Overview ──

interface OverviewRow {
  key: string;
  basket_id: string | null;
  basket: string;
  symbol: string;
  accounts: string[];
  value: number;
  target: number | null;
  now: number | null;
  drift: number | null;
  limit: number;
  rebalance: string;
  mode: string;
}

function overviewRows(o: AutopilotOverview): OverviewRow[] {
  const names = new Map(o.accounts.map((a) => [a.id, a.name]));
  const rows: OverviewRow[] = [];
  for (const b of o.baskets) {
    const rebalance = b.due ? 'Due' : dateLabel(b.next_rebalance);
    const base = {
      basket_id: b.id,
      basket: b.name,
      limit: b.drift,
      rebalance,
      mode: MODE_LABEL[b.mode],
    };
    for (const r of b.rows)
      rows.push({
        ...base,
        key: `${b.id}:${r.symbol}`,
        symbol: r.symbol,
        accounts: r.accounts.map((a) => names.get(a) ?? a),
        value: r.value,
        target: r.target,
        now: r.now,
        drift: r.drift,
      });
    if (b.cash > 0)
      rows.push({
        ...base,
        key: `${b.id}:cash`,
        symbol: 'Cash',
        accounts: b.sleeves.filter((s) => s.cash > 0).map((s) => s.account),
        value: b.cash,
        target: Object.keys(b.targets).length ? 0 : null,
        now: b.value ? b.cash_now : null,
        drift: null,
      });
  }
  for (const u of o.unassigned) {
    const base = {
      basket_id: null,
      basket: 'Unassigned',
      accounts: [u.account],
      target: null,
      now: null,
      drift: null,
      limit: 0,
      rebalance: '',
      mode: '',
    };
    for (const h of u.holdings)
      rows.push({
        ...base,
        key: `un:${u.portfolio_id}:${h.symbol}`,
        symbol: h.symbol,
        value: h.value,
      });
    if (u.cash)
      rows.push({ ...base, key: `un:${u.portfolio_id}:cash`, symbol: 'Cash', value: u.cash });
  }
  return rows;
}

const OVERVIEW: ViewDomain<OverviewRow> = {
  id: 'baskets',
  rowKey: (r) => r.key,
  text: (r) => [r.basket, r.symbol, ...r.accounts],
  fields: [
    {
      key: 'basket',
      label: 'Basket',
      icon: ShoppingBasket,
      value: (r) => r.basket,
      format: 'text',
      filterable: true,
      groupable: true,
    },
    {
      key: 'symbol',
      label: 'Symbol',
      icon: Tag,
      value: (r) => r.symbol,
      format: 'text',
      filterable: true,
      render: (r) => <span className="font-medium">{r.symbol}</span>,
    },
    {
      key: 'account',
      label: 'Account',
      icon: Wallet,
      value: (r) =>
        r.accounts.length > 1 ? `${r.accounts.length} accounts` : (r.accounts[0] ?? null),
      values: (r) => r.accounts,
      format: 'text',
      filterable: true,
    },
    {
      key: 'value',
      label: 'Value',
      icon: Hash,
      value: (r) => r.value,
      format: 'price',
      amount: true,
      aggregate: 'sum',
    },
    {
      key: 'target',
      label: 'Target',
      icon: Target,
      value: (r) => r.target,
      format: 'weight',
    },
    {
      key: 'now',
      label: 'Now',
      icon: Scale,
      value: (r) => r.now,
      format: 'weight',
    },
    {
      key: 'drift',
      label: 'Drift',
      icon: TrendingUp,
      value: (r) => r.drift,
      format: 'signed',
      render: (r) => <Drift value={r.drift} limit={r.limit} />,
    },
    {
      key: 'rebalance',
      label: 'Rebalance',
      icon: CalendarClock,
      value: (r) => r.rebalance || null,
      format: 'text',
      filterable: true,
      render: (r) =>
        r.rebalance === 'Due' ? (
          <Badge variant="outline" className="border-warning font-normal text-warning">
            <TriangleAlert />
            Due
          </Badge>
        ) : (
          <span className="num whitespace-nowrap">{r.rebalance}</span>
        ),
    },
    {
      key: 'mode',
      label: 'Mode',
      icon: Bot,
      value: (r) => r.mode || null,
      format: 'text',
      filterable: true,
      groupable: true,
    },
  ],
};

const OVERVIEW_CONFIG: CustomViewConfig = {
  name: 'Overview',
  ...customViewConfigSchema.parse({
    shape: 'group',
    columns: ['symbol', 'value', 'target', 'now', 'drift', 'account', 'rebalance', 'mode'],
    icon: 'layout-dashboard',
    group: { fields: ['basket', 'mode'], default: 'basket' },
    filters: { fields: ['basket', 'account', 'symbol', 'rebalance', 'mode'], default: [] },
  }),
};

function OverviewBody() {
  const navigate = useNavigate();
  const money = useMoney();
  const when = useWhen();
  const overview = useQuery(autopilotQuery());
  const [moving, setMoving] = useState<{ to?: string } | null>(null);
  const o = overview.data;
  const rows = useMemo(() => (o ? overviewRows(o) : []), [o]);
  const inBaskets = o?.baskets.reduce((t, b) => t + b.value, 0) ?? 0;
  const unassigned = o?.unassigned.reduce((t, u) => t + u.value, 0) ?? 0;
  const due = o?.baskets.filter((b) => b.due).length ?? 0;
  return (
    <>
      <CustomViewPage
        crumbs={[{ label: 'Autopilot' }, { label: 'Overview' }]}
        domain={OVERVIEW}
        config={OVERVIEW_CONFIG}
        rows={rows}
        onOpen={(r) =>
          r.basket_id && void navigate({ to: '/baskets/$id', params: { id: r.basket_id } })
        }
        groupActions={(key) => {
          const b = o?.baskets.find((x) => x.name === key);
          return b ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Open ${b.name}`}
              onClick={(e) => {
                e.stopPropagation();
                void navigate({ to: '/baskets/$id', params: { id: b.id } });
              }}
            >
              <PanelRightOpen />
            </Button>
          ) : null;
        }}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void navigate({ to: '/baskets/new' })}
            >
              <Plus />
              <span className="max-md:sr-only">New basket</span>
            </Button>
            <Button variant="outline" size="sm" disabled={!o} onClick={() => setMoving({})}>
              <ArrowLeftRight />
              <span className="max-md:sr-only">Move cash</span>
            </Button>
          </>
        }
        intro={
          o && (
            <TileRow aria-label="Autopilot totals">
              <Tile label="In baskets" value={money(inBaskets)} />
              <Tile label="Unassigned" value={money(unassigned)} />
              <Tile
                label="Rebalance due"
                value={due}
                valueClassName={due ? 'text-warning' : undefined}
              />
              <Tile label="Open orders" value={o.queue + o.to_place} />
            </TileRow>
          )
        }
        state={
          o ? undefined : overview.isError ? (
            <ErrorNote>{overview.error.message}</ErrorNote>
          ) : (
            <Skeleton className="h-96 w-full" />
          )
        }
        status={
          o && (
            <>
              <StatusItem label="Accounts" value={o.accounts.length} />
              <StatusItem label="Next window" value={when(o.next_window)} />
              {o.unpriced.length ? (
                <StatusItem label="No price" value={o.unpriced.join(', ')} ok={false} />
              ) : null}
            </>
          )
        }
      />
      {o && moving && (
        <MoveCashDialog overview={o} to={moving.to} onClose={() => setMoving(null)} />
      )}
    </>
  );
}

/** `/autopilot`: every basket and Unassigned. */
export function AutopilotPage() {
  return <OverviewBody />;
}

/** One basket's rows: the Overview's fields with nothing to group by (it is one basket, one mode). */
const BASKET_DOMAIN: ViewDomain<OverviewRow> = {
  ...OVERVIEW,
  fields: OVERVIEW.fields.map((f) => ({ ...f, groupable: false })),
};

const BASKET_CONFIG: CustomViewConfig = {
  name: 'Balances',
  ...customViewConfigSchema.parse({
    shape: 'table',
    columns: ['symbol', 'value', 'target', 'now', 'drift', 'account'],
    icon: 'shopping-basket',
    filters: { fields: ['account', 'symbol'], default: [] },
  }),
};

type BasketTab = 'balances' | 'sleeves' | 'rebalance' | 'orders' | 'definition';

/**
 * `/baskets/$id`: the basket as its own page (Bikram, 2026-10-12): Balances first, then its
 * sleeves, rebalance, orders and, on its own tab, the definition.
 */
export function BasketPage() {
  const { id } = useParams({ from: '/baskets/$id' });
  const navigate = useNavigate();
  const money = useMoney();
  const when = useWhen();
  const overview = useQuery(autopilotQuery());
  const [tab, setTab] = useState<BasketTab>('balances');
  const [moving, setMoving] = useState(false);
  const o = overview.data;
  const basket = o?.baskets.find((b) => b.id === id) ?? null;
  const rows = useMemo(
    () => (o && basket ? overviewRows({ ...o, baskets: [basket], unassigned: [] }) : []),
    [o, basket],
  );
  const crumbs = [
    { label: 'Autopilot', to: '/autopilot' },
    { label: basket?.name ?? (o ? 'Not found' : '…') },
  ];
  const actions = basket && (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void navigate({ to: '/baskets/$id/edit', params: { id: basket.id } })}
      >
        <Pencil />
        <span className="max-md:sr-only">Edit</span>
      </Button>
      <Button variant="outline" size="sm" onClick={() => setMoving(true)}>
        <ArrowLeftRight />
        <span className="max-md:sr-only">Move cash</span>
      </Button>
    </>
  );
  const tabs = basket && (
    <Tabs value={tab} onValueChange={(v) => setTab(v as BasketTab)}>
      <TabsList className="max-w-full justify-start overflow-x-auto">
        <TabsTrigger value="balances">Balances</TabsTrigger>
        <TabsTrigger value="sleeves">
          Sleeves
          <span className="num text-muted-foreground">{basket.sleeves.length}</span>
        </TabsTrigger>
        <TabsTrigger value="rebalance">
          Rebalance
          {basket.due && <span className="size-1.5 rounded-full bg-warning" />}
        </TabsTrigger>
        <TabsTrigger value="orders">
          Orders
          {basket.open_orders ? (
            <span className="num text-muted-foreground">{basket.open_orders}</span>
          ) : null}
        </TabsTrigger>
        <TabsTrigger value="definition">Definition</TabsTrigger>
      </TabsList>
    </Tabs>
  );
  const moveDialog = o && basket && moving && (
    <MoveCashDialog overview={o} to={basket.id} onClose={() => setMoving(false)} />
  );
  if (!o || !basket || tab === 'balances')
    return (
      <>
        <CustomViewPage
          crumbs={crumbs}
          domain={BASKET_DOMAIN}
          config={BASKET_CONFIG}
          rows={rows}
          actions={actions}
          intro={
            basket && (
              <>
                {tabs}
                <TileRow aria-label={`${basket.name} totals`}>
                  <Tile label="Value" value={money(basket.value)} />
                  <Tile label="Cash" value={money(basket.cash)} />
                  <Tile
                    label="Largest drift"
                    value={`${basket.worst_drift > 0 ? '+' : basket.worst_drift < 0 ? '−' : ''}${Math.abs(basket.worst_drift).toFixed(1)} pts`}
                    valueClassName={
                      Math.abs(basket.worst_drift) > basket.drift && basket.drift
                        ? 'text-warning'
                        : undefined
                    }
                  />
                  <Tile
                    label="Rebalance"
                    value={basket.due ? 'Due' : dateLabel(basket.next_rebalance)}
                    valueClassName={basket.due ? 'text-warning' : undefined}
                  />
                </TileRow>
              </>
            )
          }
          state={
            basket ? undefined : overview.isError ? (
              <ErrorNote>{overview.error.message}</ErrorNote>
            ) : o ? (
              <ErrorNote>No basket with this id.</ErrorNote>
            ) : (
              <Skeleton className="h-96 w-full" />
            )
          }
          status={
            basket && (
              <>
                <StatusItem label="Mode" value={MODE_LABEL[basket.mode]} />
                <StatusItem label="Next window" value={when(o?.next_window ?? null)} />
              </>
            )
          }
        />
        {moveDialog}
      </>
    );
  return (
    <Page crumbs={crumbs} actions={actions} className="pb-24">
      {tabs}
      <div key={`${basket.id}:${basket.updated_at}`} className="max-w-3xl">
        {tab === 'sleeves' && <SleevesSection basket={basket} onMove={() => setMoving(true)} />}
        {tab === 'rebalance' && <RebalanceSection basket={basket} />}
        {tab === 'orders' && <OrdersSection basket={basket} />}
        {tab === 'definition' && (
          <>
            <TargetSection basket={basket} />
            <ModeSection basket={basket} />
            <DeleteSection
              basket={basket}
              overview={o}
              onDeleted={() => void navigate({ to: '/autopilot' })}
            />
          </>
        )}
      </div>
      {moveDialog}
    </Page>
  );
}

/** One part of a basket tab: its title and hint over the content. */
function Pane({
  icon: Icon,
  title,
  count,
  hint,
  children,
}: {
  icon: typeof Info;
  title: string;
  count?: number | null;
  hint?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-1 py-3">
      <h3 className="flex items-center gap-2 font-medium text-sm">
        <Icon className="size-4 text-muted-foreground" />
        {title}
        {count ? <Badge variant="secondary">{count}</Badge> : null}
        {hint && <span className="ml-auto font-normal text-muted-foreground text-xs">{hint}</span>}
      </h3>
      {children}
    </section>
  );
}

function TargetSection({ basket }: { basket: Basket }) {
  const qc = useQueryClient();
  const [targets, setTargets] = useState(basket.targets);
  const [rebalance, setRebalance] = useState(basket.rebalance);
  const [drift, setDrift] = useState(basket.drift);
  const sum = Object.values(targets).reduce((a, b) => a + b, 0);
  const keys = Object.keys(targets);
  const dirty =
    rebalance !== basket.rebalance ||
    drift !== basket.drift ||
    keys.some((k) => targets[k] !== basket.targets[k]);
  const bad = keys.length > 0 && Math.abs(sum - 100) > 0.05;
  const save = useMutation({
    mutationFn: () => updateBasket(basket.id, { targets, rebalance, drift }),
    onSuccess: () => invalidate(qc),
  });
  const row = (k: string) => basket.rows.find((r) => r.symbol === k);
  return (
    <Pane icon={Target} title="Target" hint="your weights" defaultOpen>
      <div className="grid gap-3 pt-1">
        {keys.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead className="text-right">Target %</TableHead>
                <TableHead className="text-right">Now</TableHead>
                <TableHead className="text-right">Drift</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k}>
                  <TableCell className="font-medium">{k}</TableCell>
                  <TableCell className="text-right">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      aria-label={`${k} target`}
                      value={targets[k]}
                      onChange={(e) => setTargets({ ...targets, [k]: Number(e.target.value) || 0 })}
                      className="num ml-auto h-7 w-20 text-right"
                    />
                  </TableCell>
                  <TableCell className="num text-right">{num(row(k)?.now ?? 0, 1)}%</TableCell>
                  <TableCell className="text-right">
                    <Drift value={row(k)?.drift ?? null} limit={basket.drift} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Total</TableCell>
                <TableCell className={cn('num text-right', bad && 'text-warning')}>
                  {num(sum, 1)}%
                </TableCell>
                <TableCell />
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        ) : (
          <Hint>No target weights yet. Add stocks with the pencil above.</Hint>
        )}
        <div className="grid gap-1.5">
          <Label>Rebalance</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={rebalance}
            onValueChange={(v) => v && setRebalance(v as Rebalance)}
          >
            {(['monthly', 'quarterly', 'yearly'] as const).map((r) => (
              <ToggleGroupItem key={r} value={r}>
                {REBALANCE_LABEL[r]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="grid gap-1.5">
          <Label>Also on drift</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={String(drift)}
            onValueChange={(v) => v && setDrift(Number(v))}
          >
            {DRIFT_OPTIONS.map((d) => (
              <ToggleGroupItem key={d} value={String(d)}>
                {d ? `±${d} pts` : 'Off'}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <Hint icon={CalendarClock}>
          Next rebalance {dateLabel(basket.next_rebalance)}, the first trading day of the{' '}
          {PERIOD[rebalance]}.{' '}
          {drift
            ? `It also rebalances early if any weight drifts more than ±${drift} pts.`
            : 'Drift alone never triggers it.'}
        </Hint>
        {dirty && (
          <div className="flex items-center gap-2">
            {bad && (
              <span className="text-warning text-xs">
                Weights add up to {num(sum, 1)}%. Make them 100%.
              </span>
            )}
            <Button
              size="sm"
              className="ml-auto"
              disabled={bad || save.isPending}
              onClick={() => save.mutate()}
            >
              <Check />
              Save
            </Button>
          </div>
        )}
        {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
      </div>
    </Pane>
  );
}

function SleevesSection({ basket, onMove }: { basket: Basket; onMove: () => void }) {
  const navigate = useNavigate();
  const money = useMoney();
  const syms = [...new Set([...Object.keys(basket.targets), ...basket.rows.map((r) => r.symbol)])];
  const n = basket.sleeves.length;
  return (
    <Pane
      icon={Wallet}
      title="Sleeves"
      count={n}
      hint={`${n} ${n === 1 ? 'account' : 'accounts'}`}
      defaultOpen
    >
      <div className="grid gap-2 pt-1">
        {n ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  {syms.map((k) => (
                    <TableHead key={k} className="text-right">
                      {k}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Cash</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {basket.sleeves.map((s) => (
                  <TableRow key={s.portfolio_id}>
                    <TableCell>
                      <div className="whitespace-nowrap">{s.account}</div>
                      <div className="text-muted-foreground text-xs">
                        {s.tradeable && s.via ? `via ${VIA_LABEL[s.via]}` : 'By hand'}
                      </div>
                    </TableCell>
                    {syms.map((k) => (
                      <TableCell key={k} className="num text-right">
                        {num(s.shares[k] ?? 0, 0)}
                      </TableCell>
                    ))}
                    <TableCell className="num text-right">{money(s.cash)}</TableCell>
                    <TableCell className="num text-right">{money(s.value)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {n > 1 && (
                <TableFooter>
                  <TableRow>
                    <TableCell>Total</TableCell>
                    {syms.map((k) => (
                      <TableCell key={k} className="num text-right">
                        {num(
                          basket.sleeves.reduce((t, s) => t + (s.shares[k] ?? 0), 0),
                          0,
                        )}
                      </TableCell>
                    ))}
                    <TableCell className="num text-right">{money(basket.cash)}</TableCell>
                    <TableCell className="num text-right">{money(basket.value)}</TableCell>
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </div>
        ) : (
          <Hint>No sleeves yet: it holds nothing in any account.</Hint>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" onClick={onMove}>
            <ArrowLeftRight />
            Move cash
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigate({ to: '/baskets/$id/edit', params: { id: basket.id } })}
          >
            <Plus />
            Add account or shares
          </Button>
        </div>
      </div>
    </Pane>
  );
}

function PlannedTable({ orders }: { orders: PlannedOrder[] }) {
  const money = useMoney();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Trade</TableHead>
          <TableHead>Account</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Est.</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((o) => (
          <TableRow key={`${o.portfolio_id}:${o.side}:${o.symbol}`}>
            <TableCell className="whitespace-nowrap">
              <Side side={o.side} /> <span className="font-medium">{o.symbol}</span>
            </TableCell>
            <TableCell>
              <div>{o.account}</div>
              {o.by_hand && <div className="text-muted-foreground text-xs">By hand</div>}
            </TableCell>
            <TableCell className="num text-right">{num(o.qty, 0)}</TableCell>
            <TableCell className="num text-right">
              {amountOf(o) < 0 ? '−' : ''}
              {money(Math.abs(amountOf(o)))}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RebalanceSection({ basket }: { basket: Basket }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ready = Object.keys(basket.targets).length > 0 && basket.value > 0;
  const preview = useQuery(basketPreviewQuery(basket.id, ready));
  const propose = useMutation({
    mutationFn: () => rebalanceBasket(basket.id),
    onSuccess: (orders) => {
      invalidate(qc);
      void qc.invalidateQueries({ queryKey: ordersQuery().queryKey });
      void qc.removeQueries({ queryKey: ['autopilot', 'preview', basket.id] });
      void navigate({
        to: orders.some((o) => o.status === 'proposed') ? '/orders/queue' : '/orders/to-place',
      });
    },
  });
  const planned = preview.data ?? [];
  const byHand = planned.some((o) => o.by_hand);
  let body: ReactNode;
  if (!Object.keys(basket.targets).length) body = <Hint>Set its target weights first.</Hint>;
  else if (basket.value <= 0)
    body = <Hint>Not funded yet. Use Move cash to put money in, then it proposes the buys.</Hint>;
  else if (!preview.data)
    body = preview.isError ? (
      <ErrorNote>{preview.error.message}</ErrorNote>
    ) : (
      <Skeleton className="h-16 w-full" />
    );
  else if (!planned.length) body = <Hint icon={Check}>On target. Nothing to trade.</Hint>;
  else if (!basket.due)
    body = (
      <div className="flex flex-wrap items-center gap-2">
        <Hint icon={Check}>
          {basket.drift
            ? `Within ±${basket.drift} pts. Next rebalance ${dateLabel(basket.next_rebalance)}.`
            : `Next rebalance ${dateLabel(basket.next_rebalance)} (${REBALANCE_LABEL[basket.rebalance].toLowerCase()}).`}
        </Hint>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={propose.isPending}
          onClick={() => propose.mutate()}
        >
          <ListPlus />
          Rebalance now ({planned.length})
        </Button>
      </div>
    );
  else
    body = (
      <div className="grid gap-2">
        <PlannedTable orders={planned} />
        <div className="flex flex-wrap items-center gap-2">
          <Hint>
            {byHand ? 'Read-only accounts get By hand orders, in To place. ' : ''}
            Replaces this basket's open orders.
          </Hint>
          <Button
            size="sm"
            className="ml-auto"
            disabled={propose.isPending}
            onClick={() => propose.mutate()}
          >
            <ListPlus />
            Propose {planned.length}
          </Button>
        </div>
      </div>
    );
  return (
    <Pane
      icon={Scale}
      title="Rebalance"
      hint={basket.due ? 'due' : null}
      defaultOpen={Boolean(basket.due)}
    >
      <div className="grid gap-2 pt-1">
        {body}
        {propose.isError && <ErrorNote>{propose.error.message}</ErrorNote>}
      </div>
    </Pane>
  );
}

function ModeSection({ basket }: { basket: Basket }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (mode: BasketMode) => updateBasket(basket.id, { mode }),
    onSuccess: () => invalidate(qc),
  });
  return (
    <Pane icon={Bot} title="Mode" hint={MODE_LABEL[basket.mode]}>
      <div className="grid gap-2 pt-1">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={save.isPending ? save.variables : basket.mode}
          onValueChange={(v) => v && v !== basket.mode && save.mutate(v as BasketMode)}
        >
          <ToggleGroupItem value="off">
            <CircleDashed />
            Off
          </ToggleGroupItem>
          <ToggleGroupItem value="suggest">
            <Hand />
            Suggest
          </ToggleGroupItem>
        </ToggleGroup>
        <Hint>{MODE_NOTE[save.isPending ? (save.variables ?? basket.mode) : basket.mode]}</Hint>
        {save.isError && <ErrorNote>{save.error.message}</ErrorNote>}
      </div>
    </Pane>
  );
}

function OrdersSection({ basket }: { basket: Basket }) {
  const navigate = useNavigate();
  const orders = useQuery(ordersQuery());
  const open = (orders.data ?? []).filter(
    (o) => o.basket_id === basket.id && ['proposed', 'approved', 'by_hand'].includes(o.status),
  );
  const byHand = open.some((o) => o.status === 'by_hand');
  return (
    <Pane
      icon={ListChecks}
      title="Orders"
      count={open.length || null}
      hint={open.length ? null : 'none open'}
      defaultOpen={open.length > 0}
    >
      <div className="grid gap-2 pt-1">
        {open.length ? (
          <>
            <Table>
              <TableBody>
                {open.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>
                      <StatusBadge status={o.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Side side={o.side} /> <span className="num">{num(o.qty, 0)}</span>{' '}
                      <span className="font-medium">{o.symbol}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{o.account}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void navigate({ to: byHand ? '/orders/to-place' : '/orders/queue' })}
              >
                <ListChecks />
                {byHand ? 'Open To place' : 'Open Autopilot queue'}
              </Button>
            </div>
          </>
        ) : (
          <Hint>None open.</Hint>
        )}
      </div>
    </Pane>
  );
}

function DeleteSection({
  basket,
  overview,
  onDeleted,
}: {
  basket: Basket;
  overview: AutopilotOverview;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const money = useMoney();
  const remove = useMutation({
    mutationFn: () => deleteBasket(basket.id),
    onSuccess: () => {
      qc.setQueryData(autopilotQuery().queryKey, {
        ...overview,
        baskets: overview.baskets.filter((b) => b.id !== basket.id),
      });
      invalidate(qc);
      void qc.invalidateQueries({ queryKey: ordersQuery().queryKey });
      onDeleted();
    },
  });
  return (
    <Pane icon={Trash2} title="Delete basket">
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Hint>Its shares and cash go back to Unassigned. Nothing is sold.</Hint>
        <ConfirmDelete
          title={`Delete ${basket.name}?`}
          description={`Its shares and ${money(basket.cash)} cash go back to Unassigned and its open orders are cancelled. Nothing is sold.`}
          onConfirm={() => remove.mutate()}
        >
          <Button variant="destructive" size="sm" className="ml-auto" disabled={remove.isPending}>
            <Trash2 />
            Delete
          </Button>
        </ConfirmDelete>
        {remove.isError && <ErrorNote>{remove.error.message}</ErrorNote>}
      </div>
    </Pane>
  );
}

// ── Move cash ──

const UNASSIGNED = '_unassigned';

function MoveCashDialog({
  overview,
  to: initialTo,
  onClose,
}: {
  overview: AutopilotOverview;
  to?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const money = useMoney();
  // Accounts with money to move: unassigned cash, or a sleeve.
  const accounts = overview.accounts.filter(
    (a) =>
      overview.unassigned.some((u) => u.portfolio_id === a.id && u.cash > 0) ||
      overview.baskets.some((b) => b.sleeves.some((s) => s.portfolio_id === a.id)),
  );
  const target = overview.baskets.find((b) => b.id === (initialTo ?? overview.baskets[0]?.id));
  const free = (id: string) => overview.unassigned.find((u) => u.portfolio_id === id)?.cash ?? 0;
  // Start on the target's account with the most unassigned cash.
  const firstAccount =
    [...accounts]
      .filter((a) => !target || target.sleeves.some((s) => s.portfolio_id === a.id))
      .sort((a, b) => free(b.id) - free(a.id))[0] ?? accounts[0];
  const [account, setAccount] = useState(firstAccount?.id ?? '');
  const [from, setFrom] = useState(UNASSIGNED);
  const [to, setTo] = useState(initialTo ?? overview.baskets[0]?.id ?? UNASSIGNED);
  const [amount, setAmount] = useState('');
  const [propose, setPropose] = useState(true);
  const sleeveOf = (bid: string) =>
    overview.baskets.find((b) => b.id === bid)?.sleeves.find((s) => s.portfolio_id === account);
  const unassignedCash = overview.unassigned.find((u) => u.portfolio_id === account)?.cash ?? 0;
  const available = from === UNASSIGNED ? unassignedCash : (sleeveOf(from)?.cash ?? 0);
  const amt = Math.max(0, Math.min(Number(amount) || 0, available));
  const toBasket = overview.baskets.find((b) => b.id === to);
  const canPropose = Boolean(toBasket && Object.keys(toBasket.targets).length);
  const preview = useQuery(
    movePreviewQuery(to, account, amt, canPropose && propose && amt > 0 && to !== UNASSIGNED),
  );
  const planned = canPropose && propose && amt > 0 ? (preview.data ?? []) : [];
  const move = useMutation({
    mutationFn: () =>
      moveCash({
        portfolio_id: account,
        from: from === UNASSIGNED ? null : from,
        to: to === UNASSIGNED ? null : to,
        amount: amt,
        propose: canPropose && propose,
      }),
    onSuccess: (o) => {
      qc.setQueryData(autopilotQuery().queryKey, o);
      void qc.invalidateQueries({ queryKey: ordersQuery().queryKey });
      void qc.invalidateQueries({ queryKey: ['autopilot', 'preview'] });
      onClose();
    },
  });
  // What the account holds today: each basket's sleeve and Unassigned.
  const parts = [
    ...overview.baskets.flatMap((b) => {
      const s = b.sleeves.find((x) => x.portfolio_id === account);
      return s ? [{ id: b.id, label: b.name, value: s.value }] : [];
    }),
    {
      id: UNASSIGNED,
      label: 'Unassigned',
      value: overview.unassigned.find((u) => u.portfolio_id === account)?.value ?? 0,
    },
  ];
  const before = toBasket ? (sleeveOf(to)?.value ?? 0) : 0;
  const name = (id: string) =>
    id === UNASSIGNED ? 'Unassigned' : (overview.baskets.find((b) => b.id === id)?.name ?? id);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="size-4" />
            Move cash
          </DialogTitle>
          <DialogDescription>
            Money moves between Unassigned and a basket's sleeve in one account. Nothing is sold.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="mv-account">Account</Label>
            <Select
              value={account}
              onValueChange={(v) => {
                setAccount(v);
                setFrom(UNASSIGNED);
              }}
            >
              <SelectTrigger id="mv-account" className="w-full">
                <SelectValue placeholder="Pick an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {account && (
              <div className="flex flex-wrap gap-1.5">
                {parts.map((p) => (
                  <Badge key={p.id} variant="secondary" className="font-normal">
                    {p.label} <span className="num">{money(p.value)}</span>
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="mv-from">From</Label>
              <Select value={from} onValueChange={setFrom}>
                <SelectTrigger id="mv-from" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>Unassigned · {money(unassignedCash)}</SelectItem>
                  {overview.baskets
                    .filter((b) => sleeveOf(b.id))
                    .map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name} · {money(sleeveOf(b.id)?.cash ?? 0)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mv-to">To</Label>
              <Select value={to} onValueChange={setTo}>
                <SelectTrigger id="mv-to" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {overview.baskets.map((b) => (
                    <SelectItem key={b.id} value={b.id} disabled={b.id === from}>
                      {b.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={UNASSIGNED} disabled={from === UNASSIGNED}>
                    Unassigned
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mv-amount">Amount</Label>
            <Input
              id="mv-amount"
              type="number"
              min={0}
              step={100}
              max={available}
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="num"
            />
            <span className="text-muted-foreground text-xs">
              {money(available)} available in {name(from)}
            </span>
          </div>
          {canPropose && (
            <div className="flex items-center gap-2">
              <Switch id="mv-propose" checked={propose} onCheckedChange={setPropose} />
              <Label htmlFor="mv-propose">Also propose buys to reach target weights</Label>
            </div>
          )}
          {planned.length > 0 && (
            <>
              <PlannedTable orders={planned} />
              <Hint>
                Replaces {toBasket?.name}'s open orders. The sleeve keeps its gains from here on;
                nothing moves back unless you move it.
              </Hint>
            </>
          )}
          {move.isError && <ErrorNote>{move.error.message}</ErrorNote>}
        </div>
        <DialogFooter className="items-center">
          {toBasket && (
            <span className="num mr-auto text-muted-foreground text-xs">
              {toBasket.name} {money(before)} → {money(before + amt)}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!account || amt <= 0 || from === to || move.isPending}
            onClick={() => move.mutate()}
          >
            <ArrowLeftRight />
            {planned.length ? `Move, propose ${planned.length}` : 'Move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Orders ──

type OrdersTile = 'queue' | 'to-place' | 'filled' | 'all';
const TILE_PATH: Record<OrdersTile, string> = {
  queue: '/orders/queue',
  'to-place': '/orders/to-place',
  filled: '/orders/history',
  all: '/orders/history',
};
const TILE_TITLE: Record<OrdersTile, string> = {
  queue: 'Autopilot queue',
  'to-place': 'To place',
  filled: 'Order history',
  all: 'Order history',
};
const MONTH_MS = 30 * 86_400_000;
const inTile = (t: OrdersTile, o: Order) =>
  t === 'all'
    ? true
    : t === 'queue'
      ? o.status === 'proposed' || o.status === 'approved'
      : t === 'to-place'
        ? o.status === 'by_hand'
        : o.status === 'filled' && Date.now() - Date.parse(o.updated_at) < MONTH_MS;

function ordersDomain(
  act: (ids: string[], action: OrderAction) => void,
  busy: boolean,
  when: (iso: string | null) => string,
): ViewDomain<Order> {
  return {
    id: 'orders',
    rowKey: (o) => o.id,
    text: (o) => [o.basket, o.symbol, o.account],
    fields: [
      {
        key: 'status',
        label: 'Status',
        icon: ListChecks,
        value: (o) => STATUS_LABEL[o.status],
        format: 'text',
        filterable: true,
        groupable: true,
        render: (o) => <StatusBadge status={o.status} />,
      },
      {
        key: 'basket',
        label: 'Basket',
        icon: ShoppingBasket,
        value: (o) => o.basket,
        format: 'text',
        filterable: true,
        groupable: true,
      },
      {
        key: 'account',
        label: 'Account',
        icon: Wallet,
        value: (o) => o.account,
        format: 'text',
        filterable: true,
        groupable: true,
      },
      {
        key: 'side',
        label: 'Side',
        icon: ArrowLeftRight,
        value: (o) => (o.side === 'buy' ? 'Buy' : 'Sell'),
        format: 'text',
        filterable: true,
        render: (o) => <Side side={o.side} />,
      },
      {
        key: 'symbol',
        label: 'Symbol',
        icon: Tag,
        value: (o) => o.symbol,
        format: 'text',
        filterable: true,
        render: (o) => <span className="font-semibold">{o.symbol}</span>,
      },
      { key: 'qty', label: 'Qty', icon: Hash, value: (o) => o.qty, format: 'integer' },
      {
        key: 'type',
        label: 'Type',
        icon: Target,
        value: (o) => (o.send_at ? 'Limit @ mid' : null),
        format: 'text',
      },
      {
        key: 'amount',
        label: 'Est. amount',
        icon: Scale,
        value: (o) => amountOf(o),
        format: 'price',
        amount: true,
        aggregate: 'sum',
      },
      {
        key: 'send_at',
        label: 'Send at',
        icon: Clock,
        value: (o) => o.send_at,
        format: 'text',
        render: (o) => <span className="num whitespace-nowrap">{when(o.send_at)}</span>,
      },
      {
        key: 'via',
        label: 'Via',
        icon: Bot,
        value: (o) => (o.via && o.send_at ? VIA_LABEL[o.via] : 'By hand'),
        format: 'text',
        filterable: true,
        render: (o) => <TradingBadge via={o.via} tradeable={Boolean(o.send_at)} />,
      },
      {
        key: 'action',
        label: '',
        icon: Check,
        value: () => null,
        format: 'text',
        render: (o) =>
          o.status === 'by_hand' ? (
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                act([o.id], 'placed');
              }}
            >
              <Check />
              Placed
            </Button>
          ) : o.status === 'approved' ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                act([o.id], 'undo');
              }}
            >
              <Undo2 />
              Undo
            </Button>
          ) : null,
      },
    ],
  };
}

const ORDERS_CONFIG: CustomViewConfig = {
  name: 'Orders',
  ...customViewConfigSchema.parse({
    shape: 'table',
    columns: [
      'side',
      'qty',
      'symbol',
      'amount',
      'status',
      'account',
      'basket',
      'type',
      'send_at',
      'via',
      'action',
    ],
    icon: 'list-checks',
    group: { fields: ['status', 'basket', 'account'], default: null },
    filters: { fields: ['status', 'basket', 'account', 'side', 'symbol', 'via'], default: [] },
  }),
};

const TILE_NOTE: Record<OrdersTile, string> = {
  queue:
    'Orders for tradeable accounts wait here for your Approve. Approved orders are meant to send at the next window, 5 min after the open, as limit orders at mid. Sending is not switched on yet: nothing reaches a broker.',
  'to-place':
    'Orders for read-only accounts, or ones with Trading off in Settings ▸ Brokers and accounts. Place them yourself, then tick Placed.',
  filled: 'Orders filled in the last 30 days.',
  all: 'Every order Autopilot has proposed.',
};

function OrdersBody({ tile }: { tile: OrdersTile }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const money = useMoney();
  const when = useWhen();
  const orders = useQuery(ordersQuery());
  const overview = useQuery(autopilotQuery());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const act = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: OrderAction }) =>
      actOnOrders(ids, action),
    onSuccess: () => {
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ordersQuery().queryKey });
      invalidate(qc);
    },
  });
  const all = orders.data ?? [];
  const rows = all.filter((o) => inTile(tile, o));
  const domain = useMemo(
    () => ordersDomain((ids, action) => act.mutate({ ids, action }), act.isPending, when),
    [act.mutate, act.isPending, when],
  );
  const picked = rows.filter((o) => selected.has(o.id) && o.status === 'proposed');
  const net = picked.reduce((t, o) => t - amountOf(o), 0);
  const count = (t: OrdersTile) => all.filter((o) => inTile(t, o)).length;
  const next = overview.data?.next_window ?? null;
  return (
    <CustomViewPage
      key={tile}
      crumbs={[{ label: 'Autopilot', to: '/autopilot' }, { label: TILE_TITLE[tile] }]}
      domain={domain}
      config={ORDERS_CONFIG}
      rows={rows}
      selection={tile === 'queue' ? { keys: selected, onChange: setSelected } : undefined}
      onOpen={(o) => void navigate({ to: '/baskets/$id', params: { id: o.basket_id } })}
      rowTitle={(o) => `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.qty} ${o.symbol}`}
      actions={
        picked.length > 0 && (
          <>
            <span className="num hidden text-muted-foreground text-xs md:inline">
              {picked.length} selected · Net cash {net < 0 ? '−' : '+'}
              {money(Math.abs(net))}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={act.isPending}
              onClick={() => act.mutate({ ids: picked.map((o) => o.id), action: 'reject' })}
            >
              <X />
              <span className="max-md:sr-only">Reject</span>
            </Button>
            <Button
              size="sm"
              disabled={act.isPending}
              onClick={() => act.mutate({ ids: picked.map((o) => o.id), action: 'approve' })}
            >
              <Check />
              Approve {picked.length}
            </Button>
          </>
        )
      }
      intro={
        <div className="grid gap-2">
          <TileToggleGroup
            label="Orders"
            selected={tile}
            onSelect={(t) =>
              void navigate({
                to: TILE_PATH[t as OrdersTile],
                search: t === 'all' ? { show: 'all' } : {},
              })
            }
            options={[
              { id: 'queue', label: 'Autopilot queue', value: count('queue') },
              { id: 'to-place', label: 'To place', value: count('to-place') },
              { id: 'filled', label: 'Filled · 30d', value: count('filled') },
              { id: 'all', label: 'All', value: all.length },
            ]}
          />
          <Hint>{TILE_NOTE[tile]}</Hint>
          {act.isError && <ErrorNote>{act.error.message}</ErrorNote>}
        </div>
      }
      state={
        orders.data ? undefined : orders.isError ? (
          <ErrorNote>{orders.error.message}</ErrorNote>
        ) : (
          <Skeleton className="h-96 w-full" />
        )
      }
      status={next && <StatusItem label="Next window" value={when(next)} />}
    />
  );
}

export function QueuePage() {
  return <OrdersBody tile="queue" />;
}
export function ToPlacePage() {
  return <OrdersBody tile="to-place" />;
}
export function HistoryPage() {
  const { show } = useSearch({ from: '/orders/history' });
  return <OrdersBody tile={show === 'all' ? 'all' : 'filled'} />;
}

// ── Setup flow ──

interface AccountDraft {
  on: boolean;
  /** Shares moved in from Unassigned, per symbol. */
  shares: Record<string, number>;
  cash: number;
}
const STEPS = ['Stocks', 'Accounts & money', 'Trades'] as const;

function SetupBody({ basket, overview }: { basket?: Basket; overview: AutopilotOverview }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const money = useMoney();
  const [step, setStep] = useState(1);
  const [name, setName] = useState(basket?.name ?? '');
  const [targets, setTargets] = useState<Record<string, number>>(basket?.targets ?? {});
  const [rebalance, setRebalance] = useState<Rebalance>(basket?.rebalance ?? 'quarterly');
  const [drift, setDrift] = useState(basket?.drift ?? 0);
  const [mode, setMode] = useState<BasketMode>(basket?.mode ?? 'suggest');
  const [add, setAdd] = useState('');
  const [accounts, setAccounts] = useState<Record<string, AccountDraft>>(() =>
    Object.fromEntries(
      overview.accounts.map((a) => [
        a.id,
        { on: Boolean(basket?.sleeves.some((s) => s.portfolio_id === a.id)), shares: {}, cash: 0 },
      ]),
    ),
  );
  const keys = Object.keys(targets);
  const sum = Object.values(targets).reduce((a, b) => a + b, 0);
  const quotes = useQuery(quotesQuery(keys));
  const priceOf = (k: string) => {
    const q = quotes.data?.quotes[k];
    return q && 'last' in q ? q.last : null;
  };
  // Each sleeve as it will be: what it already holds (editing) plus what moves in.
  const sleeves = overview.accounts.flatMap((a) => {
    const d = accounts[a.id];
    if (!d?.on) return [];
    const had = basket?.sleeves.find((s) => s.portfolio_id === a.id);
    const shares: Record<string, number> = { ...(had?.shares ?? {}) };
    for (const [k, q] of Object.entries(d.shares)) if (q > 0) shares[k] = (shares[k] ?? 0) + q;
    return [{ portfolio_id: a.id, shares, cash: (had?.cash ?? 0) + d.cash }];
  });
  const draft = useQuery({
    queryKey: ['autopilot', 'draft', JSON.stringify({ targets, sleeves })],
    queryFn: () => draftBasket({ targets, sleeves }),
    enabled: step === 3,
  });
  const error =
    step === 1 && !name.trim()
      ? 'Give the basket a name.'
      : step === 1 && !keys.length
        ? 'Add at least one stock.'
        : step === 1 && Math.abs(sum - 100) > 0.05
          ? `Weights add up to ${num(sum, 1)}%. Make them 100%.`
          : step === 2 && !sleeves.length
            ? 'Pick at least one account.'
            : null;
  const [tried, setTried] = useState(false);
  const planned = draft.data ?? [];
  const finish = useMutation({
    mutationFn: async () => {
      const input = { name: name.trim(), targets, rebalance, drift, mode, sleeves };
      const saved = basket ? await updateBasket(basket.id, input) : await createBasket(input);
      if (mode === 'suggest' && planned.length) await rebalanceBasket(saved.id);
      return saved;
    },
    onSuccess: (saved) => {
      invalidate(qc);
      void qc.invalidateQueries({ queryKey: ordersQuery().queryKey });
      void navigate({ to: '/baskets/$id', params: { id: saved.id } });
    },
  });
  const addTicker = () => {
    const t = add.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(t) || targets[t] !== undefined) return;
    setTargets({ ...targets, [t]: 0 });
    setAdd('');
  };
  const equal = () => {
    if (!keys.length) return;
    const w = Math.floor(1000 / keys.length) / 10;
    const rest = Math.round((100 - w * (keys.length - 1)) * 10) / 10;
    setTargets(Object.fromEntries(keys.map((k, i) => [k, i === keys.length - 1 ? rest : w])));
  };
  const next = () => {
    setTried(true);
    if (error) return;
    setTried(false);
    setStep(step + 1);
  };
  const title = basket ? `Edit ${basket.name}` : 'New basket';
  const buys = planned.filter((o) => o.side === 'buy').reduce((t, o) => t + o.qty * o.price, 0);
  const sells = planned.filter((o) => o.side === 'sell').reduce((t, o) => t + o.qty * o.price, 0);
  const cashIn = sleeves.reduce((t, s) => t + s.cash, 0);
  const value =
    cashIn +
    sleeves.reduce(
      (t, s) => t + Object.entries(s.shares).reduce((v, [k, q]) => v + q * (priceOf(k) ?? 0), 0),
      0,
    );
  const readOnly = sleeves
    .map((s) => overview.accounts.find((a) => a.id === s.portfolio_id))
    .filter((a) => a && !a.tradeable)
    .map((a) => a?.name);
  return (
    <Page crumbs={[{ label: 'Autopilot', to: '/autopilot' }, { label: title }]} className="pb-24">
      <div className="mx-auto grid w-full max-w-2xl gap-5">
        <nav aria-label="Steps" className="flex items-center gap-1">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-1">
              {i > 0 && <ChevronRight className="size-4 text-muted-foreground" />}
              <Button
                variant={step === i + 1 ? 'secondary' : 'ghost'}
                size="sm"
                disabled={i + 1 > step}
                aria-current={step === i + 1 ? 'step' : undefined}
                onClick={() => setStep(i + 1)}
              >
                <Badge
                  variant={step > i + 1 ? 'default' : step === i + 1 ? 'default' : 'outline'}
                  className="size-5 rounded-full p-0"
                >
                  {step > i + 1 ? <Check /> : i + 1}
                </Badge>
                <span className={cn(step !== i + 1 && 'max-md:hidden')}>{s}</span>
              </Button>
            </div>
          ))}
        </nav>

        {step === 1 && (
          <section className="grid gap-4">
            <h2 className="font-semibold text-base">
              Name it and pick the stocks and their weights
            </h2>
            <div className="grid gap-1.5">
              <Label htmlFor="su-name">Name</Label>
              <Input
                id="su-name"
                placeholder="e.g. chips"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="max-w-xs"
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stock</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Weight %</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k}>
                    <TableCell className="font-semibold">{k}</TableCell>
                    <TableCell className="num text-right text-muted-foreground">
                      {priceOf(k) === null ? DASH : `$${num(priceOf(k), 2)}`}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={0.5}
                        aria-label={`${k} weight`}
                        value={targets[k]}
                        onChange={(e) =>
                          setTargets({ ...targets, [k]: Number(e.target.value) || 0 })
                        }
                        className="num ml-auto h-7 w-20 text-right"
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Remove ${k}`}
                        onClick={() => {
                          const { [k]: _, ...rest } = targets;
                          setTargets(rest);
                        }}
                      >
                        <X />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>Total</TableCell>
                  <TableCell />
                  <TableCell
                    className={cn(
                      'num text-right',
                      Math.abs(sum - 100) > 0.05 ? 'text-warning' : 'text-gain',
                    )}
                  >
                    {num(sum, 1)}%
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                addTicker();
              }}
            >
              <Input
                aria-label="Ticker"
                placeholder="Add a ticker, e.g. TSM"
                value={add}
                onChange={(e) => setAdd(e.target.value)}
                className="num max-w-48"
              />
              <Button type="submit" variant="outline" size="sm">
                <Plus />
                Add
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={equal}>
                <Scale />
                Equal weights
              </Button>
            </form>
            <div className="grid gap-1.5">
              <Label>Rebalance</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={rebalance}
                onValueChange={(v) => v && setRebalance(v as Rebalance)}
              >
                {(['monthly', 'quarterly', 'yearly'] as const).map((r) => (
                  <ToggleGroupItem key={r} value={r}>
                    {REBALANCE_LABEL[r]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <div className="grid gap-1.5">
              <Label>Also on drift</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={String(drift)}
                onValueChange={(v) => v && setDrift(Number(v))}
              >
                {DRIFT_OPTIONS.map((d) => (
                  <ToggleGroupItem key={d} value={String(d)}>
                    {d ? `±${d} pts` : 'Off'}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <Hint icon={CalendarClock}>
              Rebalances on the first trading day of each {PERIOD[rebalance]}
              {drift ? `, or sooner if any weight drifts more than ±${drift} pts` : ''}.
            </Hint>
          </section>
        )}

        {step === 2 && (
          <section className="grid gap-3">
            <h2 className="font-semibold text-base">
              Choose the accounts and the money that goes in
            </h2>
            <p className="text-muted-foreground text-sm">
              A basket can live in one account or several. In each, bring shares you already own and
              cash that isn't in a basket yet.
            </p>
            {overview.accounts.map((a) => {
              const d = accounts[a.id] ?? { on: false, shares: {}, cash: 0 };
              const un = overview.unassigned.find((u) => u.portfolio_id === a.id);
              const had = basket?.sleeves.find((s) => s.portfolio_id === a.id);
              const own = keys.filter((k) =>
                un?.holdings.some((h) => h.symbol === k && h.shares > 0),
              );
              const elsewhere = overview.baskets
                .filter((b) => b.id !== basket?.id)
                .flatMap((b) =>
                  keys.flatMap((k) => {
                    const q = b.sleeves.find((s) => s.portfolio_id === a.id)?.shares[k];
                    return q ? [`${num(q, 0)} ${k} in ${b.name}`] : [];
                  }),
                );
              const set = (patch: Partial<AccountDraft>) =>
                setAccounts({ ...accounts, [a.id]: { ...d, ...patch } });
              const sleeve = sleeves.find((s) => s.portfolio_id === a.id);
              return (
                <div
                  key={a.id}
                  className={cn('rounded-lg border', d.on && 'border-primary/40 bg-primary/5')}
                >
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                    <Checkbox
                      id={`su-acct-${a.id}`}
                      checked={d.on}
                      onCheckedChange={(v) => set({ on: v === true })}
                    />
                    <Label htmlFor={`su-acct-${a.id}`} className="font-semibold">
                      {a.name}
                    </Label>
                    {a.tradeable && a.via ? (
                      <Badge variant="secondary" className="font-normal">
                        Trades via {VIA_LABEL[a.via]}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="font-normal text-muted-foreground">
                        Read-only: you place trades
                      </Badge>
                    )}
                    {d.on && sleeve && (
                      <span className="num ml-auto text-sm">
                        {money(
                          sleeve.cash +
                            Object.entries(sleeve.shares).reduce(
                              (v, [k, q]) => v + q * (priceOf(k) ?? 0),
                              0,
                            ),
                        )}
                      </span>
                    )}
                  </div>
                  {d.on && (
                    <div className="grid gap-2 border-t px-3 py-2.5 pl-9 text-sm">
                      {had && (
                        <p className="flex items-center gap-1.5 text-muted-foreground">
                          <ShoppingBasket className="size-3.5" />
                          Already in {basket?.name}:{' '}
                          {Object.entries(had.shares)
                            .filter(([, q]) => q)
                            .map(([k, q]) => `${num(q, 0)} ${k}`)
                            .join(', ') || 'no shares'}{' '}
                          + {money(had.cash)} cash
                        </p>
                      )}
                      {own.map((k) => {
                        const free = un?.holdings.find((h) => h.symbol === k)?.shares ?? 0;
                        const q = d.shares[k];
                        const on = q !== undefined;
                        return (
                          <div key={k} className="flex flex-wrap items-center gap-2">
                            <Checkbox
                              id={`su-sh-${a.id}-${k}`}
                              checked={on}
                              onCheckedChange={(v) => {
                                const { [k]: _, ...rest } = d.shares;
                                set({ shares: v === true ? { ...rest, [k]: free } : rest });
                              }}
                            />
                            <Label htmlFor={`su-sh-${a.id}-${k}`} className="font-normal">
                              Move in my <b>{k}</b> shares
                            </Label>
                            <Input
                              type="number"
                              min={0}
                              max={free}
                              aria-label={`${k} shares`}
                              disabled={!on}
                              value={on ? q : free}
                              onChange={(e) =>
                                set({
                                  shares: {
                                    ...d.shares,
                                    [k]: Math.min(free, Math.max(0, Number(e.target.value) || 0)),
                                  },
                                })
                              }
                              className="num h-7 w-24 text-right"
                            />
                            <span className="text-muted-foreground text-xs">
                              of {num(free, 0)} unassigned ·{' '}
                              {money((on ? q : free) * (priceOf(k) ?? 0))}
                            </span>
                          </div>
                        );
                      })}
                      {elsewhere.map((t) => (
                        <p key={t} className="flex items-center gap-1.5 text-muted-foreground">
                          <Lock className="size-3.5" />
                          {t} stays there
                        </p>
                      ))}
                      <div className="flex flex-wrap items-center gap-2">
                        <Label htmlFor={`su-cash-${a.id}`} className="font-normal">
                          Cash in
                        </Label>
                        <Input
                          id={`su-cash-${a.id}`}
                          type="number"
                          min={0}
                          step={100}
                          max={un?.cash ?? 0}
                          value={d.cash || ''}
                          placeholder="0"
                          onChange={(e) =>
                            set({
                              cash: Math.min(
                                un?.cash ?? 0,
                                Math.max(0, Number(e.target.value) || 0),
                              ),
                            })
                          }
                          className="num h-7 w-28 text-right"
                        />
                        <span className="text-muted-foreground text-xs">
                          of {money(un?.cash ?? 0)} unassigned
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <Hint>
              Moving money in sells nothing. The sleeve then keeps its own gains and losses.
            </Hint>
          </section>
        )}

        {step === 3 && (
          <section className="grid gap-4">
            <h2 className="font-semibold text-base">Trades to reach the weights</h2>
            <TileRow>
              <Tile label="Basket value" value={money(value)} />
              <Tile
                label="Buys"
                value={money(buys)}
                valueClassName={buys ? 'text-gain' : undefined}
              />
              <Tile
                label="Sells"
                value={money(sells)}
                valueClassName={sells ? 'text-loss' : undefined}
              />
              <Tile label="Cash left" value={money(Math.max(0, cashIn - buys + sells))} />
            </TileRow>
            {!draft.data ? (
              draft.isError ? (
                <ErrorNote>{draft.error.message}</ErrorNote>
              ) : (
                <Skeleton className="h-32 w-full" />
              )
            ) : (
              sleeves.map((s) => {
                const a = overview.accounts.find((x) => x.id === s.portfolio_id);
                const mine = planned.filter((o) => o.portfolio_id === s.portfolio_id);
                return (
                  <div key={s.portfolio_id} className="grid gap-1">
                    <div className="flex items-center gap-2 font-medium text-sm">
                      {a?.name}
                      <TradingBadge via={a?.via ?? null} tradeable={Boolean(a?.tradeable)} />
                    </div>
                    {mine.length ? (
                      <PlannedTable orders={mine} />
                    ) : (
                      <Hint>Nothing to trade here.</Hint>
                    )}
                  </div>
                );
              })
            )}
            <div className="grid gap-1.5">
              <Label>Mode</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={mode}
                onValueChange={(v) => v && setMode(v as BasketMode)}
              >
                <ToggleGroupItem value="off">
                  <CircleDashed />
                  Off
                </ToggleGroupItem>
                <ToggleGroupItem value="suggest">
                  <Hand />
                  Suggest
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <Hint>
              {mode === 'off'
                ? 'No orders: the basket only tracks value and drift.'
                : 'Tradeable accounts: these wait in Autopilot queue for your Approve. Read-only accounts: To place.'}
            </Hint>
            {readOnly.length > 0 && (
              <Hint icon={Lock}>
                {readOnly.join(', ')} {readOnly.length > 1 ? 'are' : 'is'} read-only, so its trades
                go to To place.
              </Hint>
            )}
          </section>
        )}

        {tried && error && <p className="text-sm text-warning">{error}</p>}
        {finish.isError && <ErrorNote>{finish.error.message}</ErrorNote>}

        <div className="flex items-center gap-2 border-t pt-4">
          {step > 1 ? (
            <Button variant="outline" size="sm" onClick={() => setStep(step - 1)}>
              <ChevronLeft />
              Back
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void (basket
                  ? navigate({ to: '/baskets/$id', params: { id: basket.id } })
                  : navigate({ to: '/autopilot' }))
              }
            >
              Cancel
            </Button>
          )}
          {step < 3 ? (
            <Button size="sm" className="ml-auto" onClick={next}>
              Next
              <ChevronRight />
            </Button>
          ) : (
            <Button
              size="sm"
              className="ml-auto"
              disabled={finish.isPending || !draft.data}
              onClick={() => finish.mutate()}
            >
              <Check />
              {basket ? 'Save' : 'Create basket'}
              {mode === 'suggest' && planned.length ? ` · propose ${planned.length}` : ''}
            </Button>
          )}
        </div>
      </div>
    </Page>
  );
}

function SetupById({ id }: { id?: string }) {
  const overview = useQuery(autopilotQuery());
  const o = overview.data;
  const basket = id ? o?.baskets.find((b) => b.id === id) : undefined;
  if (!o || (id && !basket))
    return (
      <Page crumbs={[{ label: 'Autopilot', to: '/autopilot' }, { label: id ? '…' : 'New basket' }]}>
        {overview.isError ? (
          <ErrorNote>{overview.error.message}</ErrorNote>
        ) : o ? (
          <ErrorNote>No basket with this id. It may have been deleted.</ErrorNote>
        ) : (
          <Skeleton className="h-96 w-full" />
        )}
      </Page>
    );
  return <SetupBody key={id ?? 'new'} basket={basket} overview={o} />;
}

/** `/baskets/new`: the 3-step setup. */
export function NewBasketPage() {
  return <SetupById />;
}

/** `/baskets/$id/edit`: the same steps over a basket. */
export function EditBasketPage() {
  const { id } = useParams({ from: '/baskets/$id/edit' });
  return <SetupById id={id} />;
}
