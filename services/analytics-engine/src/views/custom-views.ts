// The REST routes and MCP tools for custom views on a desk (Bikram, 2026-10-08): any domain a desk
// shows on CustomViewPage (holdings, ...) saves its views here, one set per signed-in person.
// Explorer views are custom views too, but they go through `/api/explorer-views` and
// `explorer_view_*`, which check their formulas against ClickHouse first.
import {
  type CustomViewDesk,
  customViewConfigSchema,
  customViewDomainSchema,
  customViewFields,
  customViewIssues,
} from '@edgedesk/types/views';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AccessIdentity } from '../access';
import { CustomViewNotFound, CustomViewReadOnly, type CustomViews, customViewOwner } from './store';

/** Domains with their own routes and checks; these routes refuse them. */
const OWN_ROUTES: Record<string, string> = { explorer: '/api/explorer-views' };

const domainSchema = customViewDomainSchema.refine(
  (d) => !(d in OWN_ROUTES),
  'explorer views have their own routes (/api/explorer-views, explorer_view_*)',
);
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'view id');
const nameSchema = z.string().trim().min(1).max(80);
export const customViewWriteShape = {
  domain: domainSchema,
  id: idSchema.optional().describe('Leave out to create a view; give it to replace that view.'),
  name: nameSchema,
  config: customViewConfigSchema,
};
const writeSchema = z.object(customViewWriteShape);

const invalid = (issues: z.ZodIssue[]) => ({
  error: 'invalid input',
  issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
});

/** REST under `/api/custom-views` (signed in; `identity` is set by the `/api` middleware). */
export function customViewRoutes(views: CustomViews, desk: CustomViewDesk) {
  const r = new Hono<{ Variables: { identity?: AccessIdentity } }>();
  const owner = (c: { get(k: 'identity'): AccessIdentity | undefined }) =>
    customViewOwner(c.get('identity'));
  r.onError((err, c) => {
    if (err instanceof CustomViewNotFound) return c.json({ error: err.message }, 404);
    if (err instanceof CustomViewReadOnly) return c.json({ error: err.message }, 403);
    throw err;
  });

  r.get('/', async (c) => {
    const domain = domainSchema.safeParse(c.req.query('domain'));
    if (!domain.success) return c.json(invalid(domain.error.issues), 400);
    return c.json({ custom_views: await views.list(domain.data, owner(c)) });
  });
  r.get('/:domain/:id', async (c) => {
    const domain = domainSchema.safeParse(c.req.param('domain'));
    if (!domain.success) return c.json(invalid(domain.error.issues), 400);
    const view = await views.read(domain.data, c.req.param('id'), owner(c));
    if (!view) throw new CustomViewNotFound(domain.data, c.req.param('id'));
    return c.json(view);
  });
  r.post('/', async (c) => {
    const body = writeSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    const { domain, id, name, config } = body.data;
    const who = owner(c);
    const issues = customViewIssues(domain, config);
    if (issues.length)
      return c.json(
        { error: 'invalid input', issues: issues.map((message) => ({ path: 'config', message })) },
        400,
      );
    const view = id
      ? await views.update(domain, id, who, { name, config })
      : await views.create({ desk, domain, owner: who, name, config });
    return c.json(view, id ? 200 : 201);
  });
  r.delete('/:domain/:id', async (c) => {
    const domain = domainSchema.safeParse(c.req.param('domain'));
    if (!domain.success) return c.json(invalid(domain.error.issues), 400);
    await views.delete(domain.data, c.req.param('id'), owner(c));
    return c.json({ deleted: c.req.param('id') });
  });
  return r;
}

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });

const fieldKeysDoc = Object.entries(customViewFields)
  .map(
    ([domain, f]) =>
      `${domain}: columns ${f.columns.join(', ')}; group ${f.group.join(', ')}; filter ` +
      `${f.filter.join(', ')}${f.widgets ? `; widgets ${f.widgets.join(', ')}` : ''}`,
  )
  .join('. ');

