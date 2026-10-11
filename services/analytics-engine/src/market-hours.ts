/**
 * US market sessions (America/New_York), NYSE holidays and early closes.
 * Options RTH: 9:30–16:15 ET (broad-ETF options trade to 16:15). Stocks
 * (underlying quotes) trade 4:00–20:00 ET including pre/post-market.
 */

/** NYSE full-day closures, YYYYMMDD. */
const HOLIDAYS = new Set([
  20260101, 20260119, 20260216, 20260403, 20260525, 20260619, 20260703, 20260907, 20261126,
  20261225, 20270101, 20270118, 20270215, 20270326, 20270531, 20270618, 20270705, 20270906,
  20271125, 20271224,
]);
/** NYSE 1pm-ET early closes (options until 13:15), YYYYMMDD. */
const EARLY_CLOSES = new Set([20261127, 20261224, 20271126]);

export type Session = 'options' | 'stocks';

interface NyParts {
  date: number;
  /** 0 = Sunday. */
  weekday: number;
  /** Minutes since midnight ET. */
  minutes: number;
}

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function nyParts(ms: number): NyParts {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return {
    date: Number(`${p.year}${p.month}${p.day}`),
    weekday: WD[p.weekday as string] ?? 0,
    minutes: hour * 60 + Number(p.minute),
  };
}

export const isTradingDay = (p: NyParts) =>
  p.weekday >= 1 && p.weekday <= 5 && !HOLIDAYS.has(p.date);

function window(session: Session, date: number): [number, number] {
  if (session === 'stocks') return [4 * 60, EARLY_CLOSES.has(date) ? 17 * 60 : 20 * 60];
  return [9 * 60 + 30, EARLY_CLOSES.has(date) ? 13 * 60 + 15 : 16 * 60 + 15];
}

export function isSessionOpen(session: Session, ms = Date.now()): boolean {
  const p = nyParts(ms);
  if (!isTradingDay(p)) return false;
  const [open, close] = window(session, p.date);
  return p.minutes >= open && p.minutes < close;
}

/** Seconds until the session next opens (0 if open now). Scans minute-precise, up to 10 days. */
export function secondsUntilOpen(session: Session, ms = Date.now()): number {
  if (isSessionOpen(session, ms)) return 0;
  // Sessions open on a quarter hour (ET offsets are whole hours), so scan quarter-hour boundaries.
  const Q = 15 * 60_000;
  let t = Math.ceil(ms / Q) * Q;
  const limit = ms + 10 * 86_400_000;
  while (t < limit && !isSessionOpen(session, t)) t += Q;
  return Math.max(60, Math.round((t - ms) / 1000));
}
