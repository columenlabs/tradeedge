import { ChainTable } from '@/components/chain-table';
import { useNewTrade } from '@/components/new-trade';
import { Ticker } from '@/components/ticker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { expirationsQuery, removeFromWatchlist, useChainStream, watchlistQuery } from '@/lib/api';
import { shortDate, timePT } from '@/lib/format';
import { daysTo } from '@/lib/saved';
import { TRADE_MIN_DTE, atmIv } from '@/lib/strategy';
import { cn } from '@/lib/utils';
import { STRIKE_COUNTS } from '@/router';
import { ConfirmDelete, Page, StatusItem } from '@edgedesk/app-shell';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Spline, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** The expiry a chain opens on: the first at least a few weeks out, like a new trade. */
function defaultExpiry(expirations: number[]): number | null {
  return expirations.find((x) => daysTo(x) >= TRADE_MIN_DTE) ?? expirations[0] ?? null;
}

/** `/chain/$symbol`: the live chain of one underlying, one expiry at a time. */
export function ChainPage() {
  const { symbol } = useParams({ from: '/chain/$symbol' });
  const { exp, strikes = 20 } = useSearch({ from: '/chain/$symbol' });
  const navigate = useNavigate({ from: '/chain/$symbol' });
  const qc = useQueryClient();
  const { open } = useNewTrade();
  const exps = useQuery(expirationsQuery(symbol));
  const expirations = exps.data?.expirations ?? [];
  const expiration = exp ?? defaultExpiry(expirations);
  const stream = useChainStream(symbol, expiration);
  const chain = stream.chain;
  const spot = chain?.spot?.last ?? null;
  const loadMs = useLoadTime(`${symbol}:${expiration}`, !!chain);

  const watch = useQuery(watchlistQuery());
  const watched = watch.data?.some((w) => w.symbol === symbol) ?? false;
  const unwatch = useMutation({
    mutationFn: () => removeFromWatchlist(symbol),
    onSuccess: (data) => {
      qc.setQueryData(watchlistQuery().queryKey, data);
      const next = data[0]?.symbol;
      void (next
        ? navigate({ to: '/chain/$symbol', params: { symbol: next }, search: { strikes } })
        : navigate({ to: '/trades/$symbol', params: { symbol } }));
    },
  });

  return (
    <Page
      crumbs={[{ label: 'Live chain' }, { label: symbol }]}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => open({ symbol, expiration: expiration ?? undefined })}
          >
            <Spline />
            Build from chain
          </Button>
          {watched ? (
            <ConfirmDelete
              title={`Remove ${symbol} from the watchlist?`}
              action="Remove"
              onConfirm={() => unwatch.mutate()}
            >
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={`Remove ${symbol} from watchlist`}
                title={`Remove ${symbol} from watchlist`}
                disabled={unwatch.isPending}
              >
                <Trash2 />
              </Button>
            </ConfirmDelete>
          ) : null}
        </>
      }
      status={
        <>
          <StatusItem
            label="Quotes"
            value={
              stream.status === 'live'
                ? 'live'
                : stream.status === 'error'
                  ? 'reconnecting'
                  : 'connecting'
            }
            ok={stream.status === 'live' ? true : stream.status === 'error' ? false : null}
          />
          {loadMs !== null ? <StatusItem label="Chain load" value={`${loadMs} ms`} /> : null}
          {chain?.asOf ? <StatusItem label="Refreshed" value={`${timePT(chain.asOf)} PT`} /> : null}
        </>
      }
    >
      <Ticker
        symbol={symbol}
        quote={chain?.spot ?? null}
        iv={atmIv(chain ?? undefined)}
        expiration={expiration}
      />
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
        {expirations.length ? (
          <Tabs
            value={expiration ? String(expiration) : undefined}
            onValueChange={(v) => navigate({ search: (p) => ({ ...p, exp: Number(v) }) })}
            className="w-full min-w-0 sm:flex-1"
          >
            <div className="min-w-0 overflow-x-auto">
              <TabsList aria-label="Expiry">
                {expirations.map((x) => (
                  <TabsTrigger key={x} value={String(x)} className="num gap-1.5 px-2.5">
                    {shortDate(x)}
                    <span className="text-[10px] text-muted-foreground">{daysTo(x)}d</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </Tabs>
        ) : exps.isPending ? (
          <Skeleton className="h-8 flex-1" />
        ) : null}
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Strikes</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={String(strikes)}
            onValueChange={(v) => v && navigate({ search: (p) => ({ ...p, strikes: Number(v) }) })}
            aria-label="Strikes shown"
          >
            {STRIKE_COUNTS.map((n) => (
              <ToggleGroupItem
                key={n}
                value={String(n)}
                aria-label={`${n} strikes`}
                className="num px-2.5"
              >
                {n}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>
      {exps.isError ? (
        <ErrorNote>No expirations for {symbol}. Check the symbol and try again.</ErrorNote>
      ) : null}
      {stream.status === 'error' && !chain ? <ErrorNote>{stream.error}</ErrorNote> : null}
      {chain ? (
        <ChainTable quotes={chain.quotes} spot={spot} strikes={strikes} />
      ) : stream.status === 'connecting' ? (
        <Skeleton className="h-[60vh] w-full" />
      ) : null}
    </Page>
  );
}

/** Milliseconds from asking for a chain (`key` changes) to its first data. */
function useLoadTime(key: string, loaded: boolean): number | null {
  const start = useRef(performance.now());
  const [ms, setMs] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart the clock per chain asked for
  useEffect(() => {
    start.current = performance.now();
    setMs(null);
  }, [key]);
  useEffect(() => {
    if (loaded && ms === null) setMs(Math.round(performance.now() - start.current));
  }, [loaded, ms]);
  return ms;
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-loss/40 bg-loss-tint px-4 py-3 text-sm">
      {children}
    </p>
  );
}
