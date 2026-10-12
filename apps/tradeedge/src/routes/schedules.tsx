/**
 * Schedules (Bikram, 2026-10-12): the work TradeEdge runs on its own for the person, opened from the
 * profile menu: Check X in and outside market hours, and Prune old posts. Each shows when it runs,
 * its next and last run and an On switch; a row opens its settings (every, window, days, time zone)
 * with Run now. X checks show in Logs under X, the prune under Schedules.
 */
import {
  type Schedule,
  type ScheduleChange,
  type ScheduleId,
  runSchedule,
  saveSchedule,
  schedulesQuery,
} from '@/lib/api';
import { ErrorNote } from '@/routes/chain';
import { Page, StatusItem, useIsMobile, usePrefs } from '@edgedesk/app-shell';
import { Badge } from '@edgedesk/app-shell/ui/badge';
import { Button } from '@edgedesk/app-shell/ui/button';
import { Input } from '@edgedesk/app-shell/ui/input';
import { Label } from '@edgedesk/app-shell/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@edgedesk/app-shell/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@edgedesk/app-shell/ui/sheet';
import { Skeleton } from '@edgedesk/app-shell/ui/skeleton';
import { Switch } from '@edgedesk/app-shell/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@edgedesk/app-shell/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@edgedesk/app-shell/ui/toggle-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangleIcon, CheckIcon, PlayIcon, RefreshCwIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** The choices each schedule offers for Every, in minutes. */
const EVERY: Record<ScheduleId, number[]> = {
  x_market: [1, 2, 5, 15],
  x_outside: [60, 120, 240, 480],
  posts_prune: [],
};
const ZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'Europe/London',
  'Asia/Kolkata',
  'UTC',
];

const everyText = (m: number) => (m >= 1440 ? '1 day' : m >= 60 ? `${m / 60} h` : `${m} min`);
/** `13:00` → `1:00 PM`. */
const clockText = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const daysText = (days: number[]) => {
  const d = [...days].sort();
  if (d.length === 7) return 'Every day';
  if (d.join() === '1,2,3,4,5') return 'Weekdays';
  return d.map((x) => DAYS[x]).join(', ');
};
const zoneText = (tz: string) => tz.split('/').pop()?.replace('_', ' ') ?? tz;

/** When it runs, in words. */
function when(s: Schedule) {
  if (s.id === 'x_market')
    return `${daysText(s.days)} ${clockText(s.from)}–${clockText(s.to)} ${zoneText(s.tz)}`;
  if (s.id === 'x_outside') return 'All other times, and market holidays';
  return `Daily at ${clockText(s.from)} ${zoneText(s.tz)} · keeps 30 days`;
}

