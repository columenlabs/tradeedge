import { type ViewTokenOp, meetsNumber } from '@edgedesk/types/views';
// The one filter box every view uses (Bikram, 2026-10-08): a click opens a menu grouped by field
// with counts; picking a value adds it to that field's chip, ⊘ (or typing `-field:value`) excludes
// it. One field: "in" any of its values and "not in" any excluded one; a chip's in/not in flips
// (Bikram, 2026-10-09). Different fields: all must match (AND). Free text matches the row's text
// and any field value. It filters the rows already loaded, on the client. The box is one row that
// never grows; menu groups start collapsed; phones get a bottom sheet (Bikram, 2026-10-11).
import { Command as CommandPrimitive } from 'cmdk';
import {
  BanIcon,
  ChevronRightIcon,
  type LucideIcon,
  SaveIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useIsMobile } from './hooks/use-mobile';
import { cn } from './lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Input } from './ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton } from './ui/input-group';
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

export interface FilterField<T> {
  key: string;
  label: string;
  icon: LucideIcon;
  /** The row's values for this field (a row can carry several, like symbols). */
  values: (row: T) => string[];
  /**
   * A number field (Bikram, 2026-10-11): filtered by one condition, `> 100`, `< 0`, `= 5` or
   * between, instead of by values.
   */
  number?: (row: T) => number | null;
}

export interface FilterToken {
  key: string;
  value: string;
  /** Excluded: rows with this value are dropped ("not in"). */
  not?: boolean;
  /** A number condition; `value` is a number, or `a..b` for between. */
  op?: ViewTokenOp;
}

const OP_SIGN: Record<ViewTokenOp, string> = { gt: '>', lt: '<', eq: '=', between: '' };
export const tokenText = (t: FilterToken) =>
  `${t.not ? '-' : ''}${t.key}:${t.op ? OP_SIGN[t.op] : ''}${t.value}`;
/** A number condition as people read it: `> 100`, `0 – 500`. */
const conditionText = (t: FilterToken) =>
  t.op === 'between' ? t.value.replace('..', ' – ') : `${OP_SIGN[t.op ?? 'eq']} ${t.value}`;
/** `field:>100`, `field:<0`, `field:=5`, `field:0..500` typed out for a number field. */
const NUMBER_TYPED = /^(\w+):(>|<|=)?(-?\d+(?:\.\d+)?)(?:\.\.(-?\d+(?:\.\d+)?))?$/;
/** Same field and value, included or not: a value sits in one chip only. */
const same = (a: FilterToken, b: FilterToken) =>
  a.key === b.key && a.value.toLowerCase() === b.value.toLowerCase();
const token = (key: string, value: string, not: boolean): FilterToken =>
  not ? { key, value, not } : { key, value };

/** Keeps the rows whose values pass every field's tokens, skipping the field `except`. */
function passes(
  values: Record<string, string[]>,
  nums: Record<string, number | null>,
  tokens: FilterToken[],
  fields: { key: string; number?: unknown }[],
  except?: string,
) {
  for (const f of fields) {
    if (f.key === except) continue;
    const of = tokens.filter((t) => t.key === f.key);
    if (f.number) {
      if (!of.every((t) => meetsNumber(t.op, t.value, nums[f.key] ?? null))) return false;
      continue;
    }
    const have = values[f.key] ?? [];
    const inc = of.filter((t) => !t.not).map((t) => t.value.toLowerCase());
    const exc = of.filter((t) => t.not).map((t) => t.value.toLowerCase());
    if (inc.length && !have.some((v) => inc.includes(v))) return false;
    if (exc.length && have.some((v) => exc.includes(v))) return false;
  }
  return true;
}
/** How many values a field lists in the menu before typing narrows it. */
const PER_FIELD = 8;

