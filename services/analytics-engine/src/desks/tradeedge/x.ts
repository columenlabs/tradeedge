/**
 * X posts (Bikram, 2026-10-12): the twitterapi.io client each person's own key calls, and the tags
 * every post gets, both on Workers AI (its free daily allowance): symbols from a small chat model,
 * sentiment and the macro theme from Clef-flash, Cloudflare's System One decision model, each with
 * its confidence (Bikram, 2026-10-12: Clef over TypeSafe's Jev, no key to keep).
 *
 * twitterapi.io: https://docs.twitterapi.io. One advanced search reads every tracked account at once
 * (`from:a OR from:b since_time:…`); `/oapi/my/info` reads the key's credit (100,000 credits = $1).
 */

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const TWITTERAPI = 'https://api.twitterapi.io';
/** twitterapi.io's free-tier limit is one request every 5 seconds. */
const RATE_WAIT_MS = 5_500;
/** Handles per search: a longer query risks X's query-length limit. */
const HANDLES_PER_SEARCH = 20;
/** Pages read per search and run (20 posts a page). */
const MAX_PAGES = 5;
const CREDITS_PER_USD = 100_000;

export class XError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The macro themes Clef picks from (design, 2026-10-12); `none` when a post has no macro angle. */
export const THEMES = {
  fed_rates: 'Fed and rates',
  inflation: 'Inflation',
  jobs: 'Jobs',
  earnings: 'Earnings',
  oil: 'Oil',
  crypto: 'Crypto',
  geopolitics: 'Geopolitics',
  ai_semis: 'AI and semis',
  credit: 'Credit',
} as const;
export type Theme = keyof typeof THEMES;

export interface XCredit {
  at: string;
  usd: number;
  paid: number;
  bonus: number;
}

/**
 * Where a post came from (Bikram, 2026-10-12): an X account, Alpaca's news (Benzinga), or a
 * company's earnings 8-K at the SEC (earnings.ts).
 */
export const POST_SOURCES = { x: 'X', alpaca: 'Alpaca', sec: 'SEC' } as const;
export type PostSource = keyof typeof POST_SOURCES;

/** One post as TradeEdge keeps it: an X post, or a news article. */
export interface Post {
  /** X's post id, `alpaca:<article id>` or `sec:<accession number>`. */
  id: string;
  /** Absent on posts stored before sources existed: those are X. */
  source?: PostSource;
  url: string;
  /** When it was posted, ISO. */
  at: string;
  /** The X account, without @, lowercase; for news, the publisher (`benzinga`); `sec` for a filing. */
  handle: string;
  name: string;
  text: string;
  /** Tickers the post is about (Workers AI). */
  symbols: string[];
  /** The macro theme (Clef), null when none or not tagged. */
  theme: Theme | null;
  theme_conf: number | null;
  /** −1 (very bearish) … +1 (very bullish) (Clef), null when not tagged. */
  sentiment: number | null;
  sentiment_conf: number | null;
  /** The id of the earlier post this one repeats (same news from another account), else absent. */
  dup_of?: string | null;
  /** On a read: later posts of the same news, folded into this one, oldest first. */
  repeats?: Post[];
}

interface RawTweet {
  type?: string;
  id: string;
  url?: string;
  text?: string;
  createdAt?: string;
  author?: { userName?: string; name?: string };
}