function useTime() {
  const { timeZone } = usePrefs();
  return (iso: string) =>
    new Date(iso).toLocaleString('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
}

function Last({ s }: { s: Schedule }) {
  const time = useTime();
  if (!s.last) return <span className="text-muted-foreground">Not yet</span>;
  return (
    <span className={`flex min-w-0 items-center gap-1.5 ${s.last.ok ? '' : 'text-loss'}`}>
      {s.last.ok ? (
        <CheckIcon className="size-3.5 shrink-0 text-gain" />
      ) : (
        <AlertTriangleIcon className="size-3.5 shrink-0" />
      )}
      <span className="truncate">
        {time(s.last.at)} · {s.last.detail}
      </span>
    </span>
  );
}

function OnSwitch({ s }: { s: Schedule }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (on: boolean) => saveSchedule(s.id, { on }),
    onSuccess: (r) => qc.setQueryData(schedulesQuery().queryKey, r.schedules),
  });
  return (
    <Switch
      aria-label={`${s.name} on`}
      checked={s.on}
      disabled={m.isPending}
      onClick={(e) => e.stopPropagation()}
      onCheckedChange={(on) => m.mutate(on)}
    />
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/** One schedule's settings, with Run now. */
function Editor({ s, onClose }: { s: Schedule; onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<ScheduleChange>({
    on: s.on,
    every: s.every,
    from: s.from,
    to: s.to,
    days: s.days,
    tz: s.tz,
  });
  const set = (c: ScheduleChange) => setDraft((d) => ({ ...d, ...c }));
  const save = useMutation({
    mutationFn: () => saveSchedule(s.id, draft),
    onSuccess: (r) => {
      qc.setQueryData(schedulesQuery().queryKey, r.schedules);
      onClose();
    },
  });
  const run = useMutation({
    mutationFn: () => runSchedule(s.id),
    onSuccess: (r) => {
      qc.setQueryData(schedulesQuery().queryKey, r.schedules);
      void qc.invalidateQueries({ queryKey: ['posts'] });
      void qc.invalidateQueries({ queryKey: ['integrations'] });
      void qc.invalidateQueries({ queryKey: ['logs'] });
    },
  });
  const zones = ZONES.includes(s.tz) ? ZONES : [s.tz, ...ZONES];
  return (
    <>
      <SheetHeader>
        <SheetTitle>{s.name}</SheetTitle>
        <SheetDescription>{when(s)}</SheetDescription>
      </SheetHeader>
      <div className="grid grid-cols-1 gap-5 px-4">
        <div className="flex items-center justify-between">
          <Label htmlFor="sched-on">On</Label>
          <Switch id="sched-on" checked={draft.on} onCheckedChange={(on) => set({ on })} />
        </div>
        {EVERY[s.id].length ? (
          <Row label="Every">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={String(draft.every)}
              onValueChange={(v) => v && set({ every: Number(v) })}
            >
              {EVERY[s.id].map((m) => (
                <ToggleGroupItem key={m} value={String(m)} className="num">
                  {everyText(m)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Row>
        ) : null}
        {s.id === 'x_market' ? (
          <>
            <Row label="Window">
              <div className="flex items-center gap-2">
                <Input
                  type="time"
                  aria-label="From"
                  className="num w-32"
                  value={draft.from}
                  onChange={(e) => set({ from: e.target.value })}
                />
                <span className="text-muted-foreground">to</span>
                <Input
                  type="time"
                  aria-label="To"
                  className="num w-32"
                  value={draft.to}
                  onChange={(e) => set({ to: e.target.value })}
                />
              </div>
            </Row>
            <Row label="Days">
              <ToggleGroup
                type="multiple"
                variant="outline"
                size="sm"
                spacing={1}
                className="w-full"
                value={(draft.days ?? []).map(String)}
                onValueChange={(v) => v.length && set({ days: v.map(Number) })}
              >
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <ToggleGroupItem key={d} value={String(d)} className="flex-1 px-0">
                    {DAYS[d]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Row>
          </>
        ) : null}
        {s.id === 'posts_prune' ? (
          <Row label="At">
            <Input
              type="time"
              aria-label="At"
              className="num w-32"
              value={draft.from}
              onChange={(e) => set({ from: e.target.value })}
            />
          </Row>
        ) : null}
        {s.id !== 'x_outside' ? (
          <Row label="Time zone">
            <Select value={draft.tz} onValueChange={(tz) => set({ tz })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {z.replace('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        ) : (
          <p className="text-sm text-muted-foreground">
            Runs whenever Check X · market hours is outside its window, including market holidays.
          </p>
        )}
        {s.id !== 'posts_prune' ? (
          <p className="text-xs text-muted-foreground">
            Each check costs twitterapi.io at least $0.00015, and posts $0.15 per 1,000. Market
            holidays count as outside hours.
          </p>
        ) : null}
        {s.waiting ? <p className="text-sm text-warning">{s.waiting}</p> : null}
        {run.data?.run ? (
          <p className={`text-sm ${run.data.run.ok ? '' : 'text-loss'}`}>
            {run.data.run.ok ? 'Ran: ' : 'Failed: '}
            {run.data.run.detail}
          </p>
        ) : null}
        {save.error || run.error ? (
          <p role="alert" className="text-xs text-loss">
            {(save.error ?? run.error)?.message}
          </p>
        ) : null}
      </div>
      <SheetFooter className="flex-row justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={run.isPending || Boolean(s.waiting)}
          onClick={() => run.mutate()}
        >
          {run.isPending ? <RefreshCwIcon className="animate-spin" /> : <PlayIcon />}
          {run.isPending ? 'Running…' : 'Run now'}
        </Button>
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          <CheckIcon />
          Save
        </Button>
      </SheetFooter>
    </>
  );
}

/** `/schedules`. */
export function SchedulesPage() {
  const q = useQuery(schedulesQuery());
  const time = useTime();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState<ScheduleId | null>(null);
  const editing = q.data?.find((s) => s.id === open);
  const failed = q.data?.filter((s) => s.last && !s.last.ok).length ?? 0;
  return (
    <Page
      crumbs={[{ label: 'Schedules' }]}
      status={
        <>
          <StatusItem label="Times" value={usePrefs().timeZone.replace('_', ' ')} />
          <StatusItem
            label="Last runs"
            value={failed ? `${failed} failed` : 'All ok'}
            ok={failed === 0}
          />
        </>
      }
    >
      {q.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : q.isError ? (
        <ErrorNote>{q.error.message}</ErrorNote>
      ) : isMobile ? (
        <div className="grid grid-cols-1 divide-y rounded-lg border">
          {q.data.map((s) => (
            <button
              key={s.id}
              type="button"
              className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 p-3 text-left hover:bg-muted/50"
              onClick={() => setOpen(s.id)}
            >
              <span className="font-medium">{s.name}</span>
              <OnSwitch s={s} />
              <span className="col-span-2 text-xs text-muted-foreground">
                Every {everyText(s.every)} · {when(s)}
              </span>
              <span className="col-span-2 text-xs">
                <Last s={s} />
              </span>
              <span className="col-span-2 text-xs text-muted-foreground">
                {s.waiting ?? (s.next ? `Next ${time(s.next)}` : 'Off')}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Schedule</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Every</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead className="text-right">On</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((s) => (
                <TableRow key={s.id} className="cursor-pointer" onClick={() => setOpen(s.id)}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-muted-foreground">{when(s)}</TableCell>
                  <TableCell className="num">{everyText(s.every)}</TableCell>
                  <TableCell className="num">
                    {s.waiting ? (
                      <Badge variant="outline" className="text-warning">
                        {s.waiting}
                      </Badge>
                    ) : s.next ? (
                      time(s.next)
                    ) : (
                      <span className="text-muted-foreground">Off</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-80">
                    <Last s={s} />
                  </TableCell>
                  <TableCell className="text-right">
                    <OnSwitch s={s} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        X checks show in Logs under X, the prune under Schedules.
      </p>
      <Sheet open={Boolean(editing)} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-4">
          {editing ? <Editor key={editing.id} s={editing} onClose={() => setOpen(null)} /> : null}
        </SheetContent>
      </Sheet>
    </Page>
  );
}
