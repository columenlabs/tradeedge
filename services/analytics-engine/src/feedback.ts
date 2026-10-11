/**
 * Agent feedback (Bikram, 2026-10-08): agents are team members. Through any desk's MCP they open
 * feedback, read our replies, answer back and confirm a fix (`feedback_write`, `feedback_list`,
 * `feedback_read`). Each item is a GitHub issue in `columenlabs/edgedesk` labelled `feedback`, the
 * conversation of record where Bikram and builders reply; D1 `feedback` (migration 0015) keeps the
 * owner and whether a reply waits. Ownership lives only in D1, never in issue text.
 *
 * GitHub tells us about replies and label changes through a webhook on the apex
 * (`/api/public/github-hook`, the one public route besides the waitlist, Bikram 2026-10-08): the
 * Cloudflare firewall lets only GitHub's hook IPs reach it and `hook()` checks GitHub's signature.
 * Every MCP answer then carries a footer while a reply waits (`withFeedbackFooter`).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Octokit } from '@octokit/core';
import { z } from 'zod';
import type { D1Like } from './d1';
import type { RateLimiter } from './ratelimit';

export interface FeedbackConfig {
  /** `owner/name` of the repo the issues live in. */
  repo: string;
  /** Fine-grained token: that repo only, Issues read and write. */
  token: string;
  /** The repo webhook's shared secret (GitHub signs each delivery with it). */
  webhookSecret: string;
  /** Tests only: a fake GitHub API. */
  apiUrl?: string;
}

export type Desk = 'trade' | 'data' | 'research';
export const FEEDBACK_KINDS = ['bug', 'missing', 'confusing', 'idea'] as const;
export const FEEDBACK_STATUSES = ['open', 'go', 'needs-info', 'ready-to-test', 'closed'] as const;
type Status = (typeof FEEDBACK_STATUSES)[number];

/** Opens every comment the Worker writes for an agent; the hook skips these so no one hears their own words. */
const MARKER = /^<!-- edgedesk-feedback:agent=([^ ]+) -->\n/;
const marker = (owner: string) => `<!-- edgedesk-feedback:agent=${owner} -->\n`;
const MAX_TEXT = 8000;

export class FeedbackNotFound extends Error {}

interface Row {
  number: number;
  title: string;
  desk: Desk;
  tool: string | null;
  kind: string;
  status: Status;
  unread: number;
  created_at: string;
  updated_at: string;
}

interface GhIssue {
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string | null;
  created_at: string;
  labels: ({ name?: string } | string)[];
}
interface GhComment {
  body: string | null;
  created_at: string;
}

/** The status an agent sees: closed wins, then the labels Bikram and builders set. */
export function statusOf(issue: Pick<GhIssue, 'state' | 'labels'>): Status {
  if (issue.state === 'closed') return 'closed';
  const names = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
  for (const s of ['ready-to-test', 'needs-info', 'go'] as const) if (names.includes(s)) return s;
  return 'open';
}

export class Feedback {
  private readonly octokit: Octokit;
  private readonly repo: { owner: string; repo: string };
  private readonly webhookSecret: string;

  constructor(
    private db: D1Like,
    cfg: FeedbackConfig,
    fetcher: typeof fetch = fetch,
    private limiter?: RateLimiter,
  ) {
    const [owner = '', repo = ''] = cfg.repo.split('/');
    this.repo = { owner, repo };
    this.webhookSecret = cfg.webhookSecret;
    this.octokit = new Octokit({
      auth: cfg.token,
      userAgent: 'edgedesk-feedback',
      ...(cfg.apiUrl ? { baseUrl: cfg.apiUrl } : {}),
      request: { fetch: fetcher },
    });
  }

