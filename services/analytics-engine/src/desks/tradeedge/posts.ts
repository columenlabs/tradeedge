/**
 * Posts (Bikram, 2026-10-12): what the accounts a person tracks on X post, tagged with symbols, a
 * macro theme and sentiment (x.ts), for the app's Posts views, REST `/api/posts` and MCP `post_list`.
 *
 * Where posts live depends on the deployment (Bikram, 2026-10-12): with DataEdge (the EdgeDesk
 * suite) they go to its `x_posts` dataset in ClickHouse, kept for good and shared, since posts are
 * public; which accounts a person tracks stays sealed in their X integration. Without DataEdge
 * (self-host) each person's posts are rows in D1 `posts` (migration 0031), sealed, kept 30 days and
 * removed by the Prune old posts schedule.
 *
 * A check reads only posts newer than the last one: one twitterapi.io search per 20 tracked
 * accounts, on the person's own key.
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import type { Vault } from '../../vault';
import { IntegrationNotConnected, type Integrations } from './integrations';
import type { Logs } from './logs';
import { portfolioOwner } from './portfolio';
import { type Post, type PostTagger, THEMES, type Theme, TwitterApiClient } from './x';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const KEEP_MS = 30 * 86_400_000;
/** A person's first check reads this far back. */
const FIRST_LOOK_S = 3600;

/** DataEdge's `x_posts` dataset, as the suite hands it in (desks/dataedge/x-posts.ts). */
export interface PostArchive {
  push(posts: Post[]): Promise<void>;
  /** Posts by `handles`, newest first. */
  list(q: { handles: string[]; from: string; limit: number }): Promise<Post[]>;
}

export interface PostQuery {
  /** Only posts naming this ticker. */
  symbol?: string;
  /** Only this account. */
  handle?: string;
  theme?: Theme;
  /** Posts from the last this many hours (default 24, at most 720). */
  hours?: number;
  limit?: number;
}

export class Posts {
  constructor(
    private readonly db: D1Like,
    private readonly vault: Vault,
    private readonly integrations: Integrations,
    private readonly tagger: PostTagger,
    private readonly opts: { archive?: PostArchive; logs?: Logs; fetch?: FetchFn } = {},
  ) {}

  /** `dataedge` (ClickHouse, kept for good) or `d1` (sealed, 30 days). */
  get store(): 'dataedge' | 'd1' {
    return this.opts.archive ? 'dataedge' : 'd1';
  }

  /**
   * Reads new posts by the person's tracked accounts, tags and stores them, and logs it (category X).
   * `why` names what started it (`market hours`, `Run now`). Returns a one-line report.
   */
  async check(owner: string, why: string): Promise<string> {
    const doc = await this.integrations.xDoc(owner);
    if (!doc) throw new IntegrationNotConnected('X is not connected: add your twitterapi.io key.');
    if (!doc.handles.length) return 'No tracked accounts';
    const at = new Date().toISOString();
    const t0 = performance.now();
    const since = doc.since ?? Math.floor(Date.now() / 1000) - FIRST_LOOK_S;
    const client = new TwitterApiClient(doc.api_key, this.opts.fetch);
    const what = (n: number) =>
      `Check X (${why}): ${doc.handles.length} accounts, ${client.calls} call${client.calls === 1 ? '' : 's'}${n ? `, ${n} posts read` : ''}`;
    try {
      const seen = new Set(doc.since_ids ?? []);
      const read = await client.postsSince(doc.handles, since);
      const fresh = read.filter((p) => !seen.has(p.id) && doc.handles.includes(p.handle));
      const notes = await this.tagger.tag(fresh);
      await this.save(owner, fresh);
      const newest = fresh.length
        ? Math.floor(Date.parse(fresh[fresh.length - 1]?.at ?? at) / 1000)
        : since;
      const ids = fresh
        .filter((p) => Math.floor(Date.parse(p.at) / 1000) === newest)
        .map((p) => p.id);
      await this.integrations.xChecked(
        owner,
        { at, ok: true, posts: fresh.length, error: null },
        { since: newest, since_ids: newest === since ? [...seen, ...ids] : ids },
      );
      const report = `${fresh.length} new post${fresh.length === 1 ? '' : 's'}`;
      const detail = notes.length ? `${report} · ${notes.join(' · ')}` : report;
      await this.opts.logs?.note(owner, {
        category: 'x',
        what: what(read.length),
        ok: true,
        ms: performance.now() - t0,
        detail,
      });
      return detail;
    } catch (err) {
      const error = (err as Error).message.slice(0, 300);
      await this.integrations.xChecked(owner, { at, ok: false, posts: 0, error });
      await this.opts.logs?.note(owner, {
        category: 'x',
        what: what(0),
        ok: false,
        ms: performance.now() - t0,
        detail: error,
      });
      throw err;
    }
  }

