// Custom views (Bikram, 2026-10-08): any number of views on any desk, one page for all of them.
// A data domain (holdings, chains, bars, series, research results) describes its fields once in a
// `ViewDomain`; a view is a saved `CustomViewConfig` over that domain, written in the page's Edit
// dialog or by an agent through MCP. The shell owns the mechanics: token filtering, grouping one
// level deep with collapsible group rows, pivot, totals, sorting, the details drawer and editing.
// Rows are the ones the desk already loaded; everything here runs on the client.
import type { CustomViewConfig, ViewChip, ViewFormat } from '@edgedesk/types/views';
import {
  type ColumnDef,
  type PaginationState,
  type RowData,
  type SortingState,
  createPaginatedRowModel,
  createSortedRowModel,
  flexRender,
  rowPaginationFeature,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Grid3x3Icon,
  PencilIcon,
  PlusIcon,
  TableIcon,
  XIcon,
} from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useMemo, useState } from 'react';
import { DrawerSection } from './drawer-section';
import { useIsMobile } from './hooks/use-mobile';
import { cn } from './lib/utils';
import { type Crumb, Page } from './page';
import { maskAmount, useAmountsHidden } from './shell';
import { Tile } from './tile';
import { type FilterField, type FilterToken, TokenFilter, useTokenFilter } from './token-filter';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { EditCell } from './view-edit-cell';
import { ViewEditDialog, type ViewEditorSection } from './view-editor';
import {
  FORMULAS_GROUP,
  type ViewCellValue,
  type ViewDomain,
  type ViewField,
  chipsOf,
  computedOf,
  filterFieldsOf,
  groupOf,
  label,
  pick,
  rollUp,
  tilesOf,
  withFormulas,
  withSavedFilters,
} from './view-model';

export type { ViewCellValue, ViewDomain, ViewField, ViewFieldGroup } from './view-model';
export { FORMULAS_GROUP } from './view-model';
export { rollUp } from './view-model';
export type { ViewEditorSection } from './view-editor';

/**
 * Rows that share the domain's merge key, folded into one row each: within each group, or across
 * every row when nothing is grouped (Bikram, 2026-10-11: no duplicate rows in the flat table).
 */
function mergeRows<T>(domain: ViewDomain<T>, rows: T[], groupBy: ViewField<T> | null): T[] {
  const merge = domain.merge;
  if (!merge) return rows;
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = `${groupBy ? label(groupBy.value(r)) : ''}\u0000${merge.key(r)}`;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return [...m.values()].map((rs) => (rs.length > 1 ? merge.rows(rs) : (rs[0] as T)));
}

/** A saved view (`@edgedesk/types/views`); agents write the same shape through MCP. */
export type { CustomViewConfig };

const MINUS = '−';

