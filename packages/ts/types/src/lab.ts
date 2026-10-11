// Playbook lab (Bikram, 2026-10-10): variants, their tapes and the window maths. A variant is a
// playbook plus values for some of its knobs (the rest stay at their playbook.py defaults); its
// tape is one full-history run at a commit (gzip JSON in R2). Any window is cut from the tape on
// the fly. This module is the one place the window maths lives: the Worker uses it for the
// metrics it stores and the MCP reads, the app for every chart and table.
import { z } from 'zod';
import { benchmarksSchema, commitShaSchema, playbookIdSchema } from './research';

export { playbookTagsSchema } from './research';

// ---------------------------------------------------------------------------------------------
// Requests

export const variantNameSchema = z.string().trim().min(1).max(120);
/** Knob values: only the knobs that differ from the playbook's defaults. */
export const variantValuesSchema = z
  .record(z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 8 * 1024, 'values over 8 KB');
export const variantIdSchema = z.string().regex(/^[0-9a-f-]{8,64}$/);

/** `POST /api/variants`: create or update many variants of one playbook in one call. An item with
 * `id` renames or changes that variant; without it the name finds or creates one. Each saved or
 * changed variant is queued to run. `pinned` pins or unpins the playbook (pins are per playbook). */
export const variantWriteSchema = z.object({
  playbook: playbookIdSchema,
  pinned: z.boolean().optional(),
  variants: z
    .array(
      z.object({
        id: variantIdSchema.optional(),
        name: variantNameSchema,
        values: variantValuesSchema.default({}),
      }),
    )
    .max(100)
    .default([]),
  /** Also queue a run for each saved variant (default false: runs are manual, Bikram 2026-10-10). */
  run: z.boolean().default(false),
});
export type VariantWrite = z.infer<typeof variantWriteSchema>;

/** `POST /api/variants/run`: queue runs for given variants, or every variant of a playbook. */
export const variantRunSchema = z
  .object({
    playbook: playbookIdSchema.optional(),
    variants: z.array(variantIdSchema).max(200).optional(),
    /** The repo ref to run at (default `main`). */
    ref: z
      .string()
      .regex(/^[A-Za-z0-9._/-]{1,100}$/)
      .optional(),
  })
  .refine((b) => !!b.playbook !== !!b.variants?.length, 'give playbook or variants, not both');

/** One knob as the engine reports it with a tape (`tape.knobs` in bchoor/strategies). */
export const labKnobSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    group: z.string(),
    default: z.unknown(),
    unit: z.string().nullable().optional(),
    choices: z
      .array(z.object({ label: z.string(), value: z.unknown() }))
      .nullable()
      .optional(),
    description: z.string(),
    type: z.string().nullable().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    exclusiveMinimum: z.number().optional(),
    exclusiveMaximum: z.number().optional(),
  })
  .loose();
export type LabKnob = z.infer<typeof labKnobSchema>;

/** `POST /api/variants/:id/tapes`: the engine starts a tape at a commit (the gzip JSON follows by PUT). */
export const tapeReportSchema = z.object({
  commit_sha: commitShaSchema,
  path_dependent: z.boolean(),
  knobs: z.array(labKnobSchema).max(200),
  first_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  last_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// ---------------------------------------------------------------------------------------------
// The tape (R2 blob), as the engine writes it

export interface Tape {
  version: number;
  playbook: string;
  values: Record<string, unknown>;
  path_dependent: boolean;
  symbols: string[];
  dates: string[];
  /** Growth of $1 from the first day. */
  nav: number[];
  /** Each symbol's share of the account at each close. */
  weights: Record<string, number[]>;
  trades: { date: string; symbol: string; side: 'buy' | 'sell'; qty: number; price: number }[];
  events: Record<string, unknown>[];
  /** Path-dependent only: a fresh run from every month start; `at` indexes `dates`. */
  cohorts: { start: string; at: number; nav: number[] }[];
}

// ---------------------------------------------------------------------------------------------
// Windows and metrics

/** A window: from a date through `to` (absent = the latest day). */
export interface LabWindow {
  from: string;
  to?: string;
}
/** How a path-dependent variant starts a window: `fresh` (a run from the window's month) or
 * `joined` (the full run, joined mid-flight). Stateless variants are the same either way. */
export type StartMode = 'fresh' | 'joined';

/** The preset windows (Bikram's mockup): 2016, 2018, 2020, 2022 and this year to date. */
export function windowPresets(today = new Date().toISOString().slice(0, 10)) {
  const year = today.slice(0, 4);
  return [
    { key: '2016', label: '2016', from: '2016-01-01' },
    { key: '2018', label: '2018', from: '2018-01-01' },
    { key: '2020', label: '2020', from: '2020-01-01' },
    { key: '2022', label: '2022', from: '2022-01-01' },
    { key: 'ytd', label: `${year} YTD`, from: `${year}-01-01` },
  ];
}
export const windowKeySchema = z.enum(['2016', '2018', '2020', '2022', 'ytd']);
export type WindowKey = z.infer<typeof windowKeySchema>;

/** A window as the API and MCP take it: a preset key, or from (and optional to) dates. */
export const windowSchema = z.union([
  windowKeySchema,
  z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  }),
]);
export type WindowInput = z.infer<typeof windowSchema>;
export const resolveWindow = (w: WindowInput, today?: string): LabWindow =>
  typeof w === 'string'
    ? { from: windowPresets(today).find((p) => p.key === w)?.from ?? '2016-01-01' }
    : w;

