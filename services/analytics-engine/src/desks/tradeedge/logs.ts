/**
 * Logs (Bikram, 2026-10-11): each person's TradeEdge activity, shown on the app's Logs page
 * (`/app/logs`). D1 `logs` (migration 0030), one sealed row per event; only the owner and the time
 * stay plain. Rows are kept 30 days, pruned as new ones land.
 *
 *   snaptrade  syncs, webhook events, key changes
 *   mcp        each MCP tool call: the tool, its outcome and time, never its arguments or results
 *   user       the person's own changes from the app or REST (writes only)
 *   backend    work that failed on the server (5xx) while serving the person
 */
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../../access';
import type { D1Like } from '../../d1';
import type { Vault } from '../../vault';
import { portfolioOwner } from './portfolio';

export const LOG_CATEGORIES = ['snaptrade', 'mcp', 'user', 'backend'] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

export interface LogEvent {
  category: LogCategory;
  /** One line: what happened. */
  what: string;
  ok: boolean;
  ms?: number;
  /** The error or a short report, when there is one. */
  detail?: string;
}
export interface LogEntry extends LogEvent {
  id: string;
  at: string;
}

const KEEP_MS = 30 * 86_400_000;
const MAX_TEXT = 500;
const clip = (s: string | undefined) => (s && s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);
const newId = () =>
  `lg_${[...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

export class Logs {
  constructor(
    private readonly db: D1Like,
    private readonly vault: Vault,
  ) {}

  /** Stores one event for `owner` (an email, token or `u_…` id) and drops their rows past 30 days. */
  async write(owner: string, e: LogEvent): Promise<void> {
    const v = await this.vault.for(owner);
    const id = newId();
    const now = Date.now();
    const data = await v.seal(`logs:${id}`, {
      category: e.category,
      what: clip(e.what),
      ok: e.ok,
      ms: e.ms === undefined ? undefined : Math.round(e.ms),
      detail: clip(e.detail),
    });
    await this.db.batch([
      this.db
        .prepare('INSERT INTO logs (id, owner, at, data) VALUES (?, ?, ?, ?)')
        .bind(id, v.owner, now, data),
      this.db.prepare('DELETE FROM logs WHERE owner = ? AND at < ?').bind(v.owner, now - KEEP_MS),
    ]);
  }

  /** Like `write`, but never throws: a log that can't be stored must not fail the work it records. */
  note(owner: string, e: LogEvent): Promise<void> {
    return this.write(owner, e).catch((err) => console.error('logs: write failed', err));
  }

  /** The person's newest events first, optionally before a time (paging). */
  async list(owner: string, q: { limit?: number; before?: number } = {}): Promise<LogEntry[]> {
    const v = await this.vault.for(owner);
    const { results } = await this.db
      .prepare(
        'SELECT id, at, data FROM logs WHERE owner = ? AND at < ? ORDER BY at DESC, id DESC LIMIT ?',
      )
      .bind(v.owner, q.before ?? Number.MAX_SAFE_INTEGER, Math.min(q.limit ?? 500, 1000))
      .all<{ id: string; at: number; data: string }>();
    return Promise.all(
      results.map(async (r) => ({
        id: r.id,
        at: new Date(Number(r.at)).toISOString(),
        ...(await v.open<LogEvent>(`logs:${r.id}`, r.data)),
      })),
    );
  }
}

type Env = { Variables: { identity?: AccessIdentity } };

/** Runs `p` after the reply when the runtime allows it (Workers), else finishes it first (Bun). */
async function later(c: Context, p: Promise<unknown>) {
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    await p;
  }
}

/** The error text a failed response carries (`{ error }`), which the caller already sees. */
async function errorText(res: Response): Promise<string | undefined> {
  if (!res.headers.get('content-type')?.includes('application/json')) return undefined;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : undefined;
}

/** An MCP tool call's error text, when the tool answered with `isError`. */
async function toolError(res: Response): Promise<string | undefined | false> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as {
    result?: { isError?: boolean; content?: { text?: string }[] };
    error?: { message?: string };
  } | null;
  if (body?.error) return body.error.message ?? 'error';
  if (body?.result?.isError) return body.result.content?.[0]?.text ?? 'error';
  return false;
}

/**
 * Records the person's MCP tool calls, their writes from the app or REST, and server failures.
 * Mounted ahead of TradeEdge's own routes only, so other desks' traffic never lands here.
 */
export function logRequests(logs: Logs): MiddlewareHandler<Env> {
  return async (c, next) => {
    const path = c.req.path;
    const isMcp = path === '/mcp' || path === '/mcp/';
    const isApi = path.startsWith('/api/') && !path.startsWith('/api/public/');
    if (!isMcp && !isApi) return next();
    const t0 = performance.now();
    // The MCP body names the tool; read it before the transport consumes the request.
    const rpc = isMcp
      ? ((await c.req.raw
          .clone()
          .json()
          .catch(() => null)) as { method?: string; params?: { name?: unknown } } | null)
      : null;
    await next();
    const identity = c.get('identity');
    if (!identity && c.res.status === 401) return;
    const owner = portfolioOwner(identity);
    const ms = performance.now() - t0;
    const status = c.res.status;
    let event: LogEvent | null = null;
    if (status >= 500) {
      event = {
        category: 'backend',
        what: `${c.req.method} ${path}`,
        ok: false,
        ms,
        detail: (await errorText(c.res)) ?? `HTTP ${status}`,
      };
    } else if (isMcp && rpc && !Array.isArray(rpc) && rpc.method === 'tools/call') {
      const err =
        status >= 400 ? ((await errorText(c.res)) ?? `HTTP ${status}`) : await toolError(c.res);
      event = {
        category: 'mcp',
        what: String(rpc.params?.name ?? 'unknown tool').slice(0, 80),
        ok: err === false,
        ms,
        detail: err === false ? undefined : err,
      };
    } else if (isApi && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const err = status >= 400 ? ((await errorText(c.res)) ?? `HTTP ${status}`) : undefined;
      event = {
        category: 'user',
        what: `${c.req.method} ${path}`,
        ok: status < 400,
        ms,
        detail: err,
      };
    }
    if (event) await later(c, logs.note(owner, event));
  };
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  before: z.coerce.number().int().positive().optional(),
});

/** REST under `/api/logs` (signed in): the caller's own events, newest first. */
export function logRoutes(logs: Logs) {
  const r = new Hono<Env>();
  r.get('/', async (c) => {
    const q = listQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: 'invalid query' }, 400);
    return c.json({ logs: await logs.list(portfolioOwner(c.get('identity')), q.data) });
  });
  return r;
}
