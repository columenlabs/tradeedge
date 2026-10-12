// Portfolio ▸ Performance (Bikram, 2026-10-12; design holdings-history/design.md): what the accounts
// in the filter were worth over time against the money put in (Value), or their time-weighted growth
// next to any symbol's total return (Growth), with a returns table. The server works it out on each
// read from the transactions and daily closes; this page only picks the window and draws it.
import {
  ApiError,
  PERFORMANCE_WINDOWS,
  type Performance,
  type PerformanceWindowKey,
  type PortfolioSummary,
  performanceQuery,
  portfoliosQuery,
} from '@/lib/api';
import { DASH, signedPct, usd, usdPlain } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  type ChartMarker,
  type FilterField,
  GrowthChart,
  KeyDateChips,
  type KeyDateKind,
  Page,
  type Series,
  StatusItem,
  Tile,
  TileRow,
  TokenFilter,
  keyDateMarkers,
  maskAmount,
  paletteAt,
  useAmountsHidden,
  useIsMobile,
  useShell,
  useTokenFilter,
} from '@edgedesk/app-shell';
import { Badge } from '@edgedesk/app-shell/ui/badge';
import { Button } from '@edgedesk/app-shell/ui/button';
import { Card } from '@edgedesk/app-shell/ui/card';
import { Input } from '@edgedesk/app-shell/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@edgedesk/app-shell/ui/popover';
import { Skeleton } from '@edgedesk/app-shell/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@edgedesk/app-shell/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@edgedesk/app-shell/ui/toggle-group';
import { useQuery } from '@tanstack/react-query';
import { Landmark, Plug, Plus, Receipt, Wallet, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

type Mode = 'value' | 'growth';
const PORTFOLIO = 'portfolio';
/** Compared symbols take the palette after the portfolio's colour. */
const compareColour = (i: number) => paletteAt(i + 2);
const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;
const MAX_COMPARE = 5;
/** Windows the phone shows (Bikram's mockup): the rest are desktop only. */
const PHONE_WINDOWS = new Set<PerformanceWindowKey>(['YTD', '1Y', '3Y', 'All']);

const monthYear = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
/** `$412k`, `$1.2M`: the value axis. */
const compactUsd = (v: number) =>
  `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 })}`;
const addYears = (d: string, n: number) => `${Number(d.slice(0, 4)) + n}${d.slice(4)}`;
/** Monday of a day's week. */
const weekOf = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
};
/**
 * The chart spaces points evenly, so a window that reaches past the daily two years (the server
 * sends weeks before that) is drawn weekly throughout: each week's last day, and the last day.
 */
function evenly<T extends { date: string }>(pts: T[]): T[] {
  const lastDate = pts.at(-1)?.date;
  if (!lastDate || (pts[0]?.date ?? '') > addYears(lastDate, -2)) return pts;
  return pts.filter(
    (x, i) => i === pts.length - 1 || weekOf(pts[i + 1]?.date ?? '') !== weekOf(x.date),
  );
}
const growthUsd = (v: number) => `$${v.toFixed(2)}`;

const ACCOUNT_FIELDS: FilterField<PortfolioSummary>[] = [
  { key: 'account', label: 'Account', icon: Wallet, values: (a) => [a.name] },
  { key: 'tax', label: 'Tax', icon: Receipt, values: (a) => [a.tax_type] },
  { key: 'broker', label: 'Broker', icon: Landmark, values: (a) => (a.broker ? [a.broker] : []) },
];

/** A window longer than the history reads the same as All, so it shows as a dash. */
function shown(p: Performance, key: PerformanceWindowKey) {
  const w = p.windows.find((x) => x.key === key);
  const all = p.windows.find((x) => x.key === 'All');
  if (!w || (key !== 'All' && key !== 'YTD' && w.from === all?.from)) return null;
  return w;
}

