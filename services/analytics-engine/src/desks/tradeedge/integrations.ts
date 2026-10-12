/**
 * Integrations (Bikram, 2026-10-10): the services TradeEdge connects to with each person's own keys,
 * set in Settings ▸ Integrations, so TradeEdge stands on its own. D1 `integrations` (migration 0028),
 * one sealed row per person and provider:
 *
 *   snaptrade  Personal key (client id + consumer key), the webhook id, accounts left out of Holdings,
 *              the last sync and the last webhook event. Brokers are linked in SnapTrade's own portal,
 *              from the app only; everything else here is open to the app, REST and MCP alike.
 *   alpaca     the person's market-data key; live quotes and chains use it instead of EdgeDesk's.
 *   robinhood  OAuth tokens for Robinhood's agentic-trading MCP (Bikram, 2026-10-12), signed in from the
 *              app only, plus the Agentic account and its trade-approval setting from the last test.
 */
import { AlpacaClient, type AlpacaConfig } from '@edgedesk/providers';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import { MarketService } from '../../market';
import { type Vault, withRetry } from '../../vault';
import type { Logs } from './logs';
import { PortfolioInvalid, type Portfolios, type TaxType, portfolioOwner } from './portfolio';
import {
  ROBINHOOD,
  RobinhoodError,
  type RobinhoodTokens,
  authorizeUrl,
  callTools,
  randomToken,
  registerClient,
  requestTokens,
} from './robinhood';
import {
  SnapTradeClient,
  SnapTradeError,
  type StAccount,
  type StAuthorization,
  accountName,
  guessTaxType,
  mapActivities,
  mapCash,
  mapPositions,
  verifyHook,
} from './snaptrade';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type Provider = 'snaptrade' | 'alpaca' | 'robinhood';

export interface SyncReport {
  at: string;
  ok: boolean;
  accounts: number;
  positions: number;
  transactions: number;
  /** Positions SnapTrade sent that Holdings can't hold (bonds, futures, …), as `kind symbol`. */
  skipped: string[];
  errors: string[];
}
interface SnapTradeDoc {
  client_id: string;
  consumer_key: string;
  hook_id: string;
  saved_at: string;
  /** SnapTrade account ids left out of Holdings. */
  skip: string[];
  /** The person's own account names, by SnapTrade account id (Bikram, 2026-10-11). */
  names?: Record<string, string>;
  /** Accounts the person lets TradeEdge send orders to, by SnapTrade account id (Bikram, 2026-10-12). */
  trade?: string[];
  last_sync: SyncReport | null;
  last_event: { at: string; type: string } | null;
  /** The ACTIVITY_MAPPING every stored transaction was last read with. */
  mapping?: number;
  last_test?: KeyTest | null;
}
/** A key's last test (Bikram, 2026-10-12): one cheap read with it, so the row shows it works, not only that it is saved. */
export interface KeyTest {
  at: string;
  ok: boolean;
  /** What the read returned when it worked, e.g. `3 accounts` or `SPY $512.30`. */
  detail: string | null;
  error: string | null;
}
interface AlpacaDoc {
  key_id: string;
  secret_key: string;
  saved_at: string;
  last_test?: KeyTest | null;
}
interface RobinhoodDoc {
  /** From Robinhood's dynamic client registration, for `redirect_uri`. */
  client_id: string;
  redirect_uri: string;
  /** A sign-in under way: its state and PKCE verifier, kept ten minutes. */
  pending: { state: string; verifier: string; at: string } | null;
  tokens: RobinhoodTokens | null;
  connected_at: string | null;
  /** The last test: the Agentic account (masked) and whether its trades wait for approval in Robinhood's app. */
  last_test: {
    at: string;
    ok: boolean;
    account: string | null;
    approvals: boolean | null;
    error: string | null;
  } | null;
}
interface Docs {
  snaptrade: SnapTradeDoc;
  alpaca: AlpacaDoc;
  robinhood: RobinhoodDoc;
}

const passed = (detail: string): KeyTest => ({
  at: new Date().toISOString(),
  ok: true,
  detail,
  error: null,
});
const failed = (err: unknown): KeyTest => ({
  at: new Date().toISOString(),
  ok: false,
  detail: null,
  error: ((err as Error).message ?? String(err)).slice(0, 300),
});
/**
 * Who can send orders for an account: the Robinhood sign-in for the Agentic account, SnapTrade when the
 * broker was linked with trading, else nobody (read-only, with why), plus the person's own switch.
 */