/** Keeps the tokens and text, and filters `rows` by them. */
export function useTokenFilter<T>(
  rows: T[],
  fields: FilterField<T>[],
  {
    text: textOf,
    initial = [],
  }: {
    /** Free-text haystack per row (a name, an id), besides the field values. */
    text?: (row: T) => string[];
    /** Tokens applied when the view opens (a view's default filters). */
    initial?: FilterToken[];
  } = {},
) {
  const [tokens, setTokens] = useState<FilterToken[]>(initial);
  const [text, setText] = useState('');
  const indexed = useMemo(
    () =>
      rows.map((row) => ({
        row,
        values: Object.fromEntries(
          fields.map((f) => [f.key, f.number ? [] : f.values(row).map((v) => v.toLowerCase())]),
        ) as Record<string, string[]>,
        nums: Object.fromEntries(
          fields.filter((f) => f.number).map((f) => [f.key, f.number?.(row) ?? null]),
        ) as Record<string, number | null>,
        text: (textOf?.(row) ?? []).map((v) => v.toLowerCase()),
      })),
    [rows, fields, textOf],
  );
  const results = useMemo(() => {
    const q = text.trim().toLowerCase();
    // A half-typed token ("sym", "symbol:", "-") narrows the menu, not the rows.
    const free =
      q && !q.startsWith('-') && !q.includes(':') && !fields.some((f) => f.key.startsWith(q))
        ? q
        : '';
    return indexed
      .filter(({ values, nums, text: hay }) => {
        if (!passes(values, nums, tokens, fields)) return false;
        if (!free) return true;
        return [...hay, ...Object.values(values).flat()].some((v) => v.includes(free));
      })
      .map(({ row }) => row);
  }, [indexed, fields, tokens, text]);
  return { fields, rows, indexed, tokens, setTokens, text, setText, results };
}

export type TokenFilterState<T> = ReturnType<typeof useTokenFilter<T>>;

type Chip = { key: string; not: boolean; tokens: FilterToken[] };
/** How a chip shows its values: all of them, a count once it has 2+ and the row is tight, or the
 * phone's short form (count and `=`/`≠`). */
type ChipForm = 'full' | 'count' | 'short';
/** A chip's widest (max-w-56), and the gap between chips (gap-1). */
const CHIP_MAX = 224;
const GAP = 4;

/** Which chips fit one row of `avail` px (Bikram, 2026-10-11, after p2e's filter): a chip with 2+
 * values folds to a count when its values pass the chip's cap or the row is tight (biggest saving
 * first); then chips from the end move behind "+N". */
function planChips(avail: number, full: number[], short: number[], more: number) {
  const width = full.map((w) => Math.min(w, CHIP_MAX));
  const count = full.map(() => false);
  full.forEach((w, i) => {
    if (w > CHIP_MAX && (short[i] ?? 0) < CHIP_MAX) {
      count[i] = true;
      width[i] = short[i] ?? 0;
    }
  });
  const total = (n: number) => width.slice(0, n).reduce((s, w) => s + w + GAP, 0);
  const order = full
    .map((_, i) => i)
    .filter((i) => !count[i] && (short[i] ?? 0) < (width[i] ?? 0))
    .sort((a, b) => (width[b] ?? 0) - (short[b] ?? 0) - ((width[a] ?? 0) - (short[a] ?? 0)));
  for (const i of order) {
    if (total(width.length) <= avail) break;
    count[i] = true;
    width[i] = short[i] ?? 0;
  }
  let shown = width.length;
  if (total(shown) > avail) {
    shown = 0;
    while (shown < width.length && total(shown + 1) + more <= avail) shown++;
  }
  return { shown, count };
}

