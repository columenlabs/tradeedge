import type { OptionType } from '@edgedesk/types';

export interface OccParts {
  root: string;
  /** Int YYYYMMDD. */
  expiration: number;
  type: OptionType;
  strike: number;
}

const OCC_RE = /^([A-Z0-9.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/** `SPY260918C00500000` → { root: 'SPY', expiration: 20260918, type: 'call', strike: 500 }. */
export function parseOccSymbol(symbol: string): OccParts | null {
  const m = OCC_RE.exec(symbol.replace(/\s+/g, ''));
  if (!m) return null;
  const [, root, yy, mm, dd, cp, strike] = m as unknown as [string, ...string[]];
  return {
    root: root as string,
    expiration: Number(`20${yy}${mm}${dd}`),
    type: cp === 'C' ? 'call' : 'put',
    strike: Number(strike) / 1000,
  };
}

/** The inverse of `parseOccSymbol`: { root: 'SPY', expiration: 20260918, type: 'call', strike: 500 } → `SPY260918C00500000`. */
export function occSymbol({ root, expiration, type, strike }: OccParts): string {
  const cp = type === 'call' ? 'C' : 'P';
  return `${root}${String(expiration).slice(2)}${cp}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}
