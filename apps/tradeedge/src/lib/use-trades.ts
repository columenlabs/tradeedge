/** Saved trades with their colours, and their legs filled from the live chains they sit on. */
import type { OptionChain } from '@edgedesk/types';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type Trade, chainQuery, tradesQuery } from './api';
import { hydrate, toLegs } from './saved';
import { type Leg, atmIv } from './strategy';

/** Ten chart colours from the shell theme; a trade keeps its colour by its place on its underlying. */
export const COLORS = Array.from({ length: 10 }, (_, i) => `var(--chart-${i + 1})`);

export interface Colored extends Trade {
  color: string;
}

/** Every saved trade, grouped by underlying (A–Z), oldest first within one, each with its colour. */
export function useTradeGroups() {
  const saved = useQuery(tradesQuery());
  const groups = useMemo(() => {
    const by = new Map<string, Colored[]>();
    const sorted = [...(saved.data ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const s of sorted) {
      const list = by.get(s.underlying) ?? [];
      list.push({ ...s, color: COLORS[list.length % COLORS.length] as string });
      by.set(s.underlying, list);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [saved.data]);
  return { ...saved, groups };
}

export interface Hydrated extends Colored {
  legs: Trade['legs'];
  /** Legs ready to analyse: IV, days left and any missing price taken from the live chain. */
  live: Leg[];
}

/**
 * The trades on one underlying with their legs filled from the chains of every expiry they use.
 * `ready` once those chains have loaded.
 */
export function useHydrated(symbol: string, only?: string) {
  const all = useTradeGroups();
  const mine = useMemo(
    () => (all.groups.find(([u]) => u === symbol)?.[1] ?? []).filter((s) => !only || s.id === only),
    [all.groups, symbol, only],
  );
  return useHydratedTrades(symbol, mine, all.isPending, all.error);
}

/** Any trade-shaped rows on one underlying (saved trades, a screener's picks), filled from live chains. */
export function useHydratedTrades(
  symbol: string,
  mine: Colored[],
  pending = false,
  error: Error | null = null,
) {
  const expirations = useMemo(
    () =>
      [
        ...new Set(
          mine.flatMap((s) => s.legs.flatMap((l) => (l.expiration ? [l.expiration] : []))),
        ),
      ].sort(),
    [mine],
  );
  const chains = useQueries({ queries: expirations.map((x) => chainQuery(symbol, x)) });
  const loaded = chains.every((c) => c.data || c.isError);
  const quotes = chains.flatMap((c) => c.data?.quotes ?? []);
  const front = chains.find((c) => c.data)?.data as OptionChain | undefined;
  const spot = front?.spot?.last ?? null;
  const key = chains.map((c) => c.dataUpdatedAt).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on chain updates
  const trades = useMemo<Hydrated[]>(
    () => (loaded ? mine.map((s) => ({ ...s, live: hydrate(toLegs(s.legs), quotes, spot) })) : []),
    [mine, loaded, key, spot],
  );
  return {
    isPending: pending || (mine.length > 0 && !loaded),
    error: error ?? chains.find((c) => c.error)?.error ?? null,
    trades,
    spot,
    quote: front?.spot ?? null,
    iv: atmIv(front),
    chains: chains.flatMap((c) => (c.data ? [c.data] : [])),
  };
}
