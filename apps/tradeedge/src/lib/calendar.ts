/** Calendar days as Int YYYYMMDD in US/Pacific. */
import { dateToExpInt, expIntToIso } from '@edgedesk/types';

const toDate = (d: number) => new Date(`${expIntToIso(d)}T12:00:00Z`);
const toInt = (d: Date) => Number(d.toISOString().slice(0, 10).replaceAll('-', ''));

export function todayPT(): number {
  return dateToExpInt(new Date());
}

export function addDays(d: number, n: number): number {
  return toInt(new Date(toDate(d).getTime() + n * 86_400_000));
}
