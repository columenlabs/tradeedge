import { Lever, RangeToggle, ivLabel, valueOnLabel } from '@/components/levers';
import { useNewTrade } from '@/components/new-trade';
import { OverlayChart, Sparkline } from '@/components/payoff-chart';
import { Ticker } from '@/components/ticker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Toggle } from '@/components/ui/toggle';
import { expirationsQuery } from '@/lib/api';
import { DASH, num, pct, signed, timePT, usd, usdPlain } from '@/lib/format';
import { daysTo } from '@/lib/saved';
import { type Analysis, DEFAULT_IV, TRADE_MIN_DTE, analyze, greeksAt } from '@/lib/strategy';
import { type Hydrated, useHydrated, type useHydratedTrades } from '@/lib/use-trades';
import { cn } from '@/lib/utils';
import { type Crumb, Page, StatusItem } from '@edgedesk/app-shell';
import { Checkbox } from '@edgedesk/app-shell/ui/checkbox';
import { useSidebar } from '@edgedesk/app-shell/ui/sidebar';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowDown, Bot, Plus, User } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { ErrorNote } from './chain';

type SortKey = 'net' | 'maxProfit' | 'maxLoss' | 'pop' | 'theta';

interface Row {
  s: Hydrated;
  a: Analysis;
  g: { delta: number; theta: number; vega: number };
}

const bound = (v: number | 'unlimited', sign: 1 | -1) =>
  v === 'unlimited' ? sign * Number.POSITIVE_INFINITY : v;

/** Earliest option expiry across a trade's legs. */
export const frontExpiration = (s: { legs: { expiration?: number }[] }) =>
  Math.min(...s.legs.flatMap((l) => (l.expiration ? [l.expiration] : [])));

/** `/trades/$symbol`: every saved trade on one underlying, on one payoff chart and a table. */
export function BoardPage() {
  const { symbol } = useParams({ from: '/trades/$symbol' });
  const navigate = useNavigate();
  const { open } = useNewTrade();
  const h = useHydrated(symbol);
  const byAgent = h.trades.filter((s) => s.written_by === 'agent').length;
  return (
    <TradeBoard
      symbol={symbol}
      h={h}
      crumbs={[{ label: 'Trades', name: 'Trades' }, { label: symbol }]}
      actions={
        <Button size="sm" onClick={() => open({ symbol })}>
          <Plus />
          New
        </Button>
      }
      count={`${h.trades.length} trades`}
      byAgent={byAgent}
      onOpen={(s) => navigate({ to: '/trades/$symbol/$id', params: { symbol, id: s.id } })}
      empty={
        <Card>
          <CardHeader>
            <CardTitle>No trades on {symbol} yet</CardTitle>
            <CardDescription>
              Ask an agent to build some through the TradeEdge MCP (trade_write), or start one from
              a strategy.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button size="sm" onClick={() => open({ symbol })}>
              <Plus />
              New trade
            </Button>
          </CardContent>
        </Card>
      }
    />
  );
}

/**
 * One underlying's trades on one payoff chart with What-if levers and a sortable compare table
 * (the Board, Bikram 2026-10-08). The Trades board and a symbol's screeners both show it.
 */
