/**
 * Integrations (Bikram, 2026-10-10): the services TradeEdge connects to with each person's own keys,
 * set in Settings ▸ Integrations, so TradeEdge stands on its own. D1 `integrations` (migration 0028),
 * one sealed row per person and provider:
 *
 *   snaptrade  Personal key (client id + consumer key), the webhook id, accounts left out of Holdings,
 *              the last sync and the last webhook event. Brokers are linked in SnapTrade's own portal,
 *              from the app only; everything else here is open to the app, REST and MCP alike.
 *   alpaca     the person's market-data key; live quotes and chains use it instead of EdgeDesk's.
 */
import { AlpacaClient, type AlpacaConfig } from '@edgedesk/providers';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import { MarketService } from '../../market';
import { type Vault, withRetry } from '../../vault';
import type { Logs } from './logs';
import { type Portfolios, type TaxType, portfolioOwner } from './portfolio';
import {
  SnapTradeClient,
  SnapTradeError,
  type StAccount,
  accountName,
  guessTaxType,
  mapActivities,
  mapCash,
  mapPositions,
  verifyHook,
} from './snaptrade';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type Provider = 'snaptrade' | 'alpaca';

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
  last_sync: SyncReport | null;
  last_event: { at: string; type: string } | null;
}
interface AlpacaDoc {
  key_id: string;
  secret_key: string;
  saved_at: string;
}
interface Docs {
  snaptrade: SnapTradeDoc;
  alpaca: AlpacaDoc;
}

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
      /** Where SnapTrade's portal returns: the app's Settings ▸ Integrations. */
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
   * What Settings ▸ Integrations shows; brokers and accounts are read live from SnapTrade. `live`
   * false skips SnapTrade (the header's sync status reads only what is stored).
   */
  async status(owner: string, live = true) {
    const [st, alp] = await Promise.all([this.get(owner, 'snaptrade'), this.get(owner, 'alpaca')]);
    return {
      snaptrade: st ? await this.snaptradeStatus(owner, st, live) : { connected: false as const },
      alpaca: alp
        ? { connected: true as const, key_id: hint(alp.key_id), saved_at: alp.saved_at }
        : { connected: false as const },
    };
  }

  private async snaptradeStatus(owner: string, doc: SnapTradeDoc, live: boolean) {
    const base = {
      connected: true as const,
      client_id: doc.client_id,
      consumer_key: hint(doc.consumer_key),
      saved_at: doc.saved_at,
      webhook_url: `${this.opts.hookOrigin}/api/public/snaptrade-hook/${doc.hook_id}`,
      last_sync: doc.last_sync,
      last_event: doc.last_event,
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
              name: x.name ?? accountName(x),
              number: `••${x.number.slice(-4)}`,
              import: !skip.has(x.id),
              tax_type: synced.get(x.id)?.tax_type ?? guessTaxType(x),
              portfolio_id: synced.get(x.id)?.id ?? null,
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
    try {
      await new SnapTradeClient(key.client_id, key.consumer_key, this.opts.fetch).accounts();
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
    }));
    return this.status(owner);
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

  /** Includes or leaves out one SnapTrade account, and sets its tax type. Leaving one out removes it. */
  async setAccount(
    owner: string,
    input: { account_id: string; import?: boolean; tax_type?: TaxType },
  ) {
    const doc = await this.snaptrade(owner);
    const accounts = await this.client(doc).accounts();
    if (!accounts.some((a) => a.id === input.account_id))
      throw new IntegrationInvalid('no such SnapTrade account (see integration_list)');
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
      const since = doc.last_sync?.at
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
        prev ? { ...prev, last_sync: report } : prev,
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
      name: accountName(a),
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
    try {
      await new AlpacaClient({
        ...this.opts.alpaca,
        keyId: key.key_id,
        secretKey: key.secret_key,
      }).getUnderlyingQuote('SPY');
    } catch {
      throw new IntegrationInvalid('Alpaca rejected this key. Check both values and try again.');
    }
    await this.update(owner, 'alpaca', () => ({ ...key, saved_at: new Date().toISOString() }));
    this.markets.delete(owner);
    return this.status(owner);
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
    if (err instanceof SnapTradeError) return c.json({ error: err.message }, 502);
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
  r.post('/snaptrade/sync', async (c) => c.json(await svc.sync(owner(c))));
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
          error: 'Brokers are linked by a person in the app: Settings ▸ Integrations ▸ SnapTrade.',
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
  r.delete('/alpaca', async (c) => {
    await svc.deleteAlpaca(owner(c));
    return c.json({ ok: true });
  });
  return r;
}
