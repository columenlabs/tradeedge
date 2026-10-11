/**
 * Machine-readable descriptions generated from the operation registry, so they
 * can't drift from the MCP tools / REST routes:
 *   /api/openapi.json  OpenAPI 3.1
 *   /llms.txt          agent-oriented overview (llmstxt.org format)
 */
import { z } from 'zod';
import { OPERATIONS, type Operation, SERVER_INSTRUCTIONS } from './operations';

const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z_]+)/g, '{$1}');

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return rest;
}

function operationObject(op: Operation) {
  const shape = op.input;
  const pathParams = op.pathParams.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: jsonSchema(shape[name] as z.ZodType),
  }));
  const base = {
    operationId: op.id,
    summary: op.title,
    description: `${op.description}\n\nSame as MCP tool \`${op.id}\`.`,
    tags: [
      op.id.startsWith('screener_') || op.id.startsWith('trade_') ? 'strategies' : 'market data',
    ],
    responses: {
      '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
      '400': { $ref: '#/components/responses/BadRequest' },
      '401': { $ref: '#/components/responses/Unauthorized' },
      '429': { $ref: '#/components/responses/RateLimited' },
    },
  };
  const rest = Object.fromEntries(
    Object.entries(shape).filter(([k]) => !op.pathParams.includes(k)),
  );
  if (op.method === 'GET') {
    const query = Object.entries(rest).map(([name, s]) => {
      const js = jsonSchema(s as z.ZodType);
      const optional = (s as z.ZodType).safeParse(undefined).success;
      return { name, in: 'query', required: !optional, schema: js, description: js.description };
    });
    return { ...base, parameters: [...pathParams, ...query] };
  }
  const { underlying: _u, ...example } = op.example;
  return {
    ...base,
    parameters: pathParams,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: jsonSchema(z.object(rest)), example } },
    },
  };
}

export function buildOpenApi(origin: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const p = toOpenApiPath(op.path);
    paths[p] = { ...paths[p], [op.method.toLowerCase()]: operationObject(op) };
  }
  paths['/options/{underlying}/stream'] = {
    get: {
      operationId: 'options_chain_stream',
      summary: 'Live option chain stream (SSE)',
      description:
        'Server-sent events: an `event: chain` with the full OptionChain every `interval` seconds (2–60, default 3). ' +
        'Same selection params as options_chain except near_money_pct (always the whole chain). REST only.',
      tags: ['market data'],
      parameters: [
        { name: 'underlying', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'expiration', in: 'query', schema: { type: 'integer' } },
        { name: 'min_dte', in: 'query', schema: { type: 'integer' } },
        { name: 'type', in: 'query', schema: { type: 'string', enum: ['call', 'put'] } },
        { name: 'strike_min', in: 'query', schema: { type: 'number' } },
        { name: 'strike_max', in: 'query', schema: { type: 'number' } },
        { name: 'interval', in: 'query', schema: { type: 'integer', minimum: 2, maximum: 60 } },
      ],
      responses: { '200': { description: 'event stream', content: { 'text/event-stream': {} } } },
    },
  };
  paths['/health'] = {
    get: {
      operationId: 'health',
      summary: 'Health',
      security: [],
      responses: { '200': { description: '{ ok, live }', content: { 'application/json': {} } } },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'EdgeDesk API',
      version: '0.3.0',
      description: `${SERVER_INSTRUCTIONS}\n\nMCP: ${origin}/mcp (Streamable HTTP). Agent guide: ${origin}/llms.txt`,
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ cloudflareAccess: [] }],
    tags: [
      { name: 'market data', description: 'Quotes, expirations, chains' },
      { name: 'strategies', description: 'Screener and trade evaluator' },
    ],
    paths,
    components: {
      securitySchemes: {
        cloudflareAccess: {
          type: 'apiKey',
          in: 'header',
          name: 'Cf-Access-Jwt-Assertion',
          description: `Cloudflare Access. Browsers: sign in at ${origin}/app (the Access cookie covers /api). CLI: \`cloudflared access curl\`. The MCP endpoint uses Access OAuth instead.`,
        },
      },
      responses: {
        BadRequest: {
          description: 'Invalid input',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                  issues: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { path: { type: 'string' }, message: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
        Unauthorized: { description: 'Not signed in (Cloudflare Access)' },
        RateLimited: { description: 'Per-identity rate limit (120/min on /api); retry after 60 s' },
      },
    },
  };
}

