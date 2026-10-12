import type { NewsArticle } from '@edgedesk/providers';
/**
 * Posts (Bikram, 2026-10-12): what the accounts a person tracks on X post, and the news their own
 * Alpaca key reads (Benzinga, every article), tagged with symbols, a macro theme and sentiment
 * (x.ts), for the app's Posts views, REST `/api/posts` and MCP `post_list`. Each post names its
 * `source` (X or Alpaca).
 *
 * Where posts live depends on the deployment (Bikram, 2026-10-12): with DataEdge (the EdgeDesk
 * suite) they go to its `x_posts` dataset in ClickHouse, kept for good and shared, since posts are
 * public; which accounts a person tracks stays sealed in their X integration. Without DataEdge
 * (self-host) each person's posts are rows in D1 `posts` (migration 0031), sealed, kept 30 days and
 * removed by the Prune old posts schedule.
 *
 * A check reads only posts newer than the last one: one twitterapi.io search per 20 tracked
 * accounts, on the person's own key; a news check, one Alpaca news read (more pages when busy).
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import type { Vault } from '../../vault';
import { IntegrationNotConnected, type Integrations } from './integrations';
import type { Logs } from './logs';
import { portfolioOwner } from './portfolio';
import {
  POST_SOURCES,
  type Post,
  type PostSource,
  type PostTagger,
  THEMES,
  type Theme,
  TwitterApiClient,
} from './x';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const KEEP_MS = 30 * 86_400_000;
/** A person's first check reads this far back. */
const FIRST_LOOK_S = 3600;

/** DataEdge's `x_posts` and `alpaca_news` datasets, as the suite hands them in (desks/dataedge/x-posts.ts). */
export interface PostArchive {
  push(posts: Post[]): Promise<void>;
  /**
   * Posts by `handles`, every news article when `news`, and earnings posts naming `tickers`, newest
   * first.
   */
  list(q: {
    handles: string[];
    news: boolean;
    tickers: string[];
    from: string;
    limit: number;
  }): Promise<Post[]>;
}

/** An Alpaca news article as a post; tickers come with it. */
function newsPost(a: NewsArticle): Post {
  const source = a.source.trim().toLowerCase() || 'news';
  return {
    id: `alpaca:${a.id}`,
    source: 'alpaca',
    url: a.url,
    at: new Date(a.createdAt).toISOString(),
    handle: source,
    name: a.author || source,
    text: a.headline || a.summary,
    symbols: [...new Set(a.symbols.map((s) => s.toUpperCase()))],
    theme: null,
    theme_conf: null,
    sentiment: null,
    sentiment_conf: null,
  };
}

export interface PostQuery {
  /** Only posts naming this ticker. */
  symbol?: string;
  /** Only this account (or news publisher). */
  handle?: string;
  /** Only posts from this source. */
  source?: PostSource;
  theme?: Theme;
  /** Posts from the last this many hours (default 24, at most 720). */
  hours?: number;
  limit?: number;
  /** Keep repeats as their own rows (the check's own read); by default each folds into its first post. */
  raw?: boolean;
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
      const fresh = read
        .filter((p) => !seen.has(p.id) && doc.handles.includes(p.handle))
        .map((p) => ({ ...p, source: 'x' as const }));
      const { repeats, notes } = await this.ingest(owner, fresh);
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
      const detail = report(fresh.length, repeats, notes);
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

  /**
   * Folds repeats of recent news (any source), tags the rest, copies tags onto repeats and stores
   * them all.
   */
  private async ingest(owner: string, fresh: Post[]) {
    const notes: string[] = [];
    let repeats = 0;
    const recent = fresh.length ? await this.list(owner, { hours: 2, raw: true }) : [];
    try {
      repeats = await this.tagger.markRepeats(fresh, recent);
    } catch (err) {
      notes.push(`Repeats not checked: ${(err as Error).message.slice(0, 120)}`);
    }
    // A repeat is not tagged again: it takes the tags of the post it repeats.
    notes.push(...(await this.tagger.tag(fresh.filter((p) => !p.dup_of))));
    const byId = new Map(fresh.map((p) => [p.id, p]));
    for (const p of fresh) {
      const src = p.dup_of ? (byId.get(p.dup_of) ?? recent.find((r) => r.id === p.dup_of)) : null;
      if (src) {
        if ((p.source ?? 'x') === 'x') p.symbols = src.symbols;
        p.theme = src.theme;
        p.theme_conf = src.theme_conf;
        p.sentiment = src.sentiment;
        p.sentiment_conf = src.sentiment_conf;
      }
    }
    await this.save(owner, fresh);
    return { repeats, notes };
  }

