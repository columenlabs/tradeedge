/**
 * Earnings one-liners (Bikram, 2026-10-12, /mnt/project-files/earnings-8k/proposal.md, plan A): when
 * a company the person holds or watches reports, one post in Posts (source SEC) with EPS against the
 * analyst estimate, revenue and guidance, and the "Earnings reported" notification.
 *
 *   Calendar  daily (Refresh earnings calendar): report date, am/pm and EPS estimate of every
 *             symbol held (option underlyings included) or watched, from Robinhood's earnings
 *             calendar with the person's own sign-in. ETFs and funds have no entries there.
 *   Check     every 2 min in the report windows (3:00 to 6:30 AM and 1:00 to 2:30 PM Pacific,
 *             NYSE days; Check earnings reports): for each symbol reporting today in its window
 *             and not found yet, the company's SEC filings list. A new 8-K with Item 2.02 (Results
 *             of Operations) is read: its Exhibit 99.1 (the press release) goes to Workers AI,
 *             which pulls EPS (adjusted when stated, else GAAP), revenue and guidance. No SEC call
 *             outside those windows or for symbols not reporting that day.
 *
 * Robinhood gives no revenue estimate, so revenue shows without one. The calendar and the reports
 * found are kept, sealed, with the Robinhood sign-in (integrations.ts).
 */
import { type Context, Hono } from 'hono';
import type { AccessIdentity } from '../../access';
import { nyParts } from '../../market-hours';
import { IntegrationNotConnected, type Integrations } from './integrations';
import type { Logs } from './logs';
import { type Portfolios, portfolioOwner } from './portfolio';
import type { Posts } from './posts';
import type { Watchlist } from './watchlist';
import type { AiBinding, Post } from './x';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** One upcoming report. */
export interface EarningsEntry {
  symbol: string;
  /** Report day, `YYYY-MM-DD` (US/Eastern). */
  date: string;
  /** False while the company has not confirmed the date. */
  verified: boolean;
  /** `am` (before the open) or `pm` (after the close), null when not known. */
  timing: string | null;
  eps_estimate: number | null;
}
/** A report found in an 8-K. */
export interface EarningsResult {
  symbol: string;
  date: string;
  accession: string;
  line: string;
  url: string;
  at: string;
}
export interface EarningsDoc {
  refreshed_at: string | null;
  calendar: EarningsEntry[];
  /** Newest first, at most 200. */
  reported: EarningsResult[];
}

const SEC_UA = 'EdgeDesk notifications@edgedesk.app';
const EXTRACT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
/** Calendar windows read, 31 days each. */
const WINDOWS = 3;
/** Report windows in Pacific minutes: before the open, after the close. */
export const REPORT_WINDOWS = { am: [180, 390], pm: [780, 870] } as const;
const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
/** Minutes since midnight, Pacific. */
export function pacificMinutes(ms: number) {
  const p = Object.fromEntries(PACIFIC.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}
const inWindow = (m: number, w: readonly [number, number]) => m >= w[0] && m < w[1];
/** Whether `ms` is inside either report window (the check's schedule). */
export const inReportWindow = (ms: number) =>
  inWindow(pacificMinutes(ms), REPORT_WINDOWS.am) ||
  inWindow(pacificMinutes(ms), REPORT_WINDOWS.pm);

const isoDay = (n: number) => {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function resultsOf(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.results)) return o.results as Record<string, unknown>[];
    if (o.data) return resultsOf(o.data);
  }
  return [];
}