export function TradeBoard({
  symbol,
  h,
  crumbs,
  actions,
  count,
  byAgent,
  onOpen,
  empty,
}: {
  symbol: string;
  h: ReturnType<typeof useHydratedTrades>;
  crumbs: Crumb[];
  actions?: ReactNode;
  count: string;
  byAgent: number;
  onOpen: (s: Hydrated) => void;
  empty: ReactNode;
}) {
  const { isMobile } = useSidebar();
  const exps = useQuery(expirationsQuery(symbol));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [days, setDays] = useState<number | null>(null);
  const [ivScale, setIvScale] = useState(1);
  const [range, setRange] = useState(10);
  const [sort, setSort] = useState<SortKey>('pop');

  const spot = h.spot;
  const iv = h.iv ?? DEFAULT_IV;
  const rows = useMemo<Row[]>(() => {
    if (!spot) return [];
    return h.trades.flatMap((s) => {
      const a = analyze(s.live, spot, { days: 0, ivScale, fill: 0, fallbackIv: iv });
      return a ? [{ s, a, g: greeksAt(a, spot, 0, ivScale, iv) }] : [];
    });
  }, [h.trades, spot, ivScale, iv]);
  const maxFront = Math.max(0, ...rows.map((r) => r.a.frontDte));
  const valueOn = days ?? maxFront;
  const sorted = useMemo(() => {
    const key: Record<SortKey, (r: Row) => number> = {
      net: (r) => r.a.net,
      maxProfit: (r) => bound(r.a.maxProfit, 1),
      maxLoss: (r) => bound(r.a.maxLoss, -1),
      pop: (r) => r.a.pop,
      theta: (r) => r.g.theta,
    };
    return [...rows].sort((x, y) => key[sort](y) - key[sort](x));
  }, [rows, sort]);

  const firstExp = h.trades[0] ? frontExpiration(h.trades[0]) : null;
  const expiration =
    firstExp && Number.isFinite(firstExp)
      ? firstExp
      : ((exps.data?.expirations ?? []).find((x) => daysTo(x) >= TRADE_MIN_DTE) ?? null);
  const lines = sorted
    .filter((r) => !hidden.has(r.s.id))
    .map((r) => ({ id: r.s.id, name: r.s.name, color: r.s.color, analysis: r.a }));
  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openRow = onOpen;

  return (
    <Page
      crumbs={crumbs}
      actions={actions}
      status={
        <>
          <StatusItem label="Quotes" value="live" ok={spot !== null} />
          <StatusItem label={count} value={`· ${byAgent} by an agent`} />
        </>
      }
    >
      <Ticker symbol={symbol} quote={h.quote} iv={h.iv} expiration={expiration} />
      {h.error ? <ErrorNote>{h.error.message}</ErrorNote> : null}
      {h.isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : rows.length === 0 ? (
        empty
      ) : spot ? (
        <>
          <Card className="gap-3">
            <CardHeader>
              <CardTitle>Payoff</CardTitle>
              <CardDescription className="num text-xs">
                {valueOn >= maxFront
                  ? `At expiry · ${valueOnLabel(maxFront, maxFront).replace('Expiry · ', '')}`
                  : `On ${valueOnLabel(valueOn, maxFront).split(' · ')[0]} · IV ${num(iv * ivScale * 100, 1)}%`}{' '}
                · 1 lot each
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 md:flex-wrap">
                {sorted.map((r) => (
                  <Toggle
                    key={r.s.id}
                    size="sm"
                    variant="outline"
                    pressed={!hidden.has(r.s.id)}
                    onPressedChange={() => toggle(r.s.id)}
                    aria-label={`Show ${r.s.name}`}
                    className="shrink-0 rounded-full data-[state=off]:opacity-55"
                  >
                    <span className="size-2 rounded-full" style={{ background: r.s.color }} />
                    {r.s.name}
                  </Toggle>
                ))}
              </div>
              <OverlayChart lines={lines} spot={spot} range={range / 100} days={valueOn} />
              <div className="grid gap-4 border-t pt-3 md:grid-cols-[1fr_1fr_auto]">
                <Lever
                  label="Value on"
                  value={valueOn}
                  min={0}
                  max={maxFront}
                  current={valueOnLabel(valueOn, maxFront)}
                  onChange={setDays}
                />
                <Lever
                  label="Implied vol"
                  value={Math.round((ivScale - 1) * 100)}
                  min={-50}
                  max={100}
                  current={ivLabel(iv, ivScale)}
                  onChange={(v) => setIvScale(1 + v / 100)}
                />
                {isMobile ? null : <RangeToggle value={range} onChange={setRange} />}
              </div>
            </CardContent>
          </Card>
          {isMobile ? (
            <PhoneList rows={sorted} spot={spot} onOpen={openRow} />
          ) : (
            <CompareTable
              rows={sorted}
              spot={spot}
              hidden={hidden}
              onToggle={toggle}
              sort={sort}
              onSort={setSort}
              onOpen={openRow}
            />
          )}
        </>
      ) : null}
    </Page>
  );
}

const SORTABLE: { key: SortKey; label: string }[] = [
  { key: 'net', label: 'Net' },
  { key: 'maxProfit', label: 'Max profit' },
  { key: 'maxLoss', label: 'Max loss' },
  { key: 'pop', label: 'POP' },
  { key: 'theta', label: 'Θ/day' },
];

const fmtBound = (v: number | 'unlimited') => (v === 'unlimited' ? 'Unlimited' : usdPlain(v));
const beText = (a: Analysis) =>
  a.breakevens.length ? a.breakevens.map((b) => num(b)).join(' · ') : DASH;

function By({ s }: { s: Hydrated }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      {s.written_by === 'agent' ? <Bot className="size-3.5" /> : <User className="size-3.5" />}
      {s.written_by === 'agent' ? 'Agent' : 'You'} · {timePT(s.updated_at).slice(0, 5)}
    </span>
  );
}

