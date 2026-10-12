/**
 * Typed history reads: builder → client → normalizer. Services depend on this,
 * not on raw SQL.
 */
import type { HistoryCoverage, OptionQuote, UnderlyingQuote } from '@edgedesk/types';
import type { ClickHouseClient } from './client';
import { normalizeOptionRows, underlyingLast } from './normalize';
import {
  type ChainQueryParams,
  chainQuery,
  coverageQuery,
  dailyClosesQuery,
  expirationsQuery,
  fundNavsQuery,
  keyDatesQuery,
  optionMarksQuery,
  rawClosesQuery,
  snapshotDatesQuery,
  symbolFactsQuery,
  symbolListQuery,
  underlyingsQuery,
} from './queries';

const n = (v: unknown): number => Number(v);

/** One day of a symbol: its close as traded and its total-return close (dividends and splits in). */
export interface DailyClose {
  date: string;
  close: number;
  /** Null when the day has no adjusted close. A fund NAV's is the NAV. */
  adj: number | null;
}
/** Closes by symbol, oldest first: tickers from the bars (or fund NAVs), OCC contracts their marks. */
export type DailyCloses = Record<string, DailyClose[]>;
/** FOMC, CPI and Jobs days. */
export type KeyDates = Record<'fomc' | 'cpi' | 'jobs', string[]>;

/** `SPY260918C00500000` → `SPY`; null for a ticker. */
const occRoot = (s: string) => /^([A-Z0-9.]{1,6})\d{6}[CP]\d{8}$/.exec(s)?.[1] ?? null;
const nOrNull = (v: unknown): number | null => {
  const x = Number(v);
  return v === null || v === undefined || !Number.isFinite(x) || x === 0 ? null : x;
};

export class HistoryStore {
  constructor(private readonly ch: ClickHouseClient) {}

  ping(): Promise<number> {
    return this.ch.ping();
  }

  async underlyings(): Promise<string[]> {
    const rows = await this.ch.query<{ underlying: string }>(underlyingsQuery(this.ch.database));
    return rows.map((r) => r.underlying);
  }

  /** Snapshot days, newest first. */
  async dates(underlying: string): Promise<number[]> {
    const rows = await this.ch.query<{ date: unknown }>(
      snapshotDatesQuery(underlying, this.ch.database),
    );
    return rows.map((r) => n(r.date));
  }

  async expirations(underlying: string, date: number): Promise<number[]> {
    const rows = await this.ch.query<{ expiration: unknown }>(
      expirationsQuery(underlying, date, this.ch.database),
    );
    return rows.map((r) => n(r.expiration));
  }

  /** One expiration's quotes, plus the underlying price stored with them. */
  async chain(p: ChainQueryParams): Promise<{ quotes: OptionQuote[]; spot: number | null }> {
    const rows = await this.ch.query(chainQuery(p, this.ch.database));
    return { quotes: normalizeOptionRows(rows), spot: underlyingLast(rows) };
  }

  /** Unadjusted daily closes per symbol between two days (YYYY-MM-DD), oldest first. */
  async rawCloses(
    symbols: string[],
    from: string,
    to: string,
  ): Promise<Record<string, { date: string; close: number }[]>> {
    if (symbols.length === 0) return {};
    const rows = await this.ch.query<{ symbol: string; date: string; close: unknown }>(
      rawClosesQuery(symbols, from, to, this.ch.database),
    );
    const out: Record<string, { date: string; close: number }[]> = {};
    for (const r of rows) {
      const list = out[r.symbol] ?? [];
      list.push({ date: r.date, close: n(r.close) });
      out[r.symbol] = list;
    }
    return out;
  }

  /** Latest NAV of each fund that has one, as a quote: change is against the NAV before it. */
  async fundNavs(symbols: string[]): Promise<Record<string, UnderlyingQuote>> {
    if (symbols.length === 0) return {};
    const rows = await this.ch.query<{ symbol: string; date: string; value: unknown }>(
      fundNavsQuery(symbols, this.ch.database),
    );
    const out: Record<string, UnderlyingQuote> = {};
    for (const symbol of new Set(rows.map((r) => r.symbol))) {
      const [latest, prev] = rows.filter((r) => r.symbol === symbol);
      if (!latest) continue;
      const last = n(latest.value);
      const prevClose = prev ? n(prev.value) : null;
      const change = prevClose !== null ? last - prevClose : null;
      out[symbol] = {
        symbol,
        last,
        bid: null,
        ask: null,
        prevClose,
        change,
        changePct: change !== null && prevClose ? change / prevClose : null,
        time: `${latest.date}T20:00:00.000Z`,
      };
    }
    return out;
  }

