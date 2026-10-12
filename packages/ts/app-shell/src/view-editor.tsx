// The Edit view dialog (Bikram, 2026-10-12, mock 2b): two panes. Left, a tree of every field the
// view's rows reach, grouped by where it comes from (Holding, Symbol by topic, Account, Formulas),
// ticked to show. Right, what the view does with them: column order (drag), shape, group, filter,
// sort, header tiles, then the view id, Duplicate and Delete. Name, icon, Cancel and Save sit in
// the header. On a phone the panes are two tabs, Fields and Layout. Everything here is the view's
// config, which agents write the same way through MCP custom_view_write.
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
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Columns3Icon,
  CopyIcon,
  EllipsisIcon,
  FilterIcon,
  GripVerticalIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  ShapesIcon,
  SigmaIcon,
  SlidersHorizontalIcon,
  SmileIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { ConfirmDelete } from './confirm';
import { DrawerSection } from './drawer-section';
import { useIsMobile } from './hooks/use-mobile';
import { cn } from './lib/utils';
import { maskAmount, useAmountsHidden } from './shell';
import { type FilterToken, tokenText } from './token-filter';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { EmojiPicker, EmojiPickerContent, EmojiPickerSearch } from './ui/emoji-picker';
import { Input } from './ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './ui/input-group';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Separator } from './ui/separator';
import { Switch } from './ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import {
  AGG_LABELS,
  FormulaForm,
  MAX_FORMULAS,
  MAX_TILES,
  formulaIssues,
  tileIssues,
} from './view-formulas';
import { VIEW_ICONS, lucideIconNames, shapeIcon, viewIcon } from './view-icons';
import {
  FORMULAS_GROUP,
  type ViewCellValue,
  type ViewDomain,
  type ViewField,
  type ViewFieldGroup,
  canFilter,
  chipsOf,
  computedOf,
  formulasOf,
  groupOf,
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

const SHAPES = [
  { value: 'table', label: 'Table' },
  { value: 'group', label: 'Group' },
  { value: 'pivot', label: 'Pivot' },
] as const;

const NONE = '_none';
const CHIP_TEXT = 'text';
/** The colour of fields with no group colour (formulas, a domain without groups). */
const PLAIN = 'var(--color-muted-foreground)';

/** `list` with `key` on or off; an empty list stands for `all`, kept in `order`. */
const toggleIn = (list: string[], all: string[], key: string, on: boolean, order = all) => {
  const base = list.length ? list : all;
  const next = on ? [...base, key] : base.filter((k) => k !== key);
  return order.filter((k) => next.includes(k));
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

/** The tree's groups: the domain's own, else one; then the view's formulas. */
function groupsOf<T>(domain: ViewDomain<T>): ViewFieldGroup[] {
  const own = domain.groups?.length ? domain.groups : [{ id: '', label: 'Fields' }];
  return domain.formulas ? [...own, { id: FORMULAS_GROUP, label: 'Formulas', color: PLAIN }] : own;
}

type Setter = (c: CustomViewConfig) => void;

type SectionId = 'details' | 'header' | 'columns' | 'formulas' | 'desk' | 'more';

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
  const isMobile = useIsMobile();
  const [draft, setDraft] = useState(config);
  const [tab, setTab] = useState<'view' | 'fields'>('view');
  const [sections, setSections] = useState<Set<SectionId>>(new Set(['details', 'columns']));
  // The formula open in the Formulas section.
  const [editing, setEditing] = useState<string | null>(null);
  const domain = withFormulas(base, draft);
  const widgetKeys = (base.widgets ?? []).map((w) => w.key);
  const formulas = formulasOf(draft);
  const formulaProblems = formulaIssues(
    formulas,
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
  const section = (id: SectionId) => ({
    open: sections.has(id),
    onOpenChange: (o: boolean) => {
      const next = new Set(sections);
      if (o) next.add(id);
      else next.delete(id);
      setSections(next);
    },
  });

  const edit = (key: string | null) => {
    setEditing(key);
    if (key) {
      setSections(new Set(sections).add('formulas'));
      setTab('view');
    }
  };
  const addFormula = () => {
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
    edit(key);
  };
  const save = () => {
    const keys = new Set(domain.fields.map((f) => f.key));
    // A removed field leaves its chip and sort too.
    onSave({
      ...draft,
      name: draft.name.trim(),
      columns: draft.columns.filter((k) => keys.has(k)),
      chips: chipsOf(draft).filter((c) => keys.has(c.key)),
      sort: draft.sort && keys.has(draft.sort.key) ? draft.sort : null,
    });
    onOpenChange(false);
  };

  const tree = (
    <FieldTree
      domain={domain}
      draft={draft}
      setDraft={setDraft}
      shownKeys={shownKeys}
      formulaProblems={formulaProblems}
      onEditFormula={edit}
      onAddFormula={formulas.length < MAX_FORMULAS ? addFormula : undefined}
    />
  );
  const tiles = tilesOf(draft).length + draft.widgets.length;
  const main = (
    <div className="flex flex-col">
      <DrawerSection icon={SlidersHorizontalIcon} title="Details" {...section('details')}>
        <DetailsSection
          domain={domain}
          draft={draft}
          setDraft={setDraft}
          shownKeys={shownKeys}
          current={current}
        />
      </DrawerSection>
      {(domain.widgets?.length || domain.formulas) && (
        <DrawerSection
          icon={LayoutDashboardIcon}
          title="Header"
          count={tiles}
          hint="tiles over the table"
          {...section('header')}
        >
          <SummarySection
            domain={domain}
            draft={draft}
            setDraft={setDraft}
            rows={rows}
            tileProblems={tileProblems}
          />
        </DrawerSection>
      )}
      <DrawerSection
        icon={Columns3Icon}
        title="Columns"
        count={shownKeys.length}
        hint="drag to reorder"
        {...section('columns')}
      >
        <ColumnList
          domain={domain}
          draft={draft}
          setDraft={setDraft}
          shownKeys={shownKeys}
          onEditFormula={edit}
        />
      </DrawerSection>
      {domain.formulas && (
        <DrawerSection
          icon={SigmaIcon}
          title="Formulas"
          count={formulas.length}
          hint="columns you compute"
          {...section('formulas')}
        >
          <FormulasSection
            base={base}
            draft={draft}
            setDraft={setDraft}
            formulaProblems={formulaProblems}
            editing={editing}
            setEditing={setEditing}
            onAdd={formulas.length < MAX_FORMULAS ? addFormula : undefined}
          />
        </DrawerSection>
      )}
      {editor && (
        <DrawerSection icon={editor.icon} title={editor.title} {...section('desk')}>
          {editor.description && (
            <p className="mb-3 text-sm text-muted-foreground">{editor.description}</p>
          )}
          {editor.content}
        </DrawerSection>
      )}
      <DrawerSection
        icon={EllipsisIcon}
        title="More"
        hint="view id, duplicate, delete"
        {...section('more')}
      >
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
      </DrawerSection>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setDraft(config);
          setEditing(null);
          setTab('view');
          setSections(new Set(['details', 'columns']));
        }
        onOpenChange(o);
      }}
    >
      <DialogContent
        data-slot="view-editor"
        showCloseButton={false}
        className="flex h-[min(780px,calc(100svh-2rem))] flex-col gap-0 overflow-hidden p-0 max-md:h-svh max-md:max-w-full max-md:rounded-none max-md:ring-0 sm:max-w-6xl"
      >
        <DialogDescription className="sr-only">
          This view's details, header tiles, columns and formulas, and the fields it can show.
        </DialogDescription>
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2 md:px-4">
          {isMobile && (
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <XIcon />
              </Button>
            </DialogClose>
          )}
          <DialogTitle className="min-w-0 truncate text-sm font-semibold">
            Edit view <span className="font-normal text-muted-foreground">· {draft.name}</span>
          </DialogTitle>
          <span className="flex-1" />
          {!isMobile && (
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
          )}
          <Button size="sm" disabled={bad} onClick={save}>
            <CheckIcon />
            Save
          </Button>
        </header>
        {isMobile ? (
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as typeof tab)}
            className="min-h-0 flex-1 gap-0 pt-2"
          >
            <TabsList className="mx-3 w-[calc(100%-1.5rem)]">
              <TabsTrigger value="view">View</TabsTrigger>
              <TabsTrigger value="fields">
                Fields · <span className="num">{shownKeys.length}</span>
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="view"
              className="min-h-0 overflow-y-auto px-2 py-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
            >
              {main}
            </TabsContent>
            <TabsContent value="fields" className="min-h-0 overflow-y-auto px-3 py-2">
              {tree}
            </TabsContent>
          </Tabs>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px]">
            <section aria-label="View" className="min-h-0 overflow-y-auto px-3 py-2">
              {main}
            </section>
            <aside
              aria-label="Fields"
              className="flex min-h-0 flex-col overflow-y-auto border-l bg-sidebar px-2 py-2"
            >
              <p className="px-1.5 pb-2 text-xs text-muted-foreground">
                Tick a field to add it as a column.
              </p>
              {tree}
              <p className="mt-auto px-2 pt-4 text-xs text-muted-foreground">
                Agents change the same settings with{' '}
                <code className="font-mono">custom_view_write</code>.
              </p>
            </aside>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The right pane: every field by group and topic, ticked to show it as a column. */
