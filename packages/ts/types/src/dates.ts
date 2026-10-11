/**
 * Expiration + market-date helpers. Expirations are Int YYYYMMDD everywhere
 * (matches ClickHouse `market_lab.options_chains.expiration`).
 */

export const MARKET_TZ = 'America/Los_Angeles';

/** `2026-09-18` | Date → 20260918. Dates are read in US/Pacific. */
export function dateToExpInt(d: string | Date): number {
  if (typeof d === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    if (!m) throw new Error(`invalid date: ${d}`);
    return Number(`${m[1]}${m[2]}${m[3]}`);
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MARKET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return dateToExpInt(parts);
}

/** 20260918 → `2026-09-18`. */
export function expIntToIso(exp: number): string {
  const s = String(exp);
  if (!/^\d{8}$/.test(s)) throw new Error(`invalid expiration: ${exp}`);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Calendar days from `today` (Int YYYYMMDD) to `exp` (Int YYYYMMDD). */
export function daysBetween(today: number, exp: number): number {
  const a = Date.parse(`${expIntToIso(today)}T00:00:00Z`);
  const b = Date.parse(`${expIntToIso(exp)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}
