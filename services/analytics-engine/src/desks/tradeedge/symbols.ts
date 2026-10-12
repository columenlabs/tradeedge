/**
 * Symbol fields (Bikram, 2026-10-12, /mnt/project-files/symbol-indicators/design.md): facts about a
 * ticker that TradeEdge views show next to their rows. Robinhood's (valuation, analysts, earnings,
 * dividends, profile) are read live with the person's own sign-in, batched (fundamentals 10 a call,
 * analyst ratings 75, earnings dates from the market-wide calendar) and held in memory for five
 * minutes like quotes; nothing is saved. DataEdge's (trailing P/E, technicals) are read from market
 * data on each call. Without a Robinhood sign-in its fields are empty; a self-hosted TradeEdge
 * without market data has no DataEdge fields.
 */
import {
  SYMBOL_FIELDS,
  SYMBOL_INDICATORS,
  type SymbolFacts,
  type SymbolRead,
} from '@edgedesk/types/symbols';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { HistoryService } from '../../history';
import { IntegrationNotConnected, type Integrations } from './integrations';
import { portfolioOwner } from './portfolio';

const TTL_MS = 5 * 60_000;
/** Earnings dates are looked up this many days ahead, one calendar call per 31 days. */
const EARNINGS_WINDOWS = 3;
/** Robinhood connections at once. */
const LANES = 4;
export const MAX_SYMBOLS = 1000;

export const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.-]{0,9}$/, 'a ticker like NVDA or BRK.B');
export const symbolReadShape = {
  symbols: z.array(symbolSchema).min(1).max(MAX_SYMBOLS),
};

type Call = { name: string; arguments?: Record<string, unknown> };
type Reader = <T extends unknown[]>(calls: { [K in keyof T]: Call }) => Promise<T>;

/** Robinhood documents inputs, not outputs: the `results` list wherever it sits. */
function resultsOf(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.results)) return o.results as Record<string, unknown>[];
    if (o.data) return resultsOf(o.data);
  }
  return [];
}
const num = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const chunks = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function fundamentals(r: Record<string, unknown>): SymbolFacts {
  const year = num(r.year_founded);
  return {
    pe_ttm: num(r.pe_ratio),
    pb: num(r.pb_ratio),
    market_cap: num(r.market_cap),
    shares_outstanding: num(r.shares_outstanding),
    float: num(r.float),
    div_yield: num(r.dividend_yield),
    div_per_share: num(r.dividend_per_share),
    ex_dividend: text(r.ex_dividend_date),
    pay_date: text(r.payable_date),
    high_52w: num(r.high_52_weeks),
    low_52w: num(r.low_52_weeks),
    avg_volume_2w: num(r.average_volume_2_weeks),
    avg_volume_30d: num(r.average_volume_30_days),
    industry: text(r.industry),
    employees: num(r.num_employees),
    founded: year === null ? null : String(year),
    ceo: text(r.ceo),
  };
}

function ratings(r: Record<string, unknown>): SymbolFacts {
  const x = (r.ratings ?? null) as Record<string, unknown> | null;
  if (!x) return {};
  const buy = num(x.num_buy_ratings);
  const hold = num(x.num_hold_ratings);
  const sell = num(x.num_sell_ratings);
  const all = (buy ?? 0) + (hold ?? 0) + (sell ?? 0);
  return {
    target_mean: num(x.mean_price_target),
    target_high: num(x.high_price_target),
    target_low: num(x.low_price_target),
    buy_count: buy,
    hold_count: hold,
    sell_count: sell,
    buy_pct: all ? ((buy ?? 0) / all) * 100 : null,
  };
}

interface Cached {
  at: number;
  facts: SymbolFacts;
}

export class SymbolFactsService {
  /** Per person: Robinhood facts per symbol, and the earnings calendar. Memory only. */
  private readonly people = new Map<
    string,
    { symbols: Map<string, Cached>; earnings?: { at: number; by: Map<string, SymbolFacts> } }
  >();

  constructor(
    private readonly history: HistoryService,
    private readonly integrations?: Integrations,
    private readonly now: () => number = Date.now,
  ) {}

  /** The facts of `symbols`, from Robinhood (the person's sign-in) and DataEdge. */
  async read(owner: string, symbols: string[]): Promise<SymbolRead> {
    const list = [...new Set(symbols)].slice(0, MAX_SYMBOLS);
    const [rh, de] = await Promise.all([this.robinhood(owner, list), this.dataedge(list)]);
    const out: Record<string, SymbolFacts> = {};
    for (const s of list) out[s] = { ...(rh.facts.get(s) ?? {}), ...(de.facts[s] ?? {}) };
    return { symbols: out, robinhood: rh.status, dataedge: de.status };
  }

  /** DataEdge's symbol list (~800 symbols), for the Symbols rows' `in` filter. */
  dataedgeList(): Promise<string[]> {
    return this.history.available ? this.history.symbolList() : Promise.resolve([]);
  }

  private async dataedge(
    symbols: string[],
  ): Promise<{ facts: Record<string, Record<string, number>>; status: SymbolRead['dataedge'] }> {
    if (!this.history.available) return { facts: {}, status: { state: 'off', as_of: null } };
    try {
      const { facts, asOf } = await this.history.symbolFacts(symbols, SYMBOL_INDICATORS);
      return { facts, status: { state: 'ok', as_of: asOf } };
    } catch (err) {
      console.error('symbol facts (dataedge)', err);
      return {
        facts: {},
        status: { state: 'error', error: 'DataEdge did not answer', as_of: null },
      };
    }
  }

