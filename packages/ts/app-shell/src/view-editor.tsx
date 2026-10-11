// The Edit view dialog (Bikram, 2026-10-09): shaped like Settings. Sections on the left (a section
// picker on phones), the view's name and Close pinned at the top, Cancel and Save pinned at the
// bottom. Layout sets how the view opens; Fields is one list of every field (show, chip placement,
// group, filter, order by dragging, formulas edited in place); Summary the tiles above the table;
// More the view id for agents, Duplicate and Delete. Everything here is the view's config, which
// agents write the same way through MCP custom_view_write.
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  type CustomViewConfig,
  type ViewChipPlacement,
  type ViewTile,
  viewAggs,
} from '@edgedesk/types/views';
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  FilterIcon,
  GripVerticalIcon,
  LayoutGridIcon,
  ListIcon,
  type LucideIcon,
  PanelsTopLeftIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SigmaIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { ConfirmDelete } from './confirm';
import { cn } from './lib/utils';
import { maskAmount, useAmountsHidden } from './shell';
import { type FilterToken, tokenText } from './token-filter';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './ui/input-group';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Separator } from './ui/separator';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from './ui/sidebar';
import { Switch } from './ui/switch';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import {
  AGG_LABELS,
  FormulaForm,
  MAX_FORMULAS,
  MAX_TILES,
  formulaIssues,
  tileIssues,
} from './view-formulas';
import { VIEW_ICONS, shapeIcon } from './view-icons';
import {
  type ViewCellValue,
  type ViewDomain,
  type ViewField,
  chipsOf,
  computedOf,
  formulasOf,
  rollUp,
  tilesOf,
  withFormulas,
} from './view-model';

/** A desk's own section in the dialog (an explorer view's columns). */
export interface ViewEditorSection {
  title: string;
  icon: LucideIcon;
  description?: string;
  content: ReactNode;
}

export interface ViewEditDialogProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domain: ViewDomain<T>;
  config: CustomViewConfig;
  /** The rows the page shows now (after its filters), for the tile previews. */
  rows: T[];
  /** The filter tokens on the page now, offered as the new defaults. */
  current: FilterToken[];
  onSave: (config: CustomViewConfig) => void;
  viewId?: string;
  editor?: ViewEditorSection;
  onDuplicate?: () => void;
  onDelete?: () => void;
}

type SectionId = 'layout' | 'fields' | 'summary' | 'editor' | 'more';

const SHAPES = [
  { value: 'table', label: 'Table' },
  { value: 'group', label: 'Group' },
  { value: 'pivot', label: 'Pivot' },
] as const;

const NONE = '_none';

/** A toggled key in a list that, empty, means "all of `all`"; the result keeps `all`'s order. */
const toggleIn = (list: string[], all: string[], key: string, on: boolean) => {
  const base = list.length ? list : all;
  const next = on ? [...base, key] : base.filter((k) => k !== key);
  return all.filter((k) => next.includes(k));
};

const sensorsOptions = { activationConstraint: { distance: 4 } };

