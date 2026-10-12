// Views (Bikram, 2026-10-08): one table, group and pivot engine every desk reuses over its own
// data (researchedge's explorer over ClickHouse market data, tradeedge's portfolio over D1).
// A desk produces rows of columns; these schemas say how a view shows them, and `views/shape.ts`
// in the Worker rolls them up.
import { z } from 'zod';
import { SYMBOL_FIELDS } from './symbols';
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
/** A number condition on a number field (Bikram, 2026-10-11): `value` is a number, or `a..b` for between. */
export const viewTokenOps = ['gt', 'lt', 'eq', 'between'] as const;
export type ViewTokenOp = (typeof viewTokenOps)[number];
const NUM = '-?\\d+(?:\\.\\d+)?';
const numberToken = (t: { value: string; op?: ViewTokenOp }) =>
  !t.op || new RegExp(t.op === 'between' ? `^${NUM}\\.\\.${NUM}$` : `^${NUM}$`).test(t.value);
/**
 * A filter token, `key:value` (symbol:QQQ); `not: true` excludes the value. On one key a row must
 * have one of its included values (if any) and none of its excluded ones; tokens on different keys
 * must all match. Text matches without case, a number by its value. With `op`, a number field
 * keeps the rows above (`gt`), below (`lt`), at (`eq`) or `between` the value (`a..b`, inclusive).
 */
export const viewTokenSchema = z
  .object({
    key: viewKey,
    value: z.string().trim().min(1).max(40),
    not: z.boolean().optional(),
    op: z.enum(viewTokenOps).optional(),
  })
  .refine(numberToken, 'a number condition needs a number, or a..b for between');
export type ViewToken = z.infer<typeof viewTokenSchema>;
/** Whether `n` meets a number token's condition; `eq` matches to the cent. */
export function meetsNumber(op: ViewTokenOp | undefined, value: string, n: number | null) {
  if (n === null || !Number.isFinite(n)) return false;
  const [a = Number.NaN, b = Number.NaN] = value.split('..').map(Number);
  if (op === 'gt') return n > a;
  if (op === 'lt') return n < a;
  if (op === 'between') return n >= Math.min(a, b) && n <= Math.max(a, b);
  return Math.abs(n - a) < 0.005;
}
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
/** The quick-pick icons for a view (lucide names; the shell maps them). */
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
/**
 * A view's sidebar icon (Bikram, 2026-10-12): any lucide icon name in kebab case (`viewIconNames`
 * are the quick picks; an unknown name shows the shape's icon), or one emoji.
 */
