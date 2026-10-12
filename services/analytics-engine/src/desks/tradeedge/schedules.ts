/**
 * Schedules (Bikram, 2026-10-12): the work TradeEdge runs for a person on its own, listed under the
 * profile menu ▸ Schedules, each changeable by the person. "Schedule", not "job": a Job is
 * ResearchEdge's queued runner request.
 *
 *   x_market     Check X in market hours: every 2 min, 6:30 AM to 1:00 PM Pacific, Mon to Fri,
 *                NYSE holidays skipped (they count as outside hours)
 *   x_outside    Check X outside market hours: every 4 h, whenever x_market's window is closed
 *   news_market  Check news in market hours: every 2 min in its own window (like x_market), with the
 *                person's Alpaca key (Bikram, 2026-10-12)
 *   news_outside Check news outside market hours: every 4 h, whenever news_market's window is closed
 *   posts_prune  Prune old posts: daily at 2:00 AM Pacific, removes D1 posts past 30 days
 *   earnings_calendar  Refresh earnings calendar: daily at 2:30 AM Pacific, with the person's
 *                Robinhood sign-in (earnings.ts)
 *   earnings     Check earnings reports: every 2 min inside the report windows (3:00 to 6:30 AM and
 *                1:00 to 2:30 PM Pacific, NYSE days), only for symbols reporting that day
 *
 * One sealed document per person in D1 `schedules` (migration 0031); its plain `next_at` is when the
 * earliest one is due, so the Worker's every-minute cron reads only the people with work
 * (`runDue`). A run is claimed by moving its next time first (a version check), so two crons never
 * run it twice.
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import { isTradingDay, nyParts } from '../../market-hours';
import { type Vault, withRetry } from '../../vault';
import { inReportWindow } from './earnings';
import type { Logs } from './logs';
import { portfolioOwner } from './portfolio';

export const SCHEDULE_IDS = [
  'x_market',
  'x_outside',
  'news_market',
  'news_outside',
  'posts_prune',
  'earnings_calendar',
  'earnings',
] as const;
export type ScheduleId = (typeof SCHEDULE_IDS)[number];

export interface ScheduleRun {
  at: string;
  ok: boolean;
  /** One line: what the run did, or its error. */
  detail: string;
}
export interface Schedule {
  id: ScheduleId;
  on: boolean;
  /** Minutes between runs (posts_prune: 1440, once a day). */
  every: number;
  /** `HH:MM` in `tz`: the window's start (x_market) or the time of day (posts_prune). */
  from: string;
  /** `HH:MM` in `tz`: the window's end (x_market). */
  to: string;
  /** Days it runs, 0 = Sunday (x_market). */
  days: number[];
  /** IANA time zone, e.g. `America/Los_Angeles`. */
  tz: string;
  last: ScheduleRun | null;
}
interface Doc {
  schedules: Schedule[];
  /** False while X is not connected: the X checks don't run. */
  x: boolean;
  /** False while Alpaca is not connected: Check news doesn't run. */
  news?: boolean;
  /** False while Robinhood is not connected: the earnings schedules don't run. */
  earnings?: boolean;
}
/** Which outside services are connected, so their schedules can run. */
export interface Ready {
  x: boolean;
  news: boolean;
  earnings: boolean;
}