function FilterChip({
  chip,
  field,
  form,
  wrap,
  className,
  onFlip,
  onRemove,
  onEdit,
}: {
  chip: Chip;
  field?: FilterField<never>;
  form: ChipForm;
  /** Values wrap instead of truncating (the phone sheet lists every chip in full). */
  wrap?: boolean;
  className?: string;
  onFlip: () => void;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const name = field?.label ?? chip.key;
  const verb = chip.not ? 'not in' : 'in';
  const values = chip.tokens.map((t) => t.value).join(', ');
  const shown = form !== 'full' && chip.tokens.length > 1 ? String(chip.tokens.length) : values;
  // A number field's chip holds its one condition, `> 100`.
  const condition = field?.number && chip.tokens[0];
  const title = condition ? `${name} ${conditionText(condition)}` : `${name} ${verb} ${values}`;
  return (
    <Badge
      variant="secondary"
      title={title}
      className={cn('h-6 max-w-56 justify-start gap-0 pr-0.5 pl-1 font-normal', className)}
    >
      <Button
        variant="ghost"
        size="xs"
        className="h-5 shrink-0 gap-1 px-1 font-normal text-muted-foreground"
        aria-label={`Edit ${name}`}
        onClick={onEdit}
      >
        {field && <field.icon className="size-3" />}
        {name}
      </Button>
      {condition ? (
        <Button
          variant="ghost"
          size="xs"
          className="h-5 min-w-0 shrink px-1 font-normal"
          aria-label={`Edit ${name} condition`}
          onClick={onEdit}
        >
          <span className="num truncate">{conditionText(condition)}</span>
        </Button>
      ) : (
        <>
          <Button
            variant="ghost"
            size="xs"
            className={cn(
              'h-5 shrink-0 px-1 font-normal text-muted-foreground',
              chip.not && 'text-destructive hover:text-destructive',
            )}
            aria-label={`${name} ${verb}: switch to ${chip.not ? 'in' : 'not in'}`}
            onClick={onFlip}
          >
            {form === 'short' ? (chip.not ? '≠' : '=') : verb}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className={cn('h-5 min-w-0 shrink px-1 font-normal', wrap && 'h-auto py-0.5')}
            aria-label={`Edit ${name} values`}
            onClick={onEdit}
          >
            <span className={cn('num', wrap ? 'text-left whitespace-normal' : 'truncate')}>
              {shown}
            </span>
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        className="size-4 shrink-0 rounded-full"
        aria-label={`Remove ${title}`}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </Badge>
  );
}

const OPS: { op: ViewTokenOp; label: string }[] = [
  { op: 'lt', label: 'Less' },
  { op: 'gt', label: 'Greater' },
  { op: 'between', label: 'Between' },
];
const isNumber = (v: string) => /^-?\d+(\.\d+)?$/.test(v.trim());

/** A number field's condition in the menu, two lines (Bikram, 2026-10-12): Less than, Greater
 * than or Between, then the number (0 by default). Each change filters at once. */
function NumberCondition({
  label,
  current,
  tall,
  count,
  onSet,
}: {
  label: string;
  current?: FilterToken;
  /** Phone: taller controls, and 16px text so the page doesn't zoom. */
  tall: boolean;
  /** How many rows a condition keeps. */
  count: (op: ViewTokenOp, value: string) => number;
  onSet: (op: ViewTokenOp, value: string) => void;
}) {
  const [from = '0', to = '0'] = current?.value.split('..') ?? [];
  const [op, setOp] = useState<ViewTokenOp>(current?.op === 'eq' ? 'gt' : (current?.op ?? 'gt'));
  const [a, setA] = useState(from);
  const [b, setB] = useState(current?.op === 'between' ? to : '0');
  const value = (o: ViewTokenOp, x: string, y: string) =>
    o === 'between' ? `${x.trim()}..${y.trim()}` : x.trim();
  const set = (o: ViewTokenOp, x: string, y: string) => {
    if (isNumber(x) && (o !== 'between' || isNumber(y))) onSet(o, value(o, x, y));
  };
  const box = cn(
    'min-w-0 flex-1 px-2 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
    tall ? 'h-10 text-base' : 'h-8 text-sm',
  );
  const ok = isNumber(a) && (op !== 'between' || isNumber(b));
  return (
    // Keys stay here: the menu would take Enter and the arrows.
    <div
      className="flex flex-col gap-1.5 py-1 pr-2 pl-12"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.preventDefault();
      }}
    >
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={current ? op : ''}
        onValueChange={(v) => {
          if (!v) return;
          setOp(v as ViewTokenOp);
          set(v as ViewTokenOp, a, b);
        }}
        aria-label={`${label} condition`}
        className="w-full"
      >
        {OPS.map((o) => (
          <ToggleGroupItem
            key={o.op}
            value={o.op}
            className={cn('flex-1 font-normal', tall ? 'h-10 text-base' : 'h-8 text-sm')}
          >
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          inputMode="decimal"
          className={box}
          aria-label={`${label} ${op === 'between' ? 'from' : 'value'}`}
          value={a}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setA(e.target.value);
            set(op, e.target.value, b);
          }}
        />
        {op === 'between' && (
          <>
            <span className="text-muted-foreground text-sm">and</span>
            <Input
              type="number"
              inputMode="decimal"
              className={box}
              aria-label={`${label} to`}
              value={b}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                setB(e.target.value);
                set(op, a, e.target.value);
              }}
            />
          </>
        )}
        <span className="num w-16 shrink-0 text-right text-muted-foreground text-xs">
          {current && ok ? `${count(op, value(op, a, b))} rows` : ''}
        </span>
      </div>
    </div>
  );
}

