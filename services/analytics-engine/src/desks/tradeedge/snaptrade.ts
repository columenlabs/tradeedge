/**
 * SnapTrade (Bikram, 2026-10-10): each person brings their own free Personal key (client id +
 * consumer key) and links their brokers through SnapTrade's own portal. The sync here is the only
 * writer of a SnapTrade account in Holdings: positions, cash, the broker's tax lots and transactions.
 *
 *   Personal key requests: `clientId` + `timestamp` in the query, a `Signature` header = base64
 *   HMAC-SHA256 of the sorted JSON {content, path, query}, keyed with the consumer key. No userId or
 *   userSecret: SnapTrade knows the person from the key (docs.snaptrade.com/docs/personal-vs-commercial).
 *
 * Webhooks: SnapTrade calls the person's own URL (`/api/public/snaptrade-hook/<hook id>` on the apex)
 * and signs the body with the same consumer key; a holdings or transactions event re-syncs.
 */
import { z } from 'zod';
import {
  type LotInput,
  MARGIN_CASH,
  type SyncedAccount,
  type TaxType,
  type TransactionInput,
} from './portfolio';

const API = 'https://api.snaptrade.com';
type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
const te = new TextEncoder();

/** JSON with every object's keys sorted, as SnapTrade signs requests. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${sortedJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}

async function hmacB64(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    te.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Buffer.from(await crypto.subtle.sign('HMAC', k, te.encode(message))).toString('base64');
}

export class SnapTradeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── The API shapes used here (snaptrade-typescript-sdk 12.2 models) ──

export interface StAccount {
  id: string;
  brokerage_authorization: string;
  name: string | null;
  number: string;
  institution_name: string;
  raw_type?: string | null;
  is_paper?: boolean;
}
export interface StAuthorization {
  id?: string;
  name?: string;
  /** `trade` when the person linked it with trading allowed, else `read`. */
  type?: string;
  disabled?: boolean;
  disabled_date?: string | null;
  brokerage?: { name?: string; display_name?: string; slug?: string };
}
interface StInstrument {
  kind: string;
  symbol: string;
  option_type?: 'CALL' | 'PUT';
  strike_price?: string;
  expiration_date?: string;
  underlying?: { symbol?: string };
}
interface StTaxLot {
  original_purchase_date?: string | null;
  quantity?: string | null;
  purchased_price?: string | null;
  cost_basis?: string | null;
}
interface StPosition {
  instrument: StInstrument;
  units?: string | null;
  cost_basis?: string | null;
  cash_equivalent?: boolean;
  tax_lots?: StTaxLot[];
}
interface StBalance {
  currency?: { code?: string };
  cash?: number | null;
}
export interface StActivity {
  id?: string;
  symbol?: { symbol?: string } | null;
  option_symbol?: {
    option_type: 'CALL' | 'PUT';
    strike_price: number;
    expiration_date: string;
    underlying_symbol: { symbol?: string };
  } | null;
  price?: number;
  units?: number;
  amount?: number | null;
  type?: string;
  description?: string;
  trade_date?: string | null;
  settlement_date?: string;
  fee?: number;
}
interface StBrokerage {
  slug?: string;
  name?: string;
  display_name?: string;
  enabled?: boolean;
}

/** One person's Personal key. */
export class SnapTradeClient {
  constructor(
    private readonly clientId: string,
    private readonly consumerKey: string,
    private readonly fetchImpl: FetchFn = (i, init) => fetch(i, init),
  ) {}

