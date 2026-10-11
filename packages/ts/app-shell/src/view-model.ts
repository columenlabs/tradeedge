// The view model every custom view page and its Edit dialog share: a domain's fields, a view's
// formula columns and chips, and the values worked out over the shown rows (Bikram, 2026-10-08).
import type { CustomViewConfig, ViewAgg, ViewChip, ViewFormat } from '@edgedesk/types/views';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { formulaFields } from './view-formulas';

export type ViewCellValue = number | string | null;

/** One field of a data domain: how to read it, show it, filter, group and roll it up. */
export interface ViewField<T> {
  key: string;
  label: string;
  icon: LucideIcon;
  value: (row: T) => ViewCellValue;
  format: ViewFormat;
  /** How the value is made, shown under the field in the Edit dialog (Bikram, 2026-10-09). */
  formula?: string;
  /** A holding amount (dollars or size) that Hide amounts masks (Bikram, 2026-10-09). */
  amount?: boolean;
  /** Large numbers in short form, $283.1B or 6.1M (13F funds, Bikram 2026-10-10). */
  compact?: boolean;
  /** A short note beside the field in the Edit dialog, e.g. `per ticker`. */
  note?: string;
  /**
   * Makes the cell editable (Bikram, 2026-10-09): a click picks a value in use or takes a new one,
   * saved through `save`; `note` says what an edit covers for that row.
   */
  edit?: { save: (row: T, value: string | null) => Promise<unknown>; note?: (row: T) => string };
  /** Offered as `field:value` tokens in the filter box. */
  filterable?: boolean;
  /** Offered in the Group switcher and as pivot rows or columns. */
  groupable?: boolean;
  /** How group, pivot and Total rows roll the field up; no roll-up when left out. */
  aggregate?: ViewAgg;
  /** A formula column with no `aggregate`: group and Total rows run `compute` over the rows' roll-ups of its inputs. */
  rollFormula?: boolean;
  /** A value the page works out from the row and the shown rows (a formula column). */
  compute?: (
    row: T,
    scope: {
      value: (key: string) => ViewCellValue;
      groupSum: (key: string) => number;
      totalSum: (key: string) => number;
    },
  ) => ViewCellValue;
  /**
   * A share the page works out, in %: the row's `of` field over its sum in the row's group
   * (`group`; every shown row when not grouped) or in every shown row (`total`). A group row shows
   * its group's share of the total (Bikram, 2026-10-09). `value` is unused for it.
   */
  share?: { of: string; within: 'group' | 'total' };
  /** Draws the cell instead of its formatted value (a sparkline); sorting and filters still use
   *  `value` (strategy lab, Bikram 2026-10-10). */
  render?: (row: T) => ReactNode;
}

/** A data domain: registered once, any desk can open views on it. */
export interface ViewDomain<T> {
  id: string;
  fields: ViewField<T>[];
  /** A stable id per row (React keys, the details drawer). */
  rowKey: (row: T) => string;
  /** Free text the filter box matches besides field values (a name, an id). */
  text?: (row: T) => string[];
  /** Views can add their own formula columns over these fields (`config.formulas`). */
  formulas?: boolean;
  /** Summary tiles a view can show above its table, in the order offered (Bikram, 2026-10-09). */
  widgets?: { key: string; label: string; icon: LucideIcon }[];
  /** The details drawer: collapsible sections, each with its icon. */
  details?: { id: string; label: string; icon: LucideIcon; render: (row: T) => ReactNode }[];
  /** While grouped, rows of one group sharing `key` show as one line, made by `rows` (Bikram, 2026-10-09). */
  merge?: { key: (row: T) => string; rows: (rows: T[]) => T };
  /** A folded row's own rows, shown as a table at the top of its details drawer, first column
   *  `by` (the field they differ on), then the view's columns (Bikram, 2026-10-09). */
  parts?: { label: string; by: string; rows: (row: T) => T[] };
}

/** Rolls values up; nulls are skipped and an empty set is null (count is 0). */
export function rollUp(values: ViewCellValue[], agg: ViewAgg): ViewCellValue {
  const have = values.filter((v) => v !== null);
  if (agg === 'count') return have.length;
  if (!have.length) return null;
  if (agg === 'first') return have[0] ?? null;
  if (agg === 'last') return have[have.length - 1] ?? null;
  const xs = have.filter((v): v is number => typeof v === 'number');
  if (!xs.length) return null;
  if (agg === 'sum') return xs.reduce((a, b) => a + b, 0);
  if (agg === 'mean') return xs.reduce((a, b) => a + b, 0) / xs.length;
  if (agg === 'min') return Math.min(...xs);
  return Math.max(...xs);
}

