// Views (Bikram, 2026-10-08): one table, group and pivot engine every desk reuses over its own
// data (researchedge's explorer over ClickHouse market data, tradeedge's portfolio over D1).
// A desk produces rows of columns; these schemas say how a view shows them, and `views/shape.ts`
// in the Worker rolls them up.
import { z } from 'zod';
import { checkViewFormula } from './view-formula';

export {
  checkViewFormula,
  compileViewFormula,
  viewFormulaFunctions,
  type ViewFormulaScope,
} from './view-formula';

const viewKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'key: lowercase letters, digits and _');
const MAX_VALUES = 40;

/** How a view shows its rows; the sidebar icon follows it. */
export const viewShapes = ['table', 'group', 'pivot'] as const;
export type ViewShape = (typeof viewShapes)[number];
/** Calendar buckets a group or pivot can use besides a column's own values. */
export const viewPeriods = ['week', 'month', 'quarter', 'year', 'weekday'] as const;
export const viewAggs = ['last', 'first', 'mean', 'sum', 'min', 'max', 'count'] as const;
export type ViewAgg = (typeof viewAggs)[number];
/** A period, or the key of a column whose values make the buckets. */
const viewBucket = z.union([z.enum(viewPeriods), viewKey]);
const MAX_FIELDS = 20;
export const viewGroupSchema = z
  .object({
    /** The grouping the view opens on. */
    by: viewBucket.default('month'),
    /** The groupings a reader can switch between; empty = only `by`. */
    fields: z.array(viewBucket).max(MAX_FIELDS).default([]),
    /** Each entry is one rolled-up column; empty = `last` of every shown column. */
    values: z
      .array(z.object({ key: viewKey, agg: z.enum(viewAggs).default('last') }))
      .max(MAX_VALUES)
      .default([]),
  })
  .refine((g) => !g.fields.length || g.fields.includes(g.by), 'by is not one of fields');
export const viewPivotSchema = z.object({
  rows: viewBucket.default('year'),
  columns: viewBucket.default('month'),
  /** Null = the first shown column. */
  value: viewKey.nullable().default(null),
  agg: z.enum(viewAggs).default('mean'),
});
/**
 * A filter token, `key:value` (symbol:QQQ); `not: true` excludes the value. On one key a row must
 * have one of its included values (if any) and none of its excluded ones; tokens on different keys
 * must all match. Text matches without case, a number by its value.
 */
export const viewTokenSchema = z.object({
  key: viewKey,
  value: z.string().trim().min(1).max(40),
  not: z.boolean().optional(),
});
export type ViewToken = z.infer<typeof viewTokenSchema>;
export const viewFilterSchema = z
  .object({
    /** The columns a reader can filter on. */
    fields: z.array(viewKey).max(MAX_FIELDS).default([]),
    /** The tokens the view opens with; a read may send others. */
    default: z.array(viewTokenSchema).max(MAX_FIELDS).default([]),
  })
  .refine(
    (f) => f.default.every((t) => f.fields.includes(t.key)),
    'a default token is not on a filterable field',
  );

/** A cell: a number, text (a symbol, an account), a `span(a, b)` pair, or null for no data. */
export type ViewValue = number | string | null | [number | null, number | null];
/** `weight` is an unsigned percent (a share of a whole); `percent` is a signed change. */
export type ViewFormat = 'number' | 'price' | 'percent' | 'weight' | 'signed' | 'integer' | 'text';

/** Rows rolled up by a bucket; `days` counts the rows in each. */
export interface ViewGrouped {
  shape: 'group';
  by: string;
  values: { key: string; agg: ViewAgg; label: string; format: ViewFormat }[];
  rows: { bucket: string; days: number; values: ViewValue[] }[];
}
/** One value rolled up into a rows × columns grid; `cells[r][c]` is null where no row falls. */
export interface ViewPivoted {
  shape: 'pivot';
  rows_by: string;
  columns_by: string;
  value: { key: string; agg: ViewAgg; label: string; format: ViewFormat };
  rows: string[];
  columns: string[];
  cells: (number | null)[][];
}

const cell = (v: ViewValue) =>
  Array.isArray(v) ? v.map((x) => x ?? '').join(';') : v === null ? '' : String(v);