  private async save(owner: string, posts: Post[]) {
    if (!posts.length) return;
    if (this.opts.archive) return this.opts.archive.push(posts);
    const v = await this.vault.for(owner);
    const stmts = await Promise.all(
      posts.map(async (p) => {
        const id = `ps_${await v.index(`post:${p.id}`)}`;
        return this.db
          .prepare('INSERT OR IGNORE INTO posts (id, owner, at, data) VALUES (?, ?, ?, ?)')
          .bind(id, v.owner, Date.parse(p.at), await v.seal(`posts:${id}`, p));
      }),
    );
    for (let i = 0; i < stmts.length; i += 50) await this.db.batch(stmts.slice(i, i + 50));
  }

  /** Removes the person's D1 posts older than 30 days. Returns a one-line report. */
  async prune(owner: string): Promise<string> {
    const v = await this.vault.for(owner);
    const r = await this.db
      .prepare('DELETE FROM posts WHERE owner = ? AND at < ?')
      .bind(v.owner, Date.now() - KEEP_MS)
      .run();
    const n = Number(r.meta?.changes ?? 0);
    return this.opts.archive
      ? `${n} removed (posts are kept in DataEdge)`
      : `${n} post${n === 1 ? '' : 's'} removed`;
  }

  /** The person's posts, newest first. */
  async list(owner: string, q: PostQuery = {}): Promise<Post[]> {
    const hours = Math.min(q.hours ?? 24, 720);
    const limit = Math.min(q.limit ?? 1000, 2000);
    const from = Date.now() - hours * 3_600_000;
    const doc = await this.integrations.xDoc(owner);
    let rows: Post[];
    if (this.opts.archive) {
      const handles = q.handle ? [q.handle.toLowerCase()] : (doc?.handles ?? []);
      if (!handles.length) return [];
      rows = await this.opts.archive.list({
        handles,
        from: new Date(from).toISOString(),
        limit: q.symbol || q.theme ? 2000 : limit,
      });
    } else {
      const v = await this.vault.for(owner);
      const { results } = await this.db
        .prepare(
          'SELECT id, data FROM posts WHERE owner = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?',
        )
        .bind(v.owner, from, 2000)
        .all<{ id: string; data: string }>();
      rows = await Promise.all(results.map((r) => v.open<Post>(`posts:${r.id}`, r.data)));
      if (q.handle) rows = rows.filter((p) => p.handle === q.handle?.toLowerCase());
    }
    const symbol = q.symbol?.toUpperCase();
    return rows
      .filter((p) => (!symbol || p.symbols.includes(symbol)) && (!q.theme || p.theme === q.theme))
      .slice(0, limit);
  }
}

export const postListShape = {
  symbol: z.string().trim().min(1).max(12).optional().describe('Only posts naming this ticker.'),
  handle: z.string().trim().min(1).max(16).optional().describe('Only this X account (no @).'),
  theme: z
    .enum(Object.keys(THEMES) as [Theme, ...Theme[]])
    .optional()
    .describe(
      `Only this macro theme: ${Object.entries(THEMES)
        .map(([k, v]) => `${k} (${v})`)
        .join(', ')}.`,
    ),
  hours: z.number().int().min(1).max(720).optional().describe('Look back this many hours (24).'),
  limit: z.number().int().min(1).max(2000).optional(),
};

type Env = { Variables: { identity?: AccessIdentity } };

/** REST under `/api/posts` (signed in): the caller's posts, newest first. */
export function postRoutes(posts: Posts) {
  const r = new Hono<Env>();
  const owner = (c: Context<Env>) => portfolioOwner(c.get('identity'));
  const query = z.object({
    symbol: postListShape.symbol,
    handle: postListShape.handle,
    theme: postListShape.theme,
    hours: z.coerce.number().int().min(1).max(720).optional(),
    limit: z.coerce.number().int().min(1).max(2000).optional(),
  });
  r.get('/', async (c) => {
    const q = query.safeParse(c.req.query());
    if (!q.success) return c.json({ error: 'invalid query' }, 400);
    return c.json({
      store: posts.store,
      kept: posts.store === 'd1' ? '30 days' : 'for good',
      posts: await posts.list(owner(c), q.data),
    });
  });
  return r;
}
