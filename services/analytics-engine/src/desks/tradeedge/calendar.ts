/**
 * The Dashboard's Calendar (Bikram, 2026-10-12, mockup https://claude.ai/artifact/CeBrGCu3jLFB4CSbNLeFKd):
 * every dated event of the symbols a person holds (option underlyings included) or watches, for a
 * range of days.
 *
 *   earnings  the next report from the earnings calendar (earnings.ts, Robinhood sign-in), and the
 *             8-K one-liner once found
 *   dividend  ex-dividend dates from the symbol fields (Robinhood fundamentals, read live)
 *   macro     FOMC, CPI and Jobs days from DataEdge (`series_1d` `cal:*`), in the suite or with the
 *             person's DataEdge key
 *
 * Nothing is stored here: each read joins the sources, and a source that fails is reported, not
 * thrown.
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import { nyParts } from '../../market-hours';
import type { Earnings } from './earnings';
import type { Integrations } from './integrations';
import { type Portfolios, portfolioOwner } from './portfolio';
import type { SymbolFactsService } from './symbols';
import type { Watchlist } from './watchlist';

export type CalendarKind = 'earnings' | 'dividend' | 'macro';
export interface CalendarEvent {
  /** `YYYY-MM-DD`, the US/Eastern day. */
  date: string;
  kind: CalendarKind;
  /** Ticker, or `FOMC` / `CPI` / `Jobs`. */
  symbol: string;
  /** Held (in any account), watched, both, or neither (macro). */
  held: boolean;
  watched: boolean;
  /** Earnings: `am` before the open, `pm` after the close, null when not known. */
  timing: string | null;
  /** Macro: when it is released (ISO). */
  at: string | null;
  /** Earnings: false while the company has not confirmed the date. */
  verified: boolean;
  eps_estimate: number | null;
  /** Dividend: dollars a share. */
  amount: number | null;
  /** Earnings once reported: the 8-K one-liner and the filing. */
  result: { line: string; url: string; at: string } | null;
  /** Macro: what is released. */
  note: string | null;
}
export interface CalendarSource {
  state: 'ok' | 'not_connected' | 'error';
  error?: string;
}
export interface CalendarRead {
  from: string;
  to: string;
  events: CalendarEvent[];
  earnings: CalendarSource & { refreshed_at: string | null };
  dividends: CalendarSource;
  macro: CalendarSource;
}

const MACRO: Record<'fomc' | 'cpi' | 'jobs', { symbol: string; et: number; note: string }> = {
  fomc: { symbol: 'FOMC', et: 14 * 60, note: 'Fed rate decision' },
  cpi: { symbol: 'CPI', et: 8 * 60 + 30, note: 'Consumer prices' },
  jobs: { symbol: 'Jobs', et: 8 * 60 + 30, note: 'Jobs report' },
};

/** The moment `date` (`YYYY-MM-DD`) reaches `minutes` past midnight in New York. */
function nyTime(date: string, minutes: number) {
  const base = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  for (const h of [4, 5]) {
    const t = base + h * 3_600_000;
    const p = nyParts(t);
    if (p.minutes === minutes && p.date === Number(date.replace(/-/g, '')))
      return new Date(t).toISOString();
  }
  return new Date(base + 4 * 3_600_000).toISOString();
}

const blank = {
  held: false,
  watched: false,
  timing: null,
  at: null,
  verified: true,
  eps_estimate: null,
  amount: null,
  result: null,
  note: null,
} as const;

export class CalendarService {
  constructor(
    private readonly portfolios: Portfolios,
    private readonly watchlist: Watchlist,
    private readonly symbols: SymbolFactsService,
    private readonly earnings?: Earnings,
    private readonly integrations?: Integrations,
  ) {}

