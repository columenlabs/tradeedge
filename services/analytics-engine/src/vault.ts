/**
 * Vault (Bikram, 2026-10-10): every per-user row in D1 is sealed, so reading D1 shows nothing useful.
 * Envelope encryption, WebCrypto only:
 *
 *   master key (Secrets Store EDGEDESK_VAULT_KEK, 32 bytes base64)
 *     ├─ HKDF "owner"  → HMAC key: owner email → `u_<hex>` (D1 never holds an email)
 *     └─ HKDF "wrap"   → AES-GCM key: wraps each user's data key (D1 `vaults`)
 *   user data key (random, 32 bytes)
 *     ├─ AES-256-GCM: seals every row; the AAD names the table and row, so a blob can't be moved
 *     └─ HKDF "index"  → HMAC key: names and buckets used as lookup keys (`index`)
 *
 * Unwrapped keys stay in isolate memory, so after the first request a seal or open costs microseconds
 * and no D1 read. Design: /mnt/project-files/encryption/design.md.
 *
 * Encryption off (Bikram, 2026-10-12): a self-hosted TradeEdge without `VAULT_KEK` stores the same
 * rows readable: owners are emails, lookup keys are the JSON of the value, blobs are `plain.` + JSON.
 * Setting a key later seals every such row once (`sealPlainRows`); there is no way back. The hosted
 * suite never runs without its key.
 */
import type { D1Like } from './d1';

const te = new TextEncoder();
const td = new TextDecoder();
const VERSION = 'v1.';
const PLAIN = 'plain.';
/** A stored owner id (`ownerId`); no email, service token or `local` looks like one. */
const OWNER_ID = /^u_[0-9a-f]{40}$/;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s, 'base64'));
const hex = (buf: ArrayBuffer) => Buffer.from(buf).toString('hex');

async function hkdf(
  raw: Uint8Array<ArrayBuffer>,
  info: string,
  usage: 'aes' | 'hmac',
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) },
    base,
    usage === 'aes' ? { name: 'AES-GCM', length: 256 } : { name: 'HMAC', hash: 'SHA-256' },
    false,
    usage === 'aes' ? ['encrypt', 'decrypt'] : ['sign'],
  );
}

async function seal(key: CryptoKey, aad: string, plain: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: te.encode(aad) },
      key,
      plain,
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return VERSION + b64(out);
}

async function unseal(
  key: CryptoKey,
  aad: string,
  sealed: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!sealed.startsWith(VERSION)) throw new Error('vault: unknown blob version');
  const bytes = unb64(sealed.slice(VERSION.length));
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: te.encode(aad) },
      key,
      bytes.subarray(12),
    ),
  );
}

/** One user's open vault: seals and opens their rows. */
export class UserVault {
  constructor(
    /** The owner as D1 stores it: `u_` + HMAC of the email. */
    readonly owner: string,
    /** Both null when encryption is off. */
    private readonly dataKey: CryptoKey | null,
    private readonly indexKey: CryptoKey | null,
  ) {}

  /** JSON value → sealed text; `aad` names the table and row (e.g. `trades:tr_…`). */
  async seal(aad: string, value: unknown): Promise<string> {
    if (!this.dataKey) return PLAIN + JSON.stringify(value);
    return seal(this.dataKey, aad, te.encode(JSON.stringify(value)));
  }

  async open<T>(aad: string, sealed: string): Promise<T> {
    if (!this.dataKey) {
      if (!sealed.startsWith(PLAIN))
        throw new Error('vault: row is encrypted but VAULT_KEK is not set');
      return JSON.parse(sealed.slice(PLAIN.length)) as T;
    }
    return JSON.parse(td.decode(await unseal(this.dataKey, aad, sealed))) as T;
  }

  /** A lookup key for a value (a name, a month): equal values match, nothing else shows. */
  async index(value: string): Promise<string> {
    if (!this.indexKey) return JSON.stringify(value);
    return hex(await crypto.subtle.sign('HMAC', this.indexKey, te.encode(value))).slice(0, 32);
  }
}

/** Opens each owner's vault, creating it on first use. One per isolate. */
export class Vault {
  private master?: Promise<{ owner: CryptoKey; wrap: CryptoKey }>;
  private readonly open = new Map<string, Promise<UserVault>>();

  constructor(
    private readonly db: D1Like,
    /** Base64 of 32 random bytes (Secrets Store `EDGEDESK_VAULT_KEK`); null = encryption off (self-host). */
    private readonly kek: string | null,
  ) {}

  get encrypted(): boolean {
    return this.kek !== null;
  }

  private keys() {
    this.master ??= (async () => {
      if (!this.kek) throw new Error('vault: encryption is off');
      const raw = unb64(this.kek);
      if (raw.length !== 32) throw new Error('vault: EDGEDESK_VAULT_KEK must be 32 bytes, base64');
      return { owner: await hkdf(raw, 'owner', 'hmac'), wrap: await hkdf(raw, 'wrap', 'aes') };
    })();
    return this.master;
  }