const WRITE_DOC = [
  'Create a view (no id) or replace one of yours (id): the same settings the Edit view dialog',
  'changes. Use it to give a person a table they keep coming back to (options only, grouped by',
  'basket, a weight column). App views are read-only: custom_view_read one, change its config and',
  'write it without an id. config parts, each with what it does, when to use it and an example:',
  'shape: table (flat rows), group (rows folded under group headers with roll-ups) or pivot (a',
  'cross-tab); pick group to compare buckets, pivot to see one value across two fields.',
  'columns: field and formula keys in display order, empty = every field; e.g. ["symbol",',
  '"quantity", "market_value", "weight"]. chips: text fields drawn as badges, [{key, placement}];',
  'placement "column" keeps the field in its own column, "inline" puts the badge on the first column',
  '(the Symbol) and drops its column; use inline for short tags like kind or basket, e.g.',
  '[{"key": "kind", "placement": "inline"}]. group {fields, default}: the fields a person may',
  'group by, and the one the view opens grouped by (null = flat), e.g. {"fields": ["basket",',
  '"sector"], "default": "basket"}; a group row spans the leading columns that have no roll-up.',
  'filters {fields, default: [{key, value, not?}]}: the fields offered as filters and the tokens',
  'the view opens with, e.g. {"fields": ["kind"], "default": [{"key": "kind", "value": "Option"}]}',
  'for an options-only view. pivot {rows, columns, value, agg} or null: for shape pivot, e.g.',
  '{"rows": "basket", "columns": "kind", "value": "market_value", "agg": "sum"}. icon: sidebar icon',
  'name or null. widgets: the domain’s built-in summary widget keys in order (empty hides them).',
  'Holdings unrealized_pct is unrealized ÷ |cost basis| × 100, worked out over the group on group rows;',
  'pct_of_group is each row’s share of its group’s market value, pct_of_total its share',
  'of every shown row (a group row shows its group’s share). formulas [{key, label, expr, format,',
  'agg}]: columns the view computes, listed in columns by key; use one when a number the person',
  'wants is arithmetic over existing fields. expr is Jexl over the field keys and earlier formula',
  'keys: + - * / % ^, comparisons, a ? b : c, and group_sum("key") / total_sum("key"), a field',
  'summed over the row’s group (every shown row when not grouped) / over every shown row. Example:',
  '{"key": "weight", "label": "Weight", "expr": "market_value / group_sum(\\"market_value\\") * 100",',
  '"format": "weight", "agg": "sum"}. format: number, price, percent (signed), weight (a share),',
  'signed or integer; agg rolls it up on group and Total rows (null: the same expr over each input\u2019s own roll-up; a field with none reads null; e.g. a group\u2019s unrealized / cost_basis * 100). tiles [{key, label,',
  'field, agg}]: the view’s own summary tiles after its widgets, one field or formula key rolled up',
  '(sum, mean, min, max, count, first, last) over the rows the view shows after its filters; use',
  'one for a headline number, e.g. {"key": "hedge_value", "label": "Hedge value", "field":',
  '"market_value", "agg": "sum"}; widgets follow the filters too. Field keys by domain:',
  `${fieldKeysDoc}.`,
  'Holdings sector (per ticker, set with sector_write) and basket (per holding, set with',
  'basket_write) are fields like any other: show, group, filter and chip by them, e.g. a "9-sig"',
  'view: {"shape": "group", "group": {"fields": ["basket"], "default": "basket"}, "filters":',
  '{"fields": ["basket"], "default": [{"key": "basket", "value": "9-sig"}]}}.',
].join(' ');

/** `custom_view_*` on a desk's MCP: the caller's own views, the same rules as the REST routes. */
export function registerCustomViewTools(
  server: McpServer,
  views: CustomViews,
  owner: string,
  desk: CustomViewDesk,
) {
  server.registerTool(
    'custom_view_list',
    {
      title: 'Custom views',
      description:
        'The views of one data domain (holdings, transactions, ...): how its page filters, groups, ' +
        'pivots, which columns and widgets it shows. App views (app: true) come first and are ' +
        'read-only; write a new view from one’s config to change it. The rest are your own.',
      inputSchema: { domain: domainSchema },
    },
    async ({ domain }) => json(await views.list(domain, owner)),
  );
  server.registerTool(
    'custom_view_read',
    {
      title: 'Read custom view',
      description: 'One saved view with its config.',
      inputSchema: { domain: domainSchema, id: idSchema },
    },
    async ({ domain, id }) => {
      const view = await views.read(domain, id, owner);
      if (!view) throw new CustomViewNotFound(domain, id);
      return json(view);
    },
  );
  server.registerTool(
    'custom_view_write',
    {
      title: 'Write custom view',
      description: WRITE_DOC,
      inputSchema: customViewWriteShape,
    },
    async ({ domain, id, name, config }) => {
      const issues = customViewIssues(domain, config);
      if (issues.length) throw new Error(`invalid view: ${issues.join('; ')}`);
      return json(
        id
          ? await views.update(domain, id, owner, { name, config })
          : await views.create({ desk, domain, owner, name, config }),
      );
    },
  );
  server.registerTool(
    'custom_view_delete',
    {
      title: 'Delete custom view',
      description: 'Delete one of your saved views.',
      inputSchema: { domain: domainSchema, id: idSchema },
    },
    async ({ domain, id }) => {
      await views.delete(domain, id, owner);
      return json({ ok: true });
    },
  );
}