/** `elonmusk`, `@ElonMusk` or an x.com link → `elonmusk`; null when it is not a handle. */
export function normalizeHandle(s: string): string | null {
  const h = s
    .trim()
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^@/, '')
    .split(/[/?#]/)[0]
    ?.toLowerCase();
  return h && /^[a-z0-9_]{1,15}$/.test(h) ? h : null;
}

/** X escapes `&`, `<` and `>` in post text; show them as written. */
const unescapeText = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export class TwitterApiClient {
  /** Requests made, for Logs (each is billed). */
  calls = 0;

  constructor(
    private readonly key: string,
    // Wrapped: Workers throws "Illegal invocation" when fetch is called as a method.
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
  ) {}

  /**
   * One request. A 429 (free-tier keys get one request every 5 seconds) waits that out and retries,
   * at most twice.
   */
  private async get<T>(path: string): Promise<T> {
    this.calls++;
    let res = await this.fetchFn(`${TWITTERAPI}${path}`, { headers: { 'X-API-Key': this.key } });
    for (let retry = 0; res.status === 429 && retry < 2; retry++) {
      await new Promise((r) => setTimeout(r, RATE_WAIT_MS));
      res = await this.fetchFn(`${TWITTERAPI}${path}`, { headers: { 'X-API-Key': this.key } });
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const why = body?.message ?? body?.detail ?? body?.error ?? res.statusText;
      throw new XError(res.status, `twitterapi.io ${res.status}: ${String(why).slice(0, 200)}`);
    }
    return body as T;
  }

  /** The key's credit, in dollars: paid (never expires) and bonus (expires 31 days after it is granted). */
  async credit(): Promise<XCredit> {
    const r = await this.get<{ recharge_credits?: number; total_bonus_credits?: number }>(
      '/oapi/my/info',
    );
    const paid = Number(r.recharge_credits ?? 0) / CREDITS_PER_USD;
    const bonus = Number(r.total_bonus_credits ?? 0) / CREDITS_PER_USD;
    return { at: new Date().toISOString(), usd: paid + bonus, paid, bonus };
  }

  /**
   * Whether an X account exists and can be read (18 credits, about $0.0002). False for an unknown or
   * suspended account; other failures throw.
   */
  async userExists(handle: string): Promise<boolean> {
    try {
      const r = await this.get<{
        status?: string;
        data?: { userName?: string; unavailable?: boolean } | null;
      }>(`/twitter/user/info?userName=${encodeURIComponent(handle)}`);
      return r.status !== 'error' && !!r.data?.userName && !r.data.unavailable;
    } catch (err) {
      if (err instanceof XError && (err.status === 400 || err.status === 404)) return false;
      throw err;
    }
  }

  /** Posts by `handles` from `since` (unix seconds) on, oldest first, at most 100 per 20 handles. */
  async postsSince(handles: string[], since: number): Promise<Post[]> {
    const out = new Map<string, Post>();
    for (let i = 0; i < handles.length; i += HANDLES_PER_SEARCH) {
      const from = handles
        .slice(i, i + HANDLES_PER_SEARCH)
        .map((h) => `from:${h}`)
        .join(' OR ');
      const query = `(${from}) since_time:${since}`;
      let cursor = '';
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await this.get<{
          tweets?: RawTweet[];
          has_next_page?: boolean;
          next_cursor?: string;
        }>(
          `/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest&cursor=${encodeURIComponent(cursor)}`,
        );
        for (const t of r.tweets ?? []) {
          const at = Date.parse(t.createdAt ?? '');
          const handle = (t.author?.userName ?? '').toLowerCase();
          if (!t.id || Number.isNaN(at) || !handle) continue;
          out.set(t.id, {
            id: t.id,
            url: t.url ?? `https://x.com/${handle}/status/${t.id}`,
            at: new Date(at).toISOString(),
            handle,
            name: t.author?.name ?? handle,
            text: unescapeText(t.text ?? ''),
            symbols: [],
            theme: null,
            theme_conf: null,
            sentiment: null,
            sentiment_conf: null,
          });
        }
        if (!r.has_next_page || !r.next_cursor) break;
        cursor = r.next_cursor;
      }
    }
    return [...out.values()].sort((a, b) => a.at.localeCompare(b.at));
  }
}

/** The Workers AI binding (`env.AI`), as much of it as this file uses. */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

