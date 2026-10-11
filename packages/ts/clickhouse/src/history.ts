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
  expirationsQuery,
  fundNavsQuery,
  snapshotDatesQuery,
  underlyingsQuery,
} from './queries';

const n = (v: unknown): number => Number(v);
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
}
