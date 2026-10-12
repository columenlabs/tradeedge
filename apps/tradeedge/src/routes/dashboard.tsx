/**
 * Dashboard (Bikram, 2026-10-12, mockup https://claude.ai/artifact/CeBrGCu3jLFB4CSbNLeFKd): the
 * TradeEdge home page. Its first tab is Calendar: earnings (before or after the open, EPS estimate,
 * the 8-K one-liner once reported), ex-dividend days and macro days (FOMC, CPI, Jobs) of the symbols
 * the person holds or watches, a week at a time. Desktop shows the week's five trading days side by
 * side; phone lists the days that have events.
 */
import { type CalendarEvent, type CalendarKind, calendarQuery } from '@/lib/api';
import { ErrorNote } from '@/routes/chain';
import { Page, StatusItem, useIsMobile, usePrefs, useShell } from '@edgedesk/app-shell';
import { Button } from '@edgedesk/app-shell/ui/button';
import { Skeleton } from '@edgedesk/app-shell/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@edgedesk/app-shell/ui/tabs';
import { Toggle } from '@edgedesk/app-shell/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@edgedesk/app-shell/ui/toggle-group';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ChevronLeft, ChevronRight, PlugIcon } from 'lucide-react';
import { useState } from 'react';

const KINDS: Record<CalendarKind, { label: string; dot: string; edge: string }> = {
  earnings: { label: 'Earnings', dot: 'bg-primary', edge: 'border-l-primary' },
  dividend: { label: 'Dividends', dot: 'bg-gain', edge: 'border-l-gain' },
  macro: { label: 'Macro', dot: 'bg-warning', edge: 'border-l-warning' },
};
const DAY_MS = 86_400_000;

/** Today in New York, `YYYY-MM-DD` (report days are US/Eastern). */
const nyToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
/** Monday to Friday of the week `offset` weeks from this one. */
function week(offset: number) {
  const t = utc(nyToday());
  const wd = new Date(t).getUTCDay();
  const monday = t - ((wd + 6) % 7) * DAY_MS + offset * 7 * DAY_MS;
  return Array.from({ length: 5 }, (_, i) => iso(monday + i * DAY_MS));
}
const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(utc(d)).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