/** A view's chip fields and where each shows; views saved before chips existed have none. */
export const chipsOf = (c: CustomViewConfig): ViewChip[] => c.chips ?? [];
/** A view's formula columns; views saved before formulas existed have none. */
export const formulasOf = (c: CustomViewConfig) => c.formulas ?? [];
/** A view's own tiles; views saved before tiles existed have none. */
export const tilesOf = (c: CustomViewConfig) => c.tiles ?? [];
/** The domain's fields plus the view's formula columns, where the domain takes formulas. */
export const withFormulas = <T>(domain: ViewDomain<T>, c: CustomViewConfig): ViewDomain<T> =>
  domain.formulas && formulasOf(c).length
    ? { ...domain, fields: [...domain.fields, ...formulaFields<T>(formulasOf(c))] }
    : domain;

export const pick = <T>(fields: ViewField<T>[], keys: string[]) =>
  keys.length
    ? keys.map((k) => fields.find((f) => f.key === k)).filter((f): f is ViewField<T> => !!f)
    : fields;

export const label = (v: ViewCellValue) => (v === null ? '—' : String(v));

/**
 * Values over the shown rows: plain fields as read, share fields and formula columns worked out
 * against the row's group (every shown row when not grouped) and every shown row.
 */
export function computedOf<T>(domain: ViewDomain<T>, rows: T[], groupBy: ViewField<T> | null) {
  const byKey = new Map(domain.fields.map((f) => [f.key, f]));
  const groups = new Map<string, T[]>();
  if (groupBy)
    for (const r of rows) {
      const k = label(groupBy.value(r));
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
  const groupOf = (r: T) => (groupBy ? (groups.get(label(groupBy.value(r))) ?? []) : rows);
  const sums = new Map<T[], Map<string, number>>();
  const sum = (rs: T[], key: string) => {
    const m = sums.get(rs) ?? new Map<string, number>();
    sums.set(rs, m);
    const f = byKey.get(key);
    if (!m.has(key)) m.set(key, f ? rs.reduce((a, r) => a + num(value(f, r)), 0) : 0);
    return m.get(key) ?? 0;
  };
  const pct = (part: number, whole: number) => (whole ? (part / whole) * 100 : null);
  // A formula that reaches itself (a draft) reads null rather than looping.
  const busy = new Set<string>();
  function value(f: ViewField<T>, r: T): ViewCellValue {
    if (f.share) {
      const base = byKey.get(f.share.of);
      if (!base) return null;
      const whole = f.share.within === 'group' ? groupOf(r) : rows;
      return pct(num(value(base, r)), sum(whole, f.share.of));
    }
    if (!f.compute) return f.value(r);
    if (busy.has(f.key)) return null;
    busy.add(f.key);
    try {
      return f.compute(r, {
        value: (k) => {
          const x = byKey.get(k);
          return x ? value(x, r) : null;
        },
        groupSum: (k) => sum(groupOf(r), k),
        totalSum: (k) => sum(rows, k),
      });
    } finally {
      busy.delete(f.key);
    }
  }
  /**
   * A set of rows' roll-up (Bikram, 2026-10-09): a `total` share is their share of every shown row,
   * an `aggregate` rolls the rows' values, and a formula with none runs over the rows' roll-ups of
   * its inputs (a ratio input is itself recomputed; an input with no roll-up reads null).
   */
  const rolled = new Map<T[], Map<string, ViewCellValue>>();
  function roll(f: ViewField<T>, rs: T[]): ViewCellValue {
    if (f.share)
      return f.share.within === 'total' ? pct(sum(rs, f.share.of), sum(rows, f.share.of)) : null;
    if (f.aggregate)
      return rollUp(
        rs.map((r) => value(f, r)),
        f.aggregate,
      );
    if (!f.rollFormula || !f.compute) return null;
    const m = rolled.get(rs) ?? new Map<string, ViewCellValue>();
    rolled.set(rs, m);
    if (m.has(f.key)) return m.get(f.key) ?? null;
    if (busy.has(f.key)) return null;
    busy.add(f.key);
    try {
      const v = f.compute(rs[0] as T, {
        value: (k) => {
          const x = byKey.get(k);
          return x ? roll(x, rs) : null;
        },
        groupSum: (k) => sum(rs, k),
        totalSum: (k) => sum(rows, k),
      });
      m.set(f.key, v);
      return v;
    } finally {
      busy.delete(f.key);
    }
  }
  return { value, roll };
}

export const num = (v: ViewCellValue) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