  /** One GitHub REST call on the feedback repo. GitHub's error text can echo the request: keep only the status. */
  private async gh<T>(route: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return (await this.octokit.request(route, { ...this.repo, ...params })).data as T;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 'error';
      throw new Error(`feedback store unavailable (GitHub ${status})`);
    }
  }

  private async limited(owner: string) {
    if (!this.limiter) return;
    const { success } = await this.limiter.limit({ key: `feedback:${owner}` });
    if (!success) throw new Error('rate limited: slow down and retry in a minute');
  }

  private async own(owner: string, number: number): Promise<Row> {
    const row = await this.db
      .prepare('SELECT * FROM feedback WHERE number = ? AND owner = ?')
      .bind(number, owner)
      .first<Row>();
    if (!row) throw new FeedbackNotFound(`no feedback #${number} of yours`);
    return row;
  }

  async open(
    owner: string,
    desk: Desk,
    input: { title: string; kind: string; tool?: string; text: string },
  ) {
    await this.limited(owner);
    const about = input.tool ? `, about \`${input.tool}\`` : '';
    const issue = await this.gh<GhIssue>('POST /repos/{owner}/{repo}/issues', {
      title: `[${desk}] ${input.title}`,
      body: `${marker(owner)}**${owner} (agent) wrote** through the ${desk} MCP${about} (${input.kind}):\n\n${input.text}`,
      labels: ['feedback'],
    });
    await this.db
      .prepare(
        'INSERT INTO feedback (number, owner, desk, tool, kind, title) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(issue.number, owner, desk, input.tool ?? null, input.kind, input.title)
      .run();
    return { number: issue.number, status: 'open' as Status };
  }

  /** The owner answers on their item; `resolved` closes it (the fix works). */
  async reply(owner: string, number: number, text: string, resolved = false) {
    await this.limited(owner);
    await this.own(owner, number);
    await this.gh('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      issue_number: number,
      body: `${marker(owner)}**${owner} (agent) wrote:**\n\n${text}`,
    });
    if (resolved) {
      await this.gh('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
        issue_number: number,
        state: 'closed',
      });
    }
    const status: Status | null = resolved ? 'closed' : null;
    await this.db
      .prepare(
        `UPDATE feedback SET status = COALESCE(?, status), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE number = ? AND owner = ?`,
      )
      .bind(status, number, owner)
      .run();
    return { number, status: status ?? (await this.own(owner, number)).status };
  }

  async list(owner: string) {
    const { results } = await this.db
      .prepare(
        `SELECT number, title, desk, tool, kind, status, unread, created_at, updated_at
         FROM feedback WHERE owner = ? ORDER BY updated_at DESC LIMIT 100`,
      )
      .bind(owner)
      .all<Row>();
    return results.map((r) => ({ ...r, unread: r.unread === 1 }));
  }

  /** The whole conversation, oldest first; reading it clears the unread mark. */
  async read(owner: string, number: number) {
    const row = await this.own(owner, number);
    const [issue, comments] = await Promise.all([
      this.gh<GhIssue>('GET /repos/{owner}/{repo}/issues/{issue_number}', { issue_number: number }),
      this.gh<GhComment[]>('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        issue_number: number,
        per_page: 100,
      }),
    ]);
    const message = (body: string | null, at: string) => {
      const text = body ?? '';
      const agent = MARKER.exec(text);
      if (!agent) return { from: 'edgedesk', at, text };
      const words = text
        .slice(agent[0].length)
        .replace(/^\*\*[^\n]*\*\*[^\n]*\n\n/, '')
        .trim();
      return { from: agent[1] === owner ? 'you' : 'another agent', at, text: words };
    };
    await this.db
      .prepare('UPDATE feedback SET unread = 0 WHERE number = ? AND owner = ?')
      .bind(number, owner)
      .run();
    return {
      number,
      title: row.title,
      desk: row.desk,
      tool: row.tool,
      kind: row.kind,
      status: statusOf(issue),
      messages: [
        message(issue.body, issue.created_at),
        ...comments.map((c) => message(c.body, c.created_at)),
      ],
    };
  }

  /** One indexed count, for the reply footer. */
  async unread(owner: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT count(*) AS n FROM feedback WHERE owner = ? AND unread = 1')
      .bind(owner)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /**
   * GitHub's webhook (`issues`, `issue_comment`): a reply from anyone but the agent itself, or a
   * status change, marks the item unread for its owner. Unsigned or wrongly signed → 401.
   */
  async hook(req: Request): Promise<Response> {
    const raw = await req.text();
    if (!(await this.signed(raw, req.headers.get('x-hub-signature-256')))) {
      return Response.json({ error: 'bad signature' }, { status: 401 });
    }
    const event = req.headers.get('x-github-event');
    if (event !== 'issues' && event !== 'issue_comment') return new Response(null, { status: 204 });
    const payload = JSON.parse(raw) as {
      action: string;
      issue?: GhIssue;
      comment?: GhComment;
    };
    if (!payload.issue) return new Response(null, { status: 204 });
    const row = await this.db
      .prepare('SELECT status FROM feedback WHERE number = ?')
      .bind(payload.issue.number)
      .first<{ status: Status }>();
    if (!row) return new Response(null, { status: 204 });
    const status = statusOf(payload.issue);
    const reply =
      event === 'issue_comment' &&
      payload.action === 'created' &&
      !MARKER.test(payload.comment?.body ?? '');
    const unread = reply || status !== row.status;
    await this.db
      .prepare(
        `UPDATE feedback SET status = ?, unread = CASE WHEN ? THEN 1 ELSE unread END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE number = ?`,
      )
      .bind(status, unread ? 1 : 0, payload.issue.number)
      .run();
    return new Response(null, { status: 204 });
  }

  /** GitHub's `sha256=<hex>` HMAC of the raw body; `subtle.verify` compares in constant time. */
  private async signed(raw: string, header: string | null): Promise<boolean> {
    const hex = header?.startsWith('sha256=') ? header.slice(7) : '';
    if (!/^[0-9a-f]{64}$/.test(hex)) return false;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(this.webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const sig = Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
    return crypto.subtle.verify('HMAC', key, sig, enc.encode(raw));
  }
}

/** The owner key, the same one portfolios use: the email, else the service token's client ID. */
export function feedbackOwner(identity?: { email?: string; sub: string; serviceToken?: string }) {
  if (!identity) return 'local';
  if (identity.email) return identity.email.toLowerCase();
  return `token:${identity.serviceToken ?? identity.sub}`;
}

const text = (data: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  ...(isError ? { isError: true } : {}),
});

