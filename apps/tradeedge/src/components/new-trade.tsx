import { Sparkline } from '@/components/payoff-chart';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { chainQuery, expirationsQuery, saveTrade, tradesQuery, watchlistQuery } from '@/lib/api';
import { shortDate } from '@/lib/format';
import { daysTo, toSaved } from '@/lib/saved';
import {
  DEFAULT_IV,
  STRATEGIES,
  type StrategyId,
  TRADE_MIN_DTE,
  analyze,
  atmIv,
  buildStrategy,
} from '@/lib/strategy';
import { useIsMobile } from '@edgedesk/app-shell';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@edgedesk/app-shell/ui/sheet';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';

interface Opener {
  /** Opens the sheet, on an underlying and expiry when given. */
  open: (start?: { symbol?: string; expiration?: number }) => void;
}
const Ctx = createContext<Opener>({ open: () => {} });
export const useNewTrade = () => useContext(Ctx);

/** Holds the New trade sheet so the sidebar `+`, the board and the chain can open it. */
export function NewTradeProvider({ children }: { children: ReactNode }) {
  const [start, setStart] = useState<{ symbol?: string; expiration?: number } | null>(null);
  const opener = useMemo<Opener>(() => ({ open: (s) => setStart(s ?? {}) }), []);
  return (
    <Ctx.Provider value={opener}>
      {children}
      <NewTradeSheet start={start} onClose={() => setStart(null)} />
    </Ctx.Provider>
  );
}

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

function NewTradeSheet({
  start,
  onClose,
}: {
  start: { symbol?: string; expiration?: number } | null;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const watch = useQuery(watchlistQuery());
  const [symbol, setSymbol] = useState('SPY');
  const [other, setOther] = useState('');
  const [exp, setExp] = useState<number | null>(null);
  const [strategy, setStrategy] = useState<StrategyId>('iron-condor');
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);

  useEffect(() => {
    if (!start) return;
    setSymbol(start.symbol ?? watch.data?.[0]?.symbol ?? 'SPY');
    setExp(start.expiration ?? null);
    setStrategy('iron-condor');
    setNamed(false);
    setOther('');
  }, [start, watch.data]);

  const exps = useQuery({ ...expirationsQuery(symbol), enabled: !!start });
  const expirations = exps.data?.expirations ?? [];
  const expiration =
    exp ?? expirations.find((x) => daysTo(x) >= TRADE_MIN_DTE) ?? expirations[0] ?? null;
  const chain = useQuery({
    ...chainQuery(symbol, expiration),
    enabled: !!start && expiration !== null,
  });
  const def = STRATEGIES.find((s) => s.id === strategy);
  const backExp = def?.needsBack
    ? (expirations.find((x) => expiration !== null && x > expiration) ?? null)
    : null;
  const back = useQuery({ ...chainQuery(symbol, backExp), enabled: !!start && backExp !== null });
  const spot = chain.data?.spot?.last ?? null;
  const iv = atmIv(chain.data) ?? DEFAULT_IV;
  const built = useMemo(
    () =>
      chain.data && spot && (!def?.needsBack || back.data)
        ? buildStrategy(strategy, spot, iv, chain.data.quotes, back.data?.quotes ?? [])
        : null,
    [chain.data, back.data, spot, iv, strategy, def?.needsBack],
  );
  useEffect(() => {
    if (built && !named) setName(built.name);
  }, [built, named]);
  const preview = useMemo(
    () =>
      built && spot
        ? analyze(built.legs, spot, { days: 0, ivScale: 1, fill: 0, fallbackIv: iv })
        : null,
    [built, spot, iv],
  );

  const create = useMutation({
    mutationFn: () => {
      if (!built) throw new Error('No strikes for this strategy on that expiry.');
      return saveTrade({
        underlying: symbol,
        name: name.trim(),
        legs: toSaved(built.legs),
      });
    },
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: tradesQuery().queryKey });
      onClose();
      void navigate({ to: '/trades/$symbol/$id', params: { symbol: s.underlying, id: s.id } });
    },
  });

  const symbols = [...new Set([...(watch.data ?? []).map((w) => w.symbol), symbol])];
  return (
    <Sheet open={!!start} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>New trade</SheetTitle>
          <SheetDescription>
            Start from a strategy, then edit the legs. Agents do the same with trade_write.
          </SheetDescription>
        </SheetHeader>
        <form
          id="new-trade"
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (built && name.trim()) create.mutate();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">Underlying</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={symbol}
              onValueChange={(v) => {
                if (!v) return;
                setSymbol(v);
                setExp(null);
                setNamed(false);
              }}
              aria-label="Underlying"
              className="flex-wrap"
            >
              {symbols.map((s) => (
                <ToggleGroupItem key={s} value={s} className="num px-3">
                  {s}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Input
              aria-label="Other underlying"
              placeholder="Other symbol, then Enter"
              value={other}
              onChange={(e) => setOther(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (SYMBOL.test(other)) {
                  setSymbol(other);
                  setExp(null);
                  setNamed(false);
                }
              }}
              className="num h-8 uppercase placeholder:normal-case"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">Expiry</Label>
            <Select
              value={expiration ? String(expiration) : undefined}
              onValueChange={(v) => {
                setExp(Number(v));
                setNamed(false);
              }}
            >
              <SelectTrigger aria-label="Expiry" className="w-full">
                <SelectValue placeholder={exps.isPending ? 'Loading…' : 'No expiries'} />
              </SelectTrigger>
              <SelectContent>
                {expirations.map((x) => (
                  <SelectItem key={x} value={String(x)}>
                    <span className="num">{shortDate(x)}</span>
                    <span className="num ml-auto pl-3 text-xs text-muted-foreground">
                      {daysTo(x)} DTE
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">Strategy</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={strategy}
              onValueChange={(v) => {
                if (!v) return;
                setStrategy(v as StrategyId);
                setNamed(false);
              }}
              aria-label="Strategy"
              className="flex-wrap justify-start"
              spacing={1}
            >
              {STRATEGIES.map((s) => (
                <ToggleGroupItem key={s.id} value={s.id} className="gap-1.5 px-2.5">
                  <svg
                    viewBox="0 0 28 14"
                    aria-hidden="true"
                    className="h-3.5 w-7 fill-none stroke-current stroke-[1.6]"
                  >
                    <polyline points={s.glyph} />
                  </svg>
                  {s.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-trade-name" className="text-xs text-muted-foreground">
              Name
            </Label>
            <Input
              id="new-trade-name"
              value={name}
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value);
                setNamed(true);
              }}
            />
          </div>
          {preview && spot ? (
            <div className="flex items-center justify-center rounded-lg border py-2">
              <Sparkline
                analysis={preview}
                spot={spot}
                color="var(--primary)"
                className="h-24 w-full"
              />
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Strikes are picked from the live chain: short legs near 1σ, wings about 1.75% of the
            price wide. You can change every leg on the next screen.
          </p>
          {create.isError ? (
            <p role="alert" className="text-xs text-loss">
              {create.error.message}
            </p>
          ) : chain.data && spot && !built ? (
            <p role="alert" className="text-xs text-loss">
              This expiry does not list the strikes this strategy needs. Pick another.
            </p>
          ) : null}
        </form>
        <SheetFooter className="flex-row justify-end border-t">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="new-trade"
            size="sm"
            disabled={!built || !name.trim() || create.isPending}
          >
            <Check />
            Create
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