function tradingOf(
  auth: StAuthorization | undefined,
  account: StAccount,
  agentic: string | null,
  trade: Set<string>,
) {
  const broker = auth?.brokerage?.display_name ?? auth?.brokerage?.name ?? 'This broker';
  const robinhood = /robinhood/i.test(`${auth?.brokerage?.slug ?? ''} ${broker}`);
  const via: 'snaptrade' | 'robinhood' | null =
    robinhood && agentic && agentic === `••${account.number.slice(-4)}`
      ? 'robinhood'
      : !robinhood && auth?.type === 'trade'
        ? 'snaptrade'
        : null;
  const note =
    via === 'robinhood'
      ? 'Orders go through your Robinhood sign-in (Integrations)'
      : via === 'snaptrade'
        ? `${broker} is linked with trading in SnapTrade`
        : robinhood
          ? 'Robinhood trades only in your Agentic account, through the Robinhood sign-in'
          : `${broker} is linked read-only in SnapTrade`;
  return { trading: { via, note }, trade: via !== null && trade.has(account.id) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class IntegrationInvalid extends Error {}
export class IntegrationNotConnected extends Error {}

export const snaptradeKeyShape = {
  client_id: z.string().trim().min(1).max(200).describe('Your SnapTrade Personal client ID.'),
  consumer_key: z.string().trim().min(1).max(400).describe('Your SnapTrade Personal consumer key.'),
};
export const alpacaKeyShape = {
  key_id: z.string().trim().min(1).max(200).describe('Alpaca API key ID.'),
  secret_key: z.string().trim().min(1).max(400).describe('Alpaca secret key.'),
};
export const snaptradeAccountShape = {
  account_id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe("SnapTrade's account id (integration_list)."),
  import: z
    .boolean()
    .optional()
    .describe('false leaves the account out of Holdings (and removes it).'),
  tax_type: z.enum(['taxable', 'retirement']).optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .nullable()
    .optional()
    .describe("Your own name for the account; null goes back to the broker's name."),
};

const hint = (s: string) => `••••${s.slice(-4)}`;
const randomId = () =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
/** Webhook events that change holdings or transactions: each re-syncs (one account when named). */
const SYNC_EVENTS = new Set([
  'ACCOUNT_HOLDINGS_UPDATED',
  'ACCOUNT_TRANSACTIONS_UPDATED',
  'ACCOUNT_TRANSACTIONS_INITIAL_UPDATE',
  'NEW_ACCOUNT_AVAILABLE',
  'CONNECTION_ADDED',
  'CONNECTION_FIXED',
  'CONNECTION_UPDATED',
]);
/** Transactions are re-read this far back on each sync, to pick up the broker's late corrections. */
const OVERLAP_DAYS = 30;
/**
 * Bumped when `mapActivities` maps rows differently, so the next sync re-reads every transaction
 * instead of the last month (2: transfers, journals and exchanges became transfer_in / transfer_out;
 * 3: a move's direction read from its text, and 401(k) contributions became buys).
 */
const ACTIVITY_MAPPING = 3;
const MAX_ACTIVITY_PAGES = 20;
/** Accounts synced at the same time. */
const SYNC_PARALLEL = 6;

export class Integrations {
  private readonly markets = new Map<string, { at: number; market: MarketService }>();

  constructor(
    private readonly db: D1Like,
    private readonly vault: Vault,
    private readonly portfolios: Portfolios,
    private readonly opts: {
      /** `https://edgedesk.app`: the webhook is a public route on the apex. */
      hookOrigin: string;
      /** Where SnapTrade's portal returns: the app's Settings ▸ Brokers and accounts. */
      portalReturn: string;
      /** EdgeDesk's market service: anyone without their own Alpaca key uses it. */
      market: MarketService;
      /** Feeds and URLs for a person's own Alpaca key (EdgeDesk's settings, without its key). */
      alpaca: Omit<AlpacaConfig, 'keyId' | 'secretKey'>;
      /** Each person's Logs: SnapTrade syncs, webhook events and key changes. */
      logs?: Logs;
      fetch?: FetchFn;
    },
  ) {}

  // ── the sealed rows ──

  private async load<P extends Provider>(owner: string, provider: P) {
    const v = await this.vault.for(owner);
    const row = await this.db
      .prepare('SELECT data, version FROM integrations WHERE owner = ? AND provider = ?')
      .bind(v.owner, provider)
      .first<{ data: string; version: number }>();
    return {
      v,
      doc: row ? await v.open<Docs[P]>(`integrations:${v.owner}:${provider}`, row.data) : null,
      version: row ? Number(row.version) : 0,
    };
  }

  private async get<P extends Provider>(owner: string, provider: P) {
    return (await this.load(owner, provider)).doc;
  }

  /** Read-modify-write of one row; `change` returning null deletes it. */
  private update<P extends Provider>(
    owner: string,
    provider: P,
    change: (prev: Docs[P] | null) => Docs[P] | null,
  ): Promise<Docs[P] | null> {
    return withRetry(async () => {
      const { v, doc, version } = await this.load(owner, provider);
      const next = change(doc);
      if (!next) {
        await this.db
          .prepare('DELETE FROM integrations WHERE owner = ? AND provider = ?')
          .bind(v.owner, provider)
          .run();
        return null;
      }
      const data = await v.seal(`integrations:${v.owner}:${provider}`, next);
      const hookId = provider === 'snaptrade' ? (next as SnapTradeDoc).hook_id : null;
      await (version === 0
        ? this.db
            .prepare(
              'INSERT INTO integrations (owner, provider, hook_id, data, version) VALUES (?, ?, ?, ?, 1)',
            )
            .bind(v.owner, provider, hookId, data)
        : this.db
            .prepare(
              `UPDATE integrations SET data = ?, hook_id = ?,
                 version = CASE WHEN version = ? THEN version + 1 END
               WHERE owner = ? AND provider = ?`,
            )
            .bind(data, hookId, version, v.owner, provider)
      ).run();
      return next;
    });
  }

  private client(doc: SnapTradeDoc) {
    return new SnapTradeClient(doc.client_id, doc.consumer_key, this.opts.fetch);
  }

  private async snaptrade(owner: string) {
    const doc = await this.get(owner, 'snaptrade');
    if (!doc)
      throw new IntegrationNotConnected('SnapTrade is not connected: add your Personal key first.');
    return doc;
  }

  // ── status ──

  /**
   * What Settings ▸ Integrations and Brokers and accounts show; brokers and accounts are read live from SnapTrade. `live`
   * false skips SnapTrade (the header's sync status reads only what is stored).
   */
  async status(owner: string, live = true) {
    const [st, alp, rh] = await Promise.all([
      this.get(owner, 'snaptrade'),
      this.get(owner, 'alpaca'),
      this.get(owner, 'robinhood'),
    ]);
    return {
      robinhood: rh?.tokens
        ? {
            connected: true as const,
            connected_at: rh.connected_at ?? '',
            last_test: rh.last_test,
          }
        : { connected: false as const },
      snaptrade: st
        ? await this.snaptradeStatus(
            owner,
            st,
            live,
            rh?.tokens ? (rh.last_test?.account ?? null) : null,
          )
        : { connected: false as const },
      alpaca: alp
        ? {
            connected: true as const,
            key_id: hint(alp.key_id),
            saved_at: alp.saved_at,
            last_test: alp.last_test ?? null,
          }
        : { connected: false as const },
    };
  }

  private async snaptradeStatus(
    owner: string,
    doc: SnapTradeDoc,
    live: boolean,
    /** The Robinhood Agentic account, masked (`••4821`), once the Robinhood sign-in has tested it. */
    agentic: string | null = null,
  ) {
    const base = {
      connected: true as const,
      client_id: doc.client_id,
      consumer_key: hint(doc.consumer_key),
      saved_at: doc.saved_at,
      webhook_url: `${this.opts.hookOrigin}/api/public/snaptrade-hook/${doc.hook_id}`,
      last_sync: doc.last_sync,
      last_event: doc.last_event,
      last_test: doc.last_test ?? null,
    };
    if (!live) return { ...base, error: null, brokers: null };
    try {
      const client = this.client(doc);
      const [auths, accounts, synced] = await Promise.all([
        client.authorizations(),
        client.accounts(),
        this.portfolios.syncedAccounts(owner),
      ]);
      const skip = new Set(doc.skip);
      const trade = new Set(doc.trade ?? []);
      return {
        ...base,
        error: null,
        brokers: auths.map((a) => ({
          id: a.id ?? '',
          name: a.brokerage?.display_name ?? a.brokerage?.name ?? a.name ?? 'Broker',
          broken: Boolean(a.disabled),
          accounts: accounts
            .filter((x) => x.brokerage_authorization === a.id)
            .map((x) => ({
              id: x.id,
              name: doc.names?.[x.id] ?? x.name ?? accountName(x),
              broker_name: x.name ?? accountName(x),
              number: `••${x.number.slice(-4)}`,
              import: !skip.has(x.id),
              tax_type: synced.get(x.id)?.tax_type ?? guessTaxType(x),
              portfolio_id: synced.get(x.id)?.id ?? null,
              ...tradingOf(a, x, agentic, trade),
            })),
        })),
      };
    } catch (err) {
      return { ...base, error: (err as Error).message, brokers: [] };
    }
  }

  // ── SnapTrade ──

  /** Checks the key with SnapTrade, then stores it (sealed). The webhook id survives a key change. */
  async saveSnapTrade(owner: string, key: { client_id: string; consumer_key: string }) {
    let accounts: number;
    try {
      accounts = (
        await new SnapTradeClient(key.client_id, key.consumer_key, this.opts.fetch).accounts()
      ).length;
    } catch (err) {
      if (err instanceof SnapTradeError && err.status < 500)
        throw new IntegrationInvalid(
          `SnapTrade rejected this key (${err.message.replace(/^SnapTrade \d+: /, '')}). Check both values and try again.`,
        );
      throw err;
    }
    await this.update(owner, 'snaptrade', (prev) => ({
      client_id: key.client_id,
      consumer_key: key.consumer_key,
      hook_id: prev?.hook_id ?? randomId(),
      saved_at: new Date().toISOString(),
      skip: prev?.skip ?? [],
      last_sync: prev?.last_sync ?? null,
      last_event: prev?.last_event ?? null,
      last_test: passed(plural(accounts, 'account')),
    }));
    return this.status(owner);
  }

  /** Tests the saved key with one read (its accounts) and keeps the result. */
  async snaptradeTest(owner: string) {
    const doc = await this.snaptrade(owner);
    const t0 = performance.now();
    let result: KeyTest;
    try {
      result = passed(plural((await this.client(doc).accounts()).length, 'account'));
    } catch (err) {
      result = failed(err);
    }
    await this.update(owner, 'snaptrade', (p) => (p ? { ...p, last_test: result } : p));
    await this.noteTest(owner, 'snaptrade', 'SnapTrade test: list accounts', result, t0);
    return this.status(owner, false);
  }

  private async noteTest(
    owner: string,
    category: 'snaptrade' | 'user',
    what: string,
    result: KeyTest,
    t0: number,
  ) {
    await this.opts.logs?.note(owner, {
      category,
      what,
      ok: result.ok,
      ms: performance.now() - t0,
      detail: result.error ?? undefined,
    });
  }

  /** Deletes the key; syncing stops and accounts already synced stay in Holdings. */
  async deleteSnapTrade(owner: string) {
    await this.update(owner, 'snaptrade', () => null);
  }

  /** SnapTrade's Connection Portal for a new broker, or `reconnect` (a broker id) for a broken login. */
  async portal(owner: string, reconnect?: string) {
    const r = await this.client(await this.snaptrade(owner)).portal(
      this.opts.portalReturn,
      reconnect,
    );
    if (!r.redirectURI) throw new SnapTradeError(502, 'SnapTrade returned no portal link');
    return { url: r.redirectURI };
  }

  /**
   * Includes or leaves out one SnapTrade account, and sets its tax type and name. Leaving one out
   * removes it.
   */
  async setAccount(
    owner: string,
    input: { account_id: string; import?: boolean; tax_type?: TaxType; name?: string | null },
  ) {
    const doc = await this.snaptrade(owner);
    const account = (await this.client(doc).accounts()).find((a) => a.id === input.account_id);
    if (!account) throw new IntegrationInvalid('no such SnapTrade account (see integration_list)');
    if (input.name !== undefined) {
      const synced = (await this.portfolios.syncedAccounts(owner)).get(input.account_id);
      if (synced)
        await this.portfolios
          .rename(owner, synced.id, input.name ?? accountName(account))
          .catch((err) => {
            throw err instanceof PortfolioInvalid ? new IntegrationInvalid(err.message) : err;
          });
      await this.update(owner, 'snaptrade', (prev) => {
        if (!prev) return prev;
        const { [input.account_id]: _, ...names } = prev.names ?? {};
        return {
          ...prev,
          names: input.name ? { ...names, [input.account_id]: input.name } : names,
        };
      });
    }
    if (input.import !== undefined) {
      await this.update(owner, 'snaptrade', (prev) =>
        prev
          ? {
              ...prev,
              skip: input.import
                ? prev.skip.filter((id) => id !== input.account_id)
                : [...new Set([...prev.skip, input.account_id])],
            }
          : prev,
      );
    }
    const synced = (await this.portfolios.syncedAccounts(owner)).get(input.account_id);
    if (synced && input.import === false) await this.portfolios.delete(owner, synced.id);
    else if (synced && input.tax_type)
      await this.portfolios.setTaxType(owner, synced.id, input.tax_type);
    if (input.import === true && !synced) await this.sync(owner, input.account_id);
    return this.status(owner);
  }

  /**
   * Lets TradeEdge send orders to an account, or stops it (Bikram, 2026-10-12). Only an account that
   * can trade: its broker linked with trading in SnapTrade, or the Robinhood Agentic account.
   */
  async setTrade(owner: string, accountId: string, on: boolean) {
    const doc = await this.snaptrade(owner);
    const rh = await this.get(owner, 'robinhood');
    const client = this.client(doc);
    const [auths, accounts] = await Promise.all([client.authorizations(), client.accounts()]);
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new IntegrationInvalid('no such SnapTrade account (see integration_list)');
    const auth = auths.find((a) => a.id === account.brokerage_authorization);
    const t = tradingOf(
      auth,
      account,
      rh?.tokens ? (rh.last_test?.account ?? null) : null,
      new Set(),
    );
    if (on && !t.trading.via) throw new IntegrationInvalid(`${t.trading.note}.`);
    await this.update(owner, 'snaptrade', (prev) => {
      if (!prev) return prev;
      const rest = (prev.trade ?? []).filter((id) => id !== accountId);
      return { ...prev, trade: on ? [...rest, accountId] : rest };
    });
    return this.status(owner);
  }

  /** Pulls every included account (or one) from SnapTrade into Holdings. */
  async sync(owner: string, only?: string): Promise<SyncReport> {
    const t0 = performance.now();
    const doc = await this.snaptrade(owner);
    const client = this.client(doc);
    const report: SyncReport = {
      at: new Date().toISOString(),
      ok: true,
      accounts: 0,
      positions: 0,
      transactions: 0,
      skipped: [],
      errors: [],
    };
    try {
      const skip = new Set(doc.skip);
      const [accounts, synced] = await Promise.all([
        client.accounts(),
        this.portfolios.syncedAccounts(owner),
      ]);
      const since =
        doc.last_sync?.at && doc.mapping === ACTIVITY_MAPPING
          ? new Date(Date.parse(doc.last_sync.at) - OVERLAP_DAYS * 86_400_000)
              .toISOString()
              .slice(0, 10)
          : undefined;
      // Several accounts at once: a webhook's sync runs after the reply, where the Worker allows about
      // 30 s, and 21 accounts one by one did not finish in that time.
      const queue = accounts.filter((a) => !skip.has(a.id) && (!only || a.id === only));
      const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          try {
            const r = await this.syncAccount(
              client,
              owner,
              a,
              synced.has(a.id) ? since : undefined,
              synced.get(a.id)?.tax_type,
              doc.names?.[a.id],
            );
            report.accounts++;
            report.positions += r.positions;
            report.transactions += r.transactions;
            report.skipped.push(...r.skipped);
          } catch (err) {
            report.errors.push(`${accountName(a)}: ${(err as Error).message}`);
          }
        }
      };
      await Promise.all(Array.from({ length: SYNC_PARALLEL }, worker));
    } catch (err) {
      report.errors.push((err as Error).message);
    }
    report.ok = report.errors.length === 0;
    if (!only || !report.ok) {
      await this.update(owner, 'snaptrade', (prev) =>
        prev
          ? { ...prev, last_sync: report, ...(report.ok ? { mapping: ACTIVITY_MAPPING } : {}) }
          : prev,
      );
    }
    await this.opts.logs?.note(owner, {
      category: 'snaptrade',
      what:
        `Sync${only ? ' (one account)' : ''}: ${report.accounts} accounts, ${report.positions} ` +
        `positions, ${report.transactions} transactions`,
      ok: report.ok,
      ms: performance.now() - t0,
      detail: report.errors.length ? report.errors.join('; ') : undefined,
    });
    return report;
  }

  private async syncAccount(
    client: SnapTradeClient,
    owner: string,
    a: StAccount,
    since: string | undefined,
    taxType: TaxType | undefined,
    name: string | undefined,
  ) {
    const [pos, balances] = await Promise.all([client.positions(a.id), client.balances(a.id)]);
    const activities = [];
    for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
      const r = await client.activities(a.id, since, page * 1000, 1000);
      activities.push(...(r.data ?? []));
      if ((r.data ?? []).length < 1000) break;
    }
    const { positions, lots, skipped } = mapPositions(pos.results ?? []);
    const { cash, margin } = mapCash(balances);
    const transactions = mapActivities(activities);
    await this.portfolios.syncAccount(owner, {
      snaptrade_account_id: a.id,
      name: name ?? accountName(a),
      tax_type: taxType ?? guessTaxType(a),
      broker: a.institution_name,
      cash,
      positions: margin ? [...positions, margin] : positions,
      lots,
      transactions,
    });
    return { positions: positions.length, transactions: transactions.length, skipped };
  }

  /**
   * SnapTrade's webhook: finds the person by the id in the URL, checks the signature with their key,
   * notes the event and re-syncs when holdings or transactions changed. `work` runs after the reply.
   */
  async hook(
    hookId: string,
    raw: string,
    signature: string | null,
  ): Promise<{ status: 200 | 401 | 404; work?: Promise<unknown> }> {
    if (!/^[0-9a-f]{32}$/.test(hookId)) return { status: 404 };
    const row = await this.db
      .prepare("SELECT owner FROM integrations WHERE hook_id = ? AND provider = 'snaptrade'")
      .bind(hookId)
      .first<{ owner: string }>();
    if (!row) return { status: 404 };
    const doc = await this.get(row.owner, 'snaptrade');
    if (!doc || doc.hook_id !== hookId) return { status: 404 };
    if (!(await verifyHook(raw, signature, doc.consumer_key))) return { status: 401 };
    const event = JSON.parse(raw) as { eventType?: string; accountId?: string; clientId?: string };
    if (event.clientId && event.clientId !== doc.client_id) return { status: 401 };
    const type = String(event.eventType ?? 'UNKNOWN').slice(0, 60);
    await this.update(row.owner, 'snaptrade', (prev) =>
      prev ? { ...prev, last_event: { at: new Date().toISOString(), type } } : prev,
    );
    await this.opts.logs?.note(row.owner, {
      category: 'snaptrade',
      what: `Webhook: ${type}`,
      ok: true,
      detail: SYNC_EVENTS.has(type) ? 'Re-sync started' : undefined,
    });
    return {
      status: 200,
      work: SYNC_EVENTS.has(type) ? this.sync(row.owner, event.accountId || undefined) : undefined,
    };
  }

  // ── Alpaca ──

  /** Checks the key with one quote, then stores it (sealed). */
  async saveAlpaca(owner: string, key: { key_id: string; secret_key: string }) {
    let detail: string;
    try {
      detail = await this.alpacaRead(key);
    } catch {
      throw new IntegrationInvalid('Alpaca rejected this key. Check both values and try again.');
    }
    await this.update(owner, 'alpaca', () => ({
      ...key,
      saved_at: new Date().toISOString(),
      last_test: passed(detail),
    }));
    this.markets.delete(owner);
    return this.status(owner);
  }

  /** One SPY quote with the key: what a test shows when it works. */
  private async alpacaRead(key: { key_id: string; secret_key: string }) {
    const q = await new AlpacaClient({
      ...this.opts.alpaca,
      keyId: key.key_id,
      secretKey: key.secret_key,
    }).getUnderlyingQuote('SPY');
    const px = q.last ?? q.prevClose;
    return px == null ? 'SPY quote' : `SPY $${px.toFixed(2)}`;
  }

  /** Tests the saved key with one quote and keeps the result. */
  async alpacaTest(owner: string) {
    const key = await this.get(owner, 'alpaca');
    if (!key) throw new IntegrationNotConnected('Alpaca is not connected: add your key first.');
    const t0 = performance.now();
    let result: KeyTest;
    try {
      result = passed(await this.alpacaRead(key));
    } catch (err) {
      result = failed(err);
    }
    await this.update(owner, 'alpaca', (p) => (p ? { ...p, last_test: result } : p));
    await this.noteTest(owner, 'user', 'Alpaca test: SPY quote', result, t0);
    return this.status(owner, false);
  }

  async deleteAlpaca(owner: string) {
    await this.update(owner, 'alpaca', () => null);
    this.markets.delete(owner);
  }

  /**
   * The live data service for a person: their own Alpaca key's, else EdgeDesk's. Held per isolate for
   * five minutes, so a quote does not read D1 each time. Their service keeps its own memory cache and
   * skips the colo-shared one, which holds EdgeDesk's feed.
   */
  async marketFor(owner: string): Promise<MarketService> {
    const hit = this.markets.get(owner);
    if (hit && Date.now() - hit.at < 300_000) return hit.market;
    const key = await this.get(owner, 'alpaca');
    const market = key
      ? new MarketService(
          new AlpacaClient({ ...this.opts.alpaca, keyId: key.key_id, secretKey: key.secret_key }),
        )
      : this.opts.market;
    this.markets.set(owner, { at: Date.now(), market });
    return market;
  }

  // ── Robinhood ──

  private async robinhood(owner: string) {
    const doc = await this.get(owner, 'robinhood');
    if (!doc?.tokens)
      throw new IntegrationNotConnected(
        'Robinhood is not connected: connect it in Settings ▸ Integrations.',
      );
    return doc;
  }

  /** Starts a sign-in: registers TradeEdge with Robinhood once, then returns Robinhood's sign-in page. */
  async robinhoodConnect(owner: string) {
    const redirect = ROBINHOOD.redirect;
    const prev = await this.get(owner, 'robinhood');
    const clientId =
      prev?.redirect_uri === redirect
        ? prev.client_id
        : await registerClient(redirect, this.opts.fetch);
    const pending = { state: randomToken(), verifier: randomToken(), at: new Date().toISOString() };
    await this.update(owner, 'robinhood', (p) => ({
      client_id: clientId,
      redirect_uri: redirect,
      pending,
      tokens: p?.redirect_uri === redirect ? p.tokens : null,
      connected_at: p?.redirect_uri === redirect ? p.connected_at : null,
      last_test: p?.last_test ?? null,
    }));
    return {
      url: await authorizeUrl({
        clientId,
        redirectUri: redirect,
        state: pending.state,
        verifier: pending.verifier,
      }),
    };
  }

  /** The address Robinhood redirected to: checks the state, trades the code for tokens, then tests them. */
  async robinhoodCallback(
    owner: string,
    q: { code?: string; state?: string; iss?: string; error?: string },
  ) {
    const t0 = performance.now();
    const doc = await this.get(owner, 'robinhood');
    const pending = doc?.pending;
    try {
      if (q.error)
        throw new IntegrationInvalid(`Robinhood sign-in failed: ${q.error.slice(0, 100)}`);
      if (
        !doc ||
        !pending ||
        !q.code ||
        q.state !== pending.state ||
        Date.now() - Date.parse(pending.at) > 600_000
      )
        throw new IntegrationInvalid('This sign-in expired or did not start here. Connect again.');
      if (q.iss && q.iss !== ROBINHOOD.issuer)
        throw new IntegrationInvalid('The sign-in came back from an unexpected issuer.');
      const tokens = await requestTokens(
        {
          grant_type: 'authorization_code',
          code: q.code,
          code_verifier: pending.verifier,
          redirect_uri: doc.redirect_uri,
        },
        doc.client_id,
        this.opts.fetch,
      );
      await this.update(owner, 'robinhood', (p) =>
        p ? { ...p, pending: null, tokens, connected_at: new Date().toISOString() } : p,
      );
      await this.opts.logs?.note(owner, {
        category: 'user',
        what: 'Robinhood connected',
        ok: true,
        ms: performance.now() - t0,
      });
    } catch (err) {
      await this.update(owner, 'robinhood', (p) => (p ? { ...p, pending: null } : p));
      throw err;
    }
    return this.robinhoodTest(owner);
  }

  /** A working access token, refreshed (and the new one sealed) when it is about to end. */
  private async robinhoodToken(owner: string) {
    const doc = await this.robinhood(owner);
    const tokens = doc.tokens as RobinhoodTokens;
    if (Date.parse(tokens.expires_at) - Date.now() > 60_000) return tokens.access_token;
    if (!tokens.refresh_token)
      throw new IntegrationNotConnected('Robinhood sign-in ended: connect again.');
    let next: RobinhoodTokens;
    try {
      next = await requestTokens(
        { grant_type: 'refresh_token', refresh_token: tokens.refresh_token },
        doc.client_id,
        this.opts.fetch,
      );
    } catch (err) {
      if (err instanceof RobinhoodError && err.status >= 400 && err.status < 500)
        throw new IntegrationNotConnected('Robinhood sign-in ended: connect again.');
      throw err;
    }
    await this.update(owner, 'robinhood', (p) => (p ? { ...p, tokens: next } : p));
    return next.access_token;
  }

  /**
   * Read-only Robinhood tool calls with the person's sign-in (symbol fields, Bikram 2026-10-12): one
   * working token, then each call list runs on its own connection. Places nothing.
   */
  async robinhoodReader(owner: string) {
    const token = await this.robinhoodToken(owner);
    return <T extends unknown[]>(
      calls: { [K in keyof T]: { name: string; arguments?: Record<string, unknown> } },
    ) => callTools<T>(token, calls, this.opts.fetch);
  }

  /** Reads the Agentic account and its trade-approval setting; places nothing. */
  async robinhoodTest(owner: string) {
    const t0 = performance.now();
    let result: NonNullable<RobinhoodDoc['last_test']>;
    try {
      const token = await this.robinhoodToken(owner);
      const [accounts] = await callTools<[unknown]>(
        token,
        [{ name: 'get_accounts' }],
        this.opts.fetch,
      );
      const agentic = findAgentic(accounts);
      let approvals: boolean | null = null;
      if (agentic) {
        const [setting] = await callTools<[unknown]>(
          token,
          [{ name: 'get_trade_approval_setting', arguments: { account_number: agentic } }],
          this.opts.fetch,
        );
        approvals = findApprovals(setting);
      }
      result = {
        at: new Date().toISOString(),
        ok: Boolean(agentic),
        account: agentic ? `••${agentic.slice(-4)}` : null,
        approvals,
        error: agentic
          ? null
          : `No Agentic account found in Robinhood's account list (${shapeOf(accounts)}).`,
      };
    } catch (err) {
      if (err instanceof IntegrationNotConnected) throw err;
      result = {
        at: new Date().toISOString(),
        ok: false,
        account: null,
        approvals: null,
        error: (err as Error).message,
      };
    }
    await this.update(owner, 'robinhood', (p) => (p ? { ...p, last_test: result } : p));
    await this.opts.logs?.note(owner, {
      category: 'mcp',
      what: 'Robinhood test: get_accounts, get_trade_approval_setting',
      ok: result.ok,
      ms: performance.now() - t0,
      detail: result.error ?? undefined,
    });
    return this.status(owner, false);
  }

  /** Deletes the Robinhood tokens; TradeEdge can no longer reach the account. */
  async deleteRobinhood(owner: string) {
    await this.update(owner, 'robinhood', () => null);
  }
}

