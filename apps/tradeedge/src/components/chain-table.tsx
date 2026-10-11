import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { int, num, pct } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { OptionQuote } from '@edgedesk/types';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { Fragment, useEffect, useMemo, useRef } from 'react';

export interface ChainRow {
  strike: number;
  call?: OptionQuote;
  put?: OptionQuote;
}

export function toRows(quotes: OptionQuote[]): ChainRow[] {
  const by = new Map<number, ChainRow>();
  for (const q of quotes) {
    const r = by.get(q.strike) ?? { strike: q.strike };
    r[q.type] = q;
    by.set(q.strike, r);
  }
  return [...by.values()].sort((a, b) => a.strike - b.strike);
}

const features = tableFeatures({});
const h = createColumnHelper<typeof features, ChainRow>();

type Field = { key: keyof OptionQuote; label: string; fmt: (v: number | null) => string };
// Read outward from the strike: price first, then greeks, then activity.
const FIELDS: Field[] = [
  { key: 'bid', label: 'Bid', fmt: (v) => num(v) },
  { key: 'ask', label: 'Ask', fmt: (v) => num(v) },
  { key: 'delta', label: 'Δ', fmt: (v) => num(v) },
  { key: 'iv', label: 'IV', fmt: (v) => pct(v) },
  { key: 'gamma', label: 'Γ', fmt: (v) => num(v, 3) },
  { key: 'theta', label: 'Θ', fmt: (v) => num(v) },
  { key: 'vega', label: 'Vega', fmt: (v) => num(v) },
  { key: 'volume', label: 'Vol', fmt: int },
  { key: 'openInterest', label: 'OI', fmt: int },
];

function side(type: 'call' | 'put', fields: Field[]) {
  return h.columns(
    fields.map((f) =>
      h.accessor((r) => (r[type]?.[f.key] as number | null | undefined) ?? null, {
        id: `${type}-${f.key}`,
        header: f.label,
        cell: (c) => f.fmt(c.getValue()),
      }),
    ),
  );
}

const columns = h.columns([
  h.group({ id: 'calls', header: 'Calls', columns: side('call', [...FIELDS].reverse()) }),
  h.accessor('strike', { header: 'Strike', cell: (c) => num(c.getValue()) }),
  h.group({ id: 'puts', header: 'Puts', columns: side('put', FIELDS) }),
]);

/** `strikes` around the money: half below spot, half above. */
export function nearMoney(rows: ChainRow[], spot: number | null, strikes: number): ChainRow[] {
  if (spot === null) return rows.slice(0, strikes);
  const above = rows.findIndex((r) => r.strike >= spot);
  const mid = above < 0 ? rows.length : above;
  const from = Math.max(0, Math.min(mid - strikes / 2, rows.length - strikes));
  return rows.slice(from, from + strikes);
}

/**
 * Calls | strike | puts, one row per strike, the strike pinned in the centre: calls read leftward
 * and puts rightward from it, with a row marking the price between strikes. Row height is the
 * shell row height.
 */
export function ChainTable({
  quotes,
  spot,
  strikes,
}: {
  quotes: OptionQuote[];
  spot: number | null;
  /** Strikes around the money; every strike when left out. */
  strikes?: number;
}) {
  const rows = useMemo(() => {
    const all = toRows(quotes);
    return strikes ? nearMoney(all, spot, strikes) : all;
  }, [quotes, spot, strikes]);
  const table = useTable({ features, columns, data: rows });

  // Open centred on the money and on the strike column; re-centre only when the strike set changes.
  const box = useRef<HTMLDivElement>(null);
  const strikeKey = rows.length ? `${rows[0]?.strike}-${rows.length}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the strike set, not every tick
  useEffect(() => {
    const el = box.current;
    const row = el?.querySelector<HTMLElement>('[data-spot]');
    if (el && row) el.scrollTop = row.offsetTop - el.clientHeight / 2;
    const strike = el?.querySelector<HTMLElement>('[data-strike]');
    if (el && strike)
      el.scrollLeft = strike.offsetLeft + strike.offsetWidth / 2 - el.clientWidth / 2;
  }, [strikeKey, spot === null]);

  return (
    <div
      ref={box}
      className="max-h-[70vh] overflow-auto rounded-lg border bg-card [&>[data-slot=table-container]]:overflow-visible"
    >
      <Table className="num text-xs">
        <TableHeader className="sticky top-0 z-10 bg-muted">
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id} className="hover:bg-transparent">
              {hg.headers.map((hd) => (
                <TableHead
                  key={hd.id}
                  colSpan={hd.colSpan}
                  className={cn(
                    'h-(--row-h) px-(--cell-x) text-right font-sans text-xs font-medium text-muted-foreground',
                    hd.column.id === 'strike' && 'text-center',
                    // Group labels sit next to the strike, so both read when the table opens centred.
                    hd.subHeaders.length > 0 && 'text-foreground',
                    hd.column.id === 'puts' && 'text-left',
                  )}
                >
                  {hd.isPlaceholder ? null : <table.FlexRender header={hd} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row, i, all) => {
            const k = row.original.strike;
            const prev = all[i - 1]?.original.strike;
            // The price sits between the last strike below it and the first at or above it.
            const marker =
              spot !== null && k >= spot && (prev === undefined ? k > spot : prev < spot) ? (
                <TableRow
                  key="spot"
                  data-spot
                  aria-label={`Price ${num(spot)}`}
                  className="bg-primary/10 hover:bg-primary/10"
                >
                  <TableCell colSpan={FIELDS.length} className="h-6 p-0" />
                  <TableCell className="h-6 px-(--cell-x) py-0 text-center">
                    <Badge className="num h-5 px-1.5">{num(spot)}</Badge>
                  </TableCell>
                  <TableCell colSpan={FIELDS.length} className="h-6 p-0" />
                </TableRow>
              ) : null;
            return (
              <Fragment key={row.id}>
                {marker}
                <TableRow>
                  {row.getAllCells().map((cell) => {
                    const id = cell.column.id;
                    const itm =
                      spot !== null &&
                      ((id.startsWith('call') && k < spot) || (id.startsWith('put') && k > spot));
                    return (
                      <TableCell
                        key={cell.id}
                        data-strike={id === 'strike' || undefined}
                        className={cn(
                          'h-(--row-h) px-(--cell-x) py-0 text-right',
                          id === 'strike' && 'bg-muted/60 text-center font-medium',
                          itm && 'bg-muted/40',
                          cell.getValue() === null && 'text-ink-subtle',
                        )}
                      >
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    );
                  })}
                </TableRow>
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