function useDrag() {
  return useSensors(
    useSensor(PointerSensor, sensorsOptions),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/** Moves `active` to `over` in `keys` after a drag; the same list when nothing moved. */
const moved = (keys: string[], e: DragEndEvent) => {
  const from = keys.indexOf(String(e.active.id));
  const to = e.over ? keys.indexOf(String(e.over.id)) : -1;
  return from < 0 || to < 0 || from === to ? keys : arrayMove(keys, from, to);
};

export function ViewEditDialog<T>({
  open,
  onOpenChange,
  domain: base,
  config,
  rows,
  current,
  onSave,
  viewId,
  editor,
  onDuplicate,
  onDelete,
}: ViewEditDialogProps<T>) {
  const [draft, setDraft] = useState(config);
  const [section, setSection] = useState<SectionId>('fields');
  const [query, setQuery] = useState('');
  const domain = withFormulas(base, draft);
  const widgetKeys = (base.widgets ?? []).map((w) => w.key);
  const formulaProblems = formulaIssues(
    formulasOf(draft),
    base.fields.map((f) => f.key),
  );
  const tileProblems = tileIssues(
    tilesOf(draft),
    domain.fields.map((f) => f.key),
    widgetKeys,
  );
  const bad = formulaProblems.some(Boolean) || tileProblems.some(Boolean) || !draft.name.trim();
  const allKeys = domain.fields.map((f) => f.key);
  const shownKeys = draft.columns.length
    ? draft.columns.filter((k) => allKeys.includes(k))
    : allKeys;
  const groupable = domain.fields.filter((f) => f.groupable);
  const offered = (draft.group.fields.length ? draft.group.fields : groupable.map((g) => g.key))
    .map((k) => groupable.find((g) => g.key === k))
    .filter((f): f is ViewField<T> => !!f);

  const sections: { id: SectionId; title: string; icon: LucideIcon; description: string }[] = [
    {
      id: 'layout',
      title: 'Layout',
      icon: PanelsTopLeftIcon,
      description: 'How the view opens: its shape, grouping, filters and sidebar icon.',
    },
    {
      id: 'fields',
      title: 'Fields',
      icon: ListIcon,
      description:
        'Which fields show and in what order, where chips sit, and what readers group and filter by.',
    },
    ...(base.widgets?.length || base.formulas
      ? [
          {
            id: 'summary' as const,
            title: 'Summary',
            icon: LayoutGridIcon,
            description:
              'Tiles above the table. Each totals the rows the view shows, after its filters.',
          },
        ]
      : []),
    ...(editor
      ? [
          {
            id: 'editor' as const,
            title: editor.title,
            icon: editor.icon,
            description: editor.description ?? '',
          },
        ]
      : []),
    {
      id: 'more',
      title: 'More',
      icon: EllipsisIcon,
      description: 'The view id for agents, Duplicate and Delete.',
    },
  ];
  // Searching shows the matching fields, wherever it was typed.
  const shown = query.trim() ? 'fields' : section;
  const now = sections.find((s) => s.id === shown) ?? (sections[1] as (typeof sections)[number]);
  const counts: Partial<Record<SectionId, number>> = {
    fields: shownKeys.length,
    summary: draft.widgets.length + tilesOf(draft).length,
  };
  const go = (id: string) => {
    setQuery('');
    setSection(id as SectionId);
  };

  const search = (
    <InputGroup className="bg-background">
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        className="[&::-webkit-search-cancel-button]:hidden"
        aria-label="Search fields"
        placeholder="Search fields"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery('')}>
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );

  const groupedBy =
    draft.shape === 'pivot'
      ? 'pivot'
      : draft.group.default
        ? `grouped by ${domain.fields.find((f) => f.key === draft.group.default)?.label ?? draft.group.default}`
        : 'not grouped';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setDraft(config);
          setQuery('');
        }
        onOpenChange(o);
      }}
    >
      <DialogContent
        data-slot="view-editor"
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          if (query) {
            e.preventDefault();
            setQuery('');
          }
        }}
        className="flex h-[min(720px,calc(100svh-2rem))] gap-0 overflow-hidden p-0 max-md:h-svh max-md:max-w-full max-md:rounded-none max-md:ring-0 sm:max-w-4xl"
      >
        <DialogDescription className="sr-only">
          This view's layout, fields, summary tiles and more.
        </DialogDescription>
        <nav
          aria-label="Edit view sections"
          className="hidden w-56 shrink-0 flex-col border-r bg-sidebar py-2 md:flex"
        >
          <div className="px-2 pt-1 pb-1">{search}</div>
          <SidebarGroup className="py-1">
            <SidebarGroupLabel>This view</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {sections.map((s) => (
                  <SidebarMenuItem key={s.id}>
                    <SidebarMenuButton isActive={s.id === shown} onClick={() => go(s.id)}>
                      <s.icon />
                      <span>{s.title}</span>
                    </SidebarMenuButton>
                    {counts[s.id] !== undefined && (
                      <SidebarMenuBadge className="num">{counts[s.id]}</SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <p className="mt-auto border-t px-4 pt-3 pb-1 text-xs text-muted-foreground">
            Agents change the same settings with{' '}
            <code className="font-mono">custom_view_write</code>.
          </p>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 flex-col gap-2 border-b px-4 py-3 md:px-5">
            <div className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-xs text-muted-foreground">Edit view</span>
                <DialogTitle className="sr-only">Edit view {draft.name}</DialogTitle>
                <Input
                  aria-label="View name"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="-ml-2 h-8 border-transparent bg-transparent px-2 text-base font-semibold shadow-none hover:border-input dark:bg-transparent"
                />
              </div>
              <DialogClose asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close">
                  <XIcon />
                </Button>
              </DialogClose>
            </div>
            <div className="flex flex-col gap-2 md:hidden">
              {search}
              {!query.trim() && (
                <Select value={shown} onValueChange={go}>
                  <SelectTrigger aria-label="Section" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sections.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <s.icon />
                        {s.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </header>
          <section
            aria-labelledby={`view-editor-${now.id}`}
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-5"
          >
            <div className="flex flex-col gap-0.5">
              <h3
                id={`view-editor-${now.id}`}
                className="flex items-center gap-2 text-base font-semibold"
              >
                <now.icon className="size-4 text-muted-foreground" />
                {query.trim() ? `Fields matching “${query.trim()}”` : now.title}
              </h3>
              <p className="text-sm text-muted-foreground">{now.description}</p>
            </div>
            <Separator />
            {shown === 'layout' && (
              <LayoutSection
                domain={domain}
                draft={draft}
                setDraft={setDraft}
                offered={offered}
                current={current}
              />
            )}
            {shown === 'fields' && (
              <FieldsSection
                base={base}
                domain={domain}
                draft={draft}
                setDraft={setDraft}
                shownKeys={shownKeys}
                query={query.trim().toLowerCase()}
                formulaProblems={formulaProblems}
              />
            )}
            {shown === 'summary' && (
              <SummarySection
                domain={domain}
                draft={draft}
                setDraft={setDraft}
                rows={rows}
                tileProblems={tileProblems}
              />
            )}
            {shown === 'editor' && editor?.content}
            {shown === 'more' && (
              <MoreSection
                name={config.name}
                viewId={viewId}
                onDuplicate={
                  onDuplicate &&
                  (() => {
                    onOpenChange(false);
                    onDuplicate();
                  })
                }
                onDelete={
                  onDelete &&
                  (() => {
                    onOpenChange(false);
                    onDelete();
                  })
                }
              />
            )}
          </section>
          <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-5">
            <p className="num mr-auto hidden min-w-0 truncate text-xs text-muted-foreground md:block">
              {shownKeys.length} columns · {formulasOf(draft).length} formulas ·{' '}
              {draft.widgets.length + tilesOf(draft).length} tiles · {groupedBy}
            </p>
            <DialogClose asChild>
              <Button variant="outline" className="max-md:flex-1">
                Cancel
              </Button>
            </DialogClose>
            <Button
              className="max-md:flex-1"
              disabled={bad}
              onClick={() => {
                const keys = new Set(domain.fields.map((f) => f.key));
                const columns = draft.columns.filter((k) => keys.has(k));
                // A removed field leaves its chip, grouping and filter too.
                onSave({
                  ...draft,
                  name: draft.name.trim(),
                  columns,
                  chips: chipsOf(draft).filter((c) => keys.has(c.key)),
                });
                onOpenChange(false);
              }}
            >
              <CheckIcon />
              Save view
            </Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Setter = (c: CustomViewConfig) => void;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}

function LayoutSection<T>({
  domain,
  draft,
  setDraft,
  offered,
  current,
}: {
  domain: ViewDomain<T>;
  draft: CustomViewConfig;
  setDraft: Setter;
  offered: ViewField<T>[];
  current: FilterToken[];
}) {
  const groupable = domain.fields.filter((f) => f.groupable);
  const numbers = domain.fields.filter((f) => f.format !== 'text');
  const pivot = draft.pivot;
  const select = (
    label: string,
    value: string,
    fields: ViewField<T>[],
    onChange: (v: string) => void,
  ) => (
    <Field label={label}>
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue placeholder="Pick a field" />
        </SelectTrigger>
        <SelectContent>
          {fields.map((f) => (
            <SelectItem key={f.key} value={f.key}>
              <f.icon />
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
  return (
    <div className="flex flex-col gap-6">
      <Field label="Shape">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          className="self-start"
          aria-label="Shape"
          value={draft.shape}
          onValueChange={(v) => {
            if (!v) return;
            const shape = v as CustomViewConfig['shape'];
            setDraft({
              ...draft,
              shape,
              group: {
                ...draft.group,
                default:
                  shape === 'table'
                    ? null
                    : shape === 'group'
                      ? (draft.group.default ?? offered[0]?.key ?? null)
                      : draft.group.default,
              },
              pivot:
                shape === 'pivot' && !draft.pivot
                  ? {
                      rows: groupable[0]?.key ?? '',
                      columns: groupable[1]?.key ?? groupable[0]?.key ?? '',
                      value: numbers[0]?.key ?? '',
                      agg: 'sum',
                    }
                  : draft.pivot,
            });
          }}
        >
          {SHAPES.map((s) => {
            const Icon = shapeIcon(s.value);
            return (
              <ToggleGroupItem key={s.value} value={s.value} aria-label={s.label}>
                <Icon />
                {s.label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      </Field>
      {draft.shape === 'group' && (
        <Field label="Opens grouped by">
          <Select
            value={draft.group.default ?? NONE}
            onValueChange={(v) =>
              setDraft({ ...draft, group: { ...draft.group, default: v === NONE ? null : v } })
            }
          >
            <SelectTrigger aria-label="Default grouping" className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No grouping</SelectItem>
              {offered.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  <f.icon />
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Readers switch between the fields ticked under Group on Fields.
          </p>
        </Field>
      )}
      {draft.shape === 'pivot' && pivot && (
        <div className="grid gap-4 sm:grid-cols-2">
          {select('Rows', pivot.rows, groupable, (rows) =>
            setDraft({ ...draft, pivot: { ...pivot, rows } }),
          )}
          {select('Columns', pivot.columns, groupable, (columns) =>
            setDraft({ ...draft, pivot: { ...pivot, columns } }),
          )}
          {select('Value', pivot.value, numbers, (value) =>
            setDraft({ ...draft, pivot: { ...pivot, value } }),
          )}
          <Field label="Roll-up">
            <Select
              value={pivot.agg}
              onValueChange={(agg) =>
                setDraft({ ...draft, pivot: { ...pivot, agg: agg as typeof pivot.agg } })
              }
            >
              <SelectTrigger aria-label="Roll-up" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {viewAggs.map((a) => (
                  <SelectItem key={a} value={a}>
                    {AGG_LABELS[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      )}
      <Field label="Opens filtered by">
        <div className="flex flex-wrap items-center gap-1.5">
          {draft.filters.default.map((t, i) => (
            <Badge key={tokenText(t)} variant="secondary" className="gap-1 pr-0.5 font-normal">
              {tokenText(t)}
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-5 rounded-full"
                aria-label={`Remove filter ${tokenText(t)}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    filters: {
                      ...draft.filters,
                      default: draft.filters.default.filter((_, j) => j !== i),
                    },
                  })
                }
              >
                <XIcon />
              </Button>
            </Badge>
          ))}
          {!draft.filters.default.length && (
            <span className="text-sm text-muted-foreground">No filters.</span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDraft({ ...draft, filters: { ...draft.filters, default: current } })}
          >
            <FilterIcon />
            Use the page's filters
          </Button>
        </div>
      </Field>
      <Field label="Sidebar icon">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="Icon"
          className="flex-wrap justify-start"
          value={draft.icon ?? ''}
          onValueChange={(v) =>
            setDraft({ ...draft, icon: (v || null) as CustomViewConfig['icon'] })
          }
        >
          {Object.entries(VIEW_ICONS).map(([name, Icon]) => (
            <ToggleGroupItem key={name} value={name} aria-label={`Icon ${name}`}>
              <Icon />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
    </div>
  );
}

const CHIP_TEXT = 'text';
const ROW_GRID =
  'grid grid-cols-[1rem_minmax(0,1fr)_2.25rem_5.5rem_2.25rem_2.25rem_1.5rem] items-center gap-1 px-1.5 md:grid-cols-[1.25rem_minmax(0,1fr)_3rem_8rem_3rem_3rem_2rem] md:gap-2 md:px-2';

function FieldsSection<T>({
  base,
  domain,
  draft,
  setDraft,
  shownKeys,
  query,
  formulaProblems,
}: {
  base: ViewDomain<T>;
  domain: ViewDomain<T>;
  draft: CustomViewConfig;
  setDraft: Setter;
  shownKeys: string[];
  query: string;
  formulaProblems: (string | null)[];
}) {
  const sensors = useDrag();
  const [editing, setEditing] = useState<string | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const formulas = formulasOf(draft);
  const chips = chipsOf(draft);
  const allKeys = domain.fields.map((f) => f.key);
  const groupKeys = domain.fields.filter((f) => f.groupable).map((f) => f.key);
  const filterKeys = domain.fields.filter((f) => f.filterable).map((f) => f.key);
  const byKey = new Map(domain.fields.map((f) => [f.key, f]));
  const first = byKey.get(shownKeys[0] ?? '');
  const match = (f: ViewField<T>) =>
    !query || f.label.toLowerCase().includes(query) || f.key.includes(query);
  // Categorical text a reader sorts rows by (a kind, an account, a label) can be a chip.
  const chippable = (f: ViewField<T>) =>
    f.format === 'text' && (f.filterable || f.groupable) && f.key !== first?.key;
  // Shown fields first, in order; then hidden text fields (they still group and filter); the
  // rest fold away until asked for.
  const shown = shownKeys.map((k) => byKey.get(k)).filter((f): f is ViewField<T> => !!f);
  const hiddenText = domain.fields.filter(
    (f) => !shownKeys.includes(f.key) && (f.groupable || f.filterable),
  );
  const hidden = domain.fields.filter((f) => !shownKeys.includes(f.key) && !hiddenText.includes(f));
  const setColumns = (columns: string[]) => setDraft({ ...draft, columns });
  const placement = (key: string) => chips.find((c) => c.key === key)?.placement ?? CHIP_TEXT;
  const setPlacement = (key: string, v: string) =>
    setDraft({
      ...draft,
      chips:
        v === CHIP_TEXT
          ? chips.filter((c) => c.key !== key)
          : chips.some((c) => c.key === key)
            ? chips.map((c) => (c.key === key ? { key, placement: v as ViewChipPlacement } : c))
            : [...chips, { key, placement: v as ViewChipPlacement }],
    });
  const formulaKeys = (key: string) => {
    const i = formulas.findIndex((f) => f.key === key);
    return [
      ...base.fields.filter((f) => f.format !== 'text').map((f) => f.key),
      ...formulas.slice(0, i).map((f) => f.key),
    ];
  };

  const row = (f: ViewField<T>, sortable: boolean) => {
    const on = shownKeys.includes(f.key);
    const fi = formulas.findIndex((x) => x.key === f.key);
    const formula = fi >= 0 ? formulas[fi] : undefined;
    return (
      <FieldRow key={f.key} id={f.key} sortable={sortable} muted={!on}>
        <span className="flex min-w-0 items-center gap-2">
          <f.icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{f.label}</span>
          {f.note && (
            <Badge variant="secondary" className="hidden font-normal sm:inline-flex">
              {f.note}
            </Badge>
          )}
          {formula && (
            <Badge variant="outline" className="hidden text-primary sm:inline-flex">
              formula
            </Badge>
          )}
          {formula && formulaProblems[fi] && (
            <Badge variant="destructive" className="font-normal">
              fix
            </Badge>
          )}
        </span>
        <span className="grid place-items-center">
          <Switch
            size="sm"
            aria-label={`Show ${f.label}`}
            checked={on}
            onCheckedChange={(v) =>
              setColumns(v ? [...shownKeys, f.key] : shownKeys.filter((k) => k !== f.key))
            }
          />
        </span>
        <span className="min-w-0">
          {chippable(f) ? (
            <Select value={placement(f.key)} onValueChange={(v) => setPlacement(f.key, v)}>
              <SelectTrigger
                size="sm"
                aria-label={`${f.label} as a chip`}
                className="h-7 w-full min-w-0 px-2 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CHIP_TEXT}>Text</SelectItem>
                <SelectItem value="column">Own column</SelectItem>
                <SelectItem value="inline">On {first?.label ?? 'the first column'}</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Dash />
          )}
        </span>
        <span className="grid place-items-center">
          {f.groupable ? (
            <Checkbox
              aria-label={`Group by ${f.label}`}
              checked={(draft.group.fields.length ? draft.group.fields : groupKeys).includes(f.key)}
              onCheckedChange={(v) =>
                setDraft({
                  ...draft,
                  group: {
                    ...draft.group,
                    fields: toggleIn(draft.group.fields, groupKeys, f.key, v === true),
                    default:
                      v !== true && draft.group.default === f.key ? null : draft.group.default,
                  },
                })
              }
            />
          ) : (
            <Dash />
          )}
        </span>
        <span className="grid place-items-center">
          {f.filterable ? (
            <Checkbox
              aria-label={`Filter by ${f.label}`}
              checked={(draft.filters.fields.length ? draft.filters.fields : filterKeys).includes(
                f.key,
              )}
              onCheckedChange={(v) =>
                setDraft({
                  ...draft,
                  filters: {
                    ...draft.filters,
                    fields: toggleIn(draft.filters.fields, filterKeys, f.key, v === true),
                    default:
                      v === true
                        ? draft.filters.default
                        : draft.filters.default.filter((t) => t.key !== f.key),
                  },
                })
              }
            />
          ) : (
            <Dash />
          )}
        </span>
        <span className="grid place-items-center">
          {formula && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Edit formula ${f.label}`}
              aria-expanded={editing === f.key}
              onClick={() => setEditing(editing === f.key ? null : f.key)}
            >
              <PencilIcon />
            </Button>
          )}
        </span>
        {formula && editing === f.key && (
          <FormulaForm
            formula={formula}
            issue={formulaProblems[fi] ?? null}
            keys={formulaKeys(f.key)}
            onChange={(p) => {
              const next = formulas.map((x, j) => (j === fi ? { ...x, ...p } : x));
              // A renamed key carries its column, chip and tiles with it.
              const was = formula.key;
              const now = p.key ?? was;
              const rename = (k: string) => (k === was ? now : k);
              setDraft({
                ...draft,
                formulas: next,
                columns: draft.columns.map(rename),
                tiles: tilesOf(draft).map((t) => ({ ...t, field: rename(t.field) })),
              });
              if (now !== was) setEditing(now);
            }}
            onRemove={() => {
              setEditing(null);
              setDraft({
                ...draft,
                formulas: formulas.filter((_, j) => j !== fi),
                columns: draft.columns.filter((k) => k !== f.key),
              });
            }}
            onDone={() => setEditing(null)}
          />
        )}
      </FieldRow>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border" data-testid="view-fields">
        <div
          className={cn(
            ROW_GRID,
            'sticky top-0 z-10 h-8 bg-muted text-[0.65rem] font-semibold md:tracking-wide text-muted-foreground uppercase md:text-[0.7rem]',
          )}
        >
          <span />
          <span>Field</span>
          <span className="text-center">Show</span>
          <span className="text-center">Chip</span>
          <span className="text-center">Group</span>
          <span className="text-center">Filter</span>
          <span />
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(e) => setColumns(moved(shownKeys, e))}
        >
          <SortableContext items={shownKeys} strategy={verticalListSortingStrategy}>
            {shown.filter(match).map((f) => row(f, !query))}
          </SortableContext>
        </DndContext>
        {hiddenText.filter(match).map((f) => row(f, false))}
        {hidden.filter(match).length > 0 && (
          <Collapsible open={hiddenOpen || !!query} onOpenChange={setHiddenOpen}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="h-10 w-full justify-start rounded-none border-t px-3 font-normal text-muted-foreground"
              >
                <ChevronRightIcon
                  className={cn('transition-transform', (hiddenOpen || query) && 'rotate-90')}
                />
                {hidden.filter(match).length} more fields, hidden
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-wrap gap-1.5 border-t bg-muted/30 p-3">
              {hidden.filter(match).map((f) => (
                <Button
                  key={f.key}
                  variant="outline"
                  size="xs"
                  className="rounded-full border-dashed font-normal"
                  onClick={() => setColumns([...shownKeys, f.key])}
                >
                  <PlusIcon />
                  {f.label}
                </Button>
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {base.formulas && (
          <Button
            variant="outline"
            size="sm"
            disabled={formulas.length >= MAX_FORMULAS}
            onClick={() => {
              const n = formulas.length + 1;
              let key = `formula_${n}`;
              for (let k = n; allKeys.includes(key); k++) key = `formula_${k + 1}`;
              setDraft({
                ...draft,
                formulas: [
                  ...formulas,
                  { key, label: `Formula ${n}`, expr: '', format: 'number', agg: null },
                ],
                columns: [...shownKeys, key],
              });
              setEditing(key);
            }}
          >
            <SigmaIcon />
            Add formula
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          Drag <GripVerticalIcon className="inline size-3" /> to reorder columns.
          {base.formulas &&
            ' A formula reads field keys with + - * / % ^, comparisons, a ? b : c, group_sum("key") over the row’s group and total_sum("key") over every shown row.'}
        </span>
      </div>
    </div>
  );
}

function Dash() {
  return <span className="block text-center text-muted-foreground/50">–</span>;
}

/** One row of the Fields list; shown rows drag by their handle. */
function FieldRow({
  id,
  sortable,
  muted,
  children,
}: {
  id: string;
  sortable: boolean;
  muted: boolean;
  children: ReactNode;
}) {
  const s = useSortable({ id, disabled: !sortable });
  return (
    <div
      ref={s.setNodeRef}
      data-field={id}
      style={{ transform: CSS.Transform.toString(s.transform), transition: s.transition }}
      className={cn(
        ROW_GRID,
        'min-h-11 border-t bg-popover py-1.5 text-sm',
        muted && '[&>span:nth-child(2)]:text-muted-foreground',
        s.isDragging && 'relative z-20 shadow-md',
      )}
    >
      {sortable ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
          aria-label={`Drag ${id}`}
          {...s.attributes}
          {...s.listeners}
        >
          <GripVerticalIcon />
        </Button>
      ) : (
        <span />
      )}
      {children}
    </div>
  );
}

function SummarySection<T>({
  domain,
  draft,
  setDraft,
  rows,
  tileProblems,
}: {
  domain: ViewDomain<T>;
  draft: CustomViewConfig;
  setDraft: Setter;
  rows: T[];
  tileProblems: (string | null)[];
}) {
  const sensors = useDrag();
  const widgets = domain.widgets ?? [];
  const tiles = tilesOf(draft);
  const [current, setCurrent] = useState<string | null>(
    draft.widgets[0] ?? tiles[0]?.key ?? widgets[0]?.key ?? null,
  );
  const computed = useMemo(() => computedOf(domain, rows, null), [domain, rows]);
  const fieldOf = (k: string) => domain.fields.find((f) => f.key === k);
  const tileValue = (t: ViewTile): ViewCellValue => {
    const f = fieldOf(t.field);
    return f
      ? rollUp(
          rows.map((r) => computed.value(f, r)),
          t.agg,
        )
      : null;
  };
  const onWidgets = draft.widgets.filter((k) => widgets.some((w) => w.key === k));
  const offWidgets = widgets.filter((w) => !onWidgets.includes(w.key));
  const ordered = [
    ...onWidgets.map((k) => widgets.find((w) => w.key === k)).filter((w) => !!w),
    ...offWidgets,
  ] as typeof widgets;
  const setTile = (i: number, p: Partial<ViewTile>) =>
    setDraft({ ...draft, tiles: tiles.map((t, j) => (j === i ? { ...t, ...p } : t)) });
  const widget = widgets.find((w) => w.key === current);
  const ti = tiles.findIndex((t) => t.key === current);
  const tile = ti >= 0 ? tiles[ti] : undefined;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">Pick a tile to edit it; drag to reorder.</p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(e) => {
          const keys = [...onWidgets, ...tiles.map((t) => t.key)];
          const next = moved(keys, e);
          setDraft({
            ...draft,
            widgets: next.filter((k) => onWidgets.includes(k)),
            tiles: next
              .map((k) => tiles.find((t) => t.key === k))
              .filter((t): t is ViewTile => !!t),
          });
        }}
      >
        <SortableContext
          items={[...onWidgets, ...tiles.map((t) => t.key)]}
          strategy={rectSortingStrategy}
        >
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3" data-testid="view-tiles">
            {ordered.map((w) => (
              <TileCard
                key={w.key}
                id={w.key}
                sortable={onWidgets.includes(w.key)}
                selected={current === w.key}
                onSelect={() => setCurrent(w.key)}
                kind="built-in"
                label={w.label}
                value={onWidgets.includes(w.key) ? 'On' : 'Off'}
                how="Built in"
                off={!onWidgets.includes(w.key)}
              />
            ))}
            {tiles.map((t, i) => (
              <TileCard
                key={t.key || i}
                id={t.key}
                sortable
                selected={current === t.key}
                onSelect={() => setCurrent(t.key)}
                kind="yours"
                label={t.label}
                value={
                  <ViewValuePreview
                    value={tileValue(t)}
                    format={t.agg === 'count' ? 'integer' : (fieldOf(t.field)?.format ?? 'number')}
                    amount={t.agg !== 'count' && !!fieldOf(t.field)?.amount}
                  />
                }
                how={`${AGG_LABELS[t.agg]} of ${fieldOf(t.field)?.label ?? t.field}`}
                problem={!!tileProblems[i]}
              />
            ))}
            {domain.formulas && (
              <Button
                variant="outline"
                className="h-auto min-h-20 border-dashed font-normal text-muted-foreground"
                disabled={tiles.length >= MAX_TILES}
                onClick={() => {
                  let n = tiles.length + 1;
                  const taken = [...widgets.map((w) => w.key), ...tiles.map((t) => t.key)];
                  while (taken.includes(`tile_${n}`)) n++;
                  const key = `tile_${n}`;
                  setDraft({
                    ...draft,
                    tiles: [
                      ...tiles,
                      {
                        key,
                        label: `Tile ${n}`,
                        field: domain.fields.find((f) => f.format !== 'text')?.key ?? '',
                        agg: 'sum',
                      },
                    ],
                  });
                  setCurrent(key);
                }}
              >
                <PlusIcon />
                Add tile
              </Button>
            )}
          </div>
        </SortableContext>
      </DndContext>
      {widget && (
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <widget.icon className="size-4 text-muted-foreground" />
            <h4 className="flex-1 font-medium">{widget.label}</h4>
            <Label className="text-xs font-normal text-muted-foreground">
              Show
              <Switch
                aria-label={`Show ${widget.label}`}
                checked={onWidgets.includes(widget.key)}
                onCheckedChange={(v) =>
                  setDraft({
                    ...draft,
                    widgets: v
                      ? [...onWidgets, widget.key]
                      : onWidgets.filter((k) => k !== widget.key),
                  })
                }
              />
            </Label>
          </div>
          <p className="text-sm text-muted-foreground">
            A built-in tile. It follows the view's filters.
          </p>
        </div>
      )}
      {tile && (
        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <h4 className="flex-1 font-medium">{tile.label || tile.key}</h4>
            <ConfirmDelete
              title={`Remove tile ${tile.label || tile.key}?`}
              description="It leaves this view when you save."
              action="Remove"
              onConfirm={() => {
                setCurrent(null);
                setDraft({ ...draft, tiles: tiles.filter((_, j) => j !== ti) });
              }}
            >
              <Button variant="outline" size="sm" className="text-destructive">
                <Trash2Icon />
                Remove
              </Button>
            </ConfirmDelete>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="tile-label">Label</Label>
              <Input
                id="tile-label"
                value={tile.label}
                onChange={(e) => setTile(ti, { label: e.target.value })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tile-key">Key</Label>
              <Input
                id="tile-key"
                className="font-mono text-xs"
                value={tile.key}
                onChange={(e) => {
                  setTile(ti, { key: e.target.value });
                  setCurrent(e.target.value);
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Field</Label>
              <Select
                value={tile.field || undefined}
                onValueChange={(v) => setTile(ti, { field: v })}
              >
                <SelectTrigger aria-label="Tile field" className="w-full">
                  <SelectValue placeholder="Pick a field" />
                </SelectTrigger>
                <SelectContent>
                  {domain.fields.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      <f.icon />
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Roll-up</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              className="flex-wrap justify-start"
              aria-label="Roll-up"
              value={tile.agg}
              onValueChange={(v) => v && setTile(ti, { agg: v as ViewTile['agg'] })}
            >
              {viewAggs.map((a) => (
                <ToggleGroupItem key={a} value={a}>
                  {AGG_LABELS[a]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          {tileProblems[ti] && (
            <p role="alert" className="text-xs text-destructive">
              {tileProblems[ti]}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** A tile in the Summary grid: its label, a preview of its value and how it is made. */
function TileCard({
  id,
  sortable,
  selected,
  onSelect,
  kind,
  label,
  value,
  how,
  off,
  problem,
}: {
  id: string;
  sortable: boolean;
  selected: boolean;
  onSelect: () => void;
  kind: 'built-in' | 'yours';
  label: string;
  value: ReactNode;
  how: string;
  off?: boolean;
  problem?: boolean;
}) {
  const s = useSortable({ id, disabled: !sortable });
  return (
    <Button
      ref={s.setNodeRef}
      variant="outline"
      style={{ transform: CSS.Transform.toString(s.transform), transition: s.transition }}
      className={cn(
        'relative h-auto min-h-20 flex-col items-start justify-start gap-0.5 rounded-xl px-3 py-2.5 text-left font-normal whitespace-normal',
        selected && 'border-primary ring-3 ring-primary/15',
        off && 'opacity-60',
        problem && 'border-destructive',
        s.isDragging && 'z-20 shadow-md',
      )}
      {...(sortable ? { ...s.attributes, ...s.listeners } : {})}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <Badge
        variant={kind === 'yours' ? 'outline' : 'secondary'}
        className={cn('absolute top-2 right-2 font-normal', kind === 'yours' && 'text-primary')}
      >
        {kind}
      </Badge>
      <span className="pr-14 text-xs text-muted-foreground">{label}</span>
      <span className="num text-lg font-semibold">{value}</span>
      <span className="w-full truncate font-mono text-[0.7rem] text-muted-foreground">{how}</span>
    </Button>
  );
}

/** A tile's value in the Summary grid: the same figures as the page, plain. */
function ViewValuePreview({
  value,
  format,
  amount,
}: {
  value: ViewCellValue;
  format: string;
  amount: boolean;
}) {
  const hidden = useAmountsHidden() && amount;
  if (value === null) return <>—</>;
  if (typeof value === 'string') return <>{value}</>;
  const abs = hidden
    ? maskAmount('0')
    : Math.abs(value).toLocaleString('en-US', {
        minimumFractionDigits: format === 'integer' ? 0 : 2,
        maximumFractionDigits: format === 'integer' ? 0 : 2,
      });
  const sign = value < 0 ? '−' : '';
  return <>{format === 'price' ? `${sign}$${abs}` : `${sign}${abs}`}</>;
}

function MoreSection({
  name,
  viewId,
  onDuplicate,
  onDelete,
}: {
  name: string;
  viewId?: string;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      {viewId && (
        <Field label="View id">
          <p className="text-xs text-muted-foreground">
            Give it to an agent to read or change this view (custom_view_read, custom_view_write).
          </p>
          <InputGroup>
            <InputGroupInput
              aria-label="View id"
              readOnly
              value={viewId}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Copy view id"
                onClick={() =>
                  void navigator.clipboard.writeText(viewId).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                }
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
      )}
      {onDuplicate && (
        <Field label="Duplicate">
          <Button variant="outline" className="self-start" onClick={onDuplicate}>
            <CopyIcon />
            Duplicate view
          </Button>
        </Field>
      )}
      {onDelete && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/40 p-4">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium">Delete view</span>
            <span className="text-sm text-muted-foreground">
              Removes it for you. You confirm first.
            </span>
          </div>
          <ConfirmDelete title={`Delete view ${name}?`} onConfirm={onDelete}>
            <Button variant="outline" className="text-destructive">
              <Trash2Icon />
              Delete…
            </Button>
          </ConfirmDelete>
        </div>
      )}
    </div>
  );
}