// Robinhood documents its tools' inputs, not their outputs, so results are read by key wherever they sit:
// structured JSON at any depth, or `key: value` text.

const truthy = (v: unknown) => v === true || v === 'true' || v === 'True';

/** The account number of the account marked `agentic_allowed`. */
function findAgentic(v: unknown): string | null {
  if (typeof v === 'string') {
    // Text: each account's block names its number before or after the flag.
    for (const block of v.split(/\n\s*\n|(?=account_number)/)) {
      if (!/agentic_allowed\W+true/i.test(block)) continue;
      const n = block.match(/account_number\W+([A-Za-z0-9]+)/);
      if (n) return n[1] ?? null;
    }
    return null;
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      const found = findAgentic(x);
      if (found) return found;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (truthy(o.agentic_allowed) && typeof o.account_number === 'string') return o.account_number;
    for (const x of Object.values(o)) {
      const found = findAgentic(x);
      if (found) return found;
    }
  }
  return null;
}

/** Whether the account's trades wait for approval: the first boolean under a key naming approval. */
function findApprovals(v: unknown, key = ''): boolean | null {
  if (typeof v === 'boolean' || v === 'true' || v === 'false')
    return /approv|enabled|required/i.test(key) ? truthy(v) : null;
  if (typeof v === 'string') {
    const m = v.match(/(?:approv\w*|enabled|required)\W+(true|false)/i);
    return m ? (m[1] ?? '').toLowerCase() === 'true' : null;
  }
  if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      const b = findApprovals(x, k);
      if (b !== null) return b;
    }
  return null;
}