  async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number | undefined> = {},
    body?: Record<string, unknown>,
  ): Promise<T> {
    const q = new URLSearchParams({ clientId: this.clientId });
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    q.set('timestamp', String(Math.round(Date.now() / 1000)));
    const query = q.toString();
    const signature = await hmacB64(
      encodeURI(this.consumerKey),
      sortedJson({ content: body ?? null, path, query }),
    );
    const res = await this.fetchImpl(`${API}${path}?${query}`, {
      method,
      headers: {
        accept: 'application/json',
        Signature: signature,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as {
        detail?: string;
        message?: string;
      } | null;
      throw new SnapTradeError(
        res.status,
        `SnapTrade ${res.status}: ${err?.detail ?? err?.message ?? res.statusText}`,
      );
    }
    return (res.status === 204 ? null : await res.json()) as T;
  }

  accounts = () => this.call<StAccount[]>('GET', '/accounts');
  authorizations = () => this.call<StAuthorization[]>('GET', '/authorizations');
  positions = (id: string) =>
    this.call<{ results: StPosition[] }>(
      'GET',
      `/accounts/${encodeURIComponent(id)}/positions/all`,
    );
  balances = (id: string) =>
    this.call<StBalance[]>('GET', `/accounts/${encodeURIComponent(id)}/balances`);
  activities = (id: string, startDate: string | undefined, offset: number, limit: number) =>
    this.call<{ data?: StActivity[] }>('GET', `/accounts/${encodeURIComponent(id)}/activities`, {
      startDate,
      offset,
      limit,
    });
  /** SnapTrade's Connection Portal, read-only connections; `reconnect` fixes a broken login. */
  portal = (redirect: string, reconnect?: string) =>
    this.call<{ redirectURI?: string }>(
      'POST',
      '/snapTrade/login',
      {},
      {
        connectionType: 'read',
        customRedirect: redirect,
        ...(reconnect ? { reconnect } : {}),
      },
    );
}

/**
 * SnapTrade's public broker list (no key needed), read at most once a day per isolate. `match` names
 * the broker SnapTrade lists for a free-text name, or null (the manual-account block, Bikram 2026-10-10).
 */
export class SnapTradeBrokers {
  private list?: { at: number; names: Map<string, string> };
  constructor(private readonly fetchImpl: FetchFn = (i, init) => fetch(i, init)) {}

  private async names() {
    if (this.list && Date.now() - this.list.at < 86_400_000) return this.list.names;
    const res = await this.fetchImpl(`${API}/brokerages`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new SnapTradeError(res.status, `SnapTrade brokers ${res.status}`);
    const names = new Map<string, string>();
    for (const b of (await res.json()) as StBrokerage[]) {
      if (b.enabled === false) continue;
      const label = b.display_name ?? b.name ?? b.slug ?? '';
      for (const n of [b.slug, b.name, b.display_name]) if (n) names.set(norm(n), label);
    }
    this.list = { at: Date.now(), names };
    return names;
  }

  /** "Charles Schwab" → Schwab, "Fidelity Investments" → Fidelity, "SoFi Invest" → null. */
  match = async (broker: string): Promise<string | null> => {
    const names = await this.names();
    const words = broker.split(/[\s,/&+-]+/).filter(Boolean);
    for (let i = 0; i < words.length; i++)
      for (let j = i + 1; j <= words.length; j++) {
        const hit = names.get(norm(words.slice(i, j).join('')));
        if (hit) return hit;
      }
    return null;
  };
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ── Sync: SnapTrade's data → one SyncedAccount per account ──

const TICKER = /^[A-Za-z][A-Za-z0-9.^/-]{0,14}$/;
const STOCKISH = new Set(['stock', 'etf', 'adr', 'cef', 'mutualfund', 'crypto']);
const RETIREMENT = /\b(ira|roth|401\(?k\)?|403\(?b\)?|457|sep|simple|retire\w*|hsa|rrsp|tfsa)\b/i;

export const guessTaxType = (a: Pick<StAccount, 'name' | 'raw_type'>): TaxType =>
  RETIREMENT.test(`${a.name ?? ''} ${a.raw_type ?? ''}`) ? 'retirement' : 'taxable';

/** "Fidelity Rollover IRA"; a name that already says the broker ("Robinhood Individual") stays as is. */
export const accountName = (a: Pick<StAccount, 'name' | 'institution_name' | 'number'>) => {
  const name = a.name ?? `••${a.number.slice(-4)}`;
  return (
    name.toLowerCase().includes(a.institution_name.toLowerCase())
      ? name
      : `${a.institution_name} ${name}`
  )
    .trim()
    .slice(0, 80);
};

const num = (s: string | number | null | undefined) => {
  const n = typeof s === 'number' ? s : Number(s);
  return Number.isFinite(n) ? n : null;
};
const expInt = (iso: string) => Number(iso.slice(0, 10).replaceAll('-', ''));

/** Positions (same symbol merged), the broker's lots (null when SnapTrade sent none) and what was left out. */
export function mapPositions(results: StPosition[]) {
  const bySymbol = new Map<string, SyncedAccount['positions'][number]>();
  const lots: LotInput[] = [];
  const skipped: string[] = [];
  let lotsSent = false;
  for (const p of results) {
    const i = p.instrument;
    const qty = num(p.units);
    if (p.cash_equivalent) continue; // counted in the cash balance already
    let pos: SyncedAccount['positions'][number] | null = null;
    if (STOCKISH.has(i.kind) && TICKER.test(i.symbol) && qty !== null) {
      pos = { underlying: i.symbol, quantity: qty, avg_cost: num(p.cost_basis) ?? undefined };
    } else if (
      i.kind === 'option' &&
      i.underlying?.symbol &&
      TICKER.test(i.underlying.symbol) &&
      i.expiration_date &&
      num(i.strike_price) &&
      qty !== null
    ) {
      pos = {
        underlying: i.underlying.symbol,
        quantity: qty,
        avg_cost: num(p.cost_basis) ?? undefined,
        expiration: expInt(i.expiration_date),
        strike: num(i.strike_price) as number,
        right: i.option_type === 'PUT' ? 'P' : 'C',
      };
    }
    if (!pos || (pos.avg_cost !== undefined && pos.avg_cost < 0)) {
      skipped.push(`${i.kind} ${i.symbol}`);
      continue;
    }
    const key = `${pos.underlying}|${pos.expiration ?? ''}|${pos.strike ?? ''}|${pos.right ?? ''}`;
    const prev = bySymbol.get(key);
    if (prev) {
      const total = prev.quantity + pos.quantity;
      const cost =
        prev.avg_cost !== undefined && pos.avg_cost !== undefined && total !== 0
          ? (prev.avg_cost * prev.quantity + pos.avg_cost * pos.quantity) / total
          : undefined;
      bySymbol.set(key, { ...prev, quantity: total, avg_cost: cost });
    } else bySymbol.set(key, pos);
    if (p.tax_lots !== undefined) lotsSent = true;
    for (const l of p.tax_lots ?? []) {
      const q = num(l.quantity);
      const price = num(l.purchased_price) ?? (q ? (num(l.cost_basis) ?? 0) / q : null);
      if (!q || price === null || !l.original_purchase_date) continue;
      // Stored as a size: the lot takes its holding's side on read (`lots.ts`).
      lots.push({
        underlying: pos.underlying,
        ...(pos.expiration
          ? { expiration: pos.expiration, strike: pos.strike, right: pos.right }
          : {}),
        acquired: l.original_purchase_date.slice(0, 10),
        quantity: Math.abs(q),
        cost: Math.abs(price),
      });
    }
  }
  return { positions: [...bySymbol.values()], lots: lotsSent ? lots : null, skipped };
}

const KIND: Record<string, TransactionInput['kind']> = {
  BUY: 'buy',
  SELL: 'sell',
  REI: 'buy',
  DIVIDEND: 'dividend',
  SUBSTITUTE_DIVIDEND: 'dividend',
  INTEREST: 'interest',
  FEE: 'fee',
  TAX: 'fee',
  CONTRIBUTION: 'deposit',
  WITHDRAWAL: 'withdrawal',
};
/** Rows that move shares without a sale: a broker transfer, a journal, a 401(k) fund exchange. */
const MOVE = /TRANSFER|JOURNAL|EXCHANGE/;

/** A move's direction in its text: tastytrade sends "Removed 220.0 Short VOO via ACAT" with +220 units. */
const MOVE_OUT = /\b(removed|delivered|deliver|transferred to)\b/i;
const MOVE_IN = /\b(received|transferred from)\b/i;
/** A 401(k) contribution comes as a TRANSFER into the plan fund at its price: a purchase. */
const CONTRIBUTION = /^contribution$/i;

/**
 * A row's kind (Bikram, 2026-10-12: audit of the #318 transfers). A move goes in or out by its
 * type's ending, else by the words of its text, else by the sign of its units.
 */
function kindOf(
  type: string | null | undefined,
  units: number | null | undefined,
  description: string | null | undefined,
  price: number | null | undefined,
): TransactionInput['kind'] {
  const t = (type ?? '').toUpperCase();
  const known = KIND[t];
  if (known) return known;
  if (!MOVE.test(t)) return 'other';
  const text = description ?? '';
  if (CONTRIBUTION.test(text.trim()) && (price ?? 0) > 0) return 'buy';
  if (t.endsWith('OUT')) return 'transfer_out';
  if (t.endsWith('IN')) return 'transfer_in';
  if (MOVE_OUT.test(text)) return 'transfer_out';
  if (MOVE_IN.test(text)) return 'transfer_in';
  return (units ?? 0) < 0 ? 'transfer_out' : 'transfer_in';
}

/**
 * SnapTrade activities → transactions. Transfers, journals and exchanges come in as transfer_in or
 * transfer_out; other types without a kind of their own (option expiry, assignment, …) come in as
 * `other` with the broker's description, so nothing is dropped.
 */
export function mapActivities(rows: StActivity[]): TransactionInput[] {
  const out: TransactionInput[] = [];
  for (const a of rows) {
    const date = (a.trade_date ?? a.settlement_date ?? '').slice(0, 10);
    if (!a.id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const o = a.option_symbol;
    const underlying = o ? o.underlying_symbol.symbol : a.symbol?.symbol;
    const units = Math.abs(a.units ?? 0);
    const base = {
      id: a.id.slice(0, 120),
      date,
      fees: Math.abs(a.fee ?? 0),
      amount: a.amount ?? 0,
      description: a.description?.slice(0, 200) || (a.type ?? undefined),
    };
    const kind = kindOf(a.type, a.units, a.description, a.price);
    const full: TransactionInput = {
      ...base,
      kind,
      ...(underlying && TICKER.test(underlying) ? { underlying: underlying.toUpperCase() } : {}),
      ...(o && underlying && TICKER.test(underlying)
        ? {
            expiration: expInt(o.expiration_date),
            strike: o.strike_price,
            right: o.option_type === 'PUT' ? ('P' as const) : ('C' as const),
          }
        : {}),
      ...(units > 0 ? { quantity: units } : {}),
      ...(a.price !== undefined && a.price >= 0 ? { price: a.price } : {}),
    };
    const ok = transactionCheck.safeParse(full);
    out.push(ok.success ? full : { ...base, kind: 'other' });
  }
  return out;
}

// The same rules portfolio.ts applies to a transaction (buys and sells need a symbol, size and price).
const transactionCheck = z
  .object({
    kind: z.string(),
    underlying: z.string().optional(),
    quantity: z.number().positive().optional(),
    price: z.number().nonnegative().optional(),
  })
  .refine(
    (t) =>
      (t.kind !== 'buy' && t.kind !== 'sell') ||
      (t.underlying !== undefined && t.quantity !== undefined && t.price !== undefined),
  );

/** Cash in USD; a negative balance is margin borrowed and goes in as MARGIN-CASH (data rules). */
export function mapCash(balances: StBalance[]) {
  const usd = balances.find((b) => (b.currency?.code ?? 'USD').toUpperCase() === 'USD');
  const cash = num(usd?.cash) ?? 0;
  return cash < 0
    ? { cash: 0, margin: { underlying: MARGIN_CASH, quantity: cash, avg_cost: 1 } }
    : { cash, margin: null };
}

/** Verifies a webhook's `Signature`: HMAC-SHA256 of the body with the consumer key, base64. */
export async function verifyHook(raw: string, signature: string | null, consumerKey: string) {
  if (!signature) return false;
  const candidates = [raw];
  try {
    // SnapTrade's own example signs the body re-serialized with sorted keys and no spaces (Python
    // json.dumps), which is not always the bytes sent.
    candidates.push(pythonJson(JSON.parse(raw)));
  } catch {
    return false;
  }
  for (const c of candidates)
    if (timingSafeEqual(await hmacB64(consumerKey, c), signature)) return true;
  return false;
}

/** `json.dumps(v, separators=(",", ":"), sort_keys=True)`: non-ASCII escaped as \uXXXX. */
function pythonJson(value: unknown): string {
  return sortedJson(value).replace(
    /[\u007f-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