const PACIFIC = 'America/Los_Angeles';
const DEFAULTS: Record<ScheduleId, Schedule> = {
  x_market: {
    id: 'x_market',
    on: true,
    every: 2,
    from: '06:30',
    to: '13:00',
    days: [1, 2, 3, 4, 5],
    tz: PACIFIC,
    last: null,
  },
  x_outside: {
    id: 'x_outside',
    on: true,
    every: 240,
    from: '',
    to: '',
    days: [],
    tz: PACIFIC,
    last: null,
  },
  news_market: {
    id: 'news_market',
    on: true,
    every: 2,
    from: '06:30',
    to: '13:00',
    days: [1, 2, 3, 4, 5],
    tz: PACIFIC,
    last: null,
  },
  news_outside: {
    id: 'news_outside',
    on: true,
    every: 240,
    from: '',
    to: '',
    days: [],
    tz: PACIFIC,
    last: null,
  },
  posts_prune: {
    id: 'posts_prune',
    on: true,
    every: 1440,
    from: '02:00',
    to: '',
    days: [0, 1, 2, 3, 4, 5, 6],
    tz: PACIFIC,
    last: null,
  },
  earnings_calendar: {
    id: 'earnings_calendar',
    on: true,
    every: 1440,
    from: '02:30',
    to: '',
    days: [0, 1, 2, 3, 4, 5, 6],
    tz: PACIFIC,
    last: null,
  },
  earnings: {
    id: 'earnings',
    on: true,
    every: 2,
    from: '',
    to: '',
    days: [1, 2, 3, 4, 5],
    tz: PACIFIC,
    last: null,
  },
};
export const SCHEDULE_NAMES: Record<ScheduleId, string> = {
  x_market: 'Check X · market hours',
  x_outside: 'Check X · outside market hours',
  news_market: 'Check news · market hours',
  news_outside: 'Check news · outside market hours',
  posts_prune: 'Prune old posts',
  earnings_calendar: 'Refresh earnings calendar',
  earnings: 'Check earnings reports',
};
const DAILY: ScheduleId[] = ['posts_prune', 'earnings_calendar'];
const MIN = 60_000;
const readyOf = (doc: Doc): Ready => ({
  x: doc.x,
  news: doc.news ?? false,
  earnings: doc.earnings ?? false,
});
/** How far ahead a next run is looked for. */
const HORIZON = 8 * 1440;
/** People whose schedules one cron tick runs. */
const PER_TICK = 25;

const fmts = new Map<string, Intl.DateTimeFormat>();
/** Weekday (0 = Sunday) and minutes since midnight at `ms` in `tz`. */
function local(ms: number, tz: string) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    fmts.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? '');
  return { weekday: wd, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Whether `t` is inside the market-hours schedule's window (its days, hours and zone; no NYSE holiday). */
function inMarketWindow(s: Schedule, t: number) {
  const ny = nyParts(t);
  if (ny.weekday >= 1 && ny.weekday <= 5 && !isTradingDay(ny)) return false;
  const l = local(t, s.tz);
  const from = minutesOf(s.from);
  const to = minutesOf(s.to);
  return s.days.includes(l.weekday) && l.minutes >= from && l.minutes < to;
}

/** When `s` next runs (ms), or null when it is off or can't run. */
export function nextRun(
  s: Schedule,
  all: Schedule[],
  now: number,
  ready: Ready = { x: true, news: true, earnings: true },
): number | null {
  if (!s.on) return null;
  if ((s.id === 'x_market' || s.id === 'x_outside') && !ready.x) return null;
  if ((s.id === 'news_market' || s.id === 'news_outside') && !ready.news) return null;
  if ((s.id === 'earnings_calendar' || s.id === 'earnings') && !ready.earnings) return null;
  const last = s.last ? Date.parse(s.last.at) : null;
  // A daily run waits at least an hour after the last, so it never runs twice in one minute.
  const gap = DAILY.includes(s.id) ? 60 : s.every;
  let t = Math.ceil(Math.max(now, last === null ? now : last + gap * MIN) / MIN) * MIN;
  const window = (id: 'x_market' | 'news_market') => all.find((x) => x.id === id) ?? DEFAULTS[id];
  const ok = (at: number) =>
    s.id === 'x_market' || s.id === 'news_market'
      ? inMarketWindow(s, at)
      : s.id === 'x_outside'
        ? !inMarketWindow(window('x_market'), at)
        : s.id === 'news_outside'
          ? !inMarketWindow(window('news_market'), at)
          : s.id === 'earnings'
            ? isTradingDay(nyParts(at)) && inReportWindow(at)
            : local(at, s.tz).minutes === minutesOf(s.from);
  for (let i = 0; i < HORIZON; i++, t += MIN) if (ok(t)) return t;
  return null;
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour');
const tz = z
  .string()
  .min(1)
  .max(64)
  .refine((z) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: z });
      return true;
    } catch {
      return false;
    }
  }, 'not a time zone');
export const scheduleChange = z
  .object({
    on: z.boolean(),
    every: z.number().int().min(1).max(1440),
    from: hhmm,
    to: hhmm,
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    tz,
  })
  .partial();
export type ScheduleChange = z.infer<typeof scheduleChange>;

/** What each schedule does when it runs: a one-line report, or a throw when it failed. */
export type ScheduleJobs = Record<ScheduleId, (owner: string, why: string) => Promise<string>>;

export class Schedules {
  constructor(
    private readonly db: D1Like,
    private readonly vault: Vault,
    private readonly jobs: ScheduleJobs,
    private readonly logs?: Logs,
    /** Which outside services the person has connected, read live; corrects the stored flags. */
    private readonly connected?: (owner: string) => Promise<Ready>,
  ) {}

