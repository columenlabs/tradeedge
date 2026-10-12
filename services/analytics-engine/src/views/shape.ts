// Group and pivot for every desk's views (Bikram, 2026-10-08): a desk computes its rows (the
// explorer from ClickHouse, the portfolio from D1), and this rolls them up on each read so the page
// and the MCP get the same answer. Rows are capped by each desk (the explorer at 20,000), which is
// cheap to fold in the Worker; nothing here is stored.
//   group: one row per calendar period (week, month, quarter, year, weekday) of the row's date, or
//          per value of a column (a number or text, like a symbol); each entry rolls one column up
//          with last, first, mean, sum, min, max or count.
//   filter: tokens (key:value) keep the rows whose column matches; tokens on one key are OR'd,
//           a `not` token drops rows with its value, different keys AND'd. It runs before group and pivot, so roll-ups count only kept rows.
//   pivot: one value rolled up into a grid. Its buckets are calendar parts (year; quarter Q1-Q4,
//          month Jan-Dec, week W1-W53 and weekday Mon-Fri) or a column's values.
import type {
  ViewAgg,
  ViewFormat,
  ViewGrouped,
  ViewPivoted,
  ViewToken,
  ViewValue,
} from '@edgedesk/types/views';
import { meetsNumber } from '@edgedesk/types/views';

/** A view problem, named by column so the writer (a person or Claude) can fix it. */
export class ViewError extends Error {
  constructor(
    readonly column: string | null,
    message: string,
  ) {
    super(column ? `${column}: ${message}` : message);
  }
}

/** Rows come newest first; `date` (yyyy-mm-dd) is what calendar buckets read. */
type Row = { date?: string; values: ViewValue[] };
type Bucket = { label: string; sort: number | string };

const PERIODS = ['week', 'month', 'quarter', 'year', 'weekday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const parts = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return { d, y: d.getUTCFullYear(), m: d.getUTCMonth(), dow: d.getUTCDay() };
};
/** ISO week number (1-53). */
const isoWeek = (d: Date) => {
  const t = new Date(d);
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const start = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - start) / 86_400_000 + 1) / 7);
};

/** `group` buckets are whole periods (2026-10, 2026-Q4, week of 2026-10-05). */
function period(by: string, iso: string): Bucket {
  const { d, y, m, dow } = parts(iso);
  switch (by) {
    case 'week': {
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
      const label = monday.toISOString().slice(0, 10);
      return { label, sort: label };
    }
    case 'month': {
      const label = `${y}-${String(m + 1).padStart(2, '0')}`;
      return { label, sort: label };
    }
    case 'quarter': {
      const label = `${y}-Q${Math.floor(m / 3) + 1}`;
      return { label, sort: label };
    }
    case 'year':
      return { label: String(y), sort: String(y) };
    default:
      return { label: DAYS[dow] ?? '', sort: dow };
  }
}

/** `pivot` buckets are calendar parts, so years line up against months, weekdays, and so on. */
function part(by: string, iso: string): Bucket {
  const { d, y, m, dow } = parts(iso);
  switch (by) {
    case 'year':
      return { label: String(y), sort: -y };
    case 'quarter':
      return { label: `Q${Math.floor(m / 3) + 1}`, sort: Math.floor(m / 3) };
    case 'month':
      return { label: MONTHS[m] ?? '', sort: m };
    case 'week': {
      const w = isoWeek(d);
      return { label: `W${w}`, sort: w };
    }
    default:
      return { label: DAYS[dow] ?? '', sort: dow };
  }
}

const num = (v: ViewValue) => (typeof v === 'number' ? v : null);
const round = (v: number) => Math.round(v * 1e8) / 1e8;

/** Rolls values (newest first) up; nulls are skipped, and a bucket with no values is null. */
function roll(values: ViewValue[], agg: ViewAgg): ViewValue {
  const have = values.filter(
    (v) => v !== null && !(Array.isArray(v) && v.every((x) => x === null)),
  );
  if (agg === 'count') return have.length;
  if (!have.length) return null;
  if (agg === 'last') return have[0] ?? null;
  if (agg === 'first') return have[have.length - 1] ?? null;
  const xs = have.map(num).filter((x): x is number => x !== null);
  if (!xs.length) return null;
  if (agg === 'sum') return round(xs.reduce((a, b) => a + b, 0));
  if (agg === 'mean') return round(xs.reduce((a, b) => a + b, 0) / xs.length);
  if (agg === 'min') return Math.min(...xs);
  return Math.max(...xs);
}

