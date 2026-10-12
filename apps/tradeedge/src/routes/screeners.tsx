// Options screeners (Bikram, 2026-10-10): a person's saved screeners, by symbol. A symbol's page is
// the Board (as Trades): each screener's best trade on the live chain right now, on one payoff chart
// and a compare table. A screener's page lists its ranked trades (CustomViewPage), and a trade saves
// to the Trades board. Agents keep the screeners with screener_write / screener_run.
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  type ScreenCandidate,
  type ScreenLeg,
  type Screener,
  saveTrade,
  screenerRunQuery,
  screenersQuery,
  strategiesQuery,
  tradesQuery,
} from '@/lib/api';
import { expLabel, num } from '@/lib/format';
import { COLORS, type Colored, useHydratedTrades } from '@/lib/use-trades';
import { type CustomViewConfig, CustomViewPage, type ViewDomain } from '@edgedesk/app-shell';
import { Badge } from '@edgedesk/app-shell/ui/badge';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  CalendarDays,
  CircleDollarSign,
  Gauge,
  Hash,
  Layers,
  ListFilter,
  Percent,
  Play,
  Plus,
  Scale,
  ShieldAlert,
  Sigma,
  Tag,
  Timer,
} from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { TradeBoard } from './board';
import { ErrorNote } from './chain';

/** One row: a screener and one of its trades (none when it found nothing or failed). */
interface ScreenRow {
  screener: Screener;
  strategy: string;
  rank: number;
  trade: ScreenCandidate | null;
  passing: number | null;
  error: string | null;
}

const legText = (l: ScreenLeg) =>
  l.instrument === 'stock'
    ? `${l.action === 'buy' ? '+' : '−'}${l.qty} sh`
    : `${l.action === 'buy' ? '+' : '−'}${l.qty > 1 ? l.qty : ''}${num(l.strike ?? null, l.strike !== undefined && Number.isInteger(l.strike) ? 0 : 1)}${l.instrument === 'call' ? 'C' : 'P'}`;

const legsText = (t: ScreenCandidate) => t.legs.map(legText).join(' ');

/** Trade rows of one or more screeners: the screener, the strategy and the trade's numbers. */
const screenDomain: ViewDomain<ScreenRow> = {
  id: 'screener_trades',
  rowKey: (r) => `${r.screener.id}:${r.rank}`,
  text: (r) => [r.screener.name, r.strategy],
  fields: [
    {
      key: 'screener',
      label: 'Screener',
      icon: ListFilter,
      value: (r) => r.screener.name,
      format: 'text',
      filterable: true,
      groupable: true,
    },
    {
      key: 'strategy',
      label: 'Strategy',
      icon: Layers,
      value: (r) => r.strategy,
      format: 'text',
      filterable: true,
      groupable: true,
    },
    {
      key: 'legs',
      label: 'Legs',
      icon: Tag,
      value: (r) => (r.trade ? legsText(r.trade) : (r.error ?? 'No trade passes its filters')),
      format: 'text',
    },
    {
      key: 'expiry',
      label: 'Expiry',
      icon: CalendarDays,
      value: (r) => (r.trade ? expLabel(r.trade.expiration, true) : null),
      format: 'text',
      groupable: true,
    },
    {
      key: 'dte',
      label: 'DTE',
      icon: Timer,
      value: (r) => r.trade?.dte ?? null,
      format: 'integer',
    },
    {
      key: 'premium',
      label: 'Credit',
      icon: CircleDollarSign,
      note: '+ credit, − debit, per structure',
      value: (r) => r.trade?.net_premium ?? null,
      format: 'price',
    },
    {
      key: 'max_loss',
      label: 'Max loss',
      icon: ShieldAlert,
      value: (r) => r.trade?.max_loss ?? null,
      format: 'price',
    },
    {
      key: 'pop',
      label: 'POP',
      icon: Percent,
      value: (r) => (r.trade ? r.trade.pop * 100 : null),
      format: 'weight',
    },
    {
      key: 'return_on_risk',
      label: 'Ret/risk',
      icon: Scale,
      value: (r) => (r.trade?.return_on_risk == null ? null : r.trade.return_on_risk * 100),
      format: 'weight',
    },
    {
      key: 'expected_value',
      label: 'EV',
      icon: Sigma,
      value: (r) => r.trade?.expected_value ?? null,
      format: 'signed',
    },
    {
      key: 'theta',
      label: 'Theta',
      icon: Gauge,
      note: '$ a day',
      value: (r) => r.trade?.greeks.theta ?? null,
      format: 'signed',
    },
    {
      key: 'passing',
      label: 'Matches',
      icon: Hash,
      value: (r) => r.passing,
      format: 'integer',
    },
  ],
  details: [
    {
      id: 'trade',
      label: 'Trade',
      icon: Tag,
      open: true,
      render: (r) => <TradeDetails row={r} />,
    },
  ],
};

