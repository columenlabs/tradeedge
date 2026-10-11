import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { addDays, todayPT } from '@/lib/calendar';
import { num, shortDate, signed } from '@/lib/format';
import { Minus, Plus } from 'lucide-react';
import { useId } from 'react';

/** A what-if slider: its label and current value on one line, the slider under it. */
export function Lever({
  label,
  value,
  min,
  max,
  step = 1,
  current,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** The value as text: `Expiry · Nov 20`, `571.20 (0.0%)`. */
  current: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
          {label}
        </Label>
        <span className="num truncate font-medium">{current}</span>
      </div>
      <Slider
        id={id}
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => v !== undefined && onChange(v)}
      />
    </div>
  );
}

/** "Value on": today to the front expiry. */
export const valueOnLabel = (days: number, frontDte: number) => {
  const at = addDays(todayPT(), Math.min(days, frontDte));
  return days >= frontDte
    ? `Expiry · ${shortDate(at)}`
    : `${shortDate(at)} · ${frontDte - days}d left`;
};

export const ivLabel = (iv: number, scale: number) =>
  `${num(iv * scale * 100, 1)}% (${signed((scale - 1) * 100, 0)}%)`;

export const fillLabel = (fill: number) =>
  fill === 0 ? 'Mid' : fill === 1 ? 'Natural' : `${Math.round(fill * 100)}% to natural`;

export const RANGES = [5, 10, 20] as const;

/** The chart's price range: ±5, ±10 or ±20% around spot. */
export function RangeToggle({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-xs text-muted-foreground">Price range</span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={String(value)}
        onValueChange={(v) => v && onChange(Number(v))}
        aria-label="Price range"
        className="w-full"
      >
        {RANGES.map((r) => (
          <ToggleGroupItem key={r} value={String(r)} className="num flex-1">
            ±{r}%
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/** Lots: one fewer, the count, one more. */
export function LotsStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-xs text-muted-foreground">Lots</span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="One lot fewer"
          disabled={value <= 1}
          onClick={() => onChange(value - 1)}
        >
          <Minus />
        </Button>
        <span className="num w-10 text-center text-sm font-semibold" aria-label="Lots">
          {value}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="One lot more"
          onClick={() => onChange(value + 1)}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}