function useClock() {
  const { timeZone } = usePrefs();
  return (at: string) =>
    new Date(at).toLocaleTimeString('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
}

const whose = (e: CalendarEvent) =>
  e.held && e.watched ? 'held, watched' : e.held ? 'held' : e.watched ? 'watched' : null;

/** What the event says under its symbol. */
function Detail({ e }: { e: CalendarEvent }) {
  const clock = useClock();
  if (e.kind === 'macro') return <>{`${e.at ? clock(e.at) : ''} · ${e.note ?? ''}`}</>;
  if (e.kind === 'dividend')
    return (
      <>
        {[e.amount === null ? null : `$${e.amount.toFixed(2)} / share`, whose(e)]
          .filter(Boolean)
          .join(' · ')}
      </>
    );
  return (
    <>
      {[e.eps_estimate === null ? null : `EPS est ${e.eps_estimate.toFixed(2)}`, whose(e)]
        .filter(Boolean)
        .join(' · ')}
    </>
  );
}

const when = (e: CalendarEvent) =>
  e.kind === 'dividend'
    ? 'Ex-div'
    : e.kind === 'macro'
      ? null
      : e.result
        ? 'Reported'
        : `${e.timing === 'am' ? 'Before open' : e.timing === 'pm' ? 'After close' : 'Time not set'}${e.verified ? '' : ' ~'}`;

function Result({ e }: { e: CalendarEvent }) {
  if (!e.result) return null;
  const up = e.result.line.includes('▲');
  const down = e.result.line.includes('▼');
  return (
    <a
      href={e.result.url}
      target="_blank"
      rel="noreferrer"
      className={`flex items-start gap-1 text-xs leading-snug hover:underline ${up ? 'text-gain' : down ? 'text-loss' : ''}`}
      title="Open filing"
    >
      <span className="min-w-0">{e.result.line.replace(/^\S+\s/, '')}</span>
      <ArrowUpRight className="size-3 shrink-0" />
    </a>
  );
}

function Event({ e }: { e: CalendarEvent }) {
  return (
    <div
      className={`grid gap-0.5 rounded-md border border-l-[3px] bg-card px-2 py-1.5 ${KINDS[e.kind].edge}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{e.symbol}</span>
        <span className="text-xs text-muted-foreground">{when(e)}</span>
      </div>
      <div className="num text-xs text-muted-foreground">
        <Detail e={e} />
      </div>
      <Result e={e} />
    </div>
  );
}

function CalendarTab() {
  const isMobile = useIsMobile();
  const { openSettings } = useShell();
  const [offset, setOffset] = useState(0);
  const [kinds, setKinds] = useState<CalendarKind[]>(['earnings', 'dividend', 'macro']);
  const [heldOnly, setHeldOnly] = useState(false);
  const days = week(offset);
  const today = nyToday();
  const q = useQuery(calendarQuery(days[0] as string, days[4] as string));
  const all = q.data?.events ?? [];
  const shown = all.filter(
    (e) => kinds.includes(e.kind) && (!heldOnly || e.kind === 'macro' || e.held),
  );
  const count = (k: CalendarKind) =>
    all.filter((e) => e.kind === k && (!heldOnly || k === 'macro' || e.held)).length;
  const range = `${dayLabel(days[0] as string, { month: 'short', day: 'numeric' })} – ${dayLabel(days[4] as string, { month: 'short', day: 'numeric' })}`;
  const noRobinhood = q.data?.earnings.state === 'not_connected';
  const reported = shown.filter((e) => e.result);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous week"
            onClick={() => setOffset(offset - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant={offset === 0 ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setOffset(0)}
          >
            This week
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next week"
            onClick={() => setOffset(offset + 1)}
          >
            <ChevronRight />
          </Button>
          <span className="num ml-1 text-sm text-muted-foreground">{range}</span>
        </div>
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          value={kinds}
          onValueChange={(v) => setKinds(v as CalendarKind[])}
        >
          {(Object.keys(KINDS) as CalendarKind[]).map((k) => (
            <ToggleGroupItem key={k} value={k} aria-label={KINDS[k].label}>
              <span className={`size-2 rounded-full ${KINDS[k].dot}`} />
              {isMobile ? null : KINDS[k].label}
              <span className="num text-muted-foreground">{q.data ? count(k) : ''}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Toggle variant="outline" size="sm" pressed={heldOnly} onPressedChange={setHeldOnly}>
          Held only
        </Toggle>
      </div>

      {noRobinhood ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm">
          <span>
            Connect Robinhood to see earnings and ex-dividend days of the symbols you hold or watch.
          </span>
          <Button size="sm" variant="outline" onClick={() => openSettings('integrations')}>
            <PlugIcon />
            Open Integrations
          </Button>
        </div>
      ) : null}

      {q.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : q.isError ? (
        <ErrorNote>{q.error.message}</ErrorNote>
      ) : isMobile ? (
        <div className="grid gap-3">
          {days.filter((d) => shown.some((e) => e.date === d)).length ? (
            days
              .filter((d) => shown.some((e) => e.date === d))
              .map((d) => (
                <section key={d} className="grid gap-1.5">
                  <h3 className={`text-sm font-semibold ${d === today ? 'text-primary' : ''}`}>
                    {d === today ? 'Today · ' : ''}
                    {dayLabel(d, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </h3>
                  {shown
                    .filter((e) => e.date === d)
                    .map((e) => (
                      <Event key={`${e.kind}:${e.symbol}:${e.date}:${e.result ? 'r' : ''}`} e={e} />
                    ))}
                </section>
              ))
          ) : (
            <p className="text-sm text-muted-foreground">Nothing on the calendar this week.</p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-5 overflow-hidden rounded-lg border">
          {days.map((d) => (
            <div key={d} className="grid min-h-64 min-w-0 content-start border-r last:border-r-0">
              <div
                className={`flex items-baseline justify-between border-b bg-card px-2.5 py-1.5 text-sm font-semibold ${d === today ? 'text-primary' : ''}`}
              >
                {dayLabel(d, { weekday: 'short' })}
                <span className="num text-xs font-normal text-muted-foreground">
                  {dayLabel(d, { month: 'short', day: 'numeric' })}
                </span>
              </div>
              <div className="grid gap-1.5 p-1.5">
                {shown
                  .filter((e) => e.date === d)
                  .map((e) => (
                    <Event key={`${e.kind}:${e.symbol}:${e.date}:${e.result ? 'r' : ''}`} e={e} />
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!isMobile && reported.length ? (
        <div className="grid gap-1 rounded-lg border p-3">
          <h3 className="text-sm font-semibold">Reported this week</h3>
          {reported.map((e) => (
            <a
              key={`${e.symbol}:${e.date}`}
              href={e.result?.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-baseline gap-2 text-sm hover:underline"
            >
              <span className="min-w-0">{e.result?.line}</span>
              <ArrowUpRight className="size-3 shrink-0 self-center" />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** `/dashboard`. */
export function DashboardPage() {
  const { timeZone } = usePrefs();
  const days = week(0);
  const q = useQuery(calendarQuery(days[0] as string, days[4] as string));
  const refreshed = q.data?.earnings.refreshed_at;
  return (
    <Page
      crumbs={[{ label: 'Dashboard' }]}
      status={
        <>
          {refreshed ? (
            <StatusItem
              label="Calendar"
              value={new Date(refreshed).toLocaleString('en-US', {
                timeZone,
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
              ok
            />
          ) : null}
          {q.data && q.data.earnings.state === 'error' ? (
            <StatusItem label="Earnings" value="failed" ok={false} />
          ) : null}
          {q.data && q.data.macro.state === 'error' ? (
            <StatusItem label="Macro days" value="failed" ok={false} />
          ) : null}
          {q.data && q.data.dividends.state === 'error' ? (
            <StatusItem label="Dividends" value="failed" ok={false} />
          ) : null}
        </>
      }
    >
      <Tabs defaultValue="calendar" className="gap-3">
        <TabsList>
          <TabsTrigger value="calendar">Calendar</TabsTrigger>
        </TabsList>
        <TabsContent value="calendar">
          <CalendarTab />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
