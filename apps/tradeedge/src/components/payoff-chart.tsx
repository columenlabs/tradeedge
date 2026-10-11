import { type ChartConfig, ChartContainer, ChartTooltip } from '@/components/ui/chart';
import { money, num, usd } from '@/lib/format';
import type { Analysis } from '@/lib/strategy';
import { cn } from '@/lib/utils';
import { useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  XAxis,
  YAxis,
} from 'recharts';

const AXIS = { tickLine: false, axisLine: false, fontSize: 11 } as const;
const yTick = (v: number) =>
  v === 0 ? '0' : Math.abs(v) >= 1000 ? `${money(v / 1000, 1)}k` : usd(v);

/** Points across `[lo, hi]`, plus any extra x values (strikes) so kinks stay sharp. */
function xs(lo: number, hi: number, n: number, extra: number[] = []) {
  const out = Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
  for (const x of extra) if (x > lo && x < hi) out.push(x);
  return out.sort((a, b) => a - b);
}

/** Round tick values covering `[lo, hi]`, about five of them, always including 0. */
function niceTicks(lo: number, hi: number): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let t = Math.floor(lo / step) * step; t < hi + step - 1e-9; t += step) out.push(t);
  return out;
}

function TipRow({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <span className="flex items-center justify-between gap-4">
      <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
        {color ? (
          <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
        ) : null}
        {label}
      </span>
      <span className={cn('num', value > 0 ? 'text-gain' : value < 0 ? 'text-loss' : '')}>
        {money(value, 0)}
      </span>
    </span>
  );
}

/**
 * One strategy's payoff: at expiry (solid, profit and loss shaded), on the value-on date (dashed)
 * when that is before expiry, the ±1σ band to that date, breakevens, today's price and the what-if
 * point.
 */
export function PayoffChart({
  analysis,
  spot,
  symbol,
  range,
  lots,
  whatIf,
  band,
  dateLabel,
  className,
}: {
  analysis: Analysis;
  spot: number;
  symbol: string;
  /** Price range drawn, as a fraction either side of spot. */
  range: number;
  lots: number;
  /** The "SPY at" lever's price. */
  whatIf: number;
  /** ±1σ move to the value-on date, shaded around spot. */
  band: number;
  /** The value-on date when before expiry, for the dashed line and tooltip. */
  dateLabel: string | null;
  className?: string;
}) {
  const lo = spot * (1 - range);
  const hi = spot * (1 + range);
  const strikes = analysis.breakevens;
  const data = useMemo(
    () =>
      xs(lo, hi, 200, strikes).map((s) => {
        const expiry = analysis.pl(s, analysis.frontDte) * lots;
        return { spot: s, expiry, horizon: analysis.pl(s, analysis.horizon) * lots };
      }),
    [analysis, lo, hi, lots, strikes],
  );
  const config = {
    expiry: { label: 'At expiry', color: 'var(--foreground)' },
    horizon: { label: dateLabel ?? 'At expiry', color: 'var(--primary)' },
  } satisfies ChartConfig;
  const ys = data.flatMap((d) => (dateLabel ? [d.expiry, d.horizon] : [d.expiry]));
  const ticks = niceTicks(Math.min(...ys, 0), Math.max(...ys, 0));
  const top = ticks.at(-1) ?? 0;
  const bottom = ticks[0] ?? 0;
  // Split at zero: green above, red below. SVG gradients span each shape's own bounding box, not
  // the axis: the line's box is the expiry curve's min to max, the fill's also reaches the 0 base.
  const ex = data.map((d) => d.expiry);
  const split = (max: number, min: number) =>
    max === min ? (max > 0 ? 1 : 0) : Math.min(1, Math.max(0, max / (max - min)));
  const lineZero = split(Math.max(...ex), Math.min(...ex));
  const fillZero = split(Math.max(...ex, 0), Math.min(...ex, 0));
  const whatY = analysis.pl(whatIf, analysis.horizon) * lots;
  return (
    <ChartContainer
      config={config}
      className={cn('aspect-auto h-72 w-full min-w-0 sm:h-80', className)}
    >
      <ComposedChart data={data} margin={{ top: 24, right: 12, bottom: 4, left: 4 }}>
        <defs>
          <linearGradient id="payoff-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset={0} stopColor="var(--gain)" stopOpacity={0.22} />
            <stop offset={fillZero} stopColor="var(--gain)" stopOpacity={0.04} />
            <stop offset={fillZero} stopColor="var(--loss)" stopOpacity={0.04} />
            <stop offset={1} stopColor="var(--loss)" stopOpacity={0.22} />
          </linearGradient>
          <linearGradient id="payoff-line" x1="0" y1="0" x2="0" y2="1">
            <stop offset={lineZero} stopColor="var(--gain)" />
            <stop offset={lineZero} stopColor="var(--loss)" />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          {...AXIS}
          dataKey="spot"
          type="number"
          domain={[lo, hi]}
          tickCount={7}
          tickFormatter={(v: number) => num(v, 0)}
        />
        <YAxis {...AXIS} width={56} tickFormatter={yTick} domain={[bottom, top]} ticks={ticks} />
        <ReferenceArea
          x1={Math.max(spot - band, lo)}
          x2={Math.min(spot + band, hi)}
          fill="var(--primary)"
          fillOpacity={0.07}
          stroke="none"
          ifOverflow="hidden"
        />
        <ReferenceLine y={0} stroke="var(--border)" />
        {analysis.breakevens
          .filter((b) => b > lo && b < hi)
          .map((b) => (
            <ReferenceLine
              key={b}
              x={b}
              stroke="var(--muted-foreground)"
              strokeOpacity={0.4}
              strokeDasharray="2 4"
              label={{
                value: num(b, 1),
                position: 'insideBottom',
                fill: 'var(--muted-foreground)',
                fontSize: 10,
              }}
            />
          ))}
        <ReferenceLine
          x={spot}
          stroke="var(--muted-foreground)"
          strokeDasharray="3 3"
          label={{
            value: `Now ${num(spot)}`,
            position: 'insideTopRight',
            fill: 'var(--muted-foreground)',
            fontSize: 11,
          }}
        />
        <Area
          dataKey="expiry"
          type="linear"
          stroke="url(#payoff-line)"
          strokeWidth={2.25}
          fill="url(#payoff-fill)"
          baseValue={0}
          isAnimationActive={false}
          activeDot={false}
        />
        {dateLabel ? (
          <Line
            dataKey="horizon"
            type="monotone"
            stroke="var(--color-horizon)"
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={false}
            isAnimationActive={false}
          />
        ) : null}
        {Math.abs(whatIf - spot) > 1e-6 ? (
          <ReferenceLine
            x={whatIf}
            stroke="var(--primary)"
            label={{
              value: `What-if ${num(whatIf)}`,
              position: 'insideTopRight',
              fill: 'var(--primary)',
              fontSize: 11,
            }}
          />
        ) : null}
        {whatIf > lo && whatIf < hi ? (
          <ReferenceDot
            x={whatIf}
            y={whatY}
            r={5}
            fill="var(--primary)"
            stroke="var(--card)"
            strokeWidth={2}
          />
        ) : null}
        <ChartTooltip
          cursor={{ stroke: 'var(--muted-foreground)', strokeOpacity: 0.4 }}
          content={({ active, payload }) => {
            const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
            if (!active || !p) return null;
            return (
              <div className="grid min-w-40 gap-1 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md">
                <span className="num font-medium">
                  {symbol} {num(p.spot)}
                </span>
                <TipRow label="At expiry" value={p.expiry} />
                {dateLabel ? <TipRow label={dateLabel} value={p.horizon} /> : null}
              </div>
            );
          }}
        />
      </ComposedChart>
    </ChartContainer>
  );
}

