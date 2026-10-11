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
 */
import type { D1Like } from './d1';

const te = new TextEncoder();
const td = new TextDecoder();
const VERSION = 'v1.';
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
    private readonly dataKey: CryptoKey,
    private readonly indexKey: CryptoKey,
  ) {}

  /** JSON value → sealed text; `aad` names the table and row (e.g. `trades:tr_…`). */
  seal(aad: string, value: unknown): Promise<string> {
    return seal(this.dataKey, aad, te.encode(JSON.stringify(value)));
  }

  async open<T>(aad: string, sealed: string): Promise<T> {
    return JSON.parse(td.decode(await unseal(this.dataKey, aad, sealed))) as T;
  }

  /** A lookup key for a value (a name, a month): equal values match, nothing else shows. */
  async index(value: string): Promise<string> {
    return hex(await crypto.subtle.sign('HMAC', this.indexKey, te.encode(value))).slice(0, 32);
  }
}

/** Opens each owner's vault, creating it on first use. One per isolate. */
export class Vault {
  private master?: Promise<{ owner: CryptoKey; wrap: CryptoKey }>;
  private readonly open = new Map<string, Promise<UserVault>>();

  constructor(
    private readonly db: D1Like,
    /** Base64 of 32 random bytes (Secrets Store `EDGEDESK_VAULT_KEK`). */
    private readonly kek: string,
  ) {}

  private keys() {
    this.master ??= (async () => {
      const raw = unb64(this.kek);
      if (raw.length !== 32) throw new Error('vault: EDGEDESK_VAULT_KEK must be 32 bytes, base64');
      return { owner: await hkdf(raw, 'owner', 'hmac'), wrap: await hkdf(raw, 'wrap', 'aes') };
    })();
    return this.master;
  }

  /** The owner key D1 stores for an email, service token or `local`. */
  async ownerId(owner: string): Promise<string> {
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