function CompareTable({
  rows,
  spot,
  hidden,
  onToggle,
  sort,
  onSort,
  onOpen,
}: {
  rows: Row[];
  spot: number;
  hidden: Set<string>;
  onToggle: (id: string) => void;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  onOpen: (s: Hydrated) => void;
}) {
  const head = (key: SortKey) => {
    const col = SORTABLE.find((c) => c.key === key);
    return (
      <TableHead className="text-right">
        <Button
          variant="ghost"
          size="xs"
          className={cn('-mr-2 h-6 px-2 text-xs', sort === key && 'text-foreground')}
          onClick={() => onSort(key)}
          aria-label={`Sort by ${col?.label}`}
        >
          {col?.label}
          {sort === key ? <ArrowDown /> : null}
        </Button>
      </TableHead>
    );
  };
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-3">
        <CardTitle>Compare</CardTitle>
        <CardDescription className="text-xs">
          Live mids · {timePT(new Date().toISOString())} PT · click a row to open it
        </CardDescription>
      </CardHeader>
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-8" />
            <TableHead>Trade</TableHead>
            <TableHead>Payoff</TableHead>
            {head('net')}
            {head('maxProfit')}
            {head('maxLoss')}
            <TableHead className="text-right">Break-even</TableHead>
            {head('pop')}
            <TableHead className="text-right">Δ</TableHead>
            {head('theta')}
            <TableHead className="text-right">Vega</TableHead>
            <TableHead>By</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ s, a, g }) => (
            <TableRow
              key={s.id}
              data-trade={s.name}
              className={cn('cursor-pointer', hidden.has(s.id) && 'opacity-55')}
              onClick={() => onOpen(s)}
            >
              <TableCell onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={!hidden.has(s.id)}
                  onCheckedChange={() => onToggle(s.id)}
                  aria-label={`Show ${s.name} on the chart`}
                  style={
                    hidden.has(s.id) ? undefined : { background: s.color, borderColor: s.color }
                  }
                />
              </TableCell>
              <TableCell className="font-medium">{s.name}</TableCell>
              <TableCell>
                <Sparkline analysis={a} spot={spot} color={s.color} />
              </TableCell>
              <TableCell className={cn('num text-right', a.net >= 0 ? 'text-gain' : 'text-loss')}>
                {usd(a.net)}
              </TableCell>
              <TableCell className="num text-right">{fmtBound(a.maxProfit)}</TableCell>
              <TableCell className="num text-right text-loss">{fmtBound(a.maxLoss)}</TableCell>
              <TableCell className="num text-right">{beText(a)}</TableCell>
              <TableCell className="num text-right">
                <span className="inline-flex items-center gap-2">
                  <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full bg-primary"
                      style={{ width: `${a.pop * 100}%` }}
                    />
                  </span>
                  {pct(a.pop, 0)}
                </span>
              </TableCell>
              <TableCell className="num text-right">{signed(g.delta, 1)}</TableCell>
              <TableCell className={cn('num text-right', g.theta >= 0 ? 'text-gain' : 'text-loss')}>
                {signed(g.theta, 1)}
              </TableCell>
              <TableCell className="num text-right">{signed(g.vega, 0)}</TableCell>
              <TableCell>
                <By s={s} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function PhoneList({
  rows,
  spot,
  onOpen,
}: { rows: Row[]; spot: number; onOpen: (s: Hydrated) => void }) {
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-baseline gap-2">
          {rows.length} trades
          <span className="text-xs font-normal text-muted-foreground">by chance of profit</span>
        </CardTitle>
      </CardHeader>
      <ul className="divide-y">
        {[...rows]
          .sort((x, y) => y.a.pop - x.a.pop)
          .map(({ s, a }) => (
            <li key={s.id}>
              <button
                type="button"
                className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1 px-(--card-pad) py-2.5 text-left hover:bg-muted/50"
                onClick={() => onOpen(s)}
              >
                <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
                <span className="truncate text-sm font-medium">{s.name}</span>
                <Sparkline analysis={a} spot={spot} color={s.color} />
                <span />
                <span className="num col-span-2 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>
                    {a.net >= 0 ? 'Credit' : 'Debit'} {usdPlain(Math.abs(a.net))}
                  </span>
                  <span>POP {pct(a.pop, 0)}</span>
                  <span className="text-loss">Max {fmtBound(a.maxLoss)}</span>
                </span>
              </button>
            </li>
          ))}
      </ul>
    </Card>
  );
}
