// A small labelled number (Bikram, 2026-10-09): a view's widgets and tiles, and a desk's stat tiles.
// TileToggleGroup is the clickable kind: one joined strip of tiles that picks what a page shows,
// set beside plain Tiles in a page's header row (DataEdge coverage pages, 2026-10-09). On desktop
// every tile in the row is one fixed width (`TILE_WIDTH`), the row does not stretch, and it never
// wraps: `TileRow` keeps it on one line and narrow screens shrink the tiles instead (Bikram).
import type { ReactNode } from 'react';
import { cn } from './lib/utils';
import { Card } from './ui/card';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

function TileBody({
  label,
  value,
  caption,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  caption?: ReactNode;
  valueClassName?: string;
}) {
  return (
    <>
      <span className="w-full truncate text-xs text-muted-foreground">{label}</span>
      <span className={cn('num truncate text-xl leading-7 font-semibold', valueClassName)}>
        {value}
      </span>
      {caption ? (
        <span className="num line-clamp-2 text-xs text-muted-foreground">{caption}</span>
      ) : null}
    </>
  );
}

export function Tile({
  label,
  value,
  caption,
  className,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  caption?: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <Card size="sm" className={cn('min-w-0 gap-0.5 px-3', className)}>
      <TileBody label={label} value={value} caption={caption} valueClassName={valueClassName} />
    </Card>
  );
}

/** Width of every header tile on desktop, toggle tiles and plain Tiles alike; shrinks to fit the row. */
export const TILE_WIDTH = 'lg:w-(--tile-width) lg:flex-initial';

/** A page's header row of tiles: wraps on phones, one line on desktop. */
export function TileRow({
  children,
  className,
  ...props
}: { children: ReactNode; className?: string; 'aria-label'?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-2.5 lg:flex-nowrap', className)} {...props}>
      {children}
    </div>
  );
}

export interface TileOption {
  id: string;
  label: string;
  value: ReactNode;
  caption?: ReactNode;
}

export function TileToggleGroup({
  options,
  selected,
  onSelect,
  label,
  className,
}: {
  options: TileOption[];
  selected: string;
  onSelect: (id: string) => void;
  /** Accessible name of the group. */
  label: string;
  className?: string;
}) {
  return (
    <Card
      size="sm"
      className={cn('min-w-0 gap-0 bg-border py-0 lg:w-fit lg:flex-initial', className)}
    >
      <ToggleGroup
        type="single"
        spacing={0}
        value={selected}
        onValueChange={(v) => v && onSelect(v)}
        aria-label={label}
        className="grid w-full grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-px lg:flex lg:w-fit"
      >
        {options.map((o) => (
          <ToggleGroupItem
            key={o.id}
            value={o.id}
            aria-label={o.label}
            className="h-auto min-w-0 flex-col lg:w-(--tile-width) lg:shrink items-start justify-start gap-0.5 rounded-none! bg-card px-3 py-3 text-left font-normal data-[state=on]:bg-primary/5 data-[state=on]:shadow-[inset_0_-2px_0_var(--primary)]"
          >
            <TileBody label={o.label} value={o.value} caption={o.caption} />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Card>
  );
}