const SYMBOLS_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const DECISION_MODEL = '@cf/cloudflare/clef-flash';
const SYMBOLS_PER_CALL = 15;
const EMBED_MODEL = '@cf/baai/bge-m3';
/**
 * Cosine similarity (bge-m3) at or above which two posts may be the same news; Clef-flash then
 * decides. Tested 2026-10-12 on squawk reposts: repeats 0.80 to 0.90, but two different statements
 * by one speaker in one account's style reached 0.84, which Clef rejects.
 */
const NEAR_NEWS = 0.78;
/**
 * Clef's probability of "same news" needed to fold a post (tested 2026-10-12: repeats 0.85 to 0.96,
 * different news among the close pairs 0.55).
 */
const SAME_NEWS_P = 0.75;
/** A repeat is looked for among posts from this long before. */
const SAME_NEWS_MS = 3_600_000;
const EMBED_PER_CALL = 50;
const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;

/**
 * Tags posts in place, all on Workers AI: symbols with a chat model (one call per 15 X posts; news keeps its own),
 * sentiment and theme with Clef-flash (one call per post). Without the binding, or when a call
 * fails, the fields stay as they are; `notes` says which.
 */
export class PostTagger {
  constructor(private readonly ai: AiBinding | undefined) {}

  async tag(posts: Post[]): Promise<string[]> {
    const notes: string[] = [];
    if (!posts.length) return notes;
    if (!this.ai) return ['Workers AI not configured: posts are not tagged'];
    // News and filings come with their tickers; only X posts need them read.
    const unread = posts.filter((p) => (p.source ?? 'x') === 'x');
    for (let i = 0; i < unread.length; i += SYMBOLS_PER_CALL) {
      try {
        await this.symbols(unread.slice(i, i + SYMBOLS_PER_CALL));
      } catch (err) {
        notes.push(`Symbols: ${(err as Error).message.slice(0, 120)}`);
        break;
      }
    }
    const errors: string[] = [];
    for (let i = 0; i < posts.length; i += 4)
      await Promise.all(
        posts.slice(i, i + 4).map((p) =>
          this.decide(p).catch((err) => {
            errors.push((err as Error).message);
          }),
        ),
      );
    if (errors.length)
      notes.push(`Clef failed on ${errors.length} of ${posts.length}: ${errors[0]?.slice(0, 120)}`);
    return notes;
  }