const RESULTS: CustomViewConfig = {
  name: 'Trades',
  shape: 'table',
  formulas: [],
  columns: [
    'legs',
    'expiry',
    'dte',
    'premium',
    'max_loss',
    'pop',
    'return_on_risk',
    'expected_value',
    'theta',
  ],
  chips: [],
  icon: null,
  widgets: [],
  tiles: [],
  group: { fields: ['expiry'], default: null },
  filters: { fields: [], default: [] },
  pivot: null,
  sort: null,
};

/** The trade's legs and a button that saves it to the Trades board. */
function TradeDetails({ row }: { row: ScreenRow }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const save = useMutation({
    mutationFn: (t: ScreenCandidate) =>
      saveTrade({
        underlying: row.screener.underlying,
        name: `${row.screener.name} ${expLabel(t.expiration, true)}`,
        legs: toLegsSaved(t),
      }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: tradesQuery().queryKey });
      void navigate({ to: '/trades/$symbol/$id', params: { symbol: s.underlying, id: s.id } });
    },
  });
  const t = row.trade;
  if (!t) return <p className="text-sm text-muted-foreground">{row.error ?? 'No trade.'}</p>;
  return (
    <div className="grid gap-3">
      <ul className="grid gap-1 text-sm">
        {t.legs.map((l) => (
          <li key={`${l.action}${l.instrument}${l.strike}${l.expiration}`} className="num">
            {l.action === 'buy' ? 'Buy' : 'Sell'} {l.qty}{' '}
            {l.instrument === 'stock'
              ? 'shares'
              : `${l.strike} ${l.instrument} ${l.expiration ? expLabel(l.expiration, true) : ''}`}{' '}
            @ {num(l.price)}
          </li>
        ))}
      </ul>
      <Button size="sm" className="justify-self-start" onClick={() => save.mutate(t)}>
        <Plus />
        Save as trade
      </Button>
      {save.isError ? (
        <p role="alert" className="text-xs text-loss">
          {save.error.message}
        </p>
      ) : null}
    </div>
  );
}

/** Runs the screeners and turns each into rows: its best trade (`best`) or all its trades. */
function useScreenRows(screeners: Screener[], best: boolean) {
  const strategies = useQuery(strategiesQuery());
  const runs = useQueries({ queries: screeners.map((s) => screenerRunQuery(s.id)) });
  const names = new Map((strategies.data ?? []).map((s) => [s.id, s.name]));
  const rows = screeners.flatMap((s, i): ScreenRow[] => {
    const run = runs[i];
    const base = { screener: s, strategy: names.get(s.strategy) ?? s.strategy };
    if (!run?.data) {
      return [
        {
          ...base,
          rank: 0,
          trade: null,
          passing: null,
          error: run?.isError ? run.error.message : 'Running…',
        },
      ];
    }
    const trades = best ? run.data.results.slice(0, 1) : run.data.results;
    if (!trades.length) return [{ ...base, rank: 0, trade: null, passing: 0, error: null }];
    return trades.map((trade, rank) => ({
      ...base,
      rank,
      trade,
      passing: run.data.candidates_passing,
      error: null,
    }));
  });
  return {
    rows,
    running: runs.some((r) => r.isFetching),
    rerun: () => Promise.all(runs.map((r) => r.refetch())),
  };
}

function RunButton({
  running,
  onRun,
  label,
}: { running: boolean; onRun: () => void; label: string }) {
  return (
    <Button size="sm" variant="outline" disabled={running} onClick={onRun}>
      <Play />
      {label}
    </Button>
  );
}