  private async robinhood(
    owner: string,
    symbols: string[],
  ): Promise<{ facts: Map<string, SymbolFacts>; status: SymbolRead['robinhood'] }> {
    const facts = new Map<string, SymbolFacts>();
    if (!this.integrations) return { facts, status: { state: 'not_connected', at: null } };
    const person = this.people.get(owner) ?? { symbols: new Map<string, Cached>() };
    this.people.set(owner, person);
    const fresh = (c?: { at: number }) => !!c && this.now() - c.at < TTL_MS;
    const missing = symbols.filter((s) => !fresh(person.symbols.get(s)));
    let error: string | undefined;
    if (missing.length || !fresh(person.earnings)) {
      let read: Reader;
      try {
        read = await this.integrations.robinhoodReader(owner);
      } catch (err) {
        if (err instanceof IntegrationNotConnected)
          return { facts, status: { state: 'not_connected', at: null } };
        return { facts, status: { state: 'error', error: (err as Error).message, at: null } };
      }
      error = await this.load(read, person, missing, !fresh(person.earnings));
    }
    let at: number | null = null;
    for (const s of symbols) {
      const c = person.symbols.get(s);
      if (!c) continue;
      facts.set(s, { ...c.facts, ...(person.earnings?.by.get(s) ?? {}) });
      at = at === null ? c.at : Math.min(at, c.at);
    }
    return {
      facts,
      status: {
        state: error ? 'error' : 'ok',
        ...(error ? { error } : {}),
        at: at === null ? null : new Date(at).toISOString(),
      },
    };
  }

  /** Fills the cache for `missing` (and the earnings calendar); returns the first error, if any. */
  private async load(
    read: Reader,
    person: {
      symbols: Map<string, Cached>;
      earnings?: { at: number; by: Map<string, SymbolFacts> };
    },
    missing: string[],
    earnings: boolean,
  ): Promise<string | undefined> {
    const at = this.now();
    const got = new Map<string, SymbolFacts>(missing.map((s) => [s, {}]));
    const add = (s: unknown, f: SymbolFacts) => {
      if (typeof s !== 'string' || !got.has(s)) return;
      got.set(s, { ...got.get(s), ...f });
    };
    const jobs: { calls: Call[]; take: (results: unknown[]) => void }[] = [
      ...chunks(missing, 10).map((batch) => ({
        calls: [{ name: 'get_equity_fundamentals', arguments: { symbols: batch } }],
        take: ([r]: unknown[]) => {
          for (const x of resultsOf(r)) add(x.symbol, fundamentals(x));
        },
      })),
      ...chunks(missing, 75).map((batch) => ({
        calls: [{ name: 'get_equity_analyst_ratings', arguments: { symbols: batch } }],
        take: ([r]: unknown[]) => {
          for (const x of resultsOf(r)) add(x.symbol, ratings(x));
        },
      })),
    ];
    const by = new Map<string, SymbolFacts>();
    if (earnings)
      jobs.push({
        calls: Array.from({ length: EARNINGS_WINDOWS }, (_, i) => ({
          name: 'get_earnings_calendar',
          arguments: { start_date: day(i * 31), days: 31 },
        })),
        take: (windows) => {
          for (const w of windows)
            for (const x of resultsOf(w)) {
              const s = x.symbol;
              const eps = (x.eps ?? {}) as Record<string, unknown>;
              const report = (x.report ?? {}) as Record<string, unknown>;
              // Already reported (an actual EPS), or a later report than one found: skip.
              if (typeof s !== 'string' || by.has(s) || eps.actual != null) continue;
              const date = text(report.date);
              if (!date) continue;
              by.set(s, {
                earnings_next: report.verified === false ? `~${date}` : date,
                earnings_timing: text(report.timing),
                eps_estimate: num(eps.estimate),
              });
            }
        },
      });
    // Lanes run their jobs one after another, each on its own connection.
    const lanes = Array.from({ length: Math.min(LANES, jobs.length) }, (_, i) =>
      jobs.filter((_, j) => j % LANES === i),
    );
    const errors: string[] = [];
    await Promise.all(
      lanes.map(async (lane) => {
        try {
          const results = await read<unknown[]>(lane.flatMap((j) => j.calls));
          let k = 0;
          for (const j of lane) {
            j.take(results.slice(k, k + j.calls.length));
            k += j.calls.length;
          }
        } catch (err) {
          errors.push((err as Error).message);
        }
      }),
    );
    if (!errors.length) {
      for (const [s, f] of got) person.symbols.set(s, { at, facts: f });
      if (earnings) person.earnings = { at, by };
    } else {
      // Keep what came back; what failed is asked again next time.
      for (const [s, f] of got) if (Object.keys(f).length) person.symbols.set(s, { at, facts: f });
    }
    return errors[0];
  }
}

/** The field catalog for agents: key, label, topic, source and how it is made. */
export const symbolFieldDocs = SYMBOL_FIELDS.map(
  (f) => `${f.key} (${f.label}, ${f.topic}, ${f.source})`,
).join('; ');

/** REST under `/api/symbols` (signed in). */
export function symbolRoutes(svc: SymbolFactsService) {
  const r = new Hono<{ Variables: { identity?: AccessIdentity } }>();
  const owner = (c: Context<{ Variables: { identity?: AccessIdentity } }>) =>
    portfolioOwner(c.get('identity'));
  // A POST so a long symbol list fits; it reads only.
  r.post('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    const p = z.object(symbolReadShape).safeParse(body);
    if (!p.success)
      return c.json(
        {
          error: 'invalid input',
          issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      );
    return c.json(await svc.read(owner(c), p.data.symbols));
  });
  r.get('/dataedge', async (c) => c.json({ symbols: await svc.dataedgeList() }));
  return r;
}