/** A group or pivot as CSV: a group as `bucket,days,<key>_<agg>...`, a pivot as its grid. */
export function viewShapedCsv(shaped: ViewGrouped | ViewPivoted): string {
  const lines =
    shaped.shape === 'group'
      ? [
          [shaped.by, 'days', ...shaped.values.map((v) => `${v.key}_${v.agg}`)],
          ...shaped.rows.map((r) => [r.bucket, String(r.days), ...r.values.map(cell)]),
        ]
      : [
          [`${shaped.rows_by}\\${shaped.columns_by}`, ...shaped.columns],
          ...shaped.rows.map((r, i) => [r, ...(shaped.cells[i] ?? []).map(cell)]),
        ];
  return lines.map((r) => r.join(',')).join('\n');
}

/**
 * Custom views (Bikram, 2026-10-08): a saved CustomViewPage view over one data domain, for any
 * desk. One store (D1 `custom_views`) keeps them all: owner, desk, domain, name and this config.
 * Field keys are the domain's own (`symbol`, `account`), so any short key is allowed.
 */
const fieldKey = z.string().trim().min(1).max(40);
/** Icons a person can pick for a view (lucide names; the shell maps them). */
export const viewIconNames = [
  'table',
  'list-tree',
  'grid',
  'wallet',
  'receipt',
  'briefcase',
  'landmark',
  'piggy-bank',
  'banknote',
  'coins',
  'chart-line',
  'chart-bar',
  'chart-pie',
  'trending-up',
  'trending-down',
  'target',
  'shield',
  'star',
  'zap',
  'flame',
  'calendar',
  'clock',
  'layers',
  'tag',
] as const;
export type ViewIconName = (typeof viewIconNames)[number];
/** Formats a formula column can take. */
export const viewFormulaFormats = [
  'number',
  'price',
  'percent',
  'weight',
  'signed',
  'integer',
] as const;
/**
 * A formula column (Bikram, 2026-10-09): `expr` over the domain's field keys and the view's
 * earlier formulas, with group_sum("key") and total_sum("key"); `agg` rolls it up on group and
 * Total rows (null: the same expression over each input's own roll-up, so unrealized / cost_basis
 * gives each group's own gain %; Bikram, 2026-10-09). Its key can be listed in `columns` like any field.
 */
export const viewFormulaSchema = z.object({
  key: viewKey,
  label: z.string().trim().min(1).max(40),
  expr: z.string().trim().min(1).max(400),
  format: z.enum(viewFormulaFormats).default('number'),
  agg: z.enum(viewAggs).nullable().default(null),
});
export type ViewFormula = z.infer<typeof viewFormulaSchema>;
/**
 * A view's own summary tile (Bikram, 2026-10-09): one field or formula column rolled up over the
 * rows the view shows, after its filters. Shown after the domain's widgets, in order.
 */
export const viewTileSchema = z.object({
  key: viewKey,
  label: z.string().trim().min(1).max(40),
  field: viewKey,
  agg: z.enum(viewAggs).default('sum'),
});
export type ViewTile = z.infer<typeof viewTileSchema>;
/**
 * Where a chip field shows (Bikram, 2026-10-09): `column` in its own column, `inline` on the view's
 * first column (holdings: next to the Symbol), so tags read with the row's name.
 */
