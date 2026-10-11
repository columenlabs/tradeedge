/**
 * Minimal ClickHouse HTTP-interface client. Web-standard `fetch` only, so it
 * runs on Workers (through a VPC service binding's `fetch`) and on Bun/Node.
 * Int64 columns arrive as JSON strings; normalizers coerce with `Number()`.
 *
 * Values never get spliced into SQL: builders emit `{name:Type}` placeholders
 * and the client sends them as `param_<name>` (server-side binding).
 */

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export interface ClickHouseConfig {
  /** Base URL of the HTTP interface. Behind a VPC service binding only the path matters. */
  url: string;
  user: string;
  password: string;
  database: string;
  /** Defaults to global `fetch`. Pass a VPC service binding's `fetch` on Workers. */
  fetch?: FetchLike;
}

export type ParamValue = string | number;

export interface Query {
  sql: string;
  params: Record<string, ParamValue>;
}

export class ClickHouseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Raw server text. Log it; never return it to API clients. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ClickHouseError';
  }
}

export class ClickHouseClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly cfg: ClickHouseConfig) {
    this.fetchImpl = cfg.fetch ?? ((input, init) => fetch(input, init));
  }

  get database(): string {
    return this.cfg.database;
  }

  /** Run a SELECT and return its rows (`FORMAT JSON` `data`). */
  async query<T = Record<string, unknown>>(q: Query): Promise<T[]> {
    // No per-query settings: a `readonly=1` profile rejects any setting change.
    // Tables are fully qualified, so no `database` param either.
    const url = new URL(this.cfg.url);
    url.pathname = '/';
    for (const [k, v] of Object.entries(q.params)) url.searchParams.set(`param_${k}`, String(v));

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-clickhouse-user': this.cfg.user,
          'x-clickhouse-key': this.cfg.password,
        },
        body: `${q.sql}\nFORMAT JSON`,
      });
    } catch (err) {
      throw new ClickHouseError('history store unreachable', 503, String(err));
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ClickHouseError(`history query failed (${res.status})`, res.status, detail);
    }
    const body = (await res.json()) as { data?: T[] };
    return body.data ?? [];
  }

  /**
   * Insert rows into a fixed, fully qualified table (`FORMAT JSONEachRow`). `table` must be a
   * constant in code, never client input. Settings (async insert) live in the login's profile.
   */
  async insert(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`bad table ${table}`);
    if (!rows.length) return;
    const url = new URL(this.cfg.url);
    url.pathname = '/';
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-clickhouse-user': this.cfg.user,
          'x-clickhouse-key': this.cfg.password,
        },
        body: `INSERT INTO ${table} FORMAT JSONEachRow\n${rows.map((r) => JSON.stringify(r)).join('\n')}`,
      });
    } catch (err) {
      throw new ClickHouseError('history store unreachable', 503, String(err));
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ClickHouseError(`insert failed (${res.status})`, res.status, detail);
    }
  }

  /** Round-trip check. Returns latency in ms. */
  async ping(): Promise<number> {
    const t0 = Date.now();
    await this.query({ sql: 'SELECT 1 AS ok', params: {} });
    return Date.now() - t0;
  }
}