function listState(q: { isPending: boolean; isError: boolean; error: Error | null }): ReactNode {
  if (q.isError) return <ErrorNote>{q.error?.message}</ErrorNote>;
  if (q.isPending) return <Skeleton className="h-96 w-full" />;
  return undefined;
}

/** A screener's pick as a trade the Board can draw: its legs at the screener's prices. */
const toLegsSaved = (t: ScreenCandidate) =>
  t.legs.map((l) => ({
    action: l.action,
    instrument: l.instrument,
    strike: l.strike,
    expiration: l.expiration,
    qty: l.qty,
    price: l.price,
    bid: l.bid ?? undefined,
    ask: l.ask ?? undefined,
  }));

/** A symbol's screeners on the Board: each one's best trade right now, on one chart and a table. */
export function ScreenerSymbolPage() {
  const { symbol } = useParams({ from: '/screeners/$symbol' });
  const navigate = useNavigate();
  const list = useQuery(screenersQuery());
  const mine = useMemo(
    () => (list.data ?? []).filter((s) => s.underlying === symbol),
    [list.data, symbol],
  );
  const runs = useQueries({ queries: mine.map((s) => screenerRunQuery(s.id)) });
  const key = runs.map((r) => r.dataUpdatedAt).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on run updates
  const picks = useMemo<Colored[]>(
    () =>
      mine.flatMap((s, i) => {
        const best = runs[i]?.data?.results[0];
        return best
          ? [
              {
                id: s.id,
                underlying: s.underlying,
                name: s.name,
                legs: toLegsSaved(best),
                note: null,
                written_by: s.written_by,
                created_at: s.created_at,
                updated_at: s.updated_at,
                color: COLORS[i % COLORS.length] as string,
              },
            ]
          : [];
      }),
    [mine, key],
  );
  const running = runs.some((r) => r.isFetching);
  const h = useHydratedTrades(
    symbol,
    picks,
    list.isPending || runs.some((r) => r.isPending),
    list.error ?? runs.find((r) => r.error)?.error ?? null,
  );
  return (
    <TradeBoard
      symbol={symbol}
      h={h}
      crumbs={[{ label: 'Screeners', name: 'Screeners' }, { label: symbol }]}
      actions={
        <RunButton
          running={running}
          onRun={() => void Promise.all(runs.map((r) => r.refetch()))}
          label="Run all"
        />
      }
      count={`${mine.length} screeners`}
      byAgent={mine.filter((s) => s.written_by === 'agent').length}
      onOpen={(s) => navigate({ to: '/screeners/$symbol/$id', params: { symbol, id: s.id } })}
      empty={
        <ErrorNote>
          {mine.length
            ? `No screener on ${symbol} finds a trade that passes its filters right now.`
            : `No screeners on ${symbol}. An agent adds them through the TradeEdge MCP (screener_write).`}
        </ErrorNote>
      }
    />
  );
}

/** One screener: its inputs and its ranked trades on the live chain. */
export function ScreenerPage() {
  const { symbol, id } = useParams({ from: '/screeners/$symbol/$id' });
  const list = useQuery(screenersQuery());
  const screener = list.data?.find((s) => s.id === id);
  const one = useMemo(() => (screener ? [screener] : []), [screener]);
  const { rows, running, rerun } = useScreenRows(one, false);
  const inputs = Object.entries(screener?.inputs ?? {});
  return (
    <CustomViewPage
      crumbs={[
        { label: 'Screeners' },
        { label: symbol, to: `/screeners/${symbol}` },
        { label: screener?.name ?? '…' },
      ]}
      domain={screenDomain}
      config={RESULTS}
      rows={rows}
      rowTitle={(r) =>
        r.trade ? `${legsText(r.trade)} · ${expLabel(r.trade.expiration, true)}` : ''
      }
      actions={<RunButton running={running} onRun={() => void rerun()} label="Run" />}
      intro={
        screener ? (
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{rows[0]?.strategy ?? screener.strategy}</Badge>
            {inputs.map(([k, v]) => (
              <Badge key={k} variant="outline" className="num font-normal">
                {k} {Array.isArray(v) ? v.join(', ') : String(v)}
              </Badge>
            ))}
          </div>
        ) : null
      }
      state={
        listState(list) ??
        (screener ? undefined : (
          <ErrorNote>No screener with this id. It may have been deleted.</ErrorNote>
        ))
      }
    />
  );
}
