/**
 * Where TradeEdge reads daily closes for the Performance page (Bikram, 2026-10-12): one interface,
 * two sources. In the suite TradeEdge and DataEdge are one Worker, so closes come from ClickHouse in
 * process (`HistoryService`), with no key. A self-hosted TradeEdge has no ClickHouse: it reads the
 * DataEdge route `GET /api/v1/admin/market/closes` with the person's DataEdge key (an Access service
 * token, set in Settings ▸ Integrations ▸ DataEdge). Market data is read on each call, never stored.
 */
import type { DailyCloses, KeyDates } from '@edgedesk/clickhouse';
import type { HistoryService } from '../../history';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface MarketHistory {
  /** `built-in`: the suite's own ClickHouse; `dataedge`: the person's DataEdge key. */
  source: 'built-in' | 'dataedge';
  /** Daily closes of tickers and OCC contracts from `from` to `to`, by symbol, oldest first. */
  closes(symbols: string[], from: string, to: string): Promise<DailyCloses>;
  /** FOMC, CPI and Jobs days; only the built-in source has them. */
  keyDates?(from: string, to: string): Promise<KeyDates>;
}

/** The suite's: ClickHouse in process. Null when the Worker has no history. */
export function builtInHistory(history: HistoryService | undefined): MarketHistory | null {
  if (!history?.available) return null;
  return {
    source: 'built-in',
    closes: (symbols, from, to) => history.dailyCloses(symbols, from, to),
    keyDates: (from, to) => history.keyDates(from, to),
  };
}

export class DataEdgeError extends Error {}

/** DataEdge's route takes up to 200 symbols a call. */
const PER_CALL = 200;

/** A self-hosted TradeEdge's: the DataEdge route, signed in with the person's service token. */
export function dataedgeHistory(
  key: { url: string; client_id: string; client_secret: string },
  fetchFn: FetchFn = (input, init) => fetch(input, init),
): MarketHistory {
  const call = async (symbols: string[], from: string, to: string): Promise<DailyCloses> => {
    const q = new URLSearchParams({ symbols: symbols.join(','), from, to });
    let res: Response;
    try {
      res = await fetchFn(`${key.url}/api/v1/admin/market/closes?${q}`, {
        headers: {
          'CF-Access-Client-Id': key.client_id,
          'CF-Access-Client-Secret': key.client_secret,
          accept: 'application/json',
        },
        redirect: 'manual',
      });
    } catch {
      throw new DataEdgeError(`DataEdge did not answer at ${key.url}.`);
    }
    // Access answers a token it refuses with a redirect to its sign-in page.
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400))
      throw new DataEdgeError('DataEdge refused this key. Check the client ID and secret.');
    if (!res.ok) throw new DataEdgeError(`DataEdge answered ${res.status}.`);
    const body = (await res.json().catch(() => null)) as { closes?: DailyCloses } | null;
    if (!body?.closes) throw new DataEdgeError('DataEdge sent no closes.');
    return body.closes;
  };
  return {
    source: 'dataedge',
    async closes(symbols, from, to) {
      const parts: string[][] = [];
      for (let i = 0; i < symbols.length; i += PER_CALL) parts.push(symbols.slice(i, i + PER_CALL));
      return Object.assign({}, ...(await Promise.all(parts.map((p) => call(p, from, to)))));
    },
  };
}