/** What shaping needs to know about a column. */
export interface ViewColumn {
  key: string;
  label: string;
  format: ViewFormat;
  hidden?: boolean;
}

export interface Context {
  /** Every column of the view, hidden ones included, in the order the rows carry them. */
  columns: ViewColumn[];
  spans: Set<string>;
}

const index = (ctx: Context, key: string, what: string) => {
  const i = ctx.columns.findIndex((c) => c.key === key);
  if (i < 0) throw new ViewError(null, `${what}: no column ${key}`);
  return i;
};
const checkAgg = (ctx: Context, key: string, agg: ViewAgg) => {
  if (ctx.spans.has(key) && !['first', 'last', 'count'].includes(agg)) {
    throw new ViewError(key, 'a span rolls up only with first, last or count');
  }
};

/** A bucketing function: a period or part, else the values of a column (its spans refused). */
function bucketer(ctx: Context, by: string, calendar: (by: string, iso: string) => Bucket) {
  if (PERIODS.includes(by)) return (r: Row) => (r.date ? calendar(by, r.date) : null);
  if (ctx.spans.has(by)) throw new ViewError(by, 'a span cannot make buckets');
  const i = index(ctx, by, 'buckets');
  return (r: Row): Bucket | null => {
    const v = r.values[i] ?? null;
    if (typeof v === 'string') return { label: v, sort: v };
    const n = num(v);
    return n === null ? null : { label: String(round(n)), sort: n };
  };
}

function buckets(rows: Row[], key: (r: Row) => Bucket | null) {
  const out = new Map<string, { sort: number | string; rows: Row[] }>();
  for (const r of rows) {
    const b = key(r);
    if (!b) continue;
    const hit = out.get(b.label) ?? { sort: b.sort, rows: [] };
    hit.rows.push(r);
    out.set(b.label, hit);
  }
  return out;
}
const bySort = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);
const shown = (ctx: Context) => ctx.columns.filter((c) => !c.hidden);

/** Checks a group, a pivot and the filters against the view's columns, so a bad one fails on write. */
export function checkShapes(
  ctx: Context,
  group: { by: string; fields: string[]; values: { key: string; agg: ViewAgg }[] },
  pivot: { rows: string; columns: string; value: string | null; agg: ViewAgg },
  filters: { fields: string[] },
) {
  for (const by of new Set([group.by, ...group.fields])) bucketer(ctx, by, period);
  for (const v of group.values) {
    index(ctx, v.key, 'group');
    checkAgg(ctx, v.key, v.agg);
  }
  bucketer(ctx, pivot.rows, part);
  bucketer(ctx, pivot.columns, part);
  const value = pivot.value ?? shown(ctx)[0]?.key;
  if (!value) throw new ViewError(null, 'pivot: no column to show');
  index(ctx, value, 'pivot');
  if (ctx.spans.has(value)) throw new ViewError(value, 'a span cannot be pivoted');
  for (const key of filters.fields) {
    index(ctx, key, 'filters');
    if (ctx.spans.has(key)) throw new ViewError(key, 'a span cannot be filtered');
  }
}

