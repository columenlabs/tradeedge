// Custom views (Bikram, 2026-10-08): every desk's saved CustomViewPage views in one D1 table,
// `custom_views`, keyed by data domain and id. A view belongs to one person (sealed, see
// `CustomViews`), or to everyone on its desk when `owner` is null (explorer views). Each domain
// checks its own config before it gets here; the store only keeps it. App views (`appViews`) live in code: listed first,
// read like any view, never written or deleted.
import { type CustomView, type CustomViewDesk, appView, appViews } from '@edgedesk/types/views';
import type { D1Like } from '../d1';
import type { UserVault, Vault } from '../vault';

export class CustomViewNotFound extends Error {
  constructor(domain: string, id: string) {
    super(`${domain} view not found: ${id}`);
  }
}

export class CustomViewReadOnly extends Error {
  constructor(id: string) {
    super(`${id} is an app view and read-only: write a new view with its config to change it`);
  }
}

/** App views as stored views; they date from when they were defined. */
const APP_DATE = '2026-10-09T00:00:00.000Z';
const asStored = <C>(v: (typeof appViews)[number]) =>
  ({ ...v, created_at: APP_DATE, updated_at: APP_DATE }) as CustomView<C>;
const guard = (domain: string, id: string) => {
  if (appView(domain, id)) throw new CustomViewReadOnly(id);
};

/** The caller as a view owner: the Access email, else the service token. */
export function customViewOwner(identity?: { email?: string; sub: string; serviceToken?: string }) {
  if (!identity) return 'local';
  if (identity.email) return identity.email.toLowerCase();
  return `token:${identity.serviceToken ?? identity.sub}`;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'view';

const parse = <C>(r: Record<string, unknown>, owner: string | null): CustomView<C> => ({
  id: String(r.id),
  desk: String(r.desk) as CustomViewDesk,
  domain: String(r.domain),
  owner,
  name: String(r.name),
  config: JSON.parse(String(r.config)) as C,
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
});

const ownedId = () => {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return `cv_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * Shared views (`owner` null) are plain. A person's own views are sealed with their vault
 * (src/vault.ts, Bikram 2026-10-10): `owner` is their `u_…` key, `name` and `config` are sealed
 * and the id is random, so D1 shows neither the name nor the setup.
 */
export class CustomViews {
  constructor(
    private readonly db: D1Like,
    private readonly vault?: Vault,
  ) {}

  private async who(owner: string | null): Promise<UserVault | null> {
    if (owner === null) return null;
    if (!this.vault) throw new Error("custom views: a person's views need the vault");
    return this.vault.for(owner);
  }

  private async open<C>(
    r: Record<string, unknown>,
    v: UserVault | null,
    owner: string | null,
  ): Promise<CustomView<C>> {
    if (!v) return parse<C>(r, null);
    const aad = `custom_views:${r.domain}:${r.id}`;
    return parse<C>(
      {
        ...r,
        name: await v.open<string>(`${aad}:name`, String(r.name)),
        config: JSON.stringify(await v.open<C>(`${aad}:config`, String(r.config))),
      },
      owner,
    );
  }

  private ownerClause(v: UserVault | null) {
    return v === null ? { sql: 'owner IS NULL', args: [] } : { sql: 'owner = ?', args: [v.owner] };
  }

  async list<C>(domain: string, owner: string | null): Promise<CustomView<C>[]> {
    const v = await this.who(owner);
    const o = this.ownerClause(v);
    const { results } = await this.db
      .prepare(`SELECT * FROM custom_views WHERE domain = ? AND ${o.sql}`)
      .bind(domain, ...o.args)
      .all<Record<string, unknown>>();
    const rows = await Promise.all(results.map((r) => this.open<C>(r, v, owner)));
    return [
      ...appViews.filter((a) => a.domain === domain).map((a) => asStored<C>(a)),
      ...rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    ];
  }

  async read<C>(domain: string, id: string, owner: string | null): Promise<CustomView<C> | null> {
    const app = appView(domain, id);
    if (app) return asStored<C>(app);
    const v = await this.who(owner);
    const o = this.ownerClause(v);
    const row = await this.db
      .prepare(`SELECT * FROM custom_views WHERE domain = ? AND id = ? AND ${o.sql}`)
      .bind(domain, id, ...o.args)
      .first<Record<string, unknown>>();
    return row ? this.open<C>(row, v, owner) : null;
  }

  /** Sealed name and config of a person's view; plain for a shared one. */
  private async fields<C>(
    v: UserVault | null,
    domain: string,
    id: string,
    name: string,
    config: C,
  ) {
    if (!v) return { name, config: JSON.stringify(config) };
    const aad = `custom_views:${domain}:${id}`;
    return {
      name: await v.seal(`${aad}:name`, name),
      config: await v.seal(`${aad}:config`, config),
    };
  }

  /**
   * A new view. A shared view's id is its name as a slug, numbered when taken in the domain; a
   * person's own view gets a random id.
   */
  async create<C>(v: {
    desk: CustomViewDesk;
    domain: string;
    owner: string | null;
    name: string;
    config: C;
  }): Promise<CustomView<C>> {
    const who = await this.who(v.owner);
    let id = ownedId();
    if (!who) {
      const base = slug(v.name);
      const taken = new Set(
        (
          await this.db
            .prepare('SELECT id FROM custom_views WHERE domain = ? AND (id = ? OR id LIKE ?)')
            .bind(v.domain, base, `${base}-%`)
            .all<{ id: string }>()
        ).results.map((r) => r.id),
      );
      for (const a of appViews) if (a.domain === v.domain) taken.add(a.id);
      id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    }
    const f = await this.fields(who, v.domain, id, v.name, v.config);
    await this.db
      .prepare(
        'INSERT INTO custom_views (domain, id, desk, owner, name, config) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(v.domain, id, v.desk, who?.owner ?? null, f.name, f.config)
      .run();
    return (await this.read<C>(v.domain, id, v.owner)) as CustomView<C>;
  }

  async update<C>(
    domain: string,
    id: string,
    owner: string | null,
    v: { name: string; config: C },
  ): Promise<CustomView<C>> {
    guard(domain, id);
    const who = await this.who(owner);
    const o = this.ownerClause(who);
    const f = await this.fields(who, domain, id, v.name, v.config);
    const { results } = await this.db
      .prepare(
        `UPDATE custom_views SET name = ?, config = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE domain = ? AND id = ? AND ${o.sql} RETURNING id`,
      )
      .bind(f.name, f.config, domain, id, ...o.args)
      .all();
    if (!results.length) throw new CustomViewNotFound(domain, id);
    return (await this.read<C>(domain, id, owner)) as CustomView<C>;
  }

  async delete(domain: string, id: string, owner: string | null): Promise<void> {
    guard(domain, id);
    const o = this.ownerClause(await this.who(owner));
    const { results } = await this.db
      .prepare(`DELETE FROM custom_views WHERE domain = ? AND id = ? AND ${o.sql} RETURNING id`)
      .bind(domain, id, ...o.args)
      .all();
    if (!results.length) throw new CustomViewNotFound(domain, id);
  }
}