const formatter = (digits: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const FMT = { 0: formatter(0), 2: formatter(2) } as const;
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** A value as its field's format reads: tabular figures, a true minus, gain/loss on signed values. */
export function ViewValueCell({
  value,
  format,
  chip,
  amount,
  compact,
}: {
  value: ViewCellValue;
  format: ViewFormat;
  /** Text shown as a chip (a view's `chips` setting). */
  chip?: boolean;
  /** A holding amount: shown as `•••••` while Hide amounts is on. */
  amount?: boolean;
  /** Large numbers in short form: $283.1B, 6.1M. */
  compact?: boolean;
}) {
  const hidden = useAmountsHidden() && !!amount;
  if (value === null || (typeof value === 'number' && !Number.isFinite(value))) {
    return <span className="num text-muted-foreground">—</span>;
  }
  if (chip && typeof value === 'string')
    return (
      <Badge variant="secondary" className="font-normal">
        {value}
      </Badge>
    );
  if (typeof value === 'string' || format === 'text')
    return <span>{hidden ? maskAmount(String(value)) : value}</span>;
  const abs = hidden
    ? maskAmount('0')
    : (compact ? COMPACT : format === 'integer' ? FMT[0] : FMT[2]).format(Math.abs(value));
  const signed = format === 'signed' || format === 'percent';
  const sign = value < 0 ? MINUS : signed && value > 0 ? '+' : '';
  return (
    <span
      className={cn(
        'num whitespace-nowrap',
        signed && (value > 0 ? 'text-gain' : value < 0 ? 'text-loss' : ''),
      )}
    >
      {format === 'price' && value < 0 ? `${MINUS}$${abs}` : null}
      {format === 'price' && value >= 0 ? `$${abs}` : null}
      {format !== 'price' &&
        `${sign}${abs}${format === 'percent' || format === 'weight' ? '%' : ''}`}
    </span>
  );
}

/** A row's first cell with its inline chips (a view's `inline` chips), editable where the field is. */
function FirstCell({
  value,
  chips,
}: {
  value: ReactNode;
  chips: { key: string; node: ReactNode }[];
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      {value}
      {chips.map((c) => (
        <Fragment key={c.key}>{c.node}</Fragment>
      ))}
    </span>
  );
}

/** The row styling every Total and group header shares. */
const ROLLUP = 'bg-muted/50 font-medium hover:bg-muted/50';
// One scroller for the whole view (Bikram, 2026-10-11): the tiles, filter and table scroll together
// in one box, one screen tall, so a swipe never stalls where the header pins and the tiles leave the
// screen before the rows move. The header and group rows pin with native sticky inside it (the shadcn
// sticky-header data table pattern); group rows sit right under the header, overlapping it by 1px so
// no gap ever shows, and the next group row slides over the one pinned. Wide tables scroll sideways
// in the same box while the tiles and filter stay put.
const VIEW_SCROLL =
  '@container max-h-[calc(100svh-var(--shell-header-height)-var(--shell-status-height)-2*var(--shell-gutter))] overflow-auto';
/** The table inside the view's scroller: it never scrolls on its own, so sticky rows pin to the view. */
const IN_VIEW = '[&>[data-slot=table-container]]:overflow-visible';
// `--head-top` is the column-group band's height when the table draws one (Bikram, 2026-10-12).
const PINNED_BAND = 'sticky top-0 z-20 h-(--row-h) bg-card';
const PINNED_HEAD =
  'sticky top-(--head-top,0px) z-20 bg-card shadow-[inset_0_-1px_0_var(--color-border)]';
const PINNED_GROUP =
  'sticky top-[calc(var(--head-top,0px)+var(--row-h)-1px)] z-10 bg-[color-mix(in_oklab,var(--color-muted)_50%,var(--color-card))] shadow-[inset_0_1px_0_var(--color-border),inset_0_-1px_0_var(--color-border)]';

function SortIcon({ dir }: { dir: false | 'asc' | 'desc' }) {
  if (dir === 'asc') return <ArrowUpIcon className="size-3" />;
  if (dir === 'desc') return <ArrowDownIcon className="size-3" />;
  return null;
}

/** The details: a folded row's own rows as a table, then the domain's sections. */
function DetailsBody<T extends RowData>({
  domain,
  row,
  columns,
  chips,
}: {
  domain: ViewDomain<T>;
  row: T;
  columns: ViewField<T>[];
  chips: ViewChip[];
}) {
  const parts = domain.parts?.rows(row) ?? [];
  const by = domain.fields.find((f) => f.key === domain.parts?.by);
  const sections: NonNullable<ViewDomain<T>['details']> = [
    ...(parts.length > 1 && by && domain.parts
      ? [
          {
            id: '_parts',
            label: domain.parts.label,
            icon: by.icon,
            open: true,
            count: () => parts.length,
            render: () => (
              <div className="-mx-1 rounded-md border">
                <RowsTable
                  domain={domain}
                  // Text the rows all share (the symbol, the kind) says nothing here.
                  columns={[
                    by,
                    ...columns.filter(
                      (f) =>
                        f.key !== by.key &&
                        (f.format !== 'text' || new Set(parts.map((r) => f.value(r))).size > 1),
                    ),
                  ]}
                  rows={parts}
                  groupBy={null}
                  chips={chips}
                />
              </div>
            ),
          },
        ]
      : []),
    ...(domain.details ?? []),
  ];
  return (
    <div className="flex flex-col px-4 pb-4">
      {sections.map((s) => (
        <DrawerSection
          key={`${domain.rowKey(row)}:${s.id}`}
          icon={s.icon}
          title={s.label}
          count={s.count?.(row)}
          hint={s.hint?.(row)}
          defaultOpen={typeof s.open === 'function' ? s.open(row) : s.open}
        >
          {s.render(row)}
        </DrawerSection>
      ))}
    </div>
  );
}

/** The details drawer (Bikram, 2026-10-09). Phone: a bottom sheet. Desktop: a right-side sheet
 *  over the table whose width drags from 320px to 60% at its left edge. The sheet spans the screen
 *  so the resizable group has room; only the handle and the drawer take the pointer, so a click
 *  beside it falls through to the overlay and closes it (`!` beats the inline
 *  pointer-events Radix sets on a modal's content). */
function DetailsSheet<T extends RowData>({
  row,
  title,
  onClose,
  children,
}: {
  row: T | null;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const head = (
    <>
      <SheetTitle className="min-w-0 truncate">{title}</SheetTitle>
      <SheetDescription className="sr-only">Details of the row</SheetDescription>
    </>
  );
  return (
    <Sheet open={row !== null} onOpenChange={(o) => !o && onClose()}>
      {isMobile ? (
        <SheetContent side="bottom" className="max-h-[85svh] gap-0 overflow-y-auto">
          <SheetHeader className="sticky top-0 z-10 border-b bg-background">{head}</SheetHeader>
          {children}
        </SheetContent>
      ) : (
        <SheetContent
          side="right"
          showCloseButton={false}
          // The resize handle's grab zone is wider than the handle, so a drag can start on the
          // overlay; the panels library marks that pointerdown handled, and then it doesn't close.
          onPointerDownOutside={(e) =>
            e.detail.originalEvent.defaultPrevented && e.preventDefault()
          }
          className="pointer-events-none! gap-0 border-0 bg-transparent shadow-none data-[side=right]:w-full data-[side=right]:border-l-0 data-[side=right]:sm:max-w-none"
        >
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel minSize="40%" />
            <ResizableHandle withHandle className="pointer-events-auto" />
            <ResizablePanel
              defaultSize="32%"
              minSize="320px"
              maxSize="60%"
              className="pointer-events-auto bg-popover shadow-lg"
            >
              <section className="flex h-full flex-col overflow-hidden">
                <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
                  {head}
                  <SheetClose asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto"
                      aria-label="Close details"
                    >
                      <XIcon />
                    </Button>
                  </SheetClose>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto pt-2">{children}</div>
              </section>
            </ResizablePanel>
          </ResizablePanelGroup>
        </SheetContent>
      )}
    </Sheet>
  );
}

export interface CustomViewPageProps<T> {
  crumbs: Crumb[];
  domain: ViewDomain<T>;
  config: CustomViewConfig;
  rows: T[];
  /** Saves an edited view; without it the page has no Edit button. */
  onConfigChange?: (config: CustomViewConfig) => void;
  /** A desk's own section in the Edit dialog (an explorer view's columns). */
  editor?: ViewEditorSection;
  /** Duplicate and Delete, offered in the Edit dialog's More section. */
  onDuplicate?: () => void;
  onDelete?: () => void;
  /** Shown in place of the table while rows load or when they fail. */
  state?: ReactNode;
  actions?: ReactNode;
  /** Inputs that change what rows load (an explorer view's symbol and range), beside the filter. */
  controls?: ReactNode;
  /** Above the filter: summary tiles or tabs the desk shows with this view. */
  intro?: ReactNode;
  /** Draws one of the domain's widgets over the rows the view shows (after its filters); the
   *  view's `widgets` pick which, in order. */
  widget?: (key: string, rows: T[]) => ReactNode;
  status?: ReactNode;
  /** The details drawer title for a row. */
  rowTitle?: (row: T) => string;
  /** The saved view's id, shown in the Edit dialog to copy for an MCP call. */
  viewId?: string;
  /** Told the rows the view shows after its filters, every page, whenever they change, so a desk
   *  loads live data for those rows only (Bikram, 2026-10-09). */
  onShownRows?: (rows: T[]) => void;
  /** Row checkboxes (strategy lab, Bikram 2026-10-10): the checked row keys and their setter; the
   *  header box checks every shown row. */
  selection?: { keys: Set<string>; onChange: (keys: Set<string>) => void };
  /** A row click opens it (a page of its own) instead of the details drawer. */
  onOpen?: (row: T) => void;
  /** Buttons at the end of a group row's label (pin a group), given its key and rows. */
  groupActions?: (key: string, rows: T[]) => ReactNode;
  /** Told the filter's tokens whenever they change, so a desk can load rows for what they pick
   *  (the Symbols view's `in` filter, Bikram 2026-10-12). */
  onTokens?: (tokens: FilterToken[]) => void;
}

const GROUP_NONE = '_none';
const GROUP_PIVOT = '_pivot';

export function CustomViewPage<T extends RowData>({
  crumbs,
  domain: base,
  config,
  rows,
  onConfigChange,
  editor,
  state,
  actions,
  controls,
  intro,
  widget,
  status,
  rowTitle,
  viewId,
  onDuplicate,
  onDelete,
  onShownRows,
  selection,
  onOpen,
  groupActions,
  onTokens,
}: CustomViewPageProps<T>) {
  const domain = useMemo(() => withFormulas(base, config), [base, config]);
  const columns = pick(domain.fields, config.columns);
  const filterFields = useMemo<FilterField<T>[]>(
    () =>
      filterFieldsOf(domain.fields, config.filters.fields).map((f) => ({
        key: f.key,
        label: f.label,
        icon: f.icon,
        values:
          f.values ??
          ((row: T) => {
            const v = f.value(row);
            return v === null ? [] : [String(v)];
          }),
        // Number fields filter by a condition (`> 100`), formulas included (Bikram, 2026-10-11).
        number:
          f.format === 'text'
            ? undefined
            : (row: T) => {
                const v = f.value(row);
                return typeof v === 'number' ? v : null;
              },
      })),
    [domain.fields, config.filters.fields],
  );
  const filter = useTokenFilter(rows, filterFields, {
    text: domain.text,
    initial: config.filters.default,
  });
  useEffect(() => onShownRows?.(filter.results), [onShownRows, filter.results]);
  useEffect(() => onTokens?.(filter.tokens), [onTokens, filter.tokens]);
  const groupable = pick(
    domain.fields.filter((f) => f.groupable),
    config.group.fields,
  );
  const [mode, setMode] = useState<string>(
    config.shape === 'pivot' && config.pivot ? GROUP_PIVOT : (config.group.default ?? GROUP_NONE),
  );
  const [details, setDetails] = useState<T | null>(null);
  const [editing, setEditing] = useState(false);
  const chips = chipsOf(config);

  const header = (
    <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
      {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
      <TokenFilter
        filter={filter}
        label={`Filter ${config.name}`}
        className="md:max-w-md"
        saved={config.filters.default}
        onSave={
          onConfigChange &&
          ((tokens) =>
            onConfigChange({
              ...config,
              filters: withSavedFilters(domain.fields, config.filters, tokens),
            }))
        }
      />
      {(groupable.length > 0 || config.pivot) && (
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={mode}
          onValueChange={(v) => v && setMode(v)}
          aria-label="Group by"
          className="max-w-full overflow-x-auto"
        >
          <ToggleGroupItem value={GROUP_NONE} aria-label="No grouping">
            <TableIcon />
            <span className="hidden sm:inline">Rows</span>
          </ToggleGroupItem>
          {groupable.map((f) => (
            <ToggleGroupItem key={f.key} value={f.key} aria-label={`Group by ${f.label}`}>
              <f.icon />
              <span className="hidden sm:inline">{f.label}</span>
            </ToggleGroupItem>
          ))}
          {config.pivot && (
            <ToggleGroupItem value={GROUP_PIVOT} aria-label="Pivot">
              <Grid3x3Icon />
              <span className="hidden sm:inline">Pivot</span>
            </ToggleGroupItem>
          )}
        </ToggleGroup>
      )}
      <span className="num text-xs text-muted-foreground md:ml-auto">
        {filter.results.length === rows.length
          ? `${rows.length} rows`
          : `${filter.results.length} of ${rows.length} rows`}
      </span>
    </div>
  );

  const groupField = groupable.find((f) => f.key === mode) ?? null;
  // The view's own tiles, rolled up over the rows it shows (Bikram, 2026-10-09).
  const tiles = useMemo(() => {
    const own = tilesOf(config);
    if (!own.length || state) return [];
    const computed = computedOf(domain, filter.results, null);
    return own.flatMap((t) => {
      const f = domain.fields.find((x) => x.key === t.field);
      if (!f) return [];
      const value = rollUp(
        filter.results.map((r) => computed.value(f, r)),
        t.agg,
      );
      const count = t.agg === 'count';
      return [
        {
          ...t,
          value,
          format: count ? ('integer' as const) : f.format,
          amount: !count && f.amount,
        },
      ];
    });
  }, [config, domain, filter.results, state]);

  return (
    <Page
      crumbs={crumbs}
      status={status}
      actions={
        (actions || onConfigChange) && (
          <>
            {actions}
            {onConfigChange && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <PencilIcon />
                Edit
              </Button>
            )}
          </>
        )
      }
    >
      {(() => {
        const top = (intro ||
          (widget && config.widgets.length > 0) ||
          tiles.length > 0 ||
          header) && (
          <div className="sticky left-0 flex w-[100cqw] flex-col gap-(--shell-section-gap)">
            {intro}
            {((widget && config.widgets.length > 0) || tiles.length > 0) && (
              <div
                data-slot="view-widgets"
                className="grid grid-cols-2 gap-(--shell-section-gap) md:auto-cols-fr md:grid-flow-col [&>*:last-child:nth-child(odd)]:col-span-2 md:[&>*:last-child:nth-child(odd)]:col-span-1"
              >
                {widget &&
                  config.widgets.map((k) => (
                    <Fragment key={k}>{widget(k, filter.results)}</Fragment>
                  ))}
                {tiles.map((t) => (
                  <Tile
                    key={t.key}
                    label={t.label}
                    value={<ViewValueCell value={t.value} format={t.format} amount={t.amount} />}
                  />
                ))}
              </div>
            )}
            {header}
          </div>
        );
        const main = (
          <div data-slot="view-scroll" className={VIEW_SCROLL}>
            <div className="flex w-max min-w-full flex-col gap-(--shell-section-gap)">
              {top}
              <Card className="gap-0 overflow-clip py-0">
                {state ??
                  (mode === GROUP_PIVOT && config.pivot ? (
                    <PivotTable domain={domain} rows={filter.results} pivot={config.pivot} />
                  ) : (
                    <RowsTable
                      domain={domain}
                      columns={columns}
                      rows={mergeRows(domain, filter.results, groupField)}
                      groupBy={groupField}
                      chips={chips}
                      paged
                      onDetails={onOpen ?? (domain.details?.length ? setDetails : undefined)}
                      selection={selection}
                      groupActions={groupActions}
                      sort={config.sort}
                    />
                  ))}
              </Card>
            </div>
          </div>
        );
        // The open row as the rows are now, so an edit made in the drawer shows in it.
        const key = details === null ? null : domain.rowKey(details);
        const open = key === null ? null : (rows.find((r) => domain.rowKey(r) === key) ?? details);
        const title = open === null ? '' : (rowTitle?.(open) ?? domain.rowKey(open));
        return (
          <>
            {main}
            <DetailsSheet row={open} title={title} onClose={() => setDetails(null)}>
              {open !== null && (
                <DetailsBody domain={domain} row={open} columns={columns} chips={chips} />
              )}
            </DetailsSheet>
          </>
        );
      })()}
      {onConfigChange && (
        <ViewEditDialog
          open={editing}
          onOpenChange={setEditing}
          domain={base}
          config={config}
          rows={filter.results}
          current={filter.tokens}
          onSave={onConfigChange}
          viewId={viewId}
          editor={editor}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
        />
      )}
    </Page>
  );
}

/**
 * The column-group band over the headers (Bikram, 2026-10-12): one cell per run of columns from
 * the same group (Holding, Symbol, Account, Formulas), drawn only when the columns span groups.
 */
function bandsOf<T>(domain: ViewDomain<T>, shown: ViewField<T>[]) {
  if (!domain.groups?.length) return null;
  const runs: { id: string; label: string; color: string; span: number }[] = [];
  for (const f of shown) {
    const id = groupOf(domain, f);
    const last = runs.at(-1);
    if (last?.id === id) last.span++;
    else {
      const g = domain.groups.find((x) => x.id === id);
      runs.push({
        id,
        label: id === FORMULAS_GROUP ? 'Formulas' : (g?.label ?? ''),
        color: g?.color ?? 'var(--color-muted-foreground)',
        span: 1,
      });
    }
  }
  return new Set(runs.map((r) => r.id)).size > 1 ? runs : null;
}

const alignOf = (format: ViewFormat) => (format === 'text' ? 'text-left' : 'text-right');

/** The flat or grouped table: sortable headers, a Total row, group rows that collapse. */
// Sorting, and paging of flat tables (100 rows a page, Bikram 2026-10-09).
const SORTING = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns,
});
const PAGE_SIZE = 100;