  /** The owner key D1 stores for an email, service token or `local`. */
  async ownerId(owner: string): Promise<string> {
    if (!this.kek) return owner;
    const { owner: key } = await this.keys();
    return `u_${hex(await crypto.subtle.sign('HMAC', key, te.encode(owner))).slice(0, 40)}`;
  }

  /**
   * The caller's vault; the first call per isolate reads (or creates) its wrapped data key. `owner` is
   * the email (service token, `local`) or the stored `u_…` id itself, which a webhook only knows.
   */
  for(owner: string): Promise<UserVault> {
    let v = this.open.get(owner);
    if (!v) {
      v = this.load(owner);
      this.open.set(owner, v);
      v.catch(() => this.open.delete(owner));
    }
    return v;
  }

  private async load(email: string): Promise<UserVault> {
    if (!this.kek) return new UserVault(email, null, null);
    const { wrap } = await this.keys();
    const owner = OWNER_ID.test(email) ? email : await this.ownerId(email);
    const aad = `vaults:${owner}`;
    let row = await this.db
      .prepare('SELECT data_key FROM vaults WHERE owner = ?')
      .bind(owner)
      .first<{ data_key: string }>();
    if (!row) {
      const fresh = crypto.getRandomValues(new Uint8Array(32));
      await this.db
        .prepare('INSERT OR IGNORE INTO vaults (owner, data_key) VALUES (?, ?)')
        .bind(owner, await seal(wrap, aad, fresh))
        .run();
      // Two first requests at once: both read back the one key that won.
      row = await this.db
        .prepare('SELECT data_key FROM vaults WHERE owner = ?')
        .bind(owner)
        .first<{ data_key: string }>();
      if (!row) throw new Error('vault: data key not stored');
    }
    const raw = await unseal(wrap, aad, row.data_key);
    const dataKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    const indexKey = await hkdf(raw, 'index', 'hmac');
    raw.fill(0);
    return new UserVault(owner, dataKey, indexKey);
  }
}

/** True when a write lost a race on a sealed document (`version` check); the caller retries. */
export function isVersionConflict(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err);
  return /NOT NULL constraint failed: .*\.version|UNIQUE constraint failed/.test(m);
}

/**
 * Runs a read-modify-write of sealed documents, retrying when another write got there first.
 * Writes guard each document with `version` (see `docWrite`), so a lost race throws, never overwrites.
 */
export async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries || !isVersionConflict(err)) throw err;
    }
  }
}

/**
 * The statement that stores one sealed document keyed by `key` in `table` (columns `data` and
 * `version`). `version` 0 inserts (a concurrent insert fails on the key); otherwise the update only
 * passes when nobody wrote since the read (a stale version sets NULL and fails NOT NULL, which rolls
 * back the whole batch).
 */
export function docWrite(
  db: D1Like,
  table: string,
  key: Record<string, string>,
  data: string,
  version: number,
) {
  const cols = Object.keys(key);
  if (version === 0) {
    return db
      .prepare(
        `INSERT INTO ${table} (${cols.join(', ')}, data, version) VALUES (${cols.map(() => '?').join(', ')}, ?, 1)`,
      )
      .bind(...Object.values(key), data);
  }
  return db
    .prepare(
      `UPDATE ${table} SET data = ?, version = CASE WHEN version = ? THEN version + 1 END
        WHERE ${cols.map((c) => `${c} = ?`).join(' AND ')}`,
    )
    .bind(data, version, ...Object.values(key));
}

/**
 * One sealed document per owner in `table` (columns `owner`, `data`, `version`): the watchlist,
 * sectors, baskets and fund follows. A read is one row and one open; an update retries a lost race.
 */
export class OwnerDoc<T> {
  constructor(
    private readonly db: D1Like,
    private readonly vault: Vault,
    private readonly table: string,
    private readonly empty: () => T,
  ) {}

  private async load(owner: string) {
    const v = await this.vault.for(owner);
    const row = await this.db
      .prepare(`SELECT data, version FROM ${this.table} WHERE owner = ?`)
      .bind(v.owner)
      .first<{ data: string; version: number }>();
    return {
      v,
      value: row ? await v.open<T>(`${this.table}:${v.owner}`, row.data) : this.empty(),
      version: row ? Number(row.version) : 0,
    };
  }

  async read(owner: string): Promise<T> {
    return (await this.load(owner)).value;
  }

  /** Applies `change` to the current document and stores the result. */
  update(owner: string, change: (value: T) => T): Promise<T> {
    return withRetry(async () => {
      const { v, value, version } = await this.load(owner);
      const next = change(value);
      await docWrite(
        this.db,
        this.table,
        { owner: v.owner },
        await v.seal(`${this.table}:${v.owner}`, next),
        version,
      ).run();
      return next;
    });
  }
}

