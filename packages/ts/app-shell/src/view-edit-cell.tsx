// An editable text cell (Bikram, 2026-10-09): click the value, pick one already in use or type a
// new one, or clear it. Saves at once through the field's `edit`. Clicks stay off the row, which
// opens its details.
import { PlusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { cn } from './lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './ui/command';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export function EditCell({
  label,
  value,
  options,
  chip,
  note,
  onSave,
}: {
  /** The field's name, e.g. `Basket`. */
  label: string;
  value: string | null;
  /** Values already in use, offered first. */
  options: string[];
  chip?: boolean;
  /** One line under the input saying what the edit covers, e.g. `every SPY holding`. */
  note?: string;
  onSave: (value: string | null) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const save = async (v: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(v);
      setOpen(false);
      setTyped('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const fresh = typed.trim();
  const isNew = fresh !== '' && !options.some((o) => o.toLowerCase() === fresh.toLowerCase());
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {value === null ? (
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Set ${label}`}
            className="-ml-1.5 h-6 px-1.5 font-normal text-muted-foreground text-sm"
            onClick={stop}
            onKeyDown={stop}
          >
            <PlusIcon />
            <span className="sr-only sm:not-sr-only">{label}</span>
          </Button>
        ) : chip ? (
          <Badge variant="secondary" className="font-normal" asChild>
            <button type="button" aria-label={`${label}: ${value}`} onClick={stop} onKeyDown={stop}>
              {value}
            </button>
          </Badge>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            aria-label={`${label}: ${value}`}
            className="-ml-1.5 h-6 px-1.5 font-normal text-sm"
            onClick={stop}
            onKeyDown={stop}
          >
            {value}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0" onClick={stop} onKeyDown={stop}>
        <Command>
          <CommandInput
            placeholder={`${label}: pick or type…`}
            value={typed}
            onValueChange={setTyped}
            disabled={saving}
          />
          <CommandList>
            <CommandEmpty>Type a {label.toLowerCase()} name.</CommandEmpty>
            {isNew && (
              <CommandGroup>
                <CommandItem value={`new:${fresh}`} onSelect={() => save(fresh)}>
                  <PlusIcon />
                  Set “{fresh}”
                </CommandItem>
              </CommandGroup>
            )}
            {options.length > 0 && (
              <CommandGroup heading="In use">
                {options.map((o) => (
                  <CommandItem
                    key={o}
                    value={o}
                    data-checked={o === value}
                    onSelect={() => save(o)}
                  >
                    {o}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {value !== null && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem value="clear:" onSelect={() => save(null)}>
                    <XIcon />
                    Clear {label.toLowerCase()}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
          {(note || error) && (
            <p
              role={error ? 'alert' : undefined}
              className={cn(
                'border-t px-3 py-2 text-xs',
                error ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {error ?? note}
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