  private async load(owner: string) {
    const v = await this.vault.for(owner);
    const row = await this.db
      .prepare('SELECT data, version FROM schedules WHERE owner = ?')
      .bind(v.owner)
      .first<{ data: string; version: number }>();
    const stored = row ? await v.open<Doc>(`schedules:${v.owner}`, row.data) : null;
    const doc: Doc = {
      x: stored?.x ?? false,
      news: stored?.news ?? false,
      earnings: stored?.earnings ?? false,
      schedules: SCHEDULE_IDS.map((id) => ({
        ...DEFAULTS[id],
        ...(stored?.schedules.find((s) => s.id === id) ?? {}),
      })),
    };
    return { v, doc, version: row ? Number(row.version) : 0 };
  }

  /** Writes the document and its next due time; false when another write got there first. */
  private async store(owner: string, doc: Doc, version: number): Promise<boolean> {
    const v = await this.vault.for(owner);
    const now = Date.now();
    const times = doc.schedules
      .map((s) => nextRun(s, doc.schedules, now, readyOf(doc)))
      .filter((t): t is number => t !== null);
    const next = times.length ? Math.min(...times) : null;
    const data = await v.seal(`schedules:${v.owner}`, doc);
    const r = await (version === 0
      ? this.db
          .prepare(
            'INSERT OR IGNORE INTO schedules (owner, next_at, data, version) VALUES (?, ?, ?, 1)',
          )
          .bind(v.owner, next, data)
      : this.db
          .prepare(
            'UPDATE schedules SET next_at = ?, data = ?, version = version + 1 WHERE owner = ? AND version = ?',
          )
          .bind(next, data, v.owner, version)
    ).run();
    return Number(r.meta?.changes ?? 1) > 0;
  }

  private change(owner: string, f: (doc: Doc) => Doc): Promise<Doc> {
    return withRetry(async () => {
      const { doc, version } = await this.load(owner);
      const next = f(doc);
      if (!(await this.store(owner, next, version))) throw new ScheduleConflict();
      return next;
    });
  }

  /** The person's schedules with their names and next runs. */
  async list(owner: string) {
    let { doc } = await this.load(owner);
    // A service connected before its schedule existed (or the flag missed a change): set it right.
    const live = await this.connected?.(owner);
    if (
      live &&
      (live.x !== doc.x ||
        live.news !== (doc.news ?? false) ||
        live.earnings !== (doc.earnings ?? false))
    )
      doc = await this.change(owner, (d) => ({ ...d, ...live }));
    const now = Date.now();
    return doc.schedules.map((s) => {
      const next = nextRun(s, doc.schedules, now, readyOf(doc));
      return {
        ...s,
        name: SCHEDULE_NAMES[s.id],
        next: next === null ? null : new Date(next).toISOString(),
        waiting:
          s.id === 'news_market' || s.id === 'news_outside'
            ? doc.news
              ? null
              : 'Alpaca is not connected'
            : s.id === 'earnings_calendar' || s.id === 'earnings'
              ? doc.earnings
                ? null
                : 'Robinhood is not connected'
              : !doc.x && s.id !== 'posts_prune'
                ? 'X is not connected'
                : null,
      };
    });
  }

  async update(owner: string, id: ScheduleId, change: ScheduleChange) {
    if (
      change.from &&
      change.to &&
      minutesOf(change.from) >= minutesOf(change.to) &&
      (id === 'x_market' || id === 'news_market')
    )
      throw new ScheduleInvalid('The window must end after it starts.');
    await this.change(owner, (doc) => ({
      ...doc,
      schedules: doc.schedules.map((s) => (s.id === id ? { ...s, ...change } : s)),
    }));
    return this.list(owner);
  }

  /** X was connected or disconnected (integrations.ts): the X checks start or stop. */
  async setX(owner: string, connected: boolean) {
    await this.change(owner, (doc) => ({ ...doc, x: connected }));
  }

  /** Alpaca was connected, tested or disconnected (integrations.ts): Check news starts or stops. */
  async setNews(owner: string, connected: boolean) {
    await this.change(owner, (doc) => ({ ...doc, news: connected }));
  }

  /** Robinhood was connected, tested or disconnected (integrations.ts): the earnings schedules start or stop. */
  async setEarnings(owner: string, connected: boolean) {
    await this.change(owner, (doc) => ({ ...doc, earnings: connected }));
  }