/** What a result looked like, without its values, for the error line. */
function shapeOf(v: unknown): string {
  if (typeof v === 'string') return `text, ${v.length} chars`;
  if (Array.isArray(v)) return `list of ${v.length}`;
  if (v && typeof v === 'object') return `keys: ${Object.keys(v).slice(0, 8).join(', ')}`;
  return String(v);
}

/** REST under `/api/integrations` (signed in). */
export function integrationRoutes(svc: Integrations) {
  const r = new Hono<{ Variables: { identity?: AccessIdentity } }>();
  const owner = (c: Context<{ Variables: { identity?: AccessIdentity } }>) =>
    portfolioOwner(c.get('identity'));
  const parse = async <S extends z.ZodRawShape>(c: Context, shape: S) => {
    const body = await c.req.json().catch(() => null);
    return z
      .object(shape)
      .safeParse(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
  };
  const invalid = (issues: z.ZodIssue[]) => ({
    error: 'invalid input',
    issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
  r.onError((err, c) => {
    if (err instanceof IntegrationInvalid) return c.json({ error: err.message }, 400);
    if (err instanceof IntegrationNotConnected) return c.json({ error: err.message }, 409);
    if (err instanceof SnapTradeError || err instanceof RobinhoodError)
      return c.json({ error: err.message }, 502);
    throw err;
  });

  // `?live=0`: what is stored only, without asking SnapTrade (the header's sync status).
  r.get('/', async (c) => c.json(await svc.status(owner(c), c.req.query('live') !== '0')));
  r.put('/snaptrade', async (c) => {
    const p = await parse(c, snaptradeKeyShape);
    if (!p.success) return c.json(invalid(p.error.issues), 400);
    return c.json(await svc.saveSnapTrade(owner(c), p.data));
  });
  r.delete('/snaptrade', async (c) => {
    await svc.deleteSnapTrade(owner(c));
    return c.json({ ok: true });
  });
  r.post('/snaptrade/test', async (c) => c.json(await svc.snaptradeTest(owner(c))));
  r.post('/snaptrade/sync', async (c) => c.json(await svc.sync(owner(c))));
  // Letting TradeEdge send orders is a person's call in the app, never an agent's (like linking a broker).
  r.put('/snaptrade/accounts/:accountId/trade', async (c) => {
    if (c.get('identity')?.serviceToken || c.req.header('sec-fetch-site') !== 'same-origin')
      return c.json(
        { error: 'Trading is turned on by a person in the app: Settings ▸ Brokers and accounts.' },
        403,
      );
    const p = await parse(c, { trade: z.boolean() });
    if (!p.success) return c.json(invalid(p.error.issues), 400);
    return c.json(await svc.setTrade(owner(c), c.req.param('accountId'), p.data.trade));
  });
  r.put('/snaptrade/accounts/:accountId', async (c) => {
    // The account id comes from the path, so the body is checked together with it.
    const body = await c.req.json().catch(() => null);
    const checked = z.object(snaptradeAccountShape).safeParse({
      ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
      account_id: c.req.param('accountId'),
    });
    if (!checked.success) return c.json(invalid(checked.error.issues), 400);
    return c.json(await svc.setAccount(owner(c), checked.data));
  });
  // Linking a broker is the one thing only a person in the app does (Bikram, 2026-10-10): no service
  // token, and only a request the browser marks as coming from the app's own page.
  r.post('/snaptrade/portal', async (c) => {
    if (c.get('identity')?.serviceToken || c.req.header('sec-fetch-site') !== 'same-origin')
      return c.json(
        {
          error: 'Brokers are linked by a person in the app: Settings ▸ Brokers and accounts.',
        },
        403,
      );
    const p = await parse(c, { reconnect: z.string().trim().min(1).max(100).optional() });
    if (!p.success) return c.json(invalid(p.error.issues), 400);
    return c.json(await svc.portal(owner(c), p.data.reconnect));
  });
  r.put('/alpaca', async (c) => {
    const p = await parse(c, alpacaKeyShape);
    if (!p.success) return c.json(invalid(p.error.issues), 400);
    return c.json(await svc.saveAlpaca(owner(c), p.data));
  });
  r.post('/alpaca/test', async (c) => c.json(await svc.alpacaTest(owner(c))));
  r.delete('/alpaca', async (c) => {
    await svc.deleteAlpaca(owner(c));
    return c.json({ ok: true });
  });
  // Robinhood is signed in to by a person in the app only, like linking a broker.
  r.post('/robinhood/connect', async (c) => {
    if (c.get('identity')?.serviceToken || c.req.header('sec-fetch-site') !== 'same-origin')
      return c.json(
        { error: 'Robinhood is connected by a person in the app: Settings ▸ Integrations.' },
        403,
      );
    return c.json(await svc.robinhoodConnect(owner(c)));
  });
  // The address Robinhood sent the browser to (localhost, which nothing answers), pasted by the person.
  r.post('/robinhood/finish', async (c) => {
    if (c.get('identity')?.serviceToken || c.req.header('sec-fetch-site') !== 'same-origin')
      return c.json(
        { error: 'Robinhood is connected by a person in the app: Settings ▸ Integrations.' },
        403,
      );
    const p = await parse(c, { url: z.string().trim().min(1).max(4000) });
    if (!p.success) return c.json(invalid(p.error.issues), 400);
    let q: URLSearchParams;
    try {
      q = new URL(p.data.url).searchParams;
    } catch {
      throw new IntegrationInvalid(
        'Paste the whole address from the page Robinhood opened (it starts with http://localhost).',
      );
    }
    return c.json(
      await svc.robinhoodCallback(owner(c), {
        code: q.get('code') ?? undefined,
        state: q.get('state') ?? undefined,
        iss: q.get('iss') ?? undefined,
        error: q.get('error_description') ?? q.get('error') ?? undefined,
      }),
    );
  });
  r.post('/robinhood/test', async (c) => c.json(await svc.robinhoodTest(owner(c))));
  r.delete('/robinhood', async (c) => {
    await svc.deleteRobinhood(owner(c));
    return c.json({ ok: true });
  });
  return r;
}
