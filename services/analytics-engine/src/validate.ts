import type { OptionType } from '@edgedesk/types';

const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export function parseSymbol(raw: string | undefined): string | null {
  const s = raw?.trim().toUpperCase();
  return s && SYMBOL_RE.test(s) ? s : null;
}

/** Accepts `20260918` or `2026-09-18`. */
export function parseExpiration(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  const s = raw.replaceAll('-', '');
  return /^20\d{6}$/.test(s) ? Number(s) : null;
}

export function parseType(raw: string | undefined): OptionType | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  return raw === 'call' || raw === 'put' ? raw : null;
}

export function parseNum(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