/** A series cut to a window, rebased to $1 at its first day. */
export interface Slice {
  dates: string[];
  nav: number[];
  /** Index of the slice's first day in the tape's `dates`. */
  at: number;
  /** Path-dependent fresh start: the cohort's start day. */
  fresh_start?: string;
}

const firstAtOrAfter = (dates: string[], d: string) => {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((dates[mid] as string) < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** The tape over a window. A path-dependent tape in `fresh` mode uses the cohort that starts on or
 * after the window's start (window starts snap to a month). */
export function sliceTape(tape: Tape, w: LabWindow, mode: StartMode = 'fresh'): Slice {
  const end = w.to ? firstAtOrAfter(tape.dates, `${w.to}~`) : tape.dates.length;
  let at = firstAtOrAfter(tape.dates, w.from);
  let source = tape.nav;
  let offset = 0;
  let fresh: string | undefined;
  if (tape.path_dependent && mode === 'fresh' && at > 0) {
    // A cohort's NAV starts at the close before its first session (its $1), so match on `start`.
    const cohort = tape.cohorts.find((c) => c.start >= w.from);
    if (cohort && cohort.at < end) {
      source = cohort.nav;
      offset = cohort.at;
      at = cohort.at;
      fresh = cohort.start;
    }
  }
  const dates = tape.dates.slice(at, end);
  const raw = source.slice(at - offset, at - offset + dates.length);
  const base = raw[0] || 1;
  return {
    dates: dates.slice(0, raw.length),
    nav: raw.map((v) => v / base),
    at,
    ...(fresh ? { fresh_start: fresh } : {}),
  };
}

/** Benchmark closes (`[date, close]`, oldest first) over a window, rebased to $1. */
export function slicePrices(points: [string, number][], w: LabWindow) {
  const rows = points.filter(([d]) => d >= w.from && (!w.to || d <= w.to));
  const base = rows[0]?.[1] || 1;
  return { dates: rows.map((r) => r[0]), nav: rows.map((r) => r[1] / base) };
}

export interface Metrics {
  /** Compound annual growth, a fraction (0.31 = +31%). */
  cagr: number | null;
  /** The deepest fall from a high, a negative fraction. */
  max_dd: number | null;
  /** Daily returns, mean over standard deviation, times √252. */
  sharpe: number | null;
  /** CAGR over the size of the max drawdown. */
  calmar: number | null;
  /** Growth of $1 over the window. */
  growth: number | null;
  first_date: string | null;
  last_date: string | null;
}

const EMPTY: Metrics = {
  cagr: null,
  max_dd: null,
  sharpe: null,
  calmar: null,
  growth: null,
  first_date: null,
  last_date: null,
};
const round = (v: number, n = 4) => Math.round(v * 10 ** n) / 10 ** n;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

/** One formula for every window, in the Worker and the app. */
export function metrics(dates: string[], nav: number[]): Metrics {
  if (nav.length < 2) return EMPTY;
  const first = dates[0] as string;
  const last = dates[dates.length - 1] as string;
  const growth = (nav[nav.length - 1] as number) / (nav[0] as number);
  const span = days(first, last);
  const cagr = span > 0 && growth > 0 ? growth ** (365.25 / span) - 1 : null;
  let peak = nav[0] as number;
  let dd = 0;
  const rets: number[] = [];
  for (let i = 0; i < nav.length; i++) {
    const v = nav[i] as number;
    if (v > peak) peak = v;
    if (peak > 0) dd = Math.min(dd, v / peak - 1);
    if (i > 0 && (nav[i - 1] as number) > 0) rets.push(v / (nav[i - 1] as number) - 1);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(
    rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1),
  );
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : null;
  return {
    cagr: cagr === null ? null : round(cagr),
    max_dd: round(dd),
    sharpe: sharpe === null ? null : round(sharpe, 3),
    calmar: cagr !== null && dd < 0 ? round(cagr / -dd, 3) : null,
    growth: round(growth),
    first_date: first,
    last_date: last,
  };
}

/** The drawdown at each day, a negative fraction. */
export function drawdown(nav: number[]): number[] {
  let peak = Number.NEGATIVE_INFINITY;
  return nav.map((v) => {
    peak = Math.max(peak, v);
    return peak > 0 ? v / peak - 1 : 0;
  });
}

/** Month-end to month-end returns, keyed `YYYY-MM`. */
export function monthlyReturns(dates: string[], nav: number[]): Map<string, number> {
  const ends = new Map<string, number>();
  for (let i = 0; i < dates.length; i++)
    ends.set((dates[i] as string).slice(0, 7), nav[i] as number);
  const out = new Map<string, number>();
  let prev: number | undefined;
  for (const [m, v] of ends) {
    if (prev !== undefined && prev > 0) out.set(m, v / prev - 1);
    prev = v;
  }
  return out;
}

/** Pearson correlation of two monthly return series over the months both have (null under 6). */
export function correlation(a: Map<string, number>, b: Map<string, number>): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [m, x] of a) {
    const y = b.get(m);
    if (y !== undefined) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < 6) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? round(sxy / Math.sqrt(sxx * syy), 3) : null;
}