  /** Runs one schedule now, for the person (Run now); its regular times stay as they are. */
  async runNow(owner: string, id: ScheduleId) {
    const run = await this.run(owner, id, 'Run now');
    await this.change(owner, (doc) => ({
      ...doc,
      schedules: doc.schedules.map((s) => (s.id === id ? { ...s, last: run } : s)),
    }));
    return { run, schedules: await this.list(owner) };
  }

  private async run(owner: string, id: ScheduleId, why: string): Promise<ScheduleRun> {
    const at = new Date().toISOString();
    const t0 = performance.now();
    let run: ScheduleRun;
    try {
      run = { at, ok: true, detail: await this.jobs[id](owner, why) };
    } catch (err) {
      run = { at, ok: false, detail: ((err as Error).message ?? String(err)).slice(0, 300) };
    }
    // X, news and earnings log themselves (categories X, News, Earnings); the prune is logged here.
    if (id === 'posts_prune')
      await this.logs?.note(owner, {
        category: 'schedules',
        what: `${SCHEDULE_NAMES[id]} (${why})`,
        ok: run.ok,
        ms: performance.now() - t0,
        detail: run.detail,
      });
    return run;
  }

  /**
   * The cron's work, once a minute: runs every schedule that is due, for up to 25 people. Each run is
   * claimed first (its `last` moves to now), so a slow run never starts twice.
   */
  async runDue(now = Date.now()): Promise<void> {
    const { results } = await this.db
      .prepare('SELECT owner FROM schedules WHERE next_at <= ? ORDER BY next_at LIMIT ?')
      .bind(now, PER_TICK)
      .all<{ owner: string }>();
    await Promise.all(
      results.map((r) =>
        this.runOwner(r.owner, now).catch((err) => console.error('schedules', err)),
      ),
    );
  }

  private async runOwner(owner: string, now: number) {
    const { doc, version } = await this.load(owner);
    const due = doc.schedules.filter((s) => {
      const t = nextRun(s, doc.schedules, now - MIN + 1, readyOf(doc));
      return t !== null && t <= now;
    });
    if (!due.length) {
      await this.store(owner, doc, version); // refreshes a stale next_at
      return;
    }
    const at = new Date(now).toISOString();
    const claimed: Doc = {
      ...doc,
      schedules: doc.schedules.map((s) =>
        due.includes(s) ? { ...s, last: { at, ok: true, detail: 'Running' } } : s,
      ),
    };
    if (!(await this.store(owner, claimed, version))) return; // another cron took it
    for (const s of due) {
      const why =
        s.id === 'x_market' || s.id === 'news_market'
          ? 'market hours'
          : s.id === 'x_outside' || s.id === 'news_outside'
            ? 'outside market hours'
            : 'schedule';
      const run = await this.run(owner, s.id, why);
      await this.change(owner, (d) => ({
        ...d,
        schedules: d.schedules.map((x) => (x.id === s.id ? { ...x, last: { ...run, at } } : x)),
      }));
    }
  }
}

export class ScheduleInvalid extends Error {}
class ScheduleConflict extends Error {
  constructor() {
    super('version conflict');
  }
}

type Env = { Variables: { identity?: AccessIdentity } };

/** REST under `/api/schedules` (signed in). */
export function scheduleRoutes(svc: Schedules) {
  const r = new Hono<Env>();
  const owner = (c: Context<Env>) => portfolioOwner(c.get('identity'));
  const id = (c: Context<Env>) => {
    const p = z.enum(SCHEDULE_IDS).safeParse(c.req.param('id'));
    return p.success ? p.data : null;
  };
  r.onError((err, c) => {
    if (err instanceof ScheduleInvalid) return c.json({ error: err.message }, 400);
    throw err;
  });
  r.get('/', async (c) => c.json({ schedules: await svc.list(owner(c)) }));
  r.put('/:id', async (c) => {
    const which = id(c);
    if (!which) return c.json({ error: 'no such schedule' }, 404);
    const body = await c.req.json().catch(() => null);
    const p = scheduleChange.safeParse(body ?? {});
    if (!p.success)
      return c.json(
        {
          error: 'invalid input',
          issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    return c.json({ schedules: await svc.update(owner(c), which, p.data) });
  });
  r.post('/:id/run', async (c) => {
    const which = id(c);
    if (!which) return c.json({ error: 'no such schedule' }, 404);
    return c.json(await svc.runNow(owner(c), which));
  });
  return r;
}
