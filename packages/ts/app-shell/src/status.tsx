import { cn } from './lib/utils';
import { TIME_ZONES, type TimeZoneId, setPref, usePrefs } from './prefs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

/** Time zone picker: on the right of the status bar, and in Settings. */
export function TimeZoneSelect({
  className,
  side,
}: {
  className?: string;
  /** `top` opens the list upward (the status bar sits at the bottom). */
  side?: 'top' | 'bottom';
}) {
  const { timeZone } = usePrefs();
  return (
    <Select value={timeZone} onValueChange={(v) => setPref('timeZone', v as TimeZoneId)}>
      <SelectTrigger size="sm" aria-label="Time zone" className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position={side ? 'popper' : 'item-aligned'} side={side}>
        {TIME_ZONES.map((z) => (
          <SelectItem key={z.id} value={z.id}>
            {z.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function StatusTimeZone({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center', className)}>
      <TimeZoneSelect side="top" className="h-6 border-0 px-1.5 text-xs shadow-none" />
    </span>
  );
}