/** At most `n` evenly spaced points, always keeping the last. */
export function thin<T>(rows: T[], n: number): T[] {
  if (rows.length <= n) return rows;
  const step = (rows.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => rows[Math.round(i * step)] as T);
}

/** Start-date sensitivity: CAGR through the window's end from a fresh start each January (from
 * the cohorts; a stateless tape slices the full run, which is the same thing). */
export function startSensitivity(tape: Tape, to?: string) {
  const years = [...new Set(tape.dates.map((d) => d.slice(0, 4)))];
  return years
    .map((y) => {
      const s = sliceTape(tape, { from: `${y}-01-01`, to }, 'fresh');
      const m = metrics(s.dates, s.nav);
      // A fresh start's first row is the close before its first session; its year is its start's.
      return {
        year: y,
        start: s.fresh_start ?? s.dates[0] ?? null,
        cagr: m.cagr,
        max_dd: m.max_dd,
      };
    })
    .filter((r) => r.start && r.start.slice(0, 4) === r.year);
}

/** What the Worker stores for a tape when it lands: full history and every preset window, fresh
 * start, plus a thinned growth curve since the first day (the Library sparkline). */
export function tapeSummary(tape: Tape, today?: string, spy?: [string, number][]) {
  const windows: Record<string, Metrics & { rho_spy: number | null }> = {};
  const spyMonthly = spy?.length
    ? (w: LabWindow) => {
        const s = slicePrices(spy, w);
        return monthlyReturns(s.dates, s.nav);
      }
    : null;
  for (const p of windowPresets(today)) {
    const s = sliceTape(tape, { from: p.from }, 'fresh');
    const m = metrics(s.dates, s.nav);
    windows[p.key] = {
      ...m,
      rho_spy: spyMonthly
        ? correlation(monthlyReturns(s.dates, s.nav), spyMonthly({ from: p.from }))
        : null,
    };
  }
  const idx = thin(
    tape.nav.map((_, i) => i),
    60,
  );
  return {
    windows,
    sparkline: idx.map((i) => [tape.dates[i] as string, round(tape.nav[i] as number)] as const),
    trades: tape.trades.length,
  };
}
export type TapeSummary = ReturnType<typeof tapeSummary>;

// ---------------------------------------------------------------------------------------------
// Rows the API returns

export const metricKeys = ['cagr', 'max_dd', 'sharpe', 'calmar', 'growth', 'rho_spy'] as const;
export type MetricKey = (typeof metricKeys)[number];

/** `GET /api/variants`: one row per variant with its newest tape's metrics for the window. */
export interface VariantRow {
  id: string;
  playbook_id: string;
  playbook_name: string;
  name: string;
  values: Record<string, unknown>;
  /** The playbook is pinned (pins are per playbook). */
  pinned: boolean;
  tags: string[];
  /** `composer` when the playbook folder is a converted symphony (`strategies/sym_*`). */
  source: 'playbook' | 'composer';
  path_dependent: boolean;
  /** The newest finished tape: its commit and its last day ("data through"). */
  commit_sha: string | null;
  last_date: string | null;
  /** The newest job for this variant. */
  job_state: 'queued' | 'running' | 'done' | 'failed' | null;
  job_error: string | null;
  metrics: (Metrics & { rho_spy: number | null }) | null;
  sparkline: [string, number][] | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------------------------
// Saved comparisons (custom views, domain `comparison`)

export const comparisonMetricSchema = z.enum(['growth', 'cagr', 'max_dd', 'sharpe', 'calmar']);
export const comparisonConfigSchema = z.object({
  variants: z.array(variantIdSchema).max(20).default([]),
  benchmarks: benchmarksSchema.default([]),
  window: windowSchema.default('2016'),
  metric: comparisonMetricSchema.default('cagr'),
});
export type ComparisonConfig = z.infer<typeof comparisonConfigSchema>;
export const comparisonWriteSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
  name: z.string().trim().min(1).max(80),
  config: comparisonConfigSchema,
});