/** Keeps the rows every token key matches; checks each token is on a filterable field. */
export function filterRows<R extends Row>(
  ctx: Context,
  rows: R[],
  tokens: ViewToken[],
  fields: string[],
): R[] {
  if (!tokens.length) return rows;
  const byKey = new Map<string, { inc: Set<string>; exc: Set<string> }>();
  // Number conditions (`op`) each test the row on their own.
  const conditions = tokens
    .filter((t) => t.op)
    .map((t) => {
      if (!fields.includes(t.key)) throw new ViewError(t.key, 'not a filterable field');
      const i = index(ctx, t.key, 'filters');
      return (r: Row) => {
        const v = r.values[i] ?? null;
        return meetsNumber(t.op, t.value, typeof v === 'number' ? v : null);
      };
    });
  for (const t of tokens) {
    if (t.op) continue;
    if (!fields.includes(t.key)) throw new ViewError(t.key, 'not a filterable field');
    const sets = byKey.get(t.key) ?? { inc: new Set<string>(), exc: new Set<string>() };
    (t.not ? sets.exc : sets.inc).add(t.value.toLowerCase());
    byKey.set(t.key, sets);
  }
  const has = (values: Set<string>, v: ViewValue) => {
    if (typeof v === 'string') return values.has(v.toLowerCase());
    return typeof v === 'number' && [...values].some((x) => Number(x) === round(v));
  };
  const tests = [...byKey].map(([key, { inc, exc }]) => {
    const i = index(ctx, key, 'filters');
    return (r: Row) => {
      const v = r.values[i] ?? null;
      return (!inc.size || has(inc, v)) && !has(exc, v);
    };
  });
  return rows.filter((r) => tests.every((t) => t(r)) && conditions.every((t) => t(r)));
}

export function groupRows(
  ctx: Context,
  rows: Row[],
  group: { by: string; values: { key: string; agg: ViewAgg }[] },
): ViewGrouped {
  const entries = group.values.length
    ? group.values
    : shown(ctx).map((c) => ({ key: c.key, agg: 'last' as ViewAgg }));
  const cols = entries.map((e) => {
    checkAgg(ctx, e.key, e.agg);
    const i = index(ctx, e.key, 'group');
    const c = ctx.columns[i] as ViewColumn;
    return {
      i,
      key: e.key,
      agg: e.agg,
      label: c.label,
      format: e.agg === 'count' ? ('integer' as const) : c.format,
    };
  });
  const calendar = PERIODS.includes(group.by) && group.by !== 'weekday';
  const grouped = [...buckets(rows, bucketer(ctx, group.by, period)).entries()].sort(
    // Periods read newest first like the daily rows; weekdays and column values ascend.
    ([, a], [, b]) => (calendar ? bySort(b.sort, a.sort) : bySort(a.sort, b.sort)),
  );
  return {
    shape: 'group',
    by: group.by,
    values: cols.map(({ key, agg, label, format }) => ({ key, agg, label, format })),
    rows: grouped.map(([bucket, g]) => ({
      bucket,
      days: g.rows.length,
      values: cols.map((c) =>
        roll(
          g.rows.map((r) => r.values[c.i] ?? null),
          c.agg,
        ),
      ),
    })),
  };
}

export function pivotRows(
  ctx: Context,
  rows: Row[],
  pivot: { rows: string; columns: string; value: string | null; agg: ViewAgg },
): ViewPivoted {
  const key = pivot.value ?? shown(ctx)[0]?.key ?? '';
  const i = index(ctx, key, 'pivot');
  const c = ctx.columns[i] as ViewColumn;
  const rowOf = bucketer(ctx, pivot.rows, part);
  const colOf = bucketer(ctx, pivot.columns, part);
  const order = (m: Map<string, number | string>) =>
    [...m.entries()].sort(([, a], [, b]) => bySort(a, b)).map(([label]) => label);
  const rowSort = new Map<string, number | string>();
  const colSort = new Map<string, number | string>();
  const cells = new Map<string, ViewValue[]>();
  for (const r of rows) {
    const a = rowOf(r);
    const b = colOf(r);
    if (!a || !b) continue;
    rowSort.set(a.label, a.sort);
    colSort.set(b.label, b.sort);
    const k = `${a.label}\u0000${b.label}`;
    cells.set(k, [...(cells.get(k) ?? []), r.values[i] ?? null]);
  }
  const rowLabels = order(rowSort);
  const colLabels = order(colSort);
  return {
    shape: 'pivot',
    rows_by: pivot.rows,
    columns_by: pivot.columns,
    value: {
      key,
      agg: pivot.agg,
      label: c.label,
      format: pivot.agg === 'count' ? 'integer' : c.format,
    },
    rows: rowLabels,
    columns: colLabels,
    cells: rowLabels.map((a) =>
      colLabels.map((b) => {
        const vs = cells.get(`${a}\u0000${b}`);
        return vs ? num(roll(vs, pivot.agg)) : null;
      }),
    ),
  };
}
