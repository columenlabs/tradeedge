// Date helpers for research bodies: parse a date out of a scalar, and the first bar.

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/;
const COMPACT_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
/** The first bar; no window may begin earlier. */
export const FIRST_ALLOWED_DATE = '2016-01-01';

/** YYYYMMDD as a number when `y`/`m`/`d` form a plausible calendar date, else undefined. */
const asYmd = (y: string, m: string, d: string): number | undefined => {
  const mm = Number(m);
  const dd = Number(d);
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 ? Number(`${y}${m}${d}`) : undefined;
};

/** A date found in a scalar: ISO strings, and YYYYMMDD strings or integers (market_lab's Int64 dates). */
export function dateOf(v: unknown): number | undefined {
  const text = typeof v === 'number' && Number.isInteger(v) ? String(v) : v;
  if (typeof text !== 'string') return undefined;
  const m = ISO_DATE_RE.exec(text) ?? COMPACT_DATE_RE.exec(text);
  if (!m?.[1] || !m[2] || !m[3]) return undefined;
  const year = Number(m[1]);
  return year >= 1900 && year <= 2200 ? asYmd(m[1], m[2], m[3]) : undefined;
}