function FieldTree<T>({
  domain,
  draft,
  setDraft,
  shownKeys,
  formulaProblems,
  onEditFormula,
  onAddFormula,
}: {
  domain: ViewDomain<T>;
  draft: CustomViewConfig;
  setDraft: Setter;
  shownKeys: string[];
  formulaProblems: (string | null)[];
  onEditFormula: (key: string) => void;
  onAddFormula?: () => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  // Open groups and topics; a group or topic starts open when it has a shown field.
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const formulas = formulasOf(draft);
  const match = (f: ViewField<T>) =>
    !q ||
    f.label.toLowerCase().includes(q) ||
    f.key.includes(q) ||
    !!f.topic?.toLowerCase().includes(q);
  const setShown = (key: string, on: boolean) =>
    setDraft({
      ...draft,
      columns: on ? [...shownKeys, key] : shownKeys.filter((k) => k !== key),
    });
  const isOpen = (id: string, fields: ViewField<T>[]) =>
    !!q || (toggled.get(id) ?? fields.some((f) => shownKeys.includes(f.key)));
  const flip = (id: string, now: boolean) => setToggled(new Map(toggled).set(id, !now));

  const leaf = (f: ViewField<T>, color: string) => {
    const fi = formulas.findIndex((x) => x.key === f.key);
    return (
      <div
        key={f.key}
        className="flex min-h-8 items-center gap-2 rounded-md pr-1 hover:bg-accent/60"
      >
        <Label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 font-normal">
          <Checkbox
            checked={shownKeys.includes(f.key)}
            onCheckedChange={(v) => setShown(f.key, v === true)}
            aria-label={`Show ${f.label}`}
          />
          <span className="truncate">{f.label}</span>
          {f.note && (
            <Badge variant="secondary" className="font-normal">
              {f.note}
            </Badge>
          )}
          {fi >= 0 && formulaProblems[fi] && (
            <Badge variant="destructive" className="font-normal">
              fix
            </Badge>
          )}
        </Label>
        <Badge variant="secondary" className="ml-auto shrink-0 font-normal">
          {FORMAT_NAMES[f.format] ?? f.format}
        </Badge>
        <code
          className="max-w-[40%] truncate font-mono text-[0.7rem] text-muted-foreground max-md:hidden"
          title={f.formula ?? f.key}
        >
          {fi >= 0 ? formulas[fi]?.expr || 'no expression yet' : f.key}
        </code>
        {fi >= 0 && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Edit formula ${f.label}`}
            onClick={() => onEditFormula(f.key)}
          >
            <PencilIcon />
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-1" data-testid="view-fields">
      <InputGroup className="mb-1 bg-background">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          className="[&::-webkit-search-cancel-button]:hidden"
          aria-label="Search fields"
          placeholder={`Search ${domain.fields.length} fields`}
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
      {groupsOf(domain).map((g) => {
        const all = domain.fields.filter((f) => groupOf(domain, f) === g.id);
        const fields = all.filter(match);
        const formulasGroup = g.id === FORMULAS_GROUP;
        if (q && !fields.length) return null;
        if (!all.length && !formulasGroup) return null;
        const color = g.color ?? PLAIN;
        const open = isOpen(`g:${g.id}`, all) || (formulasGroup && !all.length);
        const topics = [...new Set(fields.map((f) => f.topic ?? ''))];
        return (
          <Collapsible key={g.id} open={open} onOpenChange={() => flip(`g:${g.id}`, open)}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 px-1.5 font-semibold"
              >
                <ChevronRightIcon
                  className={cn('text-muted-foreground transition-transform', open && 'rotate-90')}
                />
                <span className="size-2 shrink-0 rounded-[2px]" style={{ background: color }} />
                {formulasGroup && <SigmaIcon className="text-muted-foreground" />}
                <span className="shrink-0">{g.label}</span>
                {g.note && (
                  <span className="truncate text-xs font-normal text-muted-foreground max-md:hidden">
                    {g.note}
                  </span>
                )}
                <span className="num ml-auto text-xs font-normal text-muted-foreground">
                  {all.filter((f) => shownKeys.includes(f.key)).length} / {all.length}
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col pl-6">
              {topics.map((t) => {
                const inTopic = fields.filter((f) => (f.topic ?? '') === t);
                if (!t) return inTopic.map((f) => leaf(f, color));
                const id = `t:${g.id}:${t}`;
                const topicOpen = isOpen(
                  id,
                  all.filter((f) => f.topic === t),
                );
                return (
                  <Collapsible key={t} open={topicOpen} onOpenChange={() => flip(id, topicOpen)}>
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="w-full justify-start gap-1.5 px-1 text-muted-foreground"
                      >
                        <ChevronRightIcon
                          className={cn('transition-transform', topicOpen && 'rotate-90')}
                        />
                        <span className="font-semibold">{t}</span>
                        <span className="num">
                          {inTopic.filter((f) => shownKeys.includes(f.key)).length}/{inTopic.length}
                        </span>
                        {g.sources?.[t] && (
                          <span className="ml-auto truncate font-normal">{g.sources[t]}</span>
                        )}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="flex flex-col pl-5">
                      {inTopic.map((f) => leaf(f, color))}
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
              {formulasGroup && onAddFormula && !q && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start gap-2 px-1 text-primary"
                  onClick={onAddFormula}
                >
                  <PlusIcon />
                  New formula
                </Button>
              )}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}

/** A label beside its control, as the layout boxes lay them out. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** Details: name and icon, shape, the default grouping and sort, the filters it opens with. */
function DetailsSection<T>({
  domain,
  draft,
  setDraft,
  shownKeys,
  current,
}: {
  domain: ViewDomain<T>;
  draft: CustomViewConfig;
  setDraft: Setter;
  shownKeys: string[];
  current: FilterToken[];
}) {
  const groupable = domain.fields.filter((f) => f.groupable);
  const groupKeys = groupable.map((f) => f.key);
  const numbers = domain.fields.filter((f) => f.format !== 'text');
  const groupChoices = draft.group.fields.length ? draft.group.fields : groupKeys;
  const offered = groupable.filter((f) => groupChoices.includes(f.key));
  const byKey = new Map(domain.fields.map((f) => [f.key, f]));
  const shown = shownKeys.map((k) => byKey.get(k)).filter((f): f is ViewField<T> => !!f);
  const pivot = draft.pivot;
  const fieldSelect = (
    label: string,
    value: string,
    fields: ViewField<T>[],
    onChange: (v: string) => void,
    none?: string,
  ) => (
    <Select value={value || (none ? NONE : undefined)} onValueChange={onChange}>
      <SelectTrigger aria-label={label} size="sm" className="w-full min-w-0">
        <SelectValue placeholder="Pick a field" />
      </SelectTrigger>
      <SelectContent>
        {none && <SelectItem value={NONE}>{none}</SelectItem>}
        {fields.map((f) => (
          <SelectItem key={f.key} value={f.key}>
            <f.icon />
            {f.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex max-w-xl flex-col gap-3">
      <Row label="Name">
        <InputGroup>
          <InputGroupAddon>
            <IconPicker draft={draft} setDraft={setDraft} />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="View name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </InputGroup>
      </Row>
      <Row label="Shape">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          className="justify-self-start"
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
      </Row>
      {draft.shape === 'group' && (
        <Row label="Group by">
          {fieldSelect(
            'Default grouping',
            draft.group.default ?? '',
            offered,
            (v) =>
              setDraft({ ...draft, group: { ...draft.group, default: v === NONE ? null : v } }),
            'No grouping',
          )}
        </Row>
      )}
      {draft.shape === 'pivot' && pivot && (
        <>
          <Row label="Rows">
            {fieldSelect('Pivot rows', pivot.rows, groupable, (rows) =>
              setDraft({ ...draft, pivot: { ...pivot, rows } }),
            )}
          </Row>
          <Row label="Columns">
            {fieldSelect('Pivot columns', pivot.columns, groupable, (columns) =>
              setDraft({ ...draft, pivot: { ...pivot, columns } }),
            )}
          </Row>
          <Row label="Value">
            <div className="flex min-w-0 gap-2">
              {fieldSelect('Pivot value', pivot.value, numbers, (value) =>
                setDraft({ ...draft, pivot: { ...pivot, value } }),
              )}
              <Select
                value={pivot.agg}
                onValueChange={(agg) =>
                  setDraft({ ...draft, pivot: { ...pivot, agg: agg as typeof pivot.agg } })
                }
              >
                <SelectTrigger aria-label="Roll-up" size="sm" className="w-28 shrink-0">
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
            </div>
          </Row>
        </>
      )}
      <Row label="Sort">
        <div className="flex min-w-0 items-center gap-2">
          {fieldSelect(
            'Sort by',
            draft.sort?.key ?? '',
            shown,
            (v) =>
              setDraft({
                ...draft,
                sort: v === NONE ? null : { key: v, desc: draft.sort?.desc ?? true },
              }),
            'As loaded',
          )}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Sort direction"
            disabled={!draft.sort}
            value={draft.sort?.desc ? 'desc' : 'asc'}
            onValueChange={(v) =>
              v && draft.sort && setDraft({ ...draft, sort: { ...draft.sort, desc: v === 'desc' } })
            }
          >
            <ToggleGroupItem value="asc" aria-label="Ascending">
              <ArrowUpIcon />
            </ToggleGroupItem>
            <ToggleGroupItem value="desc" aria-label="Descending">
              <ArrowDownIcon />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </Row>
      <Row label="Opens with">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
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
            <span className="text-sm text-muted-foreground">No filters</span>
          )}
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => setDraft({ ...draft, filters: { ...draft.filters, default: current } })}
          >
            <FilterIcon />
            Use the page's filters
          </Button>
        </div>
      </Row>
    </div>
  );
}

const CHIP_LABELS: Record<string, string> = { text: 'Text', column: 'Chip', inline: 'On first' };
/** How a column's values read, for the Format column (Bikram, 2026-10-12). */
const FORMAT_NAMES: Record<string, string> = {
  price: 'Currency',
  number: 'Number',
  integer: 'Integer',
  percent: 'Signed percent',
  weight: 'Percent',
  signed: 'Signed number',
  text: 'Text',
};

/**
 * Columns: the shown fields in order, dragged to reorder, each ticked to be a filter or a
 * grouping choice, shown as text or a chip, or hidden with ×.
 */
function ColumnList<T>({
  domain,
  draft,
  setDraft,
  shownKeys,
  onEditFormula,
}: {
  domain: ViewDomain<T>;
  draft: CustomViewConfig;
  setDraft: Setter;
  shownKeys: string[];
  onEditFormula: (key: string) => void;
}) {
  const sensors = useDrag();
  const byKey = new Map(domain.fields.map((f) => [f.key, f]));
  const shown = shownKeys.map((k) => byKey.get(k)).filter((f): f is ViewField<T> => !!f);
  const chips = chipsOf(draft);
  const first = shown[0];
  const groupKeys = domain.fields.filter((f) => f.groupable).map((f) => f.key);
  const filterKeys = domain.fields.filter((f) => f.filterable).map((f) => f.key);
  const canFilterKeys = domain.fields.filter(canFilter).map((f) => f.key);
  const groupChoices = draft.group.fields.length ? draft.group.fields : groupKeys;
  const filterChoices = draft.filters.fields.length ? draft.filters.fields : filterKeys;
  const groupInfo = (f: ViewField<T>) => {
    const id = groupOf(domain, f);
    if (id === FORMULAS_GROUP) return { color: PLAIN, label: 'Formula' };
    const g = domain.groups?.find((x) => x.id === id);
    return { color: g?.color ?? PLAIN, label: f.topic ?? g?.label ?? '' };
  };
  const chippable = (f: ViewField<T>) =>
    f.format === 'text' && (f.filterable || f.groupable) && f.key !== first?.key;
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
  const isFormula = (key: string) => formulasOf(draft).some((x) => x.key === key);
  if (!shown.length)
    return <p className="text-sm text-muted-foreground">Tick fields on the right to show them.</p>;
  const grid =
    'grid grid-cols-[1.25rem_minmax(0,1fr)_3rem_3rem_1.75rem] items-center gap-x-2 md:grid-cols-[1.25rem_minmax(0,1fr)_3.5rem_3.5rem_6.5rem_1.75rem]';
  return (
    <div className="flex flex-col" data-testid="view-columns">
      <div className={cn(grid, 'pb-1 text-xs text-muted-foreground')}>
        <span />
        <span>Column</span>
        <span className="text-center">Filter</span>
        <span className="text-center">Group</span>
        <span className="max-md:hidden">Format</span>
        <span />
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(e) => setDraft({ ...draft, columns: moved(shownKeys, e) })}
      >
        <SortableContext items={shownKeys} strategy={verticalListSortingStrategy}>
          {shown.map((f) => {
            const g = groupInfo(f);
            const canF = canFilterKeys.includes(f.key);
            const canG = groupKeys.includes(f.key);
            return (
              <ColumnRow key={f.key} id={f.key} className={grid}>
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-4 w-1 shrink-0 rounded-full"
                    style={{ background: g.color }}
                    aria-hidden
                  />
                  <span className="truncate">{f.label}</span>
                  <span className="truncate text-xs text-muted-foreground max-md:hidden">
                    {g.label}
                  </span>
                  {isFormula(f.key) && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground"
                      aria-label={`Edit formula ${f.label}`}
                      onClick={() => onEditFormula(f.key)}
                    >
                      <PencilIcon />
                    </Button>
                  )}
                </span>
                <span className="flex justify-center">
                  <Checkbox
                    aria-label={`Filter by ${f.label}`}
                    disabled={!canF}
                    checked={canF && filterChoices.includes(f.key)}
                    onCheckedChange={(v) =>
                      setDraft({
                        ...draft,
                        filters: {
                          ...draft.filters,
                          fields: toggleIn(
                            draft.filters.fields,
                            filterKeys,
                            f.key,
                            v === true,
                            canFilterKeys,
                          ),
                          default:
                            v === true
                              ? draft.filters.default
                              : draft.filters.default.filter((t) => t.key !== f.key),
                        },
                      })
                    }
                  />
                </span>
                <span className="flex justify-center">
                  <Checkbox
                    aria-label={`Group by ${f.label}`}
                    disabled={!canG}
                    checked={canG && groupChoices.includes(f.key)}
                    onCheckedChange={(v) =>
                      setDraft({
                        ...draft,
                        group: {
                          ...draft.group,
                          fields: toggleIn(draft.group.fields, groupKeys, f.key, v === true),
                          default:
                            v !== true && draft.group.default === f.key
                              ? null
                              : draft.group.default,
                        },
                      })
                    }
                  />
                </span>
                <span className="max-md:hidden">
                  {chippable(f) ? (
                    <Select value={placement(f.key)} onValueChange={(v) => setPlacement(f.key, v)}>
                      <SelectTrigger
                        aria-label={`Show ${f.label} as`}
                        size="sm"
                        className="h-7 w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(CHIP_LABELS).map(([v, l]) => (
                          <SelectItem key={v} value={v}>
                            {v === 'inline' ? `On ${first?.label ?? 'first'}` : l}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="pl-2 text-xs text-muted-foreground">
                      {FORMAT_NAMES[f.format] ?? f.format}
                    </span>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  aria-label={`Hide ${f.label}`}
                  onClick={() =>
                    setDraft({ ...draft, columns: shownKeys.filter((k) => k !== f.key) })
                  }
                >
                  <XIcon />
                </Button>
              </ColumnRow>
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}

/** One column row: a drag handle, then its cells. */
function ColumnRow({
  id,
  className,
  children,
}: {
  id: string;
  className: string;
  children: ReactNode;
}) {
  const s = useSortable({ id });
  return (
    <div
      ref={s.setNodeRef}
      data-field={id}
      style={{ transform: CSS.Transform.toString(s.transform), transition: s.transition }}
      className={cn(
        className,
        'min-h-9 rounded-md border-b border-border/50 bg-card text-sm last:border-b-0 hover:bg-accent/40',
        s.isDragging && 'relative z-20 shadow-md',
      )}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-5 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
        aria-label={`Drag ${id}`}
        {...s.attributes}
        {...s.listeners}
      >
        <GripVerticalIcon />
      </Button>
      {children}
    </div>
  );
}

/** Formulas: each one a sub-item with its own editor (Bikram, 2026-10-12), then New formula. */
function FormulasSection<T>({
  base,
  draft,
  setDraft,
  formulaProblems,
  editing,
  setEditing,
  onAdd,
}: {
  base: ViewDomain<T>;
  draft: CustomViewConfig;
  setDraft: Setter;
  formulaProblems: (string | null)[];
  editing: string | null;
  setEditing: (key: string | null) => void;
  onAdd?: () => void;
}) {
  const formulas = formulasOf(draft);
  return (
    <div className="flex flex-col gap-1">
      {!formulas.length && (
        <p className="text-sm text-muted-foreground">
          A formula is a column you compute from other fields, like weight or upside.
        </p>
      )}
      {formulas.map((formula, fi) => {
        const open = editing === formula.key;
        const keys = [
          ...base.fields.filter((f) => f.format !== 'text').map((f) => f.key),
          ...formulas.slice(0, fi).map((f) => f.key),
        ];
        return (
          <Collapsible
            // biome-ignore lint/suspicious/noArrayIndexKey: the key is edited in place; the index keeps the editor mounted.
            key={fi}
            open={open}
            onOpenChange={(o) => setEditing(o ? formula.key : null)}
            className="rounded-md border"
          >
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-start gap-2 px-2">
                <ChevronRightIcon
                  className={cn('text-muted-foreground transition-transform', open && 'rotate-90')}
                />
                <SigmaIcon className="text-muted-foreground" />
                <span className="shrink-0">{formula.label || formula.key}</span>
                <code className="min-w-0 truncate font-mono text-xs font-normal text-muted-foreground">
                  {formula.expr || 'no expression yet'}
                </code>
                {formulaProblems[fi] && (
                  <Badge variant="destructive" className="ml-auto font-normal">
                    fix
                  </Badge>
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="[&>div]:border-t [&>div]:bg-transparent [&>div]:md:pl-3">
              <FormulaForm
                formula={formula}
                issue={formulaProblems[fi] ?? null}
                keys={keys}
                onChange={(p) => {
                  const next = formulas.map((x, j) => (j === fi ? { ...x, ...p } : x));
                  // A renamed key carries its column, chip, sort and tiles with it.
                  const was = formula.key;
                  const now = p.key ?? was;
                  const rename = (k: string) => (k === was ? now : k);
                  setDraft({
                    ...draft,
                    formulas: next,
                    columns: draft.columns.map(rename),
                    tiles: tilesOf(draft).map((t) => ({ ...t, field: rename(t.field) })),
                    sort: draft.sort ? { ...draft.sort, key: rename(draft.sort.key) } : null,
                  });
                  if (now !== was) setEditing(now);
                }}
                onRemove={() => {
                  setEditing(null);
                  setDraft({
                    ...draft,
                    formulas: formulas.filter((_, j) => j !== fi),
                    columns: draft.columns.filter((k) => k !== formula.key),
                  });
                }}
                onDone={() => setEditing(null)}
              />
            </CollapsibleContent>
          </Collapsible>
        );
      })}
      {onAdd && (
        <Button
          variant="ghost"
          size="sm"
          className="justify-start gap-2 self-start px-2 text-primary"
          onClick={onAdd}
        >
          <PlusIcon />
          New formula
        </Button>
      )}
    </div>
  );
}

/** Icon matches shown at once; search narrows the rest of lucide's set. */
const ICON_MATCHES = 120;

/** The sidebar icon: a popup with every lucide icon and every emoji (Bikram, 2026-10-12). */
function IconPicker({ draft, setDraft }: { draft: CustomViewConfig; setDraft: Setter }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'icons' | 'emoji'>('icons');
  const [q, setQ] = useState('');
  const Icon = viewIcon(draft);
  const pick = (icon: CustomViewConfig['icon']) => {
    setDraft({ ...draft, icon });
    setOpen(false);
  };
  const term = q.trim().toLowerCase().replace(/\s+/g, '-');
  const quick = Object.keys(VIEW_ICONS);
  const names = (
    term
      ? lucideIconNames.filter((n) => n.includes(term))
      : [...quick, ...lucideIconNames.filter((n) => !quick.includes(n))]
  ).slice(0, ICON_MATCHES);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setQ('');
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Sidebar icon" title="Sidebar icon">
          <Icon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-80 flex-col gap-0 p-0">
        <div className="p-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            className="w-full"
            aria-label="Icons or emoji"
            value={kind}
            onValueChange={(v) => v && setKind(v as typeof kind)}
          >
            <ToggleGroupItem value="icons" className="flex-1">
              <ShapesIcon />
              Icons
            </ToggleGroupItem>
            <ToggleGroupItem value="emoji" className="flex-1">
              <SmileIcon />
              Emoji
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Separator />
        {kind === 'icons' ? (
          <div className="flex h-80 flex-col">
            <div className="border-b p-2">
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput
                  aria-label="Search icons"
                  placeholder={`Search ${lucideIconNames.length.toLocaleString()} icons`}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              </InputGroup>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {names.length ? (
                <div className="grid grid-cols-8 gap-1">
                  {names.map((n) => {
                    const I = viewIcon({ icon: n, shape: draft.shape });
                    return (
                      <Button
                        key={n}
                        variant={draft.icon === n ? 'secondary' : 'ghost'}
                        size="icon-sm"
                        title={n}
                        aria-label={`Icon ${n}`}
                        aria-pressed={draft.icon === n}
                        onClick={() => pick(n)}
                      >
                        <I />
                      </Button>
                    );
                  })}
                </div>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">No icon found.</p>
              )}
            </div>
          </div>
        ) : (
          <EmojiPicker
            className="h-80 w-full"
            columns={9}
            onEmojiSelect={({ emoji }) => pick(emoji)}
          >
            <EmojiPickerSearch placeholder="Search emoji" />
            <EmojiPickerContent />
          </EmojiPicker>
        )}
        <Separator />
        <Button
          variant="ghost"
          size="sm"
          className="m-1 justify-start"
          disabled={!draft.icon}
          onClick={() => pick(null)}
        >
          <RotateCcwIcon />
          Use the shape's icon
        </Button>
      </PopoverContent>
    </Popover>
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
              <Button variant="destructive" size="sm">
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
    <div className="flex flex-col gap-4">
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
            <Button variant="destructive">
              <Trash2Icon />
              Delete…
            </Button>
          </ConfirmDelete>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}