  /** Stores posts made elsewhere (earnings.ts): repeats folded, tagged, saved. */
  async add(owner: string, posts: Post[]) {
    return this.ingest(owner, posts);
  }

  /**
   * Reads new news articles with the person's own Alpaca key, tags and stores them, and logs it
   * (category News). `why` names what started it. Returns a one-line report.
   */
  async checkNews(owner: string, why: string): Promise<string> {
    const doc = await this.integrations.alpacaDoc(owner);
    if (!doc)
      throw new IntegrationNotConnected('Alpaca is not connected: add your key in Integrations.');
    const at = new Date().toISOString();
    const t0 = performance.now();
    const since = doc.news_since ?? new Date(Date.now() - FIRST_LOOK_S * 1000).toISOString();
    const what = (n: number) => `Check news (${why})${n ? `: ${n} articles read` : ''}`;
    try {
      const seen = new Set(doc.news_ids ?? []);
      const read = await this.integrations.alpacaClient(doc).getNews({ start: since });
      const fresh = read.map(newsPost).filter((p) => !seen.has(p.id));
      const { repeats, notes } = await this.ingest(owner, fresh);
      const newest = fresh.length ? (fresh[fresh.length - 1]?.at ?? since) : since;
      const ids = fresh.filter((p) => p.at === newest).map((p) => p.id);
      await this.integrations.newsChecked(
        owner,
        { at, ok: true, posts: fresh.length, error: null },
        { news_since: newest, news_ids: newest === since ? [...seen, ...ids] : ids },
      );
      const detail = report(fresh.length, repeats, notes);
      await this.opts.logs?.note(owner, {
        category: 'news',
        what: what(read.length),
        ok: true,
        ms: performance.now() - t0,
        detail,
      });
      return detail;
    } catch (err) {
      const error = (err as Error).message.slice(0, 300);
      await this.integrations.newsChecked(owner, { at, ok: false, posts: 0, error });
      await this.opts.logs?.note(owner, {
        category: 'news',
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
    let rows: Post[];
    if (this.opts.archive) {
      const [doc, alpaca, earnings] = await Promise.all([
        this.integrations.xDoc(owner),
        this.integrations.alpacaDoc(owner),
        this.integrations.earningsDoc(owner),
      ]);
      const only = (s: PostSource) => !q.source || q.source === s;
      const handles = !only('x') ? [] : q.handle ? [q.handle.toLowerCase()] : (doc?.handles ?? []);
      const news = !!alpaca && only('alpaca');
      const tickers = only('sec')
        ? [
            ...new Set([
              ...(earnings?.calendar ?? []).map((e) => e.symbol),
              ...(earnings?.reported ?? []).map((r) => r.symbol),
            ]),
          ]
        : [];
      if (!handles.length && !news && !tickers.length) return [];
      rows = await this.opts.archive.list({
        handles,
        news,
        tickers,
        from: new Date(from).toISOString(),
        limit: q.symbol || q.theme || q.handle ? 2000 : limit,
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
    }
    rows = rows.map((p) => (p.source ? p : { ...p, source: 'x' }));
    if (q.handle) rows = rows.filter((p) => p.handle === q.handle?.toLowerCase());
    if (q.source) rows = rows.filter((p) => p.source === q.source);
    if (!q.raw) {
      // The same news posted again reads as one post: the first, with the others in `repeats`.
      const ids = new Map(rows.map((p) => [p.id, p]));
      rows = rows.filter((p) => {
        const first = p.dup_of ? ids.get(p.dup_of) : undefined;
        if (!first) return true;
        first.repeats = [p, ...(first.repeats ?? [])];
        return false;
      });
    }
    const symbol = q.symbol?.toUpperCase();
    return rows
      .filter((p) => (!symbol || p.symbols.includes(symbol)) && (!q.theme || p.theme === q.theme))
      .slice(0, limit);
  }
}

const report = (n: number, repeats: number, notes: string[]) => {
  const r = `${n} new post${n === 1 ? '' : 's'}${repeats ? `, ${repeats} repeat${repeats === 1 ? '' : 's'}` : ''}`;
  return notes.length ? `${r} · ${notes.join(' · ')}` : r;
};

export const postListShape = {
  symbol: z.string().trim().min(1).max(12).optional().describe('Only posts naming this ticker.'),
  handle: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .optional()
    .describe('Only this X account (no @) or news publisher (benzinga).'),
  source: z
    .enum(Object.keys(POST_SOURCES) as [PostSource, ...PostSource[]])
    .optional()
    .describe(
      'Only posts from this source: x (tracked X accounts), alpaca (news) or sec (earnings).',
    ),
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
    source: postListShape.source,
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