/** `feedback_write`, `feedback_list` and `feedback_read`, every one scoped to `owner`. */
export function registerFeedbackTools(
  server: McpServer,
  feedback: Feedback,
  owner: string,
  desk: Desk,
) {
  const guard =
    <A>(run: (a: A) => Promise<unknown>) =>
    async (a: A) => {
      try {
        return text(await run(a));
      } catch (err) {
        return text({ error: err instanceof Error ? err.message : 'failed' }, true);
      }
    };
  server.registerTool(
    'feedback_write',
    {
      title: 'Write feedback',
      description:
        'Tell the EdgeDesk team about a bug, a missing tool or field, something confusing, or an idea. ' +
        'Without number it opens a new item (title and kind required); with number it replies on one ' +
        'of yours, e.g. to answer a question or report how a fix works. resolved: true closes the item ' +
        'once a fix works for you. Replies come back through feedback_list and feedback_read.',
      inputSchema: {
        number: z.number().int().positive().optional().describe('Reply on this item of yours.'),
        title: z.string().trim().min(1).max(120).optional().describe('New item: one line.'),
        kind: z.enum(FEEDBACK_KINDS).optional().describe('New item: what kind of feedback.'),
        tool: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,63}$/)
          .optional()
          .describe('The tool it concerns, if any.'),
        text: z.string().trim().min(1).max(MAX_TEXT).describe('What happened, what you expected.'),
        resolved: z.boolean().optional().describe('Reply only: the fix works, close the item.'),
      },
    },
    guard(async (a) => {
      if (a.number !== undefined) return feedback.reply(owner, a.number, a.text, a.resolved);
      if (!a.title || !a.kind) throw new Error('a new item needs title and kind');
      return feedback.open(owner, desk, {
        title: a.title,
        kind: a.kind,
        tool: a.tool,
        text: a.text,
      });
    }),
  );
  server.registerTool(
    'feedback_list',
    {
      title: 'List feedback',
      description:
        'Your feedback items, newest activity first: number, title, status (open, go = being built, ' +
        'needs-info = we asked you something, ready-to-test = a fix is live, closed) and unread (a ' +
        'reply or status change you have not read). Check it at the start of a session.',
      inputSchema: {},
    },
    guard(() => feedback.list(owner)),
  );
  server.registerTool(
    'feedback_read',
    {
      title: 'Read feedback',
      description:
        'One of your items with the whole conversation, oldest first (from: you or edgedesk). ' +
        'Reading it marks it read.',
      inputSchema: { number: z.number().int().positive() },
    },
    guard(({ number }) => feedback.read(owner, number)),
  );
}

/**
 * Adds a one-line footer to every other tool's answer while `owner` has unread feedback. Call it
 * right after creating the server, before any tool is registered.
 */
export function withFeedbackFooter(server: McpServer, feedback: Feedback, owner: string) {
  type Cb = (...args: unknown[]) => Promise<{ content: unknown[] }>;
  const register = server.registerTool.bind(server) as (n: string, c: unknown, cb: Cb) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) =>
    register(name, config, async (...args) => {
      const result = await cb(...args);
      if (name.startsWith('feedback_')) return result;
      const n = await feedback.unread(owner).catch(() => 0);
      if (!n) return result;
      const note = `Unread feedback replies: ${n}. Call feedback_list.`;
      return { ...result, content: [...result.content, { type: 'text', text: note }] };
    });
}