export function TokenFilter<T>({
  filter,
  placeholder = 'Filter…',
  label = 'Filter',
  className,
  saved,
  onSave,
}: {
  filter: TokenFilterState<T>;
  placeholder?: string;
  /** The input's accessible name. */
  label?: string;
  className?: string;
  /** The view's saved filters; the save button shows when the box differs from them. */
  saved?: FilterToken[];
  /** Saves the box's filters as the view's own (Bikram, 2026-10-11). */
  onSave?: (tokens: FilterToken[]) => void;
}) {
  const { fields, indexed, tokens, setTokens, text, setText } = filter;
  // Phone: the box is one tappable row and the menu is a bottom sheet (Bikram, 2026-10-11).
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  // Menu groups start collapsed; typing opens every group with a match.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);

  const add = (t: FilterToken) => {
    setTokens([...tokens.filter((x) => !same(x, t)), t]);
    setText('');
  };
  // A number field holds one condition: a new one replaces it.
  const addCondition = (key: string, op: ViewTokenOp, value: string) => {
    setTokens([...tokens.filter((x) => x.key !== key), { key, value, op }]);
    setText('');
    if (!mobile) input.current?.focus();
  };
  // Rows a number condition keeps, given the other fields' tokens.
  const numberCount = (key: string, op: ViewTokenOp, value: string) =>
    indexed.filter(
      (r) =>
        passes(r.values, r.nums, tokens, fields, key) &&
        meetsNumber(op, value, r.nums[key] ?? null),
    ).length;
  // Set as the number is typed: the box keeps focus.
  const setCondition = (key: string, op: ViewTokenOp, value: string) =>
    setTokens([...tokens.filter((x) => x.key !== key), { key, value, op }]);
  const sameTokens = (a: FilterToken[], b: FilterToken[]) => {
    const keyOf = (ts: FilterToken[]) => ts.map(tokenText).sort().join('\n');
    return keyOf(a) === keyOf(b);
  };
  const dirty = !!onSave && !sameTokens(tokens, saved ?? []);
  // One chip per field and operator, in the order they were added.
  const chips = useMemo(() => {
    const out: Chip[] = [];
    for (const t of tokens) {
      const not = !!t.not;
      const chip = out.find((c) => c.key === t.key && c.not === not);
      if (chip) chip.tokens.push(t);
      else out.push({ key: t.key, not, tokens: [t] });
    }
    return out;
  }, [tokens]);
  const removeChip = (key: string, not: boolean) =>
    setTokens(tokens.filter((t) => t.key !== key || !!t.not !== not));
  const flipChip = (key: string, not: boolean) =>
    setTokens(
      tokens.map((t) => (t.key === key && !!t.not === not ? token(key, t.value, !not) : t)),
    );
  // Editing a chip narrows the menu to its field.
  const edit = (key: string) => {
    setText(`${key}:`);
    setOpen(true);
    if (!mobile) input.current?.focus();
  };
  const clear = () => {
    setTokens([]);
    setText('');
  };
  const toggleGroup = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // A leading `-` excludes what is picked next.
  const typed = text.trim().toLowerCase();
  const negate = typed.startsWith('-');
  const q = negate ? typed.slice(1) : typed;

  // The menu: each field's values with counts, most common first. A field counts the rows the
  // other fields' tokens keep, so a chip can take more values of its own field.
  const facets = useMemo(() => {
    const [qKey, qValue] = q.includes(':') ? q.split(':', 2) : [null, q];
    return fields
      .filter((f) => qKey === null || f.key.startsWith(qKey))
      .map((f) => {
        if (f.number) {
          const hit =
            qKey !== null ||
            !qValue ||
            f.key.startsWith(qValue) ||
            f.label.toLowerCase().startsWith(qValue);
          return { field: f, values: [] as [string, number][], total: hit ? 1 : 0 };
        }
        const counts = new Map<string, number>();
        for (const { row, values, nums } of indexed) {
          if (!passes(values, nums, tokens, fields, f.key)) continue;
          for (const v of new Set(f.values(row))) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        const matches = [...counts]
          .filter(([v]) => !tokens.some((t) => same(t, { key: f.key, value: v })))
          .filter(
            ([v]) =>
              !qValue ||
              v.toLowerCase().includes(qValue) ||
              (qKey === null && f.label.toLowerCase().startsWith(qValue)),
          )
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        return { field: f, values: matches.slice(0, PER_FIELD), total: matches.length };
      })
      .filter((g) => g.total);
  }, [fields, indexed, tokens, q]);

  // One row: the chips that fit show, the rest wait behind "+N".
  const [fit, setFit] = useState<{ shown: number; count: boolean[] }>({
    shown: chips.length,
    count: [],
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measures when the chips change.
  useLayoutEffect(() => {
    const row = box.current;
    const sizes = measure.current;
    if (!row || !sizes) return;
    const run = () => {
      const reserved = [...row.querySelectorAll<HTMLElement>('[data-reserved]')].reduce(
        (s, el) => s + el.offsetWidth,
        0,
      );
      // Room left for the text input (desktop) or the tap target (phone).
      const avail = row.clientWidth - reserved - (mobile ? 24 : 64) - GAP * 2;
      const widths = (form: ChipForm) =>
        [...sizes.querySelectorAll<HTMLElement>(`[data-form=${form}]`)].map((el) => el.offsetWidth);
      const more = sizes.querySelector<HTMLElement>('[data-more]')?.offsetWidth ?? 32;
      setFit(
        planChips(
          avail,
          widths(mobile ? 'short' : 'full'),
          widths(mobile ? 'short' : 'count'),
          more,
        ),
      );
    };
    run();
    const ro = new ResizeObserver(run);
    ro.observe(row);
    return () => ro.disconnect();
  }, [chips, mobile]);
  const shownChips = chips.slice(0, fit.shown);
  const hiddenChips = chips.slice(fit.shown);
  const chipProps = (c: Chip) => ({
    chip: c,
    field: fields.find((f) => f.key === c.key) as FilterField<never> | undefined,
    onFlip: () => flipChip(c.key, c.not),
    onRemove: () => removeChip(c.key, c.not),
    onEdit: () => edit(c.key),
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !text && tokens.length) {
      setTokens(tokens.slice(0, -1));
    } else if (e.key === 'Escape') {
      if (!mobile) setOpen(false);
    } else if (e.key === 'Enter') {
      // `field:>100`, `field:0..500` typed out on a number field sets its condition.
      const n = NUMBER_TYPED.exec(text.trim());
      const nf = n && fields.find((x) => x.number && x.key === n[1]?.toLowerCase());
      if (n?.[3] && nf) {
        e.preventDefault();
        const op = n[4] ? 'between' : n[2] === '>' ? 'gt' : n[2] === '<' ? 'lt' : 'eq';
        addCondition(nf.key, op, n[4] ? `${n[3]}..${n[4]}` : n[3]);
        return;
      }
      // `field:value` (or `-field:value`) typed out in full adds the token even when no row has it.
      const m = /^(-?)(\w+):(\S+)$/.exec(text.trim());
      const f = m && fields.find((x) => x.key === m[2]?.toLowerCase());
      if (m?.[3] && f && !facets.length) {
        e.preventDefault();
        add(token(f.key, m[3], m[1] === '-'));
      }
    } else {
      setOpen(true);
    }
  };

  const searching = q.length > 0;
  const menu = (
    <>
      <CommandEmpty>No matching values.</CommandEmpty>
      {facets.map(({ field, values, total }) => {
        const shown = searching || expanded.has(field.key);
        const current = field.number && tokens.find((t) => t.key === field.key);
        return (
          <CommandGroup key={field.key} className="px-1 py-0.5">
            <CommandItem
              value={`group:${field.key}`}
              aria-expanded={shown}
              onSelect={() => toggleGroup(field.key)}
              className={cn('font-medium', mobile && 'min-h-11')}
            >
              <ChevronRightIcon
                className={cn('text-muted-foreground transition-transform', shown && 'rotate-90')}
              />
              <field.icon className="text-muted-foreground" />
              {field.label}
              <CommandShortcut className="num tracking-normal">
                {field.number ? (current ? conditionText(current) : '') : total}
              </CommandShortcut>
            </CommandItem>
            {shown && field.number && (
              <NumberCondition
                key={field.key}
                label={field.label}
                current={current || undefined}
                tall={mobile}
                count={(op, value) => numberCount(field.key, op, value)}
                onSet={(op, value) => setCondition(field.key, op, value)}
              />
            )}
            {shown &&
              values.map(([value, count]) => (
                <CommandItem
                  key={value}
                  value={`${field.key}:${value}`}
                  onSelect={() => add(token(field.key, value, negate))}
                  className={cn('pl-14', mobile && 'min-h-11')}
                >
                  <span className="num min-w-0 truncate">{value}</span>
                  <CommandShortcut className="num tracking-normal">{count}</CommandShortcut>
                  <Button
                    variant="ghost"
                    size={mobile ? 'icon-sm' : 'icon-xs'}
                    className="-my-1 text-muted-foreground hover:text-destructive"
                    aria-label={`Exclude ${field.label} ${value}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      add(token(field.key, value, true));
                    }}
                  >
                    <BanIcon />
                  </Button>
                </CommandItem>
              ))}
          </CommandGroup>
        );
      })}
    </>
  );

  const clearButton = (dirty || tokens.length > 0 || text) && (
    <InputGroupAddon align="inline-end" data-reserved className="gap-0.5">
      {dirty && (
        <Tooltip>
          <TooltipTrigger asChild>
            <InputGroupButton
              size="icon-xs"
              aria-label="Save filters to view"
              onClick={() => onSave?.(tokens)}
            >
              <SaveIcon />
            </InputGroupButton>
          </TooltipTrigger>
          <TooltipContent>Save filters to view</TooltipContent>
        </Tooltip>
      )}
      {(tokens.length > 0 || text) && (
        <InputGroupButton size="icon-xs" aria-label="Clear filter" onClick={clear}>
          <XIcon />
        </InputGroupButton>
      )}
    </InputGroupAddon>
  );
  // Off-screen copies of every chip, to measure what fits.
  const sizes = (
    <div
      ref={measure}
      aria-hidden
      inert
      className="pointer-events-none invisible absolute top-0 left-0 flex h-0 gap-1 overflow-hidden"
    >
      {chips.flatMap((c) =>
        (mobile ? (['short'] as const) : (['full', 'count'] as const)).map((form) => (
          <span
            key={`${c.not ? '-' : ''}${c.key}:${form}`}
            data-form={form}
            className="flex shrink-0"
          >
            <FilterChip {...chipProps(c)} form={form} className="max-w-none" />
          </span>
        )),
      )}
      <Button data-more variant="secondary" size="xs" className="h-6 shrink-0 rounded-4xl px-2">
        +{chips.length}
      </Button>
    </div>
  );

  if (mobile) {
    return (
      <div className={cn('relative w-full', className)}>
        {sizes}
        <InputGroup
          ref={box}
          data-slot="token-filter"
          className="flex-nowrap gap-1 overflow-hidden bg-background"
        >
          <InputGroupAddon data-reserved>
            <InputGroupButton size="icon-xs" aria-label={label} onClick={() => setOpen(true)}>
              <SearchIcon />
            </InputGroupButton>
          </InputGroupAddon>
          {shownChips.map((c, i) => (
            <FilterChip
              key={`${c.not ? '-' : ''}${c.key}`}
              {...chipProps(c)}
              form="short"
              className={cn('shrink-0', i === 0 && '-ml-1')}
            />
          ))}
          {hiddenChips.length > 0 && (
            <Button
              variant="secondary"
              size="xs"
              className="num h-6 shrink-0 rounded-4xl px-2"
              aria-label={`${hiddenChips.length} more filters`}
              onClick={() => setOpen(true)}
            >
              +{hiddenChips.length}
            </Button>
          )}
          <Button
            variant="ghost"
            className="h-full min-w-6 flex-1 justify-start px-1 font-normal text-muted-foreground hover:bg-transparent"
            aria-label={label}
            onClick={() => setOpen(true)}
          >
            {tokens.length ? '' : placeholder}
          </Button>
          {clearButton}
        </InputGroup>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            className="max-h-[85svh] gap-0 rounded-t-xl"
            // The keyboard would cover the menu: search waits for a tap.
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <SheetHeader className="pb-2">
              <SheetTitle>Filter</SheetTitle>
              <SheetDescription className="sr-only">
                Pick values to filter the rows.
              </SheetDescription>
            </SheetHeader>
            <CommandPrimitive
              shouldFilter={false}
              loop
              className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
            >
              <CommandInput
                value={text}
                onValueChange={setText}
                onKeyDown={onKeyDown}
                placeholder="Search values…"
                aria-label={label}
                className="text-base"
              />
              {chips.length > 0 && (
                <div className="flex flex-wrap gap-1 px-1">
                  {chips.map((c) => (
                    <FilterChip
                      key={`${c.not ? '-' : ''}${c.key}`}
                      {...chipProps(c)}
                      form="full"
                      wrap
                      className="h-auto min-h-6 max-w-full"
                    />
                  ))}
                </div>
              )}
              <CommandList className="max-h-none min-h-0 flex-1" aria-label="Filter suggestions">
                {menu}
              </CommandList>
            </CommandPrimitive>
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <CommandPrimitive shouldFilter={false} className={cn('relative w-full', className)} loop>
      {sizes}
      <Popover open={open && facets.length > 0} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <InputGroup
            ref={box}
            data-slot="token-filter"
            className="flex-nowrap gap-1 overflow-hidden bg-background"
          >
            <InputGroupAddon data-reserved>
              <SearchIcon />
            </InputGroupAddon>
            {shownChips.map((c, i) => (
              <FilterChip
                key={`${c.not ? '-' : ''}${c.key}`}
                {...chipProps(c)}
                form={fit.count[i] ? 'count' : 'full'}
                className={cn('shrink-0', i === 0 && '-ml-1')}
              />
            ))}
            {hiddenChips.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="secondary"
                    size="xs"
                    className="num h-6 shrink-0 rounded-4xl px-2"
                    aria-label={`${hiddenChips.length} more filters`}
                  >
                    +{hiddenChips.length}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-80 max-w-[calc(100vw-2rem)]"
                  onCloseAutoFocus={(e) => e.preventDefault()}
                >
                  {hiddenChips.map((c) => {
                    const f = fields.find((x) => x.key === c.key);
                    const name = f?.label ?? c.key;
                    const verb = c.not ? 'not in' : 'in';
                    return (
                      <DropdownMenuItem
                        key={`${c.not ? '-' : ''}${c.key}`}
                        onSelect={() => edit(c.key)}
                      >
                        {f && <f.icon />}
                        <span className="min-w-0 flex-1 truncate">
                          <span className="text-muted-foreground">{name} </span>
                          <span
                            className={cn('text-muted-foreground', c.not && 'text-destructive')}
                          >
                            {verb}{' '}
                          </span>
                          <span className="num">{c.tokens.map((t) => t.value).join(', ')}</span>
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="-my-1"
                          aria-label={`Remove ${name} ${verb}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeChip(c.key, c.not);
                          }}
                        >
                          <XIcon />
                        </Button>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <CommandPrimitive.Input
              ref={input}
              data-slot="input-group-control"
              className="h-full min-w-16 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
              placeholder={tokens.length ? '' : placeholder}
              aria-label={label}
              value={text}
              onValueChange={(v) => {
                setText(v);
                setOpen(true);
              }}
              onKeyDown={onKeyDown}
              onFocus={() => setOpen(true)}
              onClick={() => setOpen(true)}
              // Focus moving into the menu's number row keeps the menu open.
              onBlur={(e) => {
                if (!menuBox.current?.contains(e.relatedTarget as Node)) setOpen(false);
              }}
            />
            {clearButton}
          </InputGroup>
        </PopoverAnchor>
        <PopoverContent
          ref={menuBox}
          align="start"
          className="w-(--radix-popover-trigger-width) min-w-64 p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
          // The click that opens the menu lands on the box: it must not count as "outside".
          onInteractOutside={(e) => {
            if (box.current?.contains(e.target as Node)) e.preventDefault();
          }}
          // Clicks in the menu must not blur the input first.
          // (number inputs still take focus).
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest('input')) e.preventDefault();
          }}
        >
          <CommandList aria-label="Filter suggestions">{menu}</CommandList>
        </PopoverContent>
      </Popover>
    </CommandPrimitive>
  );
}