export const viewIconSchema = z.union([
  z.string().regex(/^[a-z][a-z0-9-]{0,48}$/),
  z.emoji().max(16),
]);
export type ViewIcon = z.infer<typeof viewIconSchema>;
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
  /** The sidebar icon, a lucide name or an emoji; null = the shape's icon. */
  icon: viewIconSchema.nullable().default(null),
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
          z
            .object({
              key: fieldKey,
              value: z.string().trim().min(1).max(40),
              not: z.boolean().optional(),
              op: z.enum(viewTokenOps).optional(),
            })
            .refine(numberToken, 'a number condition needs a number, or a..b for between'),
        )
        .max(MAX_FIELDS)
        .default([]),
    })
    .prefault({}),
  pivot: z
    .object({ rows: fieldKey, columns: fieldKey, value: fieldKey, agg: z.enum(viewAggs) })
    .nullable()
    .default(null),
  /** The column the table opens sorted by (Bikram, 2026-10-12, mock 2b); null keeps the rows' order. */
  sort: z
    .object({ key: fieldKey, desc: z.boolean().default(false) })
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
        'account',
        'kind',
        'quantity',
        'avg_cost',
        'cost_basis',
        'price',
        'market_value',
        'unrealized',
        'realized',
        'dividends',
        'check',
      ],
      chips: [{ key: 'kind', placement: 'column' }],
      icon: 'wallet',
      widgets: ['value', 'day_pnl', 'unrealized', 'realized_ytd', 'check'],
      group: { fields: ['account', 'tax_type', 'underlying', 'kind'], default: 'account' },
      // Open holdings first; drop the token, or add Closed, to see what was sold out this year.
      filters: {
        fields: [
          'symbol',
          'underlying',
          'kind',
          'sector',
          'basket',
          'account',
          'tax_type',
          'status',
          'dividends',
          'realized',
          'unrealized',
        ],
        default: [{ key: 'status', value: 'Open' }],
      },
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
      columns: [
        'status',
        'account',
        'source',
        'acquired',
        'closed',
        'quantity',
        'cost',
        'sell_price',
        'cost_basis',
        'proceeds',
        'gain',
        'term',
      ],
      chips: [{ key: 'status', placement: 'column' }],
      icon: 'layers',
      widgets: ['realized_ytd', 'realized_all'],
      group: {
        fields: ['underlying', 'account', 'source', 'term', 'year'],
        default: 'underlying',
      },
      filters: {
        fields: ['status', 'source', 'account', 'underlying', 'term', 'year'],
        default: [],
      },
    }),
  },
  {
    id: 'my-symbols',
    app: true,
    desk: 'trade',
    domain: 'symbols',
    owner: null,
    name: 'My symbols',
    config: customViewConfigSchema.parse({
      shape: 'table',
      columns: [
        'symbol',
        'industry',
        'market_cap',
        'pe_ttm',
        'div_yield',
        'earnings_next',
        'market_value',
        'accounts',
      ],
      icon: 'target',
      group: { fields: ['in', 'industry'], default: null },
      filters: {
        fields: ['in', 'symbol', 'industry', 'pe_ttm', 'buy_pct', 'market_cap'],
        default: [
          { key: 'in', value: 'Holdings' },
          { key: 'in', value: 'Watchlist' },
        ],
      },
      sort: { key: 'market_value', desc: true },
    }),
  },
  {
    id: 'accounts',
    app: true,
    desk: 'trade',
    domain: 'accounts',
    owner: null,
    name: 'Accounts',
    config: customViewConfigSchema.parse({
      shape: 'group',
      columns: [
        'account',
        'brokerage',
        'tax_type',
        'trading',
        'holdings',
        'cash',
        'market_value',
        'unrealized',
        'realized_ytd',
      ],
      chips: [{ key: 'tax_type', placement: 'column' }],
      icon: 'landmark',
      group: { fields: ['brokerage', 'tax_type', 'source', 'trading'], default: null },
      filters: { fields: ['brokerage', 'tax_type', 'source', 'trading'], default: [] },
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
const SYMBOL_KEYS = SYMBOL_FIELDS.map((f) => f.key);
const SYMBOL_CATEGORIES = SYMBOL_FIELDS.filter((f) => f.category).map((f) => f.key);
const SYMBOL_NUMBERS = SYMBOL_FIELDS.filter((f) => f.format !== 'text').map((f) => f.key);
/** Account fields a row looks up by its account (`account` and `tax_type` are listed by each domain). */
const ACCOUNT_LOOKUPS = ['brokerage', 'trading', 'cash'];
const ACCOUNT_GROUPS = ['brokerage', 'trading'];

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
      'realized',
      'realized_year',
      'dividends',
      'dividends_year',
      'status',
      'pct_of_group',
      'pct_of_total',
      'sector',
      'basket',
      'account',
      'tax_type',
      ...ACCOUNT_LOOKUPS,
      'check',
      ...SYMBOL_KEYS,
    ],
    group: [
      'underlying',
      'kind',
      'expiration',
      'sector',
      'basket',
      'account',
      'tax_type',
      'status',
      ...ACCOUNT_GROUPS,
      ...SYMBOL_CATEGORIES,
    ],
    filter: [
      'symbol',
      'underlying',
      'kind',
      'sector',
      'basket',
      'account',
      'tax_type',
      'status',
      'dividends',
      'dividends_year',
      'realized',
      'realized_year',
      'unrealized',
      'market_value',
      'cost_basis',
      ...ACCOUNT_GROUPS,
      ...SYMBOL_CATEGORIES,
      ...SYMBOL_NUMBERS,
    ],
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
      'tax_type',
      ...ACCOUNT_LOOKUPS,
      'source_id',
      ...SYMBOL_KEYS,
    ],
    group: ['action', 'underlying', 'account', 'tax_type', ...ACCOUNT_GROUPS, ...SYMBOL_CATEGORIES],
    filter: [
      'action',
      'instrument',
      'underlying',
      'account',
      'tax_type',
      ...ACCOUNT_GROUPS,
      ...SYMBOL_CATEGORIES,
    ],
  },
  tax_lots: {
    columns: [
      'symbol',
      'underlying',
      'status',
      'acquired',
      'closed',
      'year',
      'quantity',
      'cost',
      'sell_price',
      'cost_basis',
      'proceeds',
      'gain',
      'gain_pct',
      'term',
      'source',
      'account',
      'tax_type',
      ...ACCOUNT_LOOKUPS,
      ...SYMBOL_KEYS,
    ],
    group: [
      'underlying',
      'status',
      'year',
      'source',
      'term',
      'account',
      'tax_type',
      ...ACCOUNT_GROUPS,
      ...SYMBOL_CATEGORIES,
    ],
    filter: [
      'symbol',
      'underlying',
      'status',
      'year',
      'source',
      'term',
      'account',
      'tax_type',
      ...ACCOUNT_GROUPS,
      ...SYMBOL_CATEGORIES,
    ],
    widgets: ['realized_ytd', 'realized_all'],
  },
  // One row per symbol you hold or watch, or in the DataEdge list (`in`): saved views are stock
  // screens (Bikram, 2026-10-12).
  symbols: {
    columns: ['symbol', 'in', 'price', 'quantity', 'market_value', 'accounts', ...SYMBOL_KEYS],
    group: ['in', ...SYMBOL_CATEGORIES],
    filter: ['in', 'symbol', ...SYMBOL_CATEGORIES, ...SYMBOL_NUMBERS, 'market_value'],
  },
  accounts: {
    columns: [
      'account',
      'brokerage',
      'tax_type',
      'source',
      'trading',
      'holdings',
      'cash',
      'cost_basis',
      'market_value',
      'unrealized',
      'realized_ytd',
      'as_of',
    ],
    group: ['brokerage', 'tax_type', 'source', 'trading'],
    filter: ['account', 'brokerage', 'tax_type', 'source', 'trading', 'cash', 'market_value'],
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
