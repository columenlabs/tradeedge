// The one filter box every view uses (Bikram, 2026-10-08): a click opens a menu grouped by field
// with counts; picking a value adds it to that field's chip, ⊘ (or typing `-field:value`) excludes
// it. One field: "in" any of its values and "not in" any excluded one; a chip's in/not in flips
// (Bikram, 2026-10-09). Different fields: all must match (AND). Free text matches the row's text
// and any field value. It filters the rows already loaded, on the client.
import { Command as CommandPrimitive } from 'cmdk';
import { BanIcon, type LucideIcon, SearchIcon, XIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { cn } from './lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './ui/command';
import { InputGroup, InputGroupAddon } from './ui/input-group';
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover';

export interface FilterField<T> {
  key: string;
  label: string;
  icon: LucideIcon;
  /** The row's values for this field (a row can carry several, like symbols). */
  values: (row: T) => string[];
}

export interface FilterToken {
  key: string;
  value: string;
  /** Excluded: rows with this value are dropped ("not in"). */
  not?: boolean;
}

export const tokenText = (t: FilterToken) => `${t.not ? '-' : ''}${t.key}:${t.value}`;
/** Same field and value, included or not: a value sits in one chip only. */
const same = (a: FilterToken, b: FilterToken) =>
  a.key === b.key && a.value.toLowerCase() === b.value.toLowerCase();
const token = (key: string, value: string, not: boolean): FilterToken =>
  not ? { key, value, not } : { key, value };

/** Keeps the rows whose values pass every field's tokens, skipping the field `except`. */
function passes(
  values: Record<string, string[]>,
  tokens: FilterToken[],
  fields: { key: string }[],
  except?: string,
) {
  for (const f of fields) {
    if (f.key === except) continue;
    const have = values[f.key] ?? [];
    const of = tokens.filter((t) => t.key === f.key);
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
          fields.map((f) => [f.key, f.values(row).map((v) => v.toLowerCase())]),
        ) as Record<string, string[]>,
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
      .filter(({ values, text: hay }) => {
        if (!passes(values, tokens, fields)) return false;
        if (!free) return true;
        return [...hay, ...Object.values(values).flat()].some((v) => v.includes(free));
      })
      .map(({ row }) => row);
  }, [indexed, fields, tokens, text]);
  return { fields, rows, indexed, tokens, setTokens, text, setText, results };
}

export type TokenFilterState<T> = ReturnType<typeof useTokenFilter<T>>;

export function TokenFilter<T>({
  filter,
  placeholder = 'Filter…',
  label = 'Filter',
  className,
}: {
  filter: TokenFilterState<T>;
  placeholder?: string;
  /** The input's accessible name. */
  label?: string;
  className?: string;
}) {
  const { fields, indexed, tokens, setTokens, text, setText } = filter;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const add = (t: FilterToken) => {
    setTokens([...tokens.filter((x) => !same(x, t)), t]);
    setText('');
  };
  // One chip per field and operator, in the order they were added.
  const chips = useMemo(() => {
    const out: { key: string; not: boolean; tokens: FilterToken[] }[] = [];
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
        const counts = new Map<string, number>();
        for (const { row, values } of indexed) {
          if (!passes(values, tokens, fields, f.key)) continue;
          for (const v of new Set(f.values(row))) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        const values = [...counts]
          .filter(([v]) => !tokens.some((t) => same(t, { key: f.key, value: v })))
          .filter(
            ([v]) =>
              !qValue ||
              v.toLowerCase().includes(qValue) ||
              (qKey === null && f.label.toLowerCase().startsWith(qValue)),
          )
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, PER_FIELD);
        return { field: f, values };
      })
      .filter((g) => g.values.length);
  }, [fields, indexed, tokens, q]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !text && tokens.length) {
      setTokens(tokens.slice(0, -1));
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Enter') {
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

  return (
    <CommandPrimitive shouldFilter={false} className={cn('w-full', className)} loop>
      <Popover open={open && facets.length > 0} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <InputGroup
            ref={box}
            data-slot="token-filter"
            className="h-auto min-h-8 flex-wrap bg-background"
          >
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            {chips.map((c) => {
              const f = fields.find((x) => x.key === c.key);
              const name = f?.label ?? c.key;
              return (
                <Badge
                  key={`${c.not ? '-' : ''}${c.key}`}
                  variant="secondary"
                  className="my-1 h-6 gap-1 pr-0.5 font-normal"
                >
                  {f && <f.icon className="size-3" />}
                  <span className="text-muted-foreground">{name}</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    className={cn(
                      'h-5 px-1 text-muted-foreground',
                      c.not && 'text-destructive hover:text-destructive',
                    )}
                    aria-label={`${name} ${c.not ? 'not in' : 'in'}: switch to ${c.not ? 'in' : 'not in'}`}
                    onClick={() => flipChip(c.key, c.not)}
                  >
                    {c.not ? 'not in' : 'in'}
                  </Button>
                  <span className="num">{c.tokens.map((t) => t.value).join(', ')}</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-4 rounded-full"
                    aria-label={`Remove ${name} ${c.not ? 'not in' : 'in'}`}
                    onClick={() => removeChip(c.key, c.not)}
                  >
                    <XIcon />
                  </Button>
                </Badge>
              );
            })}
            <CommandPrimitive.Input
              data-slot="input-group-control"
              className="h-8 min-w-16 flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
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
              onBlur={() => setOpen(false)}
            />
            {(tokens.length > 0 || text) && (
              <InputGroupAddon align="inline-end">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Clear filter"
                  onClick={() => {
                    setTokens([]);
                    setText('');
                  }}
                >
                  <XIcon />
                </Button>
              </InputGroupAddon>
            )}
          </InputGroup>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-(--radix-popover-trigger-width) min-w-64 p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
          // The click that opens the menu lands on the box: it must not count as "outside".
          onInteractOutside={(e) => {
            if (box.current?.contains(e.target as Node)) e.preventDefault();
          }}
          // Clicks in the menu must not blur the input first.
          onMouseDown={(e) => e.preventDefault()}
        >
          <CommandList aria-label="Filter suggestions">
            <CommandEmpty>No matching values.</CommandEmpty>
            {facets.map(({ field, values }) => (
              <CommandGroup
                key={field.key}
                heading={
                  <span className="flex items-center gap-1.5">
                    <field.icon className="size-3.5" />
                    {field.label}
                  </span>
                }
              >
                {values.map(([value, count]) => (
                  <CommandItem
                    key={value}
                    value={`${field.key}:${value}`}
                    onSelect={() => add(token(field.key, value, negate))}
                  >
                    <span className="num min-w-0 truncate">{value}</span>
                    <CommandShortcut className="num tracking-normal">{count}</CommandShortcut>
                    <Button
                      variant="ghost"
                      size="icon-xs"
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
            ))}
          </CommandList>
        </PopoverContent>
      </Popover>
    </CommandPrimitive>
  );
}