/** Each table holding a person's rows: its key, sealed and lookup columns, and each blob's AAD. */
const SEALED_TABLES: {
  table: string;
  key: string[];
  /** Where the owner is read: its own `owner` column, or its portfolio's. */
  owner: 'own' | 'portfolio';
  sealed: string[];
  indexed?: string[];
  where?: string;
  aad: (r: Record<string, string>) => Record<string, string>;
}[] = [
  {
    table: 'portfolio_transactions',
    key: ['portfolio_id', 'bucket'],
    owner: 'portfolio',
    sealed: ['data'],
    indexed: ['bucket'],
    aad: (r) => ({ data: `portfolio_transactions:${r.portfolio_id}:${r.bucket}` }),
  },
  {
    table: 'portfolio_lots',
    key: ['portfolio_id'],
    owner: 'portfolio',
    sealed: ['data'],
    aad: (r) => ({ data: `portfolio_lots:${r.portfolio_id}` }),
  },
  ...['portfolios', 'trades', 'screeners', 'logs'].map((table) => ({
    table,
    key: ['id'],
    owner: 'own' as const,
    sealed: ['data'],
    indexed: table === 'logs' ? [] : ['name_key'],
    aad: (r: Record<string, string>) => ({ data: `${table}:${r.id}` }),
  })),
  {
    table: 'basket_sleeves',
    key: ['basket_id', 'portfolio_id'],
    owner: 'portfolio',
    sealed: ['data'],
    aad: (r) => ({ data: `basket_sleeves:${r.basket_id}:${r.portfolio_id}` }),
  },
  {
    table: 'baskets',
    key: ['id'],
    owner: 'own',
    sealed: ['data'],
    indexed: ['name_key'],
    aad: (r) => ({ data: `baskets:${r.id}` }),
  },
  {
    table: 'basket_orders',
    key: ['id'],
    owner: 'own',
    sealed: ['data'],
    aad: (r) => ({ data: `basket_orders:${r.id}` }),
  },
  {
    table: 'posts',
    key: ['id'],
    owner: 'own',
    sealed: ['data'],
    aad: (r) => ({ data: `posts:${r.id}` }),
  },
  {
    table: 'schedules',
    key: ['owner'],
    owner: 'own',
    sealed: ['data'],
    aad: (r) => ({ data: `schedules:${r.owner}` }),
  },
  {
    table: 'integrations',
    key: ['owner', 'provider'],
    owner: 'own',
    sealed: ['data'],
    aad: (r) => ({ data: `integrations:${r.owner}:${r.provider}` }),
  },
  ...['watchlist', 'symbol_sectors', 'position_baskets', 'fund_follows'].map((table) => ({
    table,
    key: ['owner'],
    owner: 'own' as const,
    sealed: ['data'],
    aad: (r: Record<string, string>) => ({ data: `${table}:${r.owner}` }),
  })),
  {
    table: 'custom_views',
    key: ['domain', 'id'],
    owner: 'own',
    sealed: ['name', 'config'],
    where: 'owner IS NOT NULL',
    aad: (r) => ({
      name: `custom_views:${r.domain}:${r.id}:name`,
      config: `custom_views:${r.domain}:${r.id}:config`,
    }),
  },
];

/**
 * Seals every row stored while encryption was off, once a self-hosted TradeEdge gets a key: owners
 * become `u_…`, lookup keys HMACs, blobs AES-GCM. Each update only applies to the readable row it
 * read, so isolates starting together don't clash, and a pass cut short finishes on the next start.
 * Returns how many rows it sealed.
 */
export async function sealPlainRows(db: D1Like, vault: Vault): Promise<number> {
  if (!vault.encrypted) return 0;
  let sealed = 0;
  for (const t of SEALED_TABLES) {
    const first = t.sealed[0] as string;
    const sql =
      t.owner === 'portfolio'
        ? `SELECT t.*, p.owner AS owner FROM ${t.table} t JOIN portfolios p ON p.id = t.portfolio_id
            WHERE t.${first} LIKE '${PLAIN}%'`
        : `SELECT * FROM ${t.table} WHERE ${first} LIKE '${PLAIN}%'${t.where ? ` AND ${t.where}` : ''}`;
    const { results } = await db.prepare(sql).all<Record<string, string>>();
    const stmts = [];
    for (const row of results) {
      const v = await vault.for(String(row.owner));
      const next: Record<string, string> = { ...row, owner: v.owner };
      for (const c of t.indexed ?? [])
        next[c] = await v.index(JSON.parse(String(row[c])) as string);
      const aad = t.aad(next);
      for (const c of t.sealed)
        next[c] = await v.seal(String(aad[c]), JSON.parse(String(row[c]).slice(PLAIN.length)));
      const set = [...(t.owner === 'own' ? ['owner'] : []), ...(t.indexed ?? []), ...t.sealed];
      stmts.push(
        db
          .prepare(
            `UPDATE ${t.table} SET ${set.map((c) => `${c} = ?`).join(', ')}
              WHERE ${[...t.key, first].map((c) => `${c} = ?`).join(' AND ')}`,
          )
          .bind(...set.map((c) => next[c]), ...t.key.map((c) => row[c]), row[first]),
      );
    }
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    sealed += stmts.length;
  }
  return sealed;
}
