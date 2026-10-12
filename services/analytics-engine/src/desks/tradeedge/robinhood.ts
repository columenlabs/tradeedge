/**
 * Robinhood's agentic-trading MCP (Bikram, 2026-10-12): TradeEdge signs in once per person with OAuth
 * and then calls Robinhood's tools like an API, so code (the runner, autopilot) can use it without
 * Claude in the loop. Trades are possible only in the person's one Agentic account; every other
 * Robinhood account is read-only to it.
 *
 * OAuth as Robinhood publishes it (`agent.robinhood.com/.well-known/oauth-authorization-server`):
 * dynamic client registration (no app to apply for), a public client with PKCE S256, refresh tokens.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const ROBINHOOD = {
  issuer: 'https://agent.robinhood.com/mcp/trading',
  resource: 'https://agent.robinhood.com/mcp/trading',
  authorize: 'https://robinhood.com/oauth',
  token: 'https://api.robinhood.com/oauth2/token/',
  register: 'https://agent.robinhood.com/oauth/trading/register',
  scope: 'internal',
  /**
   * Robinhood returns a sign-in only to platforms it lists and to localhost (Bikram, 2026-10-12: its
   * error page after consent for trade.edgedesk.app). Nothing listens here: the browser shows "can't
   * connect" and the person pastes that address into TradeEdge, which finishes the sign-in.
   */
  redirect: 'http://localhost:8765/tradeedge/robinhood',
} as const;

export class RobinhoodError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RobinhoodTokens {
  access_token: string;
  refresh_token: string | null;
  /** ISO time the access token stops working. */
  expires_at: string;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

/** PKCE S256 challenge of a verifier. */
export async function pkceChallenge(verifier: string) {
  return b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
}

async function fail(res: Response, what: string): Promise<never> {
  const body = (await res.text().catch(() => '')).slice(0, 200);
  throw new RobinhoodError(res.status, `Robinhood ${what} ${res.status}${body ? `: ${body}` : ''}`);
}

/** Registers TradeEdge as an OAuth client for this redirect; returns its client id. */
export async function registerClient(redirectUri: string, f: FetchFn = fetch) {
  const res = await f(ROBINHOOD.register, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'TradeEdge',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) await fail(res, 'client registration');
  const { client_id } = (await res.json()) as { client_id?: string };
  if (!client_id) throw new RobinhoodError(502, 'Robinhood returned no client id');
  return client_id;
}

export async function authorizeUrl(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  verifier: string;
}) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: await pkceChallenge(p.verifier),
    code_challenge_method: 'S256',
    state: p.state,
    scope: ROBINHOOD.scope,
    resource: ROBINHOOD.resource,
  });
  return `${ROBINHOOD.authorize}?${q}`;
}

/** The token endpoint, for a code (`authorization_code`) or a refresh token. */
export async function requestTokens(
  grant:
    | {
        grant_type: 'authorization_code';
        code: string;
        code_verifier: string;
        redirect_uri: string;
      }
    | { grant_type: 'refresh_token'; refresh_token: string },
  clientId: string,
  f: FetchFn = fetch,
): Promise<RobinhoodTokens> {
  const res = await f(ROBINHOOD.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...grant, client_id: clientId, resource: ROBINHOOD.resource }),
  });
  if (!res.ok) await fail(res, 'sign-in');
  const t = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!t.access_token) throw new RobinhoodError(502, 'Robinhood returned no access token');
  return {
    access_token: t.access_token,
    refresh_token:
      t.refresh_token ?? (grant.grant_type === 'refresh_token' ? grant.refresh_token : null),
    expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
  };
}

/** Calls Robinhood MCP tools with one access token; each result's text is parsed as JSON when it can be. */
export async function callTools<T extends unknown[]>(
  accessToken: string,
  calls: { [K in keyof T]: { name: string; arguments?: Record<string, unknown> } },
  f: FetchFn = fetch,
): Promise<T> {
  const client = new Client({ name: 'TradeEdge', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(ROBINHOOD.resource), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: (url, init) => f(String(url), init),
  });
  try {
    await client.connect(transport);
    const out: unknown[] = [];
    for (const call of calls) {
      const r = await client.callTool(call);
      const text = (r.content as { type: string; text?: string }[] | undefined)
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      if (r.isError) throw new RobinhoodError(502, `Robinhood ${call.name}: ${text ?? 'failed'}`);
      try {
        out.push(r.structuredContent ?? JSON.parse(text ?? 'null'));
      } catch {
        out.push(text);
      }
    }
    return out as T;
  } catch (err) {
    if (err instanceof RobinhoodError) throw err;
    const msg = (err as Error).message ?? String(err);
    throw new RobinhoodError(/401|unauthori[sz]ed/i.test(msg) ? 401 : 502, `Robinhood: ${msg}`);
  } finally {
    await client.close().catch(() => {});
  }
}