export function buildLlmsTxt(origin: string): string {
  const lines = [
    '# EdgeDesk',
    '',
    '> Live US equity options data and an options strategy screener, available as an MCP server and a REST API. ' +
      'Every MCP tool has an identical REST endpoint (same inputs, same validation).',
    '',
    '## Connect',
    '',
    `- [MCP server](${origin}/mcp): Streamable HTTP. Sign-in is Cloudflare Access OAuth (the client opens a browser login). ` +
      `Claude: Settings → Connectors → add ${origin}/mcp. Claude Code: \`claude mcp add --transport http edgedesk ${origin}/mcp\`.`,
    `- [REST API](${origin}/api/v1): same operations. Sign in at ${origin}/app; the Access cookie covers /api. Unversioned /api/* is a permanent alias.`,
    `- [OpenAPI 3.1 spec](${origin}/api/openapi.json): machine-readable schema for every endpoint.`,
    `- [Docs](${origin}/docs/)`,
    '',
    '## Conventions',
    '',
    '- Expirations are YYYYMMDD integers; `dte` = calendar days to expiry (US/Pacific).',
    '- Prices are per share in USD; greeks are per share (×100 for one contract); iv is a decimal (0.18 = 18%).',
    '- `greeksSource`: `provider` (quoted) or `model` (implied from mid, e.g. 0DTE). Pass `min_dte: 1` to skip same-day expiries.',
    '- Screener/evaluator dollar figures are per 1 structure (options ×100); `net_premium` > 0 is a credit; null max_profit / max_loss = unlimited.',
    '- `pop` / `expected_value` are model estimates (lognormal, legs’ IV) at the front expiry.',
    '- Rate limits: 60/min on /mcp, 120/min on /api per signed-in user.',
    '',
    '## Operations (MCP tool = REST endpoint)',
    '',
  ];
  for (const op of OPERATIONS) {
    const rest = `${op.method} /api/v1${toOpenApiPath(op.path)}`;
    const params = Object.keys(op.input);
    lines.push(`- \`${op.id}\` — \`${rest}\`: ${op.description.split('\n')[0]}`);
    if (params.length) lines.push(`  - params: ${params.map((p) => `\`${p}\``).join(', ')}`);
    if (Object.keys(op.example).length)
      lines.push(`  - example: \`${JSON.stringify(op.example)}\``);
  }
  lines.push(
    '- (REST only) `GET /api/v1/options/{underlying}/stream`: Server-sent events with the live chain every few seconds.',
    '',
    '## Strategies, screeners and trades',
    '',
    'The screener builds strategies, stored in D1 and shared by every signed-in caller: `GET /api/v1/strategies` lists them with their roles and defaults, `GET|PUT|DELETE /api/v1/strategies/{id}` reads, writes or deletes one (MCP strategy_*).',
    'Leg selection per leg: `strikes` (by role) > `otm_pct` > `delta` (absolute) > strategy default. `width` = wing width in $.',
    'Your saved screeners: `GET|POST /api/v1/screeners`, `GET|PUT|DELETE /api/v1/screeners/{id}` (MCP screener_list|read|write|delete); run one with `screener_run {id}`. Your saved trades: `GET|POST /api/v1/trades`, `GET|PUT|DELETE /api/v1/trades/{id}` (MCP trade_list|read|write|delete).',
    '',
  );
  return lines.join('\n');
}
