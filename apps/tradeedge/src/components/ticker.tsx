import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DASH, num, pct, shortDate, signed, signedPct, tone } from '@/lib/format';
import { daysTo } from '@/lib/saved';
import { sigmaMove } from '@/lib/strategy';
import { cn } from '@/lib/utils';
import { Tile } from '@edgedesk/app-shell';
import type { UnderlyingQuote } from '@edgedesk/types';
import type { ReactNode } from 'react';

/** The shell's stat tile: the ticker's IV, expiry and move, and the page's stat tiles. */
export { Tile };

function Chip({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card size="sm" className="min-w-0 gap-0 px-2.5 py-1.5">
      <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span className="num text-sm font-medium whitespace-nowrap">{value}</span>
    </Card>
  );
}

/**
 * The underlying above the board, a trade and the chain: symbol, live price and change, then IV,
 * IV rank, the expiry in view and its ±1σ move. IV rank needs a year of IV history, which no desk
 * serves yet, so it shows a dash.
 */
export function Ticker({
  symbol,
  quote,
  iv,
  expiration,
  className,
}: {
  symbol: string;
  quote: UnderlyingQuote | null;
  iv: number | null;
  expiration: number | null;
  className?: string;
}) {
  const last = quote?.last ?? null;
  const t = tone(quote?.change);
  const dte = expiration ? daysTo(expiration) : null;
  return (
    <section
      aria-label={`${symbol} quote`}
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-3', className)}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="num flex size-11 shrink-0 items-center justify-center rounded-lg bg-foreground text-xs font-semibold text-background">
          {symbol}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {last === null ? (
              <Skeleton className="h-7 w-24" />
            ) : (
              <span className="num text-2xl leading-7 font-semibold">{num(last)}</span>
            )}
            {quote?.change !== null && quote?.change !== undefined ? (
              <Badge
                variant="secondary"
                className={cn(
                  'num',
                  t === 'gain' && 'bg-gain/10 text-gain',
                  t === 'loss' && 'bg-loss/10 text-loss',
                )}
              >
                {signed(quote.change)} · {signedPct(quote.changePct)}
              </Badge>
            ) : null}
          </div>
          <span className="text-xs text-muted-foreground">{symbol} · live</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 md:ml-auto">
        <Chip label="IV" value={pct(iv)} />
        <Chip label="IV rank" value={DASH} />
        <Chip label="Expiry" value={expiration ? `${shortDate(expiration)} · ${dte}d` : DASH} />
        <Chip
          label="1σ move"
          value={last && iv && dte !== null ? `±${num(sigmaMove(last, iv, dte), 1)}` : DASH}
        />
      </div>
    </section>
  );
}
