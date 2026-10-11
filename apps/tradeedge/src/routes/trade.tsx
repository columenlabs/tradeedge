import {
  Lever,
  LotsStepper,
  RangeToggle,
  fillLabel,
  ivLabel,
  valueOnLabel,
} from '@/components/levers';
import { PayoffChart } from '@/components/payoff-chart';
import { Ticker, Tile } from '@/components/ticker';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  type Trade,
  chainQuery,
  deleteTrade,
  expirationsQuery,
  saveTrade,
  tradesQuery,
} from '@/lib/api';
import { addDays, todayPT } from '@/lib/calendar';
import { DASH, num, pct, shortDate, signed, timePT, usd, usdPlain } from '@/lib/format';
import { daysTo, quoteFor, toSaved } from '@/lib/saved';
import {
  type Analysis,
  DEFAULT_IV,
  type Leg,
  analyze,
  greeksAt,
  legDelta,
  legFromQuote,
  sigmaMove,
} from '@/lib/strategy';
import { type Hydrated, useHydrated } from '@/lib/use-trades';
import { cn } from '@/lib/utils';
import { ConfirmDelete, Page, StatusItem } from '@edgedesk/app-shell';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@edgedesk/app-shell/ui/dialog';
import { useSidebar } from '@edgedesk/app-shell/ui/sidebar';
import type { OptionQuote, UnderlyingQuote } from '@edgedesk/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Copy, Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { type ComponentProps, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorNote } from './chain';

/** `/trades/$symbol/$id`: one saved trade with its what-if levers, P&L grid and legs. */
export function TradePage() {
  const { symbol, id } = useParams({ from: '/trades/$symbol/$id' });
  const h = useHydrated(symbol, id);
  const saved = useQuery(tradesQuery());
  const trade = h.trades[0];
  if (saved.isPending || h.isPending) {
    return (
      <Page
        crumbs={[{ label: 'Trades' }, { label: symbol, to: `/trades/${symbol}` }, { label: '…' }]}
      >
        <Skeleton className="h-[60vh] w-full" />
      </Page>
    );
  }
  if (!trade || !h.spot) {
    return (
      <Page
        crumbs={[
          { label: 'Trades' },
          { label: symbol, to: `/trades/${symbol}` },
          { label: 'Not found' },
        ]}
      >
        <ErrorNote>
          {trade
            ? `No live chain for ${symbol} right now.`
            : 'This trade does not exist, or it was deleted.'}
        </ErrorNote>
      </Page>
    );
  }
  return (
    <TradeView
      key={trade.id}
      trade={trade}
      spot={h.spot}
      quote={h.quote}
      iv={h.iv}
      quotes={h.chains.flatMap((c) => c.quotes)}
    />
  );
}

interface LeverState {
  days: number | null;
  move: number;
  ivScale: number;
  fill: number;
  lots: number;
  range: number;
}
const LEVERS: LeverState = { days: null, move: 0, ivScale: 1, fill: 0, lots: 1, range: 10 };