  async coverage(): Promise<HistoryCoverage[]> {
    const rows = await this.ch.query(coverageQuery(this.ch.database));
    return rows.map((r) => ({
      underlying: String(r.underlying),
      rows: n(r.rows),
      snapshots: n(r.snapshots),
      firstDate: nOrNull(r.first_date),
      lastDate: nOrNull(r.last_date),
      expirations: n(r.expirations),
      firstExpiration: nOrNull(r.first_expiration),
      lastExpiration: nOrNull(r.last_expiration),
    }));
  }

  /** DataEdge symbol fields per symbol (field key → value), and the newest day any came from. */
  async symbolFacts(
    symbols: string[],
    indicators: string[],
  ): Promise<{ facts: Record<string, Record<string, number>>; asOf: string | null }> {
    if (symbols.length === 0) return { facts: {}, asOf: null };
    const rows = await this.ch.query<{
      symbol: string;
      field: string;
      value: unknown;
      date: string;
    }>(symbolFactsQuery(symbols, indicators, this.ch.database));
    const facts: Record<string, Record<string, number>> = {};
    let asOf: string | null = null;
    for (const r of rows) {
      const v = Number(r.value);
      if (!Number.isFinite(v)) continue;
      const own = facts[r.symbol] ?? {};
      own[r.field] = v;
      facts[r.symbol] = own;
      if (!asOf || r.date > asOf) asOf = r.date;
    }
    return { facts, asOf };
  }

  /**
   * Daily closes from `from` to `to`: each ticker's bars (a fund the bars miss, its NAV), and each
   * OCC contract's end-of-day mark (`close` and `adj` both the mark). One read per kind.
   */
  async dailyCloses(symbols: string[], from: string, to: string): Promise<DailyCloses> {
    const contracts = symbols.filter((s) => occRoot(s));
    const tickers = symbols.filter((s) => !occRoot(s));
    const out: DailyCloses = {};
    const [bars, marks] = await Promise.all([
      tickers.length
        ? this.ch.query<{
            symbol: string;
            date: string;
            close: unknown;
            adj: unknown;
            nav: unknown;
          }>(dailyClosesQuery(tickers, from, to, this.ch.database))
        : [],
      contracts.length
        ? this.ch.query<{ symbol: string; date: string; mark: unknown }>(
            optionMarksQuery(
              contracts,
              [...new Set(contracts.map((c) => occRoot(c) as string))],
              from,
              to,
              this.ch.database,
            ),
          )
        : [],
    ]);
    // A ticker with bars keeps them; its NAV rows count only when it has none.
    const hasBars = new Set(bars.filter((r) => n(r.nav) === 0).map((r) => r.symbol));
    for (const r of bars) {
      if (n(r.nav) === 1 && hasBars.has(r.symbol)) continue;
      const list = out[r.symbol] ?? [];
      list.push({ date: r.date, close: n(r.close), adj: nOrNull(r.adj) });
      out[r.symbol] = list;
    }
    for (const r of marks) {
      const mark = nOrNull(r.mark);
      if (mark === null) continue;
      const list = out[r.symbol] ?? [];
      list.push({ date: r.date, close: mark, adj: mark });
      out[r.symbol] = list;
    }
    return out;
  }

  /** FOMC, CPI and Jobs days from `from` to `to`. */
  async keyDates(from: string, to: string): Promise<KeyDates> {
    const rows = await this.ch.query<{ series_id: string; date: string }>(
      keyDatesQuery(from, to, this.ch.database),
    );
    const of = (id: string) => rows.filter((r) => r.series_id === id).map((r) => r.date);
    return { fomc: of('cal:FOMC'), cpi: of('cal:CPI'), jobs: of('cal:NFP') };
  }

  /** DataEdge's symbol list. */
  async symbolList(): Promise<string[]> {
    const rows = await this.ch.query<{ symbol: string }>(symbolListQuery(this.ch.database));
    return rows.map((r) => r.symbol);
  }
}