export interface OverlayLine {
  id: string;
  name: string;
  color: string;
  analysis: Analysis;
}

/** Several strategies on one payoff chart, each on the value-on date (capped at its own expiry). */
export function OverlayChart({
  lines,
  spot,
  range,
  days,
  className,
}: {
  lines: OverlayLine[];
  spot: number;
  range: number;
  days: number;
  className?: string;
}) {
  const lo = spot * (1 - range);
  const hi = spot * (1 + range);
  const config = Object.fromEntries(
    lines.map((l) => [l.id, { label: l.name, color: l.color }]),
  ) satisfies ChartConfig;
  const data = useMemo(
    () =>
      xs(lo, hi, 200).map((s) => {
        const point: Record<string, number> = { spot: s };
        for (const l of lines) point[l.id] = l.analysis.pl(s, Math.min(days, l.analysis.frontDte));
        return point;
      }),
    [lines, lo, hi, days],
  );
  return (
    <ChartContainer
      config={config}
      className={cn('aspect-auto h-64 w-full min-w-0 sm:h-72', className)}
    >
      <LineChart data={data} margin={{ top: 20, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          {...AXIS}
          dataKey="spot"
          type="number"
          domain={[lo, hi]}
          tickCount={7}
          tickFormatter={(v: number) => num(v, 0)}
        />
        <YAxis {...AXIS} width={56} tickFormatter={yTick} />
        <ReferenceLine y={0} stroke="var(--border)" />
        <ReferenceLine
          x={spot}
          stroke="var(--muted-foreground)"
          strokeDasharray="3 3"
          label={{
            value: `Now ${num(spot)}`,
            position: 'insideTopRight',
            fill: 'var(--muted-foreground)',
            fontSize: 11,
          }}
        />
        {lines.map((l) => (
          <Line
            key={l.id}
            dataKey={l.id}
            name={l.name}
            type="linear"
            stroke={`var(--color-${l.id})`}
            strokeWidth={2.25}
            dot={false}
            isAnimationActive={false}
          />
        ))}
        <ChartTooltip
          cursor={{ stroke: 'var(--muted-foreground)', strokeOpacity: 0.4 }}
          content={({ active, payload }) => {
            const p = payload?.[0]?.payload as Record<string, number> | undefined;
            if (!active || !p) return null;
            return (
              <div className="grid min-w-52 gap-1 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md">
                <span className="num font-medium">{num(p.spot)}</span>
                {lines.map((l) => (
                  <TipRow key={l.id} label={l.name} value={p[l.id] ?? 0} color={l.color} />
                ))}
              </div>
            );
          }}
        />
      </LineChart>
    </ChartContainer>
  );
}

/** A strategy's payoff at expiry in a table cell: no axes, its colour, ±10% around spot. */
export function Sparkline({
  analysis,
  spot,
  color,
  className,
}: {
  analysis: Analysis;
  spot: number;
  color: string;
  className?: string;
}) {
  const data = useMemo(
    () => xs(spot * 0.9, spot * 1.1, 40).map((s) => ({ s, v: analysis.pl(s, analysis.frontDte) })),
    [analysis, spot],
  );
  return (
    <ChartContainer
      config={{ v: { label: 'Payoff', color } }}
      className={cn('aspect-auto h-6 w-20', className)}
    >
      <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <XAxis hide dataKey="s" type="number" domain={['dataMin', 'dataMax']} />
        <ReferenceLine y={0} stroke="var(--border)" />
        <Line
          dataKey="v"
          type="linear"
          stroke="var(--color-v)"
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}
