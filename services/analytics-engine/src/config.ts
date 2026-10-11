import { envAlpacaConfig } from '@edgedesk/providers';
import type { FeedbackConfig } from './feedback';

export interface Config {
  port: number;
  env: string;
  /** The edgedesk.app origin: the suite landing page and the waitlist (`/api/public/*`) only. */
  publicOrigin: string;
  /** Hostname the tradeedge answers on (default `trade.<PUBLIC_ORIGIN host>`): `/app`, `/docs`, `/api`, `/mcp`. */
  tradeedgeHost: string;
  /** Built tradeedge SPA for `/app` (apps/tradeedge/dist). */
  appDist: string | null;
  /** Built landing site for `/` (apps/landing/dist). */
  landingDist: string | null;
  /** Built docs for `/docs` (apps/docs/dist). */
  docsDist: string | null;
  /** Built dataedge SPA, served at the root of the dataedge host (apps/dataedge/dist). */
  dataedgeDist: string | null;
  /** Hostname the dataedge desk answers on (default `data.<PUBLIC_ORIGIN host>`). */
  dataedgeHost: string;
  /** Built researchedge SPA, served at the root of the researchedge host (apps/researchedge/dist). */
  researchedgeDist: string | null;
  /** Hostname the researchedge desk answers on (default `research.<PUBLIC_ORIGIN host>`). */
  researchedgeHost: string;
  /** Researchedge roles: owner emails and the one dev service token. */
  researchedge: {
    owners: string;
    /** The one dev service token (cloud test sessions): acts as the owner. */
    devTokens: string;
    teamDomain?: string;
    aud?: string;
    /** Local dev and e2e only: a JWKS JSON standing in for the team's certs (used when no team domain is set). */
    jwks?: string;
    /** Local dev and e2e only: ClickHouse over plain HTTP (a fake) instead of the VPC binding. */
    clickhouseUrl?: string;
    /** Local dev and e2e only: a runner HTTP base URL used instead of the `RUNNER` binding. */
    runnerUrl?: string;
    /** The researchedge GitHub App (8f). `key` is a Secrets Store secret; the URLs are e2e fakes. */
    github: { appId?: string; slug?: string; key?: string; apiUrl?: string; webUrl?: string };
  };
  /** If set, `/mcp` requires `Authorization: Bearer <token>` (local/dev only). */
  mcpToken: string | null;
  /** If set, `/mcp` requires a valid Cloudflare Access JWT for this app. */
  access: { teamDomain: string; aud: string } | null;
  /** If set, `/api/*` (except /api/health) requires a valid Access JWT for the "EdgeDesk App" app. */
  apiAccess: { teamDomain: string; aud: string } | null;
  liveCacheTtlMs: number;
  live: ReturnType<typeof envAlpacaConfig>;
  /**
   * Read-only ClickHouse credentials for history. `url` is for local dev; on the
   * Worker the `CLICKHOUSE` VPC service binding supplies the route instead.
   */
  clickhouse: { url: string | null; user: string; password: string; database: string } | null;
  /** Dagster base URL for local dev (the Worker uses the `DAGSTER` VPC binding); null = off. */
  dagsterUrl: string | null;
  /** Agent feedback as GitHub issues (`src/feedback.ts`); null = the feedback tools and hook are off. */
  feedback: FeedbackConfig | null;
  /** Master key that seals every person's rows (src/vault.ts): Secrets Store EDGEDESK_VAULT_KEK. */
  vaultKek: string | null;
  /** Insert-only ClickHouse login for pushed datasets (`edgedesk_push`); null = pushes answer 503. */
  clickhousePush: { user: string; password: string } | null;
  /**
   * Dataset pushers: Access service-token client ID → pusher name. A pusher may use only
   * `/api/admin/datasets*`, and write only datasets it owns (owner = its name).
   */
  datasetPushers: Record<string, string>;
  waitlist: {
    /** Turnstile secret; null = no bot check (local dev only). */
    turnstileSecret: string | null;
    /** Sender address on the onboarded Email Service domain. */
    emailFrom: string;
    /** Inbox notified of each confirmed request; null = off. */
    notify: string | null;
    /** Cloudflare API access for adding approved emails to the Access policy; null = manual. */
    access: { accountId: string; policyId: string; token: string } | null;
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: Number(env.PORT ?? env.ANALYTICS_ENGINE_PORT ?? 8080),
    env: env.EDGEDESK_ENV ?? 'dev',
    publicOrigin: env.PUBLIC_ORIGIN ?? 'https://edgedesk.app',
    tradeedgeHost:
      env.TRADEEDGE_HOST ??
      `trade.${new URL(env.PUBLIC_ORIGIN ?? 'https://edgedesk.app').hostname}`,
    appDist: env.APP_DIST ?? null,
    landingDist: env.LANDING_DIST ?? null,
    docsDist: env.DOCS_DIST ?? null,
    dataedgeDist: env.DATAEDGE_DIST ?? null,
    dataedgeHost:
      env.DATAEDGE_HOST ?? `data.${new URL(env.PUBLIC_ORIGIN ?? 'https://edgedesk.app').hostname}`,
    researchedgeDist: env.RESEARCHEDGE_DIST ?? null,
    researchedgeHost:
      env.RESEARCHEDGE_HOST ??
      `research.${new URL(env.PUBLIC_ORIGIN ?? 'https://edgedesk.app').hostname}`,
    researchedge: {
      owners: (env.RESEARCH_OWNERS ?? '').toLowerCase(),
      devTokens: env.RESEARCH_DEV_TOKENS ?? '',
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_APP_AUD,
      jwks: env.RESEARCH_ACCESS_JWKS,
      clickhouseUrl: env.RESEARCH_CLICKHOUSE_URL,
      runnerUrl: env.RESEARCH_RUNNER_URL,
      github: {
        appId: env.RESEARCH_GH_APP_ID,
        slug: env.RESEARCH_GH_APP_SLUG,
        key: env.RESEARCH_GH_APP_KEY,
        apiUrl: env.RESEARCH_GH_API_URL,
        webUrl: env.RESEARCH_GH_WEB_URL,
      },
    },
    mcpToken: env.MCP_BEARER_TOKEN || null,
    access:
      env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD
        ? { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }
        : null,
    apiAccess:
      env.ACCESS_TEAM_DOMAIN && env.ACCESS_APP_AUD
        ? { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_APP_AUD }
        : null,
    liveCacheTtlMs: Number(env.LIVE_CACHE_TTL_MS ?? 2000),
    live: envAlpacaConfig(env),
    clickhouse:
      env.CLICKHOUSE_USER && env.CLICKHOUSE_PASSWORD
        ? {
            url: env.CLICKHOUSE_URL || null,
            user: env.CLICKHOUSE_USER,
            password: env.CLICKHOUSE_PASSWORD,
            database: env.CLICKHOUSE_DATABASE ?? 'market_lab',
          }
        : null,
    dagsterUrl: env.DAGSTER_URL || null,
    vaultKek: env.VAULT_KEK || null,
    feedback:
      env.GITHUB_FEEDBACK_TOKEN && env.GITHUB_WEBHOOK_SECRET
        ? {
            repo: env.FEEDBACK_REPO ?? 'columenlabs/edgedesk',
            token: env.GITHUB_FEEDBACK_TOKEN,
            webhookSecret: env.GITHUB_WEBHOOK_SECRET,
            apiUrl: env.FEEDBACK_GH_API_URL,
          }
        : null,
    clickhousePush:
      env.CLICKHOUSE_PUSH_USER && env.CLICKHOUSE_PUSH_PASSWORD
        ? { user: env.CLICKHOUSE_PUSH_USER, password: env.CLICKHOUSE_PUSH_PASSWORD }
        : null,
    datasetPushers: parsePushers(env.DATASET_PUSHERS ?? ''),
    waitlist: {
      turnstileSecret: env.TURNSTILE_SECRET || null,
      emailFrom: env.WAITLIST_EMAIL_FROM ?? 'hello@edgedesk.app',
      notify:
        env.WAITLIST_NOTIFY === 'off'
          ? null
          : env.WAITLIST_NOTIFY || env.WAITLIST_EMAIL_FROM || 'hello@edgedesk.app',
      access:
        env.CF_ACCOUNT_ID &&
        env.WAITLIST_ACCESS_POLICY_ID &&
        env.CF_ACCESS_TOKEN &&
        env.CF_ACCESS_TOKEN !== 'unset'
          ? {
              accountId: env.CF_ACCOUNT_ID,
              policyId: env.WAITLIST_ACCESS_POLICY_ID,
              token: env.CF_ACCESS_TOKEN,
            }
          : null,
    },
  };
}

/** `clientId=name,clientId=name` → map. Names are lowercase `[a-z0-9_-]`; bad entries are dropped. */
function parsePushers(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const [id, name] = entry.split('=').map((s) => s?.trim() ?? '');
    if (id && name && /^[a-z0-9_-]{1,32}$/.test(name)) out[id] = name;
  }
  return out;
}