export const viewChipPlacements = ['column', 'inline'] as const;
export type ViewChipPlacement = (typeof viewChipPlacements)[number];
/** A text field shown as chips; it shows only while its key is in `columns`. */
export const viewChipSchema = z.object({
  key: fieldKey,
  placement: z.enum(viewChipPlacements).default('column'),
});
export type ViewChip = z.infer<typeof viewChipSchema>;
export const customViewConfigSchema = z.object({
  shape: z.enum(viewShapes).default('table'),
  /** The view's own formula columns, in order. */
  formulas: z.array(viewFormulaSchema).max(MAX_FIELDS).default([]),
  /** Shown field keys, in order; empty means every field. */
  columns: z.array(fieldKey).max(60).default([]),
  /** Text fields shown as chips (a kind, an account, a label), each in its own column or inline. */
  chips: z.array(viewChipSchema).max(MAX_FIELDS).default([]),
  /** The sidebar icon, one of `viewIconNames`; null = the shape's icon. */
  icon: z.enum(viewIconNames).nullable().default(null),
  /** The domain's widgets (summary tiles) shown above the table, in order. */
  widgets: z.array(fieldKey).max(MAX_FIELDS).default([]),
  /** The view's own tiles, after the widgets. */
  tiles: z.array(viewTileSchema).max(8).default([]),
  /** The groupable fields the switcher offers (empty: every groupable field), and the default. */
  group: z
    .object({
      fields: z.array(fieldKey).max(MAX_FIELDS).default([]),
      default: fieldKey.nullable().default(null),
    })
    .prefault({}),
  /** Filterable fields (empty: every filterable field) and the tokens applied on open. */
  filters: z
    .object({
      fields: z.array(fieldKey).max(MAX_FIELDS).default([]),
      default: z
        .array(
          z.object({
            key: fieldKey,
            value: z.string().trim().min(1).max(40),
            not: z.boolean().optional(),
          }),
        )
        .max(MAX_FIELDS)
        .default([]),
    })
    .prefault({}),
  pivot: z
    .object({ rows: fieldKey, columns: fieldKey, value: fieldKey, agg: z.enum(viewAggs) })
    .nullable()
    .default(null),
});
/** A saved view as CustomViewPage reads it: its name plus the config. */
export type CustomViewConfig = { name: string } & z.infer<typeof customViewConfigSchema>;
/** A custom view's domain: lowercase, like `holdings` or `explorer`. */
export const customViewDomainSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'domain: lowercase letters, digits and _');
export const customViewDesks = ['data', 'research', 'trade'] as const;
export type CustomViewDesk = (typeof customViewDesks)[number];
/** One stored custom view; `owner` null means everyone on the desk shares it. */
export interface CustomView<C = z.infer<typeof customViewConfigSchema>> {
  id: string;
  /** An app view: defined in code, read-only for everyone (copy it to change it). */
  app?: boolean;
  desk: CustomViewDesk;
  domain: string;
  owner: string | null;
  name: string;
  config: C;
  created_at: string;
  updated_at: string;
}

/**
 * App views (Bikram, 2026-10-09): a desk's built-in views, defined here and read-only. They run on
 * the same CustomViewPage as saved views; `custom_view_list` lists them first with `app: true`.
 */
export const appViews: Omit<CustomView, 'created_at' | 'updated_at'>[] = [
  {
    id: 'all-accounts',
    app: true,
    desk: 'trade',
    domain: 'holdings',
    owner: null,
    name: 'All accounts',
    config: customViewConfigSchema.parse({
      shape: 'group',
      columns: [
        'symbol',
        'kind',
        'quantity',
        'avg_cost',
        'cost_basis',
        'price',
        'market_value',
        'unrealized',
        'check',
      ],
      chips: [{ key: 'kind', placement: 'column' }],
      icon: 'wallet',
      widgets: ['value', 'day_pnl', 'unrealized', 'realized_ytd', 'check'],
      group: { fields: ['account', 'tax_type', 'underlying', 'kind'], default: 'account' },
    }),
  },
  {
    id: 'transactions',
    app: true,
    desk: 'trade',
    domain: 'transactions',
    owner: null,
    name: 'Transactions',
    config: customViewConfigSchema.parse({
      shape: 'table',
      columns: [
        'date',
        'action',
        'instrument',
        'quantity',
        'price',
        'amount',
        'account',
        'source_id',
      ],
      chips: [{ key: 'action', placement: 'column' }],
      icon: 'receipt',
      group: { fields: ['account', 'action', 'underlying'], default: null },
    }),
  },
  {
    id: 'tax-lots',
    app: true,
    desk: 'trade',
    domain: 'tax_lots',
    owner: null,
    name: 'Tax lots',
    config: customViewConfigSchema.parse({
      shape: 'group',
      columns: ['account', 'source', 'acquired', 'quantity', 'cost', 'cost_basis', 'term'],
      icon: 'layers',
      group: { fields: ['underlying', 'account', 'source', 'term'], default: 'underlying' },
      filters: { fields: ['source', 'account', 'underlying', 'term'], default: [] },
    }),
  },
  {
    id: 'closed-lots',
    app: true,
    desk: 'trade',
    domain: 'closed_lots',
    owner: null,
    name: 'Closed lots',
    config: customViewConfigSchema.parse({
      shape: 'group',
      columns: ['instrument', 'acquired', 'closed', 'quantity', 'cost', 'proceeds', 'gain', 'term'],
      chips: [{ key: 'term', placement: 'column' }],
      icon: 'coins',
      widgets: ['realized_ytd', 'realized_all'],
      group: { fields: ['account', 'underlying', 'year', 'term'], default: 'year' },
      filters: { fields: ['term', 'account', 'underlying'], default: [] },
    }),
  },
  {
    id: 'logs',
    app: true,
    desk: 'trade',
    domain: 'logs',
    owner: null,
    name: 'Logs',
    config: customViewConfigSchema.parse({
      shape: 'table',
      columns: ['at', 'category', 'what', 'outcome', 'ms', 'detail'],
      chips: [{ key: 'category', placement: 'column' }],
      icon: 'clock',
      group: { fields: ['category', 'outcome', 'what'], default: null },
      filters: { fields: ['category', 'outcome', 'what'], default: [] },
    }),
  },
];
/**
 * Each domain's field keys, for agents writing views (custom_view_write's description). The desk
 * page that shows the domain defines the fields; keep this in step with it.
 */