function RowsTable<T extends RowData>({
  domain,
  columns,
  rows,
  groupBy,
  chips = [],
  paged = false,
  onDetails,
  selection,
  groupActions,
  sort,
}: {
  domain: ViewDomain<T>;
  columns: ViewField<T>[];
  rows: T[];
  groupBy: ViewField<T> | null;
  chips?: ViewChip[];
  /** Pages a flat table; grouped tables show every row. */
  paged?: boolean;
  onDetails?: (row: T) => void;
  selection?: CustomViewPageProps<T>['selection'];
  groupActions?: CustomViewPageProps<T>['groupActions'];
  /** The view's default sort (Bikram, 2026-10-12); a header click changes it for the visit. */
  sort?: CustomViewConfig['sort'];
}) {
  const [sorting, setSorting] = useState<SortingState>(
    sort && columns.some((f) => f.key === sort.key) ? [{ id: sort.key, desc: sort.desc }] : [],
  );
  const [pageIndex, setPageIndex] = useState(0);
  const paging = paged && !groupBy && rows.length > PAGE_SIZE;
  const pagination: PaginationState = {
    pageIndex: paging ? pageIndex : 0,
    pageSize: paging ? PAGE_SIZE : Math.max(rows.length, 1),
  };
  const [closed, setClosed] = useState<Set<string>>(new Set());
  // The grouped field is the group row's label, so its column hides (Bikram, 2026-10-08).
  const visible = columns.filter((f) => f.key !== groupBy?.key);
  // Inline chips sit on the first column, next to the row's name, not in their own (Bikram,
  // 2026-10-09).
  const inline = visible.filter(
    (f, i) => i > 0 && chips.some((c) => c.key === f.key && c.placement === 'inline'),
  );
  const shown = visible.filter((f) => !inline.includes(f));
  const computed = useMemo(() => computedOf(domain, rows, groupBy), [domain, rows, groupBy]);
  // Values per editable field, offered when a cell is edited: the field's own list when it has
  // one (every value, in use or not), else the values in the shown rows.
  const options = useMemo(() => {
    const m = new Map<string, { inUse: string[]; unused: string[] }>();
    for (const f of visible)
      if (f.edit)
        m.set(
          f.key,
          f.edit.options?.() ?? {
            inUse: [
              ...new Set(
                rows
                  .map((r) => f.value(r))
                  .filter((v): v is string => typeof v === 'string' && v !== ''),
              ),
            ].sort(),
            unused: [],
          },
        );
    return m;
  }, [visible, rows]);
  const cellOf = (f: ViewField<T>, row: T, chip: boolean) => {
    if (f.render) return f.render(row);
    const v = computed.value(f, row);
    if (!f.edit)
      return (
        <ViewValueCell
          value={v}
          format={f.format}
          chip={chip}
          amount={f.amount}
          compact={f.compact}
        />
      );
    const edit = f.edit;
    return (
      <EditCell
        label={f.label}
        value={typeof v === 'string' && v !== '' ? v : null}
        options={options.get(f.key)?.inUse ?? []}
        unused={options.get(f.key)?.unused}
        chip={chip}
        note={edit.note?.(row)}
        onSave={(value) => edit.save(row, value)}
      />
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: cellOf reads computed and options, listed here
  const defs = useMemo<ColumnDef<typeof SORTING, T>[]>(
    () =>
      shown.map((f, i) => ({
        id: f.key,
        accessorFn: (r) => computed.value(f, r) ?? undefined,
        sortUndefined: 'last',
        header: f.label,
        cell: ({ row }) =>
          i === 0 && inline.length ? (
            <FirstCell
              value={cellOf(
                f,
                row.original,
                chips.some((c) => c.key === f.key),
              )}
              chips={inline.flatMap((x) => {
                const v = computed.value(x, row.original);
                if (!x.edit && (v === null || v === '')) return [];
                return [{ key: x.key, node: cellOf(x, row.original, true) }];
              })}
            />
          ) : (
            cellOf(
              f,
              row.original,
              chips.some((c) => c.key === f.key),
            )
          ),
      })),
    [shown, inline, chips, computed, options],
  );
  const table = useTable({
    features: SORTING,
    data: rows,
    columns: defs,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: (u) =>
      setPageIndex((typeof u === 'function' ? u(pagination) : u).pageIndex),
    autoResetPageIndex: false,
  });
  const pages = table.getPageCount();
  const first = pagination.pageIndex * PAGE_SIZE;
  const sorted = table.getRowModel().rows;
  const groups = useMemo(() => {
    if (!groupBy) return null;
    const m = new Map<string, typeof sorted>();
    for (const r of sorted) {
      const k = label(groupBy.value(r.original));
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m];
  }, [groupBy, sorted]);
  const span = shown.length + (selection ? 1 : 0);
  const bands = bandsOf(domain, shown);
  const keyOf = domain.rowKey;
  const toggle = (keys: string[], on: boolean) => {
    if (!selection) return;
    const next = new Set(selection.keys);
    for (const k of keys) on ? next.add(k) : next.delete(k);
    selection.onChange(next);
  };
  const allKeys = rows.map(keyOf);
  const allOn = allKeys.length > 0 && allKeys.every((k) => selection?.keys.has(k));
  const someOn = allKeys.some((k) => selection?.keys.has(k));
  const selectCell = (key: string, name: string) =>
    selection && (
      <TableCell className="w-8 pr-0" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selection.keys.has(key)}
          onCheckedChange={(on) => toggle([key], on === true)}
          aria-label={`Select ${name}`}
        />
      </TableCell>
    );

  const hasTotal = shown.some((f) => f.aggregate || f.rollFormula || f.share?.within === 'total');
  // A group row's label spans the leading columns that roll nothing up (Bikram, 2026-10-09).
  const rolls = (f: ViewField<T>) => !!f.aggregate || !!f.rollFormula || !!f.share;
  const lead = Math.max(
    1,
    shown.findIndex((f, i) => i > 0 && rolls(f)) < 0
      ? shown.length
      : shown.findIndex((f, i) => i > 0 && rolls(f)),
  );
  const rollCell = (f: ViewField<T>, members: T[]) =>
    f.aggregate || f.rollFormula || f.share?.within === 'total' ? (
      <ViewValueCell
        value={computed.roll(f, members)}
        format={f.format}
        amount={f.amount}
        compact={f.compact}
      />
    ) : null;
  const rollCells = (members: T[]) =>
    shown.map((f) => (
      <TableCell key={f.key} className={alignOf(f.format)}>
        {rollCell(f, members)}
      </TableCell>
    ));

  // The whole row opens the details drawer (Bikram, 2026-10-09).
  const dataRow = (r: (typeof sorted)[number]) => (
    <TableRow
      key={domain.rowKey(r.original)}
      data-row={domain.rowKey(r.original)}
      className={cn('group/row', onDetails && 'cursor-pointer')}
      tabIndex={onDetails ? 0 : undefined}
      onClick={onDetails ? () => onDetails(r.original) : undefined}
      onKeyDown={
        onDetails
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onDetails(r.original);
              }
            }
          : undefined
      }
    >
      {selectCell(keyOf(r.original), keyOf(r.original))}
      {r.getAllCells().map((c, i) => (
        <TableCell
          key={c.id}
          className={cn(alignOf(shown[i]?.format ?? 'text'), groupBy && i === 0 && 'pl-8')}
        >
          {flexRender(c.column.columnDef.cell, c.getContext())}
        </TableCell>
      ))}
    </TableRow>
  );

  return (
    <div className={cn(paged ? IN_VIEW : 'overflow-x-auto', bands && '[--head-top:var(--row-h)]')}>
      <Table>
        <TableHeader>
          {bands && (
            <TableRow className="hover:bg-transparent">
              {selection && <TableHead className={PINNED_BAND} />}
              {bands.map((b, i) => (
                <TableHead
                  key={`${b.id}:${i}`}
                  colSpan={b.span}
                  className={cn(PINNED_BAND, 'text-xs font-medium', i > 0 && 'border-l')}
                  style={{ boxShadow: `inset 0 -2px 0 ${b.color}`, color: b.color }}
                >
                  {b.label}
                </TableHead>
              ))}
            </TableRow>
          )}
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {selection && (
                <TableHead className={cn('w-8 pr-0', PINNED_HEAD)}>
                  <Checkbox
                    checked={allOn ? true : someOn ? 'indeterminate' : false}
                    onCheckedChange={(on) => toggle(allKeys, on === true)}
                    aria-label="Select every row"
                  />
                </TableHead>
              )}
              {hg.headers.map((h, i) => (
                <TableHead
                  key={h.id}
                  className={cn(alignOf(shown[i]?.format ?? 'text'), PINNED_HEAD)}
                  aria-sort={
                    h.column.getIsSorted() === 'asc'
                      ? 'ascending'
                      : h.column.getIsSorted() === 'desc'
                        ? 'descending'
                        : undefined
                  }
                >
                  {i === 0 && groups && (
                    // Expand or collapse every group at once (Bikram, 2026-10-09).
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="-ml-2 mr-1 align-middle"
                      aria-label={closed.size ? 'Expand all groups' : 'Collapse all groups'}
                      title={closed.size ? 'Expand all' : 'Collapse all'}
                      onClick={() =>
                        setClosed(closed.size ? new Set() : new Set(groups.map(([k]) => k)))
                      }
                    >
                      {closed.size ? <ChevronsUpDownIcon /> : <ChevronsDownUpIcon />}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    className={cn('font-medium', !(i === 0 && groups) && '-mx-2')}
                    onClick={h.column.getToggleSortingHandler()}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    <SortIcon dir={h.column.getIsSorted()} />
                  </Button>
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {!rows.length && (
            <TableRow>
              <TableCell colSpan={span} className="py-6 text-center text-muted-foreground">
                No rows match.
              </TableCell>
            </TableRow>
          )}
          {groups && groupBy
            ? groups.map(([key, members]) => {
                const open = !closed.has(key);
                return (
                  <Fragment key={key}>
                    <TableRow className={ROLLUP} data-group={key}>
                      {selection && (
                        <TableCell className={cn('w-8 pr-0', PINNED_GROUP)}>
                          <Checkbox
                            checked={
                              members.every((m) => selection.keys.has(keyOf(m.original)))
                                ? true
                                : members.some((m) => selection.keys.has(keyOf(m.original)))
                                  ? 'indeterminate'
                                  : false
                            }
                            onCheckedChange={(on) =>
                              toggle(
                                members.map((m) => keyOf(m.original)),
                                on === true,
                              )
                            }
                            aria-label={`Select every row of ${key}`}
                          />
                        </TableCell>
                      )}
                      {shown.slice(lead - 1).map((f, i) =>
                        i === 0 ? (
                          <TableCell key={f.key} colSpan={lead} className={PINNED_GROUP}>
                            <Button
                              variant="ghost"
                              size="xs"
                              className="-mx-2 hover:bg-transparent aria-expanded:bg-transparent"
                              aria-expanded={open}
                              aria-label={`${open ? 'Collapse' : 'Expand'} ${key}`}
                              onClick={() =>
                                setClosed((c) => {
                                  const n = new Set(c);
                                  n.has(key) ? n.delete(key) : n.add(key);
                                  return n;
                                })
                              }
                            >
                              <ChevronRightIcon
                                className={cn('transition-transform', open && 'rotate-90')}
                              />
                              <groupBy.icon />
                              {key}
                              <span className="num font-normal text-muted-foreground">
                                {members.length}
                              </span>
                            </Button>
                            {groupActions?.(
                              key,
                              members.map((m) => m.original),
                            )}
                          </TableCell>
                        ) : (
                          <TableCell key={f.key} className={cn(alignOf(f.format), PINNED_GROUP)}>
                            {rollCell(
                              f,
                              members.map((m) => m.original),
                            )}
                          </TableCell>
                        ),
                      )}
                    </TableRow>
                    {open && members.map(dataRow)}
                  </Fragment>
                );
              })
            : sorted.map(dataRow)}
          {hasTotal && rows.length > 0 && (
            <TableRow className={cn(ROLLUP, 'border-t-2')} data-total>
              {selection && <TableCell />}
              {rollCells(rows).map((cell, i) =>
                i === 0 && !shown[0]?.aggregate && !shown[0]?.rollFormula ? (
                  <TableCell key="total">Total</TableCell>
                ) : (
                  cell
                ),
              )}
            </TableRow>
          )}
        </TableBody>
      </Table>
      {paging && (
        <nav
          aria-label="Pages"
          className="flex items-center justify-end gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground"
        >
          <span className="num mr-auto">
            {first + 1}–{Math.min(first + PAGE_SIZE, rows.length)} of {rows.length}
          </span>
          <span className="num">
            Page {pagination.pageIndex + 1} of {pages}
          </span>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="Previous page"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="Next page"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <ChevronRightIcon />
          </Button>
        </nav>
      )}
    </div>
  );
}

/** One value rolled up into a rows × columns grid, with totals where the roll-up adds. */
function PivotTable<T>({
  domain,
  rows,
  pivot,
}: {
  domain: ViewDomain<T>;
  rows: T[];
  pivot: NonNullable<CustomViewConfig['pivot']>;
}) {
  const field = (k: string) => domain.fields.find((f) => f.key === k);
  const rf = field(pivot.rows);
  const cf = field(pivot.columns);
  const vf = field(pivot.value);
  const grid = useMemo(() => {
    if (!rf || !cf || !vf) return null;
    const rowKeys = [...new Set(rows.map((r) => label(rf.value(r))))].sort();
    const colKeys = [...new Set(rows.map((r) => label(cf.value(r))))].sort();
    const cell = (rk: string | null, ck: string | null) =>
      rollUp(
        rows
          .filter(
            (r) =>
              (rk === null || label(rf.value(r)) === rk) &&
              (ck === null || label(cf.value(r)) === ck),
          )
          .map(vf.value),
        pivot.agg,
      );
    return { rowKeys, colKeys, cell };
  }, [rows, rf, cf, vf, pivot.agg]);
  if (!grid || !rf || !cf || !vf) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        This view's pivot names a field the data does not have.
      </p>
    );
  }
  const totals = pivot.agg === 'sum' || pivot.agg === 'count';
  const fmt: ViewFormat = pivot.agg === 'count' ? 'integer' : vf.format;
  const amount = pivot.agg !== 'count' && vf.amount;
  return (
    <div className={IN_VIEW} data-testid="view-pivot">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={PINNED_HEAD}>
              <span className="flex items-center gap-1.5">
                <rf.icon className="size-3.5" />
                {rf.label} \ {cf.label}
                <span className="font-normal text-muted-foreground">
                  ({vf.label}, {pivot.agg})
                </span>
              </span>
            </TableHead>
            {grid.colKeys.map((c) => (
              <TableHead key={c} className={cn('text-right', PINNED_HEAD)}>
                {c}
              </TableHead>
            ))}
            {totals && <TableHead className={cn('text-right', PINNED_HEAD)}>Total</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {grid.rowKeys.map((r) => (
            <TableRow key={r} data-row={r}>
              <TableCell>{r}</TableCell>
              {grid.colKeys.map((c) => (
                <TableCell key={c} className="text-right">
                  <ViewValueCell value={grid.cell(r, c)} format={fmt} amount={amount} />
                </TableCell>
              ))}
              {totals && (
                <TableCell className={cn('text-right', ROLLUP)}>
                  <ViewValueCell value={grid.cell(r, null)} format={fmt} amount={amount} />
                </TableCell>
              )}
            </TableRow>
          ))}
          {totals && (
            <TableRow className={cn(ROLLUP, 'border-t-2')} data-total>
              <TableCell>Total</TableCell>
              {grid.colKeys.map((c) => (
                <TableCell key={c} className="text-right">
                  <ViewValueCell value={grid.cell(null, c)} format={fmt} amount={amount} />
                </TableCell>
              ))}
              <TableCell className="text-right">
                <ViewValueCell value={grid.cell(null, null)} format={fmt} amount={amount} />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