  async read(owner: string, from: string, to: string): Promise<CalendarRead> {
    const [held, watched] = await Promise.all([
      this.portfolios.heldSymbols(owner),
      this.watchlist.list(owner).then((w) => w.map((x) => x.symbol)),
    ]);
    const heldSet = new Set(held);
    const watchedSet = new Set(watched);
    const mine = [...new Set([...held, ...watched])].filter((s) =>
      /^[A-Z][A-Z0-9.-]{0,9}$/.test(s),
    );
    const own = (symbol: string) => ({
      held: heldSet.has(symbol),
      watched: watchedSet.has(symbol),
    });
    const inRange = (d: string | null | undefined): d is string => !!d && d >= from && d <= to;
    const events: CalendarEvent[] = [];

    const earnings = await this.readEarnings(owner).catch((err) => ({
      state: 'error' as const,
      error: (err as Error).message,
      refreshed_at: null,
      rows: [],
    }));
    for (const r of earnings.rows) {
      if (inRange(r.date) && !(r.last && r.last.date === r.date))
        events.push({
          ...blank,
          date: r.date,
          kind: 'earnings',
          symbol: r.symbol,
          ...own(r.symbol),
          timing: r.timing,
          verified: r.verified,
          eps_estimate: r.eps_estimate,
        });
      if (r.last && inRange(r.last.date))
        events.push({
          ...blank,
          date: r.last.date,
          kind: 'earnings',
          symbol: r.symbol,
          ...own(r.symbol),
          timing: r.last.date === r.date ? r.timing : null,
          eps_estimate: r.last.date === r.date ? r.eps_estimate : null,
          result: { line: r.last.line, url: r.last.url, at: r.last.at },
        });
    }

    let dividends: CalendarSource = { state: 'ok' };
    if (mine.length) {
      const read = await this.symbols.read(owner, mine);
      dividends =
        read.robinhood.state === 'ok'
          ? { state: 'ok' }
          : read.robinhood.state === 'not_connected'
            ? { state: 'not_connected' }
            : { state: 'error', error: read.robinhood.error };
      for (const [symbol, f] of Object.entries(read.symbols)) {
        const ex = typeof f.ex_dividend === 'string' ? f.ex_dividend.slice(0, 10) : null;
        if (!inRange(ex)) continue;
        events.push({
          ...blank,
          date: ex,
          kind: 'dividend',
          symbol,
          ...own(symbol),
          amount: typeof f.div_per_share === 'number' ? f.div_per_share : null,
        });
      }
    }

    let macro: CalendarSource = { state: 'not_connected' };
    try {
      const history = await this.integrations?.history(owner);
      if (history?.keyDates) {
        const dates = await history.keyDates(from, to);
        for (const k of Object.keys(MACRO) as (keyof typeof MACRO)[])
          for (const date of dates[k])
            events.push({
              ...blank,
              date,
              kind: 'macro',
              symbol: MACRO[k].symbol,
              at: nyTime(date, MACRO[k].et),
              note: MACRO[k].note,
            });
        macro = { state: 'ok' };
      }
    } catch (err) {
      macro = { state: 'error', error: (err as Error).message };
    }

    const order: Record<CalendarKind, number> = { macro: 0, earnings: 1, dividend: 2 };
    events.sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date
          ? -1
          : 1
        : order[a.kind] - order[b.kind] || a.symbol.localeCompare(b.symbol),
    );
    const { rows: _, ...earningsSource } = earnings;
    return { from, to, events, earnings: earningsSource, dividends, macro };
  }

  /** The earnings calendar; read from Robinhood once now when it was never refreshed. */
  private async readEarnings(owner: string) {
    if (!this.earnings) return { state: 'not_connected' as const, refreshed_at: null, rows: [] };
    let list = await this.earnings.list(owner);
    if (list.connected && !list.refreshed_at) {
      await this.earnings.refresh(owner, 'first look');
      list = await this.earnings.list(owner);
    }
    return list.connected
      ? { state: 'ok' as const, refreshed_at: list.refreshed_at, rows: list.rows }
      : { state: 'not_connected' as const, refreshed_at: null, rows: [] };
  }
}

type Env = { Variables: { identity?: AccessIdentity } };
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const range = z
  .object({ from: day, to: day })
  .refine((r) => r.from <= r.to, 'from must be on or before to')
  .refine(
    (r) => Date.parse(r.to) - Date.parse(r.from) <= 62 * 86_400_000,
    'at most 62 days at a time',
  );

/** REST under `/api/calendar` (signed in): `GET /?from=YYYY-MM-DD&to=YYYY-MM-DD`. */
export function calendarRoutes(svc: CalendarService) {
  const r = new Hono<Env>();
  const owner = (c: Context<Env>) => portfolioOwner(c.get('identity'));
  r.get('/', async (c) => {
    const p = range.safeParse({ from: c.req.query('from'), to: c.req.query('to') });
    if (!p.success)
      return c.json(
        {
          error: 'invalid input',
          issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    return c.json(await svc.read(owner(c), p.data.from, p.data.to));
  });
  return r;
}