/** A press release as plain text. */
function plain(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#\d+;|&\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const money = (usd: number) =>
  usd >= 1e9
    ? `$${(usd / 1e9).toFixed(1)}B`
    : usd >= 1e6
      ? `$${(usd / 1e6).toFixed(0)}M`
      : `$${usd}`;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;

interface Figures {
  quarter: string;
  eps: number | null;
  eps_kind: 'adjusted' | 'gaap' | 'unknown';
  revenue_usd: number | null;
  guidance: string | null;
}

/** `AAPL Q3 FY26 EPS 2.02 (GAAP) vs 1.98 est (+2.0%) ▲ · Rev $109.4B · guide: n/a` */
export function earningsLine(symbol: string, f: Figures, estimate: number | null) {
  const kind = f.eps_kind === 'adjusted' ? ' (adj.)' : f.eps_kind === 'gaap' ? ' (GAAP)' : '';
  let eps = f.eps === null ? 'EPS n/a' : `EPS ${f.eps.toFixed(2)}${kind}`;
  if (f.eps !== null && estimate !== null) {
    const arrow = f.eps > estimate ? '▲' : f.eps < estimate ? '▼' : '=';
    const pct =
      estimate !== 0 ? ` (${signed(((f.eps - estimate) / Math.abs(estimate)) * 100)})` : '';
    eps += ` vs ${estimate.toFixed(2)} est${pct} ${arrow}`;
  }
  const rev = f.revenue_usd === null ? 'Rev n/a' : `Rev ${money(f.revenue_usd)}`;
  return `${symbol} ${f.quarter || ''} ${eps} · ${rev} · guide: ${f.guidance || 'n/a'}`.replace(
    /\s+/g,
    ' ',
  );
}

/** SEC's ticker → CIK map, held a day per isolate. */
let ciks: { at: number; by: Map<string, { cik: number; name: string }> } | null = null;

export class Earnings {
  constructor(
    private readonly integrations: Integrations,
    private readonly portfolios: Portfolios,
    private readonly watchlist: Watchlist,
    private readonly posts: Posts,
    private readonly opts: {
      ai?: AiBinding;
      logs?: Logs;
      fetch?: FetchFn;
      now?: () => number;
    } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }
  // Wrapped: Workers throws "Illegal invocation" when fetch is called as a method.
  private fetch(url: string, init?: RequestInit) {
    return this.opts.fetch ? this.opts.fetch(url, init) : fetch(url, init);
  }

  /** The symbols the person holds (option underlyings included) or watches, without cash. */
  private async symbols(owner: string) {
    const [held, watched] = await Promise.all([
      this.portfolios.heldSymbols(owner),
      this.watchlist.list(owner),
    ]);
    return [...new Set([...held, ...watched.map((w) => w.symbol)])]
      .filter((s) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(s))
      .sort();
  }

  private async doc(owner: string) {
    const doc = await this.integrations.earningsDoc(owner);
    if (!doc)
      throw new IntegrationNotConnected(
        'Robinhood is not connected: the earnings calendar comes from your Robinhood sign-in.',
      );
    return doc;
  }

  /** Refresh earnings calendar: reads the next report of each symbol from Robinhood. */
  async refresh(owner: string, why: string): Promise<string> {
    const t0 = performance.now();
    const what = `Refresh earnings calendar (${why})`;
    try {
      await this.doc(owner);
      const symbols = new Set(await this.symbols(owner));
      const read = await this.integrations.robinhoodReader(owner);
      const today = nyParts(this.now()).date;
      const windows = await read<unknown[]>(
        Array.from({ length: WINDOWS }, (_, i) => ({
          name: 'get_earnings_calendar',
          arguments: {
            start_date: isoDay(nyParts(this.now() + i * 31 * 86_400_000).date),
            days: 31,
          },
        })),
      );
      const by = new Map<string, EarningsEntry>();
      for (const w of windows)
        for (const x of resultsOf(w)) {
          const s = x.symbol;
          const eps = (x.eps ?? {}) as Record<string, unknown>;
          const report = (x.report ?? {}) as Record<string, unknown>;
          const date = text(report.date);
          if (typeof s !== 'string' || !symbols.has(s) || !date) continue;
          // Already reported (an actual EPS) before today: not upcoming.
          if (eps.actual != null && date < isoDay(today)) continue;
          const prev = by.get(s);
          if (prev && prev.date <= date) continue;
          by.set(s, {
            symbol: s,
            date,
            verified: report.verified !== false,
            timing: text(report.timing),
            eps_estimate: num(eps.estimate),
          });
        }
      const calendar = [...by.values()].sort((a, b) =>
        a.date === b.date ? a.symbol.localeCompare(b.symbol) : a.date < b.date ? -1 : 1,
      );
      await this.integrations.earningsUpdate(owner, (d) => ({
        ...d,
        refreshed_at: new Date(this.now()).toISOString(),
        calendar,
      }));
      const soon = calendar.filter(
        (e) => e.date <= isoDay(nyParts(this.now() + 7 * 86_400_000).date),
      );
      const detail = `${symbols.size} symbols, ${calendar.length} with a report date, ${soon.length} in the next 7 days`;
      await this.opts.logs?.note(owner, {
        category: 'earnings',
        what,
        ok: true,
        ms: performance.now() - t0,
        detail,
      });
      return detail;
    } catch (err) {
      await this.opts.logs?.note(owner, {
        category: 'earnings',
        what,
        ok: false,
        ms: performance.now() - t0,
        detail: (err as Error).message.slice(0, 300),
      });
      throw err;
    }
  }

  /** Check earnings reports: looks for today's 8-Ks of symbols reporting in this window. */
  async check(owner: string, why: string): Promise<string> {
    const doc = await this.doc(owner);
    const now = this.now();
    const today = isoDay(nyParts(now).date);
    const m = pacificMinutes(now);
    const done = new Set(doc.reported.filter((r) => r.date === today).map((r) => r.symbol));
    const due = doc.calendar.filter((e) => {
      if (e.date !== today || done.has(e.symbol)) return false;
      if (e.timing === 'am') return inWindow(m, REPORT_WINDOWS.am);
      if (e.timing === 'pm') return inWindow(m, REPORT_WINDOWS.pm);
      return inReportWindow(now);
    });
    if (!due.length) return 'No reports due now';
    const t0 = performance.now();
    let calls = 0;
    const found: { entry: EarningsEntry; post: Post; result: EarningsResult }[] = [];
    const errors: string[] = [];
    try {
      const map = await this.cikMap(() => calls++);
      for (const e of due) {
        try {
          const co = map.get(e.symbol.replace('.', '-')) ?? map.get(e.symbol);
          if (!co) throw new Error('no SEC company for this ticker');
          const hit = await this.report(co, e, today, () => calls++);
          if (hit) found.push({ entry: e, ...hit });
        } catch (err) {
          errors.push(`${e.symbol}: ${(err as Error).message.slice(0, 100)}`);
        }
      }
    } catch (err) {
      errors.push((err as Error).message.slice(0, 200));
    }
    if (found.length) {
      await this.posts.add(
        owner,
        found.map((f) => f.post),
      );
      await this.integrations.earningsUpdate(owner, (d) => ({
        ...d,
        reported: [...found.map((f) => f.result), ...d.reported].slice(0, 200),
      }));
      for (const f of found)
        await this.integrations.notify(owner, 'earnings_reported', {
          title: `${f.entry.symbol} reported`,
          message: f.result.line,
          click: f.result.url,
        });
    }
    const names = found.map((f) => f.entry.symbol).join(', ') || 'none yet';
    const sec = `${calls} SEC call${calls === 1 ? '' : 's'}`;
    const tail = errors.length ? ` · ${errors.join(' · ')}` : '';
    const detail = `${due.length} due, ${found.length} reported: ${names}, ${sec}${tail}`;
    await this.opts.logs?.note(owner, {
      category: 'earnings',
      what: `Check earnings reports (${why})`,
      ok: !errors.length,
      ms: performance.now() - t0,
      detail,
    });
    if (errors.length && !found.length && errors.length === due.length) throw new Error(detail);
    return detail;
  }

  private async sec<T>(url: string, count: () => void, as: 'json' | 'text' = 'json'): Promise<T> {
    count();
    const res = await this.fetch(url, { headers: { 'User-Agent': SEC_UA, accept: '*/*' } });
    if (!res.ok) throw new Error(`SEC ${res.status} on ${new URL(url).pathname.slice(0, 60)}`);
    return (as === 'json' ? await res.json() : await res.text()) as T;
  }

  private async cikMap(count: () => void) {
    if (ciks && this.now() - ciks.at < 86_400_000) return ciks.by;
    const raw = await this.sec<Record<string, { cik_str: number; ticker: string; title: string }>>(
      'https://www.sec.gov/files/company_tickers.json',
      count,
    );
    const by = new Map<string, { cik: number; name: string }>();
    for (const r of Object.values(raw))
      by.set(r.ticker.toUpperCase(), { cik: r.cik_str, name: r.title });
    ciks = { at: this.now(), by };
    return by;
  }

  /** Today's 8-K with Item 2.02 for one company, read into a post; null when not filed yet. */
  private async report(
    co: { cik: number; name: string },
    e: EarningsEntry,
    today: string,
    count: () => void,
  ): Promise<{ post: Post; result: EarningsResult } | null> {
    const cik = String(co.cik).padStart(10, '0');
    const sub = await this.sec<{
      name?: string;
      filings?: {
        recent?: {
          accessionNumber: string[];
          filingDate: string[];
          acceptanceDateTime: string[];
          form: string[];
          items: string[];
          primaryDocument: string[];
        };
      };
    }>(`https://data.sec.gov/submissions/CIK${cik}.json`, count);
    const r = sub.filings?.recent;
    if (!r) return null;
    const i = r.form.findIndex(
      (f, k) =>
        f === '8-K' && r.filingDate[k] === today && (r.items[k] ?? '').split(',').includes('2.02'),
    );
    if (i < 0) return null;
    const accession = r.accessionNumber[i] as string;
    const folder = `https://www.sec.gov/Archives/edgar/data/${co.cik}/${accession.replace(/-/g, '')}`;
    const index = await this.sec<{ directory?: { item?: { name: string }[] } }>(
      `${folder}/index.json`,
      count,
    );
    const names = (index.directory?.item ?? []).map((x) => x.name);
    const exhibit =
      names.find((n) => /ex[-_]?99(\.?0?1)?/i.test(n) && /\.html?$/i.test(n)) ??
      (r.primaryDocument[i] as string);
    const url = `${folder}/${exhibit}`;
    const release = plain(await this.sec<string>(url, count, 'text')).slice(0, 12_000);
    const figures = await this.extract(release);
    const line = earningsLine(e.symbol, figures, e.eps_estimate);
    const at = new Date(r.acceptanceDateTime[i] ?? this.now()).toISOString();
    const surprise =
      figures.eps !== null && e.eps_estimate !== null && e.eps_estimate !== 0
        ? (figures.eps - e.eps_estimate) / Math.abs(e.eps_estimate)
        : null;
    return {
      post: {
        id: `sec:${accession}`,
        source: 'sec',
        url,
        at,
        handle: 'sec',
        name: sub.name ?? co.name,
        text: line,
        symbols: [e.symbol],
        theme: 'earnings',
        theme_conf: 1,
        // A beat reads bullish, a miss bearish: ±10% surprise is ±1.
        sentiment: surprise === null ? null : Math.max(-1, Math.min(1, surprise * 10)),
        sentiment_conf: surprise === null ? null : 1,
      },
      result: { symbol: e.symbol, date: today, accession, line, url, at },
    };
  }

  /** EPS, revenue and guidance from a press release (Workers AI). */
  private async extract(release: string): Promise<Figures> {
    if (!this.opts.ai) throw new Error('Workers AI not configured');
    const r = (await this.opts.ai.run(EXTRACT_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You read a company earnings press release and pull the headline numbers. eps: diluted ' +
            'EPS for the quarter; prefer adjusted (non-GAAP) when the release states it, else GAAP, ' +
            'and say which in eps_kind. revenue_usd: total quarterly revenue in US dollars as a ' +
            'plain number (109.4 billion = 109400000000). quarter: the fiscal quarter, like "Q3 ' +
            'FY26". guidance: next-quarter or full-year outlook in at most 12 words, or null when ' +
            'none is given. Use only numbers the release states. Answer JSON only.',
        },
        { role: 'user', content: release },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: {
            quarter: { type: 'string' },
            eps: { type: ['number', 'null'] },
            eps_kind: { type: 'string', enum: ['adjusted', 'gaap', 'unknown'] },
            revenue_usd: { type: ['number', 'null'] },
            guidance: { type: ['string', 'null'] },
          },
          required: ['quarter', 'eps', 'eps_kind', 'revenue_usd', 'guidance'],
        },
      },
      max_tokens: 300,
    })) as { response?: unknown };
    const body = (typeof r?.response === 'string' ? JSON.parse(r.response) : r?.response) as
      | Partial<Figures>
      | undefined;
    if (!body) throw new Error('no figures in the answer');
    return {
      quarter: String(body.quarter ?? ''),
      eps: num(body.eps),
      eps_kind:
        body.eps_kind === 'adjusted' || body.eps_kind === 'gaap' ? body.eps_kind : 'unknown',
      revenue_usd: num(body.revenue_usd),
      guidance: text(body.guidance),
    };
  }

  /** The calendar with each symbol's last report, for the Earnings view. */
  async list(owner: string) {
    const doc = await this.integrations.earningsDoc(owner);
    if (!doc) return { connected: false as const, refreshed_at: null, rows: [] };
    const last = new Map<string, EarningsResult>();
    for (const r of doc.reported) if (!last.has(r.symbol)) last.set(r.symbol, r);
    const rows = doc.calendar.map((e) => ({ ...e, last: last.get(e.symbol) ?? null }));
    for (const [s, r] of last)
      if (!doc.calendar.some((e) => e.symbol === s))
        rows.push({
          symbol: s,
          date: r.date,
          verified: true,
          timing: null,
          eps_estimate: null,
          last: r,
        });
    return { connected: true as const, refreshed_at: doc.refreshed_at, rows };
  }
}

type Env = { Variables: { identity?: AccessIdentity } };

/** REST under `/api/earnings` (signed in): the person's earnings calendar and last reports. */
export function earningsRoutes(svc: Earnings) {
  const r = new Hono<Env>();
  const owner = (c: Context<Env>) => portfolioOwner(c.get('identity'));
  r.get('/', async (c) => c.json(await svc.list(owner(c))));
  return r;
}
