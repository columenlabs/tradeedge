import { expIntToIso } from '@edgedesk/types';

const MINUS = '−';
const NF = new Map<number, Intl.NumberFormat>();
const nf = (d: number) => {
  let f = NF.get(d);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    NF.set(d, f);
  }
  return f;
};

export const DASH = '—';

/** Unsigned number; `—` for null. */
export function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return (v < 0 ? MINUS : '') + nf(digits).format(Math.abs(v));
}

/** Always-signed number with a true minus: `+1.20`, `−0.40`, `0.00`. */
export function signed(v: number | null | undefined, digits = 2, prefix = ''): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const r = Number(v.toFixed(digits));
  const sign = r > 0 ? '+' : r < 0 ? MINUS : '';
  return `${sign}${prefix}${nf(digits).format(Math.abs(r))}`;
}

export const money = (v: number | null | undefined, digits = 2) => signed(v, digits, '$');

/** Fraction → percent: 0.238 → `23.8%`. */
export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${num(v * 100, digits)}%`;
}

export function signedPct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return `${signed(v * 100, digits)}%`;
}

export function int(v: number | null | undefined): string {
  return v === null || v === undefined ? DASH : nf(0).format(v);
}

/** 20261120 → `20 Nov 2026` (or `20 Nov` when `short`). */
export function expLabel(exp: number, short = false): string {
  const d = new Date(`${expIntToIso(exp)}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(short ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

export function timePT(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
  });
}

export type Tone = 'gain' | 'loss' | 'flat';
export const tone = (v: number | null | undefined): Tone =>
  v === null || v === undefined || Math.abs(v) < 1e-9 ? 'flat' : v > 0 ? 'gain' : 'loss';

/** 20261120 → `Nov 20` (with `’27` when not this year). */
export function shortDate(exp: number): string {
  const d = new Date(`${expIntToIso(exp)}T12:00:00Z`);
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const year = String(exp).slice(0, 4);
  return year === new Date().toISOString().slice(0, 4) ? md : `${md} ’${year.slice(2)}`;
}

/** Whole dollars with a sign: `+$250`, `−$750`. */
export const usd = (v: number | null | undefined) => money(v, 0);
/** Whole dollars, no sign unless negative: `$250`, `−$750`. */
export const usdPlain = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? DASH
    : `${v < 0 ? '−' : ''}$${nf(0).format(Math.abs(v))}`;