export const customViewFields: Record<
  string,
  { columns: string[]; group: string[]; filter: string[]; widgets?: string[] }
> = {
  holdings: {
    columns: [
      'symbol',
      'underlying',
      'kind',
      'expiration',
      'strike',
      'quantity',
      'avg_cost',
      'price',
      'dte',
      'delta',
      'gamma',
      'theta',
      'vega',
      'iv',
      'cost_basis',
      'market_value',
      'unrealized',
      'unrealized_pct',
      'pct_of_group',
      'pct_of_total',
      'sector',
      'basket',
      'account',
      'tax_type',
      'check',
    ],
    group: ['underlying', 'kind', 'expiration', 'sector', 'basket', 'account', 'tax_type'],
    filter: ['symbol', 'underlying', 'kind', 'sector', 'basket', 'account', 'tax_type'],
    widgets: ['value', 'day_pnl', 'unrealized', 'realized_ytd', 'check'],
  },
  transactions: {
    columns: [
      'date',
      'action',
      'instrument',
      'underlying',
      'quantity',
      'price',
      'fees',
      'amount',
      'account',
      'source_id',
    ],
    group: ['action', 'underlying', 'account'],
    filter: ['action', 'instrument', 'underlying', 'account'],
  },
  tax_lots: {
    columns: [
      'symbol',
      'underlying',
      'acquired',
      'quantity',
      'cost',
      'cost_basis',
      'term',
      'source',
      'account',
      'tax_type',
    ],
    group: ['underlying', 'source', 'term', 'account', 'tax_type'],
    filter: ['symbol', 'underlying', 'source', 'term', 'account', 'tax_type'],
  },
  closed_lots: {
    columns: [
      'instrument',
      'underlying',
      'acquired',
      'closed',
      'year',
      'quantity',
      'cost',
      'proceeds',
      'gain',
      'gain_pct',
      'term',
      'account',
      'tax_type',
    ],
    group: ['underlying', 'year', 'term', 'account', 'tax_type'],
    filter: ['instrument', 'underlying', 'year', 'term', 'account', 'tax_type'],
    widgets: ['realized_ytd', 'realized_all'],
  },
  logs: {
    columns: ['at', 'category', 'what', 'outcome', 'ms', 'detail'],
    group: ['category', 'outcome', 'what'],
    filter: ['category', 'outcome', 'what'],
  },
};

/**
 * What is wrong with a view's formulas and tiles on `domain` ("formulas.0: ...", "tiles.0: ...");
 * empty when nothing.
 */
export function customViewIssues(
  domain: string,
  config: {
    formulas: { key: string; expr: string }[];
    tiles?: { key: string; field: string }[];
  },
): string[] {
  const own = customViewFields[domain];
  const fields = own ? own.columns : null;
  const { formulas } = config;
  const issues = formulas.flatMap((f, i) => {
    const keys = fields && [...fields, ...formulas.slice(0, i).map((x) => x.key)];
    if (fields?.includes(f.key)) return [`formulas.${i}: key ${f.key} is a field of ${domain}`];
    if (formulas.slice(0, i).some((x) => x.key === f.key))
      return [`formulas.${i}: key ${f.key} is used twice`];
    const issue = checkViewFormula(f.expr, keys);
    return issue ? [`formulas.${i}: ${issue}`] : [];
  });
  const tiles = config.tiles ?? [];
  const columns = fields && [...fields, ...formulas.map((f) => f.key)];
  return [
    ...issues,
    ...tiles.flatMap((t, i) => {
      if (own?.widgets?.includes(t.key))
        return [`tiles.${i}: key ${t.key} is a widget of ${domain}`];
      if (tiles.slice(0, i).some((x) => x.key === t.key))
        return [`tiles.${i}: key ${t.key} is used twice`];
      if (columns && !columns.includes(t.field)) return [`tiles.${i}: unknown field ${t.field}`];
      return [];
    }),
  ];
}

/** The app view with this domain and id, if any. */
export const appView = (domain: string, id: string) =>
  appViews.find((v) => v.domain === domain && v.id === id);