  /**
   * Marks each new post that repeats news already in `recent` or in an earlier new post (any
   * account, the same one included, within the hour) with `dup_of`: close by meaning (Workers AI
   * embeddings), then confirmed by Clef-flash. Returns how many, or throws when a model fails.
   */
  async markRepeats(fresh: Post[], recent: Post[]): Promise<number> {
    if (!this.ai || !fresh.length) return 0;
    const earlier = recent.filter((p) => !p.dup_of);
    const all = [...earlier, ...fresh];
    const vecs: number[][] = [];
    for (let i = 0; i < all.length; i += EMBED_PER_CALL) {
      const r = (await this.ai.run(EMBED_MODEL, {
        text: all.slice(i, i + EMBED_PER_CALL).map((p) => p.text.slice(0, 2000)),
      })) as { data?: number[][] };
      if (!Array.isArray(r?.data)) throw new Error('no embeddings in the answer');
      vecs.push(...r.data);
    }
    const unit = vecs.map((v) => {
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
    const cos = (a: number[], b: number[]) => a.reduce((s, x, k) => s + x * (b[k] ?? 0), 0);
    let n = 0;
    for (const [j, p] of fresh.entries()) {
      const i = earlier.length + j;
      const at = Date.parse(p.at);
      const near: { q: Post; score: number }[] = [];
      for (let k = 0; k < i; k++) {
        const q = all[k];
        if (!q || q.dup_of) continue;
        const gap = at - Date.parse(q.at);
        if (gap < 0 || gap > SAME_NEWS_MS) continue;
        const score = cos(unit[i] ?? [], unit[k] ?? []);
        if (score >= NEAR_NEWS) near.push({ q, score });
      }
      // Closeness alone also joins two different statements by one speaker; Clef confirms.
      for (const { q } of near.sort((a, b) => b.score - a.score)) {
        if (await this.sameNews(q, p)) {
          p.dup_of = q.id;
          n++;
          break;
        }
      }
    }
    return n;
  }

  /** Clef-flash: whether two posts report the same news, not just the same topic or speaker. */
  private async sameNews(a: Post, b: Post): Promise<boolean> {
    const r = (await this.ai?.run(DECISION_MODEL, {
      model: 'clef-flash',
      state: `Post A: ${a.text.slice(0, 2000)}\nPost B: ${b.text.slice(0, 2000)}`,
      questions: {
        same: {
          type: 'choice',
          instructions:
            'Do posts A and B report the same piece of news (the same statement or event), not just the same topic or speaker?',
          criteria: { yes: 'Same news', no: 'Different news' },
        },
      },
    })) as { answers?: { same?: { probabilities?: { yes?: number } } } };
    return (r?.answers?.same?.probabilities?.yes ?? 0) >= SAME_NEWS_P;
  }

  private async symbols(batch: Post[]) {
    const r = (await this.ai?.run(SYMBOLS_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You list the US stock, ETF, index or crypto tickers each social media post is about. ' +
            'Use cashtags and company or product names (Nvidia → NVDA, the 10-year → TLT only if ' +
            'named). Use no ticker the post does not point to. Answer JSON only.',
        },
        {
          role: 'user',
          content: JSON.stringify(batch.map((p, i) => ({ i, text: p.text.slice(0, 1000) }))),
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: {
            posts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  i: { type: 'integer' },
                  symbols: { type: 'array', items: { type: 'string' } },
                },
                required: ['i', 'symbols'],
              },
            },
          },
          required: ['posts'],
        },
      },
      max_tokens: 1024,
    })) as { response?: unknown };
    const body = typeof r?.response === 'string' ? JSON.parse(r.response) : r?.response;
    const rows = (body as { posts?: { i?: number; symbols?: unknown[] }[] } | undefined)?.posts;
    if (!Array.isArray(rows)) throw new Error('no posts in the answer');
    for (const row of rows) {
      const p = typeof row.i === 'number' ? batch[row.i] : undefined;
      if (!p || !Array.isArray(row.symbols)) continue;
      p.symbols = [
        ...new Set(
          row.symbols
            .map((s) => String(s).trim().replace(/^\$/, '').toUpperCase())
            .filter((s) => TICKER.test(s)),
        ),
      ].slice(0, 10);
    }
  }

  private async decide(p: Post) {
    const r = (await this.ai?.run(DECISION_MODEL, {
      model: 'clef-flash',
      state: `Post by @${p.handle} on X:\n${p.text.slice(0, 4000)}`,
      questions: {
        sentiment: {
          type: 'score',
          instructions: 'How bullish or bearish is this post on markets or the assets it names?',
          criteria: ['Very bearish', 'Bearish', 'Neutral', 'Bullish', 'Very bullish'],
        },
        theme: {
          type: 'choice',
          instructions: 'Which macro theme is this post mainly about?',
          criteria: { ...THEMES, none: 'No macro theme' },
        },
      },
    })) as {
      answers?: {
        sentiment?: { score?: number; confidence?: number };
        theme?: { choice?: string; confidence?: number };
      };
    };
    const s = r?.answers?.sentiment;
    if (typeof s?.score === 'number') {
      p.sentiment = Math.round(((s.score - 2) / 2) * 100) / 100;
      p.sentiment_conf = s.confidence ?? null;
    }
    const t = r?.answers?.theme;
    if (t?.choice && t.choice in THEMES) {
      p.theme = t.choice as Theme;
      p.theme_conf = t.confidence ?? null;
    }
  }
}