function AddSymbol({ onAdd, disabled }: { onAdd: (s: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const sym = text.trim().toUpperCase();
  const ok = TICKER.test(sym);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled} className="rounded-full">
          <Plus />
          Symbol
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ok) return;
            onAdd(sym);
            setText('');
            setOpen(false);
          }}
        >
          <Input
            autoFocus
            aria-label="Symbol to compare"
            placeholder="QQQ"
            className="num"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!ok}>
            <Plus />
            Add
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function PerformancePage() {
  const hidden = useAmountsHidden();
  const mobile = useIsMobile();
  const { openSettings } = useShell();
  const m = (text: string) => (hidden ? maskAmount(text) : text);
  const [mode, setMode] = useState<Mode>('value');
  const [win, setWin] = useState<PerformanceWindowKey>('All');
  const [compare, setCompare] = useState<string[]>(['SPY', 'QQQ']);
  const [keyDates, setKeyDates] = useState<KeyDateKind[]>([]);
  const list = useQuery(portfoliosQuery());
  const filter = useTokenFilter(list.data ?? [], ACCOUNT_FIELDS, {
    text: (a) => [a.name, a.broker ?? ''],
  });
  // Every account until the filter narrows them.
  const narrowed = filter.tokens.length > 0 || filter.text.trim() !== '';
  const accounts = narrowed ? filter.results.map((a) => a.id).sort() : null;
  const q = useQuery({
    ...performanceQuery(accounts, compare),
    enabled: list.isSuccess && (accounts === null || accounts.length > 0),
  });
  const p = q.data;
  const w = p ? shown(p, win) : null;
  const first = compare[0];

  const { lines, markers } = useMemo(() => {
    if (!p || !w) return { lines: [] as Series[], markers: [] as ChartMarker[] };
    const pts = evenly(p.points.filter((x) => x.date >= w.from));
    const base = pts[0];
    const lines: Series[] = [];
    if (mode === 'value') {
      lines.push({
        key: 'value',
        label: 'Value',
        color: paletteAt(0),
        hold: false,
        dashed: false,
        area: true,
        points: pts.map((x) => [x.date, x.value]),
      });
      lines.push({
        key: 'money_in',
        label: 'Money in',
        color: 'var(--muted-foreground)',
        hold: true,
        dashed: true,
        // Money in over the window: what was there at its start, plus what came in since.
        points: pts.map((x) => [x.date, (base?.value ?? 0) + x.money_in - (base?.money_in ?? 0)]),
      });
    } else {
      lines.push({
        key: PORTFOLIO,
        label: 'Portfolio',
        color: paletteAt(0),
        hold: false,
        dashed: false,
        points: pts.map((x) => [x.date, x.growth / (base?.growth || 1)]),
      });
      compare.forEach((s, i) => {
        const from = pts.find((x) => x.compare[s])?.compare[s];
        if (!from) return;
        lines.push({
          key: `c${i}`,
          label: s,
          color: compareColour(i),
          hold: true,
          dashed: false,
          points: pts.flatMap((x): [string, number][] => {
            const v = x.compare[s];
            return v ? [[x.date, v / from]] : [];
          }),
        });
      });
    }
    // An account whose history starts inside the window is marked where it starts.
    const starts: ChartMarker[] = p.starts
      .filter((s) => s.date > (base?.date ?? ''))
      .map((s) => ({
        date: s.date,
        label: `${s.broker ?? s.name} starts`,
        color: 'var(--warning)',
        kind: s.account_id,
        named: true,
      }));
    return { lines, markers: [...starts, ...keyDateMarkers(keyDates, p.key_dates ?? undefined)] };
  }, [p, w, mode, compare, keyDates]);

  const unavailable = q.error instanceof ApiError && q.error.status === 409;
  const unpricedShare = p?.unpriced.reduce((s, u) => s + u.share, 0) ?? 0;
  const all = p?.windows.find((x) => x.key === 'All');
  const cmp = w && first ? w.compare[first] : undefined;

  return (
    <Page
      crumbs={[{ label: 'Portfolio', to: '/portfolio' }, { label: 'Performance' }]}
      status={
        p?.as_of && (
          <>
            <StatusItem
              label="History from"
              value={p.starts.map((s) => `${monthYear(s.date)} ${s.broker ?? s.name}`).join(' · ')}
            />
            {p.unpriced.length ? (
              <StatusItem
                label="Not priced"
                ok={false}
                value={`${p.unpriced.length} holding${p.unpriced.length === 1 ? '' : 's'}, ${(unpricedShare * 100).toFixed(1)}% of value`}
              />
            ) : null}
            <StatusItem label="Closes" value={`DataEdge · daily to ${p.as_of}`} />
          </>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => v && setMode(v as Mode)}
          aria-label="Show"
        >
          <ToggleGroupItem value="value">Value</ToggleGroupItem>
          <ToggleGroupItem value="growth">Growth</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={win}
          onValueChange={(v) => v && setWin(v as PerformanceWindowKey)}
          aria-label="Window"
        >
          {PERFORMANCE_WINDOWS.map((k) => (
            <ToggleGroupItem
              key={k}
              value={k}
              className={cn(!PHONE_WINDOWS.has(k) && 'max-md:hidden')}
            >
              {k}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <TokenFilter filter={filter} label="Filter accounts" className="min-w-48 flex-1" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase max-md:hidden">
          Compare
        </span>
        {compare.map((s, i) => (
          <Badge key={s} variant="outline" className="h-8 gap-1.5 rounded-full px-3 text-sm">
            <span className="size-2 rounded-full" style={{ background: compareColour(i) }} />
            {s}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Stop comparing ${s}`}
              onClick={() => setCompare(compare.filter((x) => x !== s))}
            >
              <XIcon />
            </Button>
          </Badge>
        ))}
        <AddSymbol
          disabled={compare.length >= MAX_COMPARE}
          onAdd={(s) => !compare.includes(s) && setCompare([...compare, s])}
        />
        {p?.key_dates && (
          <>
            <span className="ml-2 text-xs font-medium tracking-wide text-muted-foreground uppercase max-md:hidden">
              Key dates
            </span>
            <KeyDateChips on={keyDates} setOn={setKeyDates} />
          </>
        )}
      </div>
      {unavailable ? (
        <Card className="items-start gap-3 p-6">
          <p className="text-sm">{(q.error as Error).message}</p>
          <p className="text-sm text-muted-foreground">
            Performance values your holdings with daily closes from DataEdge. Add its address and
            key in Settings ▸ Integrations ▸ DataEdge.
          </p>
          <Button size="sm" variant="outline" onClick={() => openSettings('integrations')}>
            <Plug />
            Open Integrations
          </Button>
        </Card>
      ) : q.isError ? (
        <p role="alert" className="text-sm text-loss">
          {(q.error as Error).message}
        </p>
      ) : accounts?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No account matches the filter.</p>
      ) : !p ? (
        <Skeleton className="h-96 w-full" />
      ) : !p.as_of || !w ? (
        <p className="text-sm text-muted-foreground">No accounts yet.</p>
      ) : (
        <>
          <TileRow aria-label="Performance totals">
            <Tile label="Value" value={m(usdPlain(w.value))} className="max-md:hidden" />
            <Tile label="Money in" value={m(usdPlain(w.money_in))} className="max-md:hidden" />
            <Tile
              label="Gain"
              value={m(usd(w.gain))}
              valueClassName={w.gain > 0 ? 'text-gain' : w.gain < 0 ? 'text-loss' : undefined}
              className="max-md:hidden"
            />
            <Tile
              label={mobile ? 'Return' : 'Return (time-weighted)'}
              value={signedPct(w.return, 1)}
              valueClassName={w.return > 0 ? 'text-gain' : w.return < 0 ? 'text-loss' : undefined}
            />
            {first && cmp ? (
              <>
                <Tile
                  label={`${first} same flows`}
                  value={m(usdPlain(cmp.same_flows))}
                  className="max-md:hidden"
                />
                <Tile
                  label={first}
                  value={signedPct(cmp.return, 1)}
                  valueClassName={
                    (cmp.return ?? 0) > 0
                      ? 'text-gain'
                      : (cmp.return ?? 0) < 0
                        ? 'text-loss'
                        : undefined
                  }
                  className="md:hidden"
                />
              </>
            ) : null}
          </TileRow>
          <Card className="p-2 pt-4">
            <GrowthChart
              lines={lines}
              scale="fit"
              ytd={false}
              markers={markers}
              format={mode === 'value' ? (v) => m(compactUsd(v)) : growthUsd}
              className="aspect-auto h-80 w-full md:h-96"
            />
          </Card>
          <Card className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Return</TableHead>
                  {PERFORMANCE_WINDOWS.map((k) => (
                    <TableHead
                      key={k}
                      className={cn(
                        'text-right',
                        !PHONE_WINDOWS.has(k) || k === 'All' ? 'max-md:hidden' : '',
                      )}
                    >
                      {k === 'All' && all ? `All (since ${monthYear(all.from)})` : k}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {[
                  {
                    key: PORTFOLIO,
                    label: 'Portfolio',
                    color: paletteAt(0),
                    at: (k: PerformanceWindowKey) => shown(p, k)?.return ?? null,
                  },
                  ...compare.map((s, i) => ({
                    key: s,
                    label: s,
                    color: compareColour(i),
                    at: (k: PerformanceWindowKey) => shown(p, k)?.compare[s]?.return ?? null,
                  })),
                ].map((r) => (
                  <TableRow key={r.key}>
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <span className="size-2 rounded-full" style={{ background: r.color }} />
                        {r.label}
                      </span>
                    </TableCell>
                    {PERFORMANCE_WINDOWS.map((k) => {
                      const v = r.at(k);
                      return (
                        <TableCell
                          key={k}
                          className={cn(
                            'num text-right',
                            !PHONE_WINDOWS.has(k) || k === 'All' ? 'max-md:hidden' : '',
                            v !== null && v > 0 && 'text-gain',
                            v !== null && v < 0 && 'text-loss',
                          )}
                        >
                          {v === null ? DASH : signedPct(v, 1)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </Page>
  );
}