function TradeView({
  trade,
  spot,
  quote,
  iv: chainIv,
  quotes,
}: {
  trade: Hydrated;
  spot: number;
  quote: UnderlyingQuote | null;
  iv: number | null;
  quotes: OptionQuote[];
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const symbol = trade.underlying;
  const [legs, setLegs] = useState<Leg[]>(trade.live);
  const [lev, setLev] = useState<LeverState>(LEVERS);
  const [unit, setUnit] = useState<'usd' | 'pct'>('usd');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const extra = useRef<OptionQuote[]>([]);
  const iv = chainIv ?? DEFAULT_IV;
  const set = (patch: Partial<LeverState>) => setLev((l) => ({ ...l, ...patch }));

  const analysis = useMemo(
    () =>
      analyze(legs, spot, {
        days: lev.days ?? Number.POSITIVE_INFINITY,
        ivScale: lev.ivScale,
        fill: lev.fill,
        fallbackIv: iv,
      }),
    [legs, spot, lev.days, lev.ivScale, lev.fill, iv],
  );

  // Every edit saves; a burst of edits saves once.
  const save = useMutation({
    mutationFn: (next: Leg[]) =>
      saveTrade(
        {
          underlying: symbol,
          name: trade.name,
          legs: toSaved(next),
          ...(trade.note ? { note: trade.note } : {}),
        },
        trade.id,
      ),
    onSuccess: (s) =>
      qc.setQueryData(tradesQuery().queryKey, (list: Trade[] | undefined) =>
        list?.map((x) => (x.id === s.id ? s : x)),
      ),
  });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const edit = (next: Leg[]) => {
    setLegs(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save.mutate(next), 600);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useMutation({
    mutationFn: () =>
      saveTrade({
        underlying: symbol,
        name: `${trade.name} copy`.slice(0, 80),
        legs: toSaved(legs),
        ...(trade.note ? { note: trade.note } : {}),
      }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: tradesQuery().queryKey });
      void navigate({ to: '/trades/$symbol/$id', params: { symbol, id: s.id } });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteTrade(trade.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: tradesQuery().queryKey });
      void navigate({ to: '/trades/$symbol', params: { symbol } });
    },
  });

  if (!analysis) return null;
  const front = analysis.frontDte;
  const days = Math.min(lev.days ?? front, front);
  const atExpiry = days >= front;
  const whatIf = spot * (1 + lev.move / 100);
  const frontExp = Math.min(...legs.flatMap((l) => (l.type === 'stock' ? [] : [l.expiration])));
  const dateLabel = atExpiry ? null : `On ${shortDate(addDays(todayPT(), days))}`;

  const allQuotes = [...quotes, ...extra.current];
  const replaceContract = async (
    l: Leg,
    patch: Partial<Pick<Leg, 'type' | 'strike' | 'expiration'>>,
  ) => {
    const want = { ...l, ...patch };
    let pool = allQuotes;
    if (want.expiration !== l.expiration) {
      const chain = await qc.fetchQuery(chainQuery(symbol, want.expiration)).catch(() => null);
      if (!chain) return;
      extra.current = [...extra.current, ...chain.quotes];
      pool = [...pool, ...chain.quotes];
    }
    const strikes = [
      ...new Set(
        pool
          .filter((q) => q.type === want.type && q.expiration === want.expiration)
          .map((q) => q.strike),
      ),
    ].sort((a, b) => a - b);
    if (!strikes.length) return;
    const k = strikes.reduce((b, x) =>
      Math.abs(x - want.strike) < Math.abs(b - want.strike) ? x : b,
    );
    const q = pool.find(
      (x) => x.type === want.type && x.expiration === want.expiration && x.strike === k,
    );
    if (!q) return;
    edit(legs.map((x) => (x.id === l.id ? { ...legFromQuote(q, l.side, l.qty), id: l.id } : x)));
  };
  const stepStrike = (l: Leg, dir: 1 | -1) => {
    const strikes = [
      ...new Set(
        allQuotes
          .filter((q) => q.type === l.type && q.expiration === l.expiration)
          .map((q) => q.strike),
      ),
    ].sort((a, b) => a - b);
    const i = strikes.indexOf(l.strike);
    const next = strikes[i + dir];
    if (i >= 0 && next !== undefined) void replaceContract(l, { strike: next });
  };
  const addLeg = () => {
    const exp = Number.isFinite(frontExp) ? frontExp : null;
    const calls = allQuotes.filter(
      (q) => q.type === 'call' && (exp === null || q.expiration === exp),
    );
    const atm = calls.reduce<OptionQuote | null>(
      (b, q) => (!b || Math.abs(q.strike - spot) < Math.abs(b.strike - spot) ? q : b),
      null,
    );
    if (atm) edit([...legs, legFromQuote(atm, 1)]);
  };

  return (
    <Page
      crumbs={[
        { label: 'Trades', name: 'Trades' },
        { label: symbol, to: `/trades/${symbol}` },
        { label: trade.name },
      ]}
      actions={
        <>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Duplicate"
            title="Duplicate"
            disabled={copy.isPending}
            onClick={() => copy.mutate()}
          >
            <Copy />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Delete trade"
            title="Delete trade"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 />
          </Button>
        </>
      }
      status={
        <>
          <StatusItem label="Quotes" value="live" ok />
          <StatusItem label="Valued" value={`${timePT(new Date().toISOString())} PT`} />
          {save.isPending ? (
            <StatusItem label="Saving…" />
          ) : save.isError ? (
            <StatusItem label="Not saved" ok={false} />
          ) : null}
        </>
      }
    >
      {isMobile ? null : (
        <Ticker
          symbol={symbol}
          quote={quote}
          iv={chainIv}
          expiration={Number.isFinite(frontExp) ? frontExp : null}
        />
      )}
      <Stats
        analysis={analysis}
        lots={lev.lots}
        whatIf={whatIf}
        atExpiry={atExpiry}
        days={days}
        symbol={symbol}
        fill={lev.fill}
        ivScale={lev.ivScale}
        iv={iv}
      />
      <div className="grid min-w-0 gap-(--shell-section-gap) lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="min-w-0 gap-2">
          <CardHeader>
            <CardTitle>Payoff</CardTitle>
            <CardDescription className="text-xs">
              {dateLabel
                ? `Shaded: at expiry · dashed: ${dateLabel.toLowerCase()}`
                : 'Shaded: at expiry'}
              {` · band: ±1σ ${num(sigmaMove(spot, analysis.iv, days), 1)}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PayoffChart
              analysis={analysis}
              spot={spot}
              symbol={symbol}
              range={lev.range / 100}
              lots={lev.lots}
              whatIf={whatIf}
              band={sigmaMove(spot, analysis.iv, days)}
              dateLabel={dateLabel}
            />
          </CardContent>
        </Card>
        <WhatIf
          analysis={analysis}
          lev={lev}
          set={set}
          days={days}
          spot={spot}
          whatIf={whatIf}
          iv={iv}
          symbol={symbol}
        />
      </div>
      <PlGrid
        analysis={analysis}
        spot={spot}
        lots={lev.lots}
        unit={unit}
        onUnit={setUnit}
        phone={isMobile}
        symbol={symbol}
      />
      <LegsCard
        legs={legs}
        quotes={allQuotes}
        spot={spot}
        iv={iv}
        lots={lev.lots}
        symbol={symbol}
        onSide={(l) =>
          edit(legs.map((x) => (x.id === l.id ? { ...x, side: x.side > 0 ? -1 : 1 } : x)))
        }
        onQty={(l, d) =>
          edit(legs.map((x) => (x.id === l.id ? { ...x, qty: Math.max(1, x.qty + d) } : x)))
        }
        onType={(l) => void replaceContract(l, { type: l.type === 'call' ? 'put' : 'call' })}
        onStrike={stepStrike}
        onExpiry={(l, x) => void replaceContract(l, { expiration: x })}
        onDelete={(l) => edit(legs.filter((x) => x.id !== l.id))}
        onAdd={addLeg}
      />
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {trade.name}?</DialogTitle>
            <DialogDescription>
              It leaves the board for you and for agents. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              <Trash2 />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

/** Four tiles a row on phones too (Bikram, 2026-10-10), so the numbers shrink there. */
function StatTile({ label, className, valueClassName, ...props }: ComponentProps<typeof Tile>) {
  return (
    <Tile
      {...props}
      label={<span className="line-clamp-2 whitespace-normal lg:line-clamp-1">{label}</span>}
      className={cn('px-1.5 lg:px-3', className)}
      valueClassName={cn(
        'text-[13px] leading-5 tracking-tight lg:text-xl lg:leading-7 lg:tracking-normal',
        valueClassName,
      )}
    />
  );
}

const fmtBound = (v: number | 'unlimited', lots: number) =>
  v === 'unlimited' ? 'Unlimited' : usdPlain(v * lots);

function Stats({
  analysis: a,
  lots,
  whatIf,
  atExpiry,
  days,
  symbol,
  fill,
  ivScale,
  iv,
}: {
  analysis: Analysis;
  lots: number;
  whatIf: number;
  atExpiry: boolean;
  days: number;
  symbol: string;
  fill: number;
  ivScale: number;
  iv: number;
}) {
  const pl = a.pl(whatIf, a.horizon) * lots;
  const g = greeksAt(a, whatIf, days, ivScale, iv);
  const tone = (v: number) => (v > 0.5 ? 'text-gain' : v < -0.5 ? 'text-loss' : undefined);
  const when = atExpiry ? 'at expiry' : `on ${shortDate(addDays(todayPT(), days))}`;
  return (
    <section
      aria-label="Trade numbers"
      className="grid grid-cols-4 gap-2 lg:gap-(--shell-section-gap)"
    >
      <StatTile
        className="ring-primary/50"
        label={`P&L if ${symbol} is ${num(whatIf)}`}
        value={usd(pl)}
        valueClassName={pl >= 0 ? 'text-gain' : 'text-loss'}
        caption={`${when} · ${lots} lot${lots > 1 ? 's' : ''}`}
      />
      <StatTile
        label={a.net >= 0 ? 'Net credit' : 'Net debit'}
        value={usd(a.net * lots)}
        valueClassName={a.net >= 0 ? 'text-gain' : 'text-loss'}
        caption={fill ? `to open · ${usd(a.slippage * lots)} slippage` : 'to open at mid'}
      />
      <StatTile label="Max profit" value={fmtBound(a.maxProfit, lots)} caption="at expiry" />
      <StatTile
        label="Max loss"
        value={fmtBound(a.maxLoss, lots)}
        valueClassName="text-loss"
        caption="at expiry"
      />
      <StatTile
        label="Chance of profit"
        value={pct(a.pop, 0)}
        caption={
          a.breakevens.length
            ? `BE ${a.breakevens.map((b) => num(b)).join(' · ')}`
            : 'no break-even'
        }
      />
      <StatTile
        label="Delta"
        value={`${signed(g.delta * lots, 0)} sh`}
        valueClassName={tone(g.delta)}
        caption={g.today ? 'shares · today' : 'share equivalent'}
      />
      <StatTile
        label="Theta"
        value={usd(g.theta * lots)}
        valueClassName={tone(g.theta)}
        caption={`per day${g.today ? ' · today' : ''}`}
      />
      <StatTile
        label="Vega"
        value={usd(g.vega * lots)}
        valueClassName={tone(g.vega)}
        caption={g.today ? 'vol pt · today' : 'per 1 vol pt'}
      />
    </section>
  );
}

function WhatIf({
  analysis: a,
  lev,
  set,
  days,
  spot,
  whatIf,
  iv,
  symbol,
}: {
  analysis: Analysis;
  lev: LeverState;
  set: (p: Partial<LeverState>) => void;
  days: number;
  spot: number;
  whatIf: number;
  iv: number;
  symbol: string;
}) {
  return (
    <Card className="min-w-0 gap-3 pb-0">
      <CardHeader>
        <CardTitle>What-if</CardTitle>
        <CardDescription className="text-xs">
          Move the levers; the chart and numbers follow
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => set(LEVERS)}>
            <RotateCcw />
            Reset
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Lever
          label="Value on"
          value={days}
          min={0}
          max={a.frontDte}
          current={valueOnLabel(days, a.frontDte)}
          onChange={(v) => set({ days: v })}
        />
        <Lever
          label={`${symbol} at`}
          value={lev.move}
          min={-10}
          max={10}
          step={0.1}
          current={`${num(whatIf)} (${signed(lev.move, 1)}%)`}
          onChange={(v) => set({ move: v })}
        />
        <Lever
          label="Implied vol"
          value={Math.round((lev.ivScale - 1) * 100)}
          min={-50}
          max={100}
          current={ivLabel(iv, lev.ivScale)}
          onChange={(v) => set({ ivScale: 1 + v / 100 })}
        />
        <Lever
          label="Fill"
          value={Math.round(lev.fill * 100)}
          min={0}
          max={100}
          step={5}
          current={fillLabel(lev.fill)}
          onChange={(v) => set({ fill: v / 100 })}
        />
        <LotsStepper value={lev.lots} onChange={(v) => set({ lots: v })} />
        <RangeToggle value={lev.range} onChange={(v) => set({ range: v })} />
      </CardContent>
    </Card>
  );
}

const MOVES = [-6, -4.5, -3, -1.5, 0, 1.5, 3, 4.5, 6];

function PlGrid({
  analysis: a,
  spot,
  lots,
  unit,
  onUnit,
  phone,
  symbol,
}: {
  analysis: Analysis;
  spot: number;
  lots: number;
  unit: 'usd' | 'pct';
  onUnit: (u: 'usd' | 'pct') => void;
  phone: boolean;
  symbol: string;
}) {
  const front = a.frontDte;
  const steps = phone ? 3 : 6;
  const cols = [
    ...new Set(Array.from({ length: steps + 1 }, (_, i) => Math.round((front * i) / steps))),
  ];
  const risk = a.maxLoss === 'unlimited' ? null : Math.abs(a.maxLoss);
  const cells = MOVES.map((m) => {
    const s = spot * (1 + m / 100);
    return { m, s, vs: cols.map((d) => a.pl(s, d) * lots) };
  });
  const peak = Math.max(1, ...cells.flatMap((c) => c.vs.map(Math.abs)));
  const show = (v: number) =>
    unit === 'pct' && risk ? `${signed((v / (risk * lots)) * 100, 0)}%` : signed(v, 0);
  const heat = (v: number) =>
    `color-mix(in srgb, var(${v >= 0 ? '--gain' : '--loss'}) ${Math.round(Math.min(1, Math.abs(v) / peak) * 38)}%, transparent)`;
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-3">
        <CardTitle>P&amp;L by date and price</CardTitle>
        <CardDescription className="text-xs">Follows the IV, fill and lots levers</CardDescription>
        <CardAction>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={unit}
            onValueChange={(v) => v && onUnit(v as 'usd' | 'pct')}
            aria-label="P&L unit"
          >
            <ToggleGroupItem value="usd" className="px-3">
              $
            </ToggleGroupItem>
            <ToggleGroupItem value="pct" disabled={risk === null} className="px-2">
              % of risk
            </ToggleGroupItem>
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <Table className="num text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{symbol} at</TableHead>
            {cols.map((d) => (
              <TableHead key={d} className="text-right">
                {d >= front ? 'Expiry' : d === 0 ? 'Today' : shortDate(addDays(todayPT(), d))}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {cells.map(({ m, s, vs }) => (
            <TableRow
              key={m}
              data-now={m === 0 || undefined}
              className="data-now:outline data-now:outline-primary"
            >
              <TableCell className="whitespace-nowrap">
                <span className="font-semibold">{num(s, 0)}</span>{' '}
                <span className="text-muted-foreground">
                  {m === 0 ? 'now' : `${signed(m, m % 1 ? 1 : 0)}%`}
                </span>
              </TableCell>
              {vs.map((v, i) => (
                <TableCell key={cols[i]} className="text-right" style={{ background: heat(v) }}>
                  {show(v)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

const SIDE = {
  1: 'bg-gain/10 text-gain hover:bg-gain/20',
  [-1]: 'bg-loss/10 text-loss hover:bg-loss/20',
} as const;

function LegsCard({
  legs,
  quotes,
  spot,
  iv,
  lots,
  symbol,
  onSide,
  onQty,
  onType,
  onStrike,
  onExpiry,
  onDelete,
  onAdd,
}: {
  legs: Leg[];
  quotes: OptionQuote[];
  spot: number;
  iv: number;
  lots: number;
  symbol: string;
  onSide: (l: Leg) => void;
  onQty: (l: Leg, d: 1 | -1) => void;
  onType: (l: Leg) => void;
  onStrike: (l: Leg, d: 1 | -1) => void;
  onExpiry: (l: Leg, x: number) => void;
  onDelete: (l: Leg) => void;
  onAdd: () => void;
}) {
  const exps = useQuery(expirationsQuery(symbol));
  // Edit buttons show on hover on desktop, always on touch.
  const ed =
    'opacity-100 md:opacity-0 md:group-hover/leg:opacity-100 md:group-focus-within/leg:opacity-100';
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-3">
        <CardTitle>Legs</CardTitle>
        <CardDescription className="text-xs">
          Hover a row to edit it · entry is the mid when added
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={onAdd}>
            <Plus />
            Add leg
          </Button>
        </CardAction>
      </CardHeader>
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Side</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Strike</TableHead>
            <TableHead>Expiry</TableHead>
            <TableHead className="text-right">Entry</TableHead>
            <TableHead className="text-right">Now</TableHead>
            <TableHead className="text-right">Δ</TableHead>
            <TableHead className="w-8" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {legs.map((l) => {
            const q = quoteFor(l, quotes);
            const now = l.type === 'stock' ? spot : (q?.mid ?? null);
            const option = l.type !== 'stock';
            return (
              <TableRow
                key={l.id}
                className="group/leg"
                data-leg={`${l.side > 0 ? 'Buy' : 'Sell'} ${l.type} ${l.strike}`}
              >
                <TableCell>
                  <Button
                    variant="ghost"
                    size="xs"
                    className={cn('h-5 px-1.5', SIDE[l.side])}
                    title="Switch buy or sell"
                    onClick={() => onSide(l)}
                  >
                    {l.side > 0 ? 'Buy' : 'Sell'}
                  </Button>
                </TableCell>
                <TableCell className="num text-right">
                  <span className="inline-flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={ed}
                      aria-label="One fewer"
                      disabled={l.qty <= 1}
                      onClick={() => onQty(l, -1)}
                    >
                      <Minus />
                    </Button>
                    <span className="w-6 text-center font-semibold">{l.qty * lots}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={ed}
                      aria-label="One more"
                      onClick={() => onQty(l, 1)}
                    >
                      <Plus />
                    </Button>
                  </span>
                </TableCell>
                <TableCell>
                  {option ? (
                    <Button
                      variant="outline"
                      size="xs"
                      className="h-5 px-1.5"
                      title="Switch call or put"
                      onClick={() => onType(l)}
                    >
                      {l.type === 'call' ? 'Call' : 'Put'}
                    </Button>
                  ) : (
                    'Shares'
                  )}
                </TableCell>
                <TableCell className="num text-right">
                  {option ? (
                    <span className="inline-flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className={ed}
                        aria-label="Strike down"
                        onClick={() => onStrike(l, -1)}
                      >
                        <Minus />
                      </Button>
                      <span className="w-10 text-center font-semibold">
                        {num(l.strike, l.strike % 1 ? 1 : 0)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className={ed}
                        aria-label="Strike up"
                        onClick={() => onStrike(l, 1)}
                      >
                        <Plus />
                      </Button>
                    </span>
                  ) : (
                    DASH
                  )}
                </TableCell>
                <TableCell>
                  {option ? (
                    <Select
                      value={String(l.expiration)}
                      onValueChange={(v) => onExpiry(l, Number(v))}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label="Expiry"
                        className="num h-6 w-28 border-transparent px-1.5 text-xs shadow-none hover:border-border"
                      >
                        <SelectValue>{shortDate(l.expiration)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(exps.data?.expirations ?? [l.expiration]).map((x) => (
                          <SelectItem key={x} value={String(x)}>
                            <span className="num">{shortDate(x)}</span>
                            <span className="num ml-auto pl-3 text-xs text-muted-foreground">
                              {daysTo(x)}d
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    DASH
                  )}
                </TableCell>
                <TableCell className="num text-right">{num(l.price)}</TableCell>
                <TableCell className="num text-right">{num(now)}</TableCell>
                <TableCell className="num text-right">{signed(legDelta(l, spot, iv))}</TableCell>
                <TableCell>
                  <ConfirmDelete title="Delete this leg?" onConfirm={() => onDelete(l)}>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={ed}
                      aria-label="Delete leg"
                      disabled={legs.length <= 1}
                    >
                      <Trash2 />
                    </Button>
                  </ConfirmDelete>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
