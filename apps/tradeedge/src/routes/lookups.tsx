// Lookup fields (Bikram, 2026-10-12, /mnt/project-files/symbol-indicators/design.md): any TradeEdge
// view's rows look up facts about their symbol (an option by its underlying) and their account,
// like a spreadsheet lookup column. Symbol facts come live from the person's Robinhood sign-in and
// from DataEdge (`/api/symbols`); account facts from the accounts and the broker links.
import { type Portfolio, type SnapTradeAccount, integrationsQuery, symbolsQuery } from '@/lib/api';
import {
  type CustomViewConfig,
  StatusItem,
  type ViewField,
  type ViewFieldGroup,
  useShell,
} from '@edgedesk/app-shell';
import { Button } from '@edgedesk/app-shell/ui/button';
import { SYMBOL_FIELDS, type SymbolFacts, type SymbolFieldSpec } from '@edgedesk/types/symbols';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BadgeDollarSign,
  Banknote,
  Building2,
  CalendarClock,
  ChartLine,
  Gauge,
  Landmark,
  Plug,
  Repeat,
  Scale,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/** The field groups, by where a field comes from; colours from the theme's chart tokens. */
export const SYMBOL_GROUP: ViewFieldGroup = {
  id: 'symbol',
  label: 'Symbol',
  color: 'var(--chart-3)',
  note: 'by symbol · an option by its underlying',
  sources: Object.fromEntries(
    SYMBOL_FIELDS.map((f) => [
      f.topic,
      f.source === 'robinhood' ? 'Robinhood · live' : 'DataEdge · daily close',
    ]),
  ),
};
export const ACCOUNT_GROUP: ViewFieldGroup = {
  id: 'account',
  label: 'Account',
  color: 'var(--chart-6)',
  note: 'by account',
};
/** A domain's own fields: Holding, Transaction, Lot. */
export const rowGroup = (label: string): ViewFieldGroup => ({
  id: 'row',
  label,
  color: 'var(--chart-1)',
});

const TOPIC_ICONS: Record<string, typeof Activity> = {
  Valuation: Scale,
  Analysts: Users,
  Earnings: CalendarClock,
  Dividends: BadgeDollarSign,
  'Range and volume': ChartLine,
  Profile: Building2,
  'P/E history': Scale,
  Technicals: Gauge,
};

/** The symbol facts' fields for rows whose symbol `of` reads (null: no symbol, like cash). */
export function symbolFields<T>(
  of: (row: T) => string | null,
  facts: Record<string, SymbolFacts>,
): ViewField<T>[] {
  return SYMBOL_FIELDS.map((s: SymbolFieldSpec) => ({
    key: s.key,
    label: s.label,
    icon: TOPIC_ICONS[s.topic] ?? Activity,
    group: SYMBOL_GROUP.id,
    topic: s.topic,
    value: (row: T) => {
      const sym = of(row);
      const v = sym ? facts[sym]?.[s.key] : undefined;
      return v === undefined ? null : v;
    },
    format: s.format,
    compact: s.compact,
    formula: s.formula,
    filterable: s.category,
    groupable: s.category,
  }));
}

export const SYMBOL_KEYS = new Set(SYMBOL_FIELDS.map((f) => f.key));

/** Does the view use a symbol field: a column, filter, group, tile, sort, pivot or formula? */
export function usesSymbolFields(config: CustomViewConfig): boolean {
  const keys = [
    ...config.columns,
    ...config.filters.fields,
    ...config.filters.default.map((t) => t.key),
    ...config.group.fields,
    ...(config.group.default ? [config.group.default] : []),
    ...config.tiles.map((t) => t.field),
    ...(config.sort ? [config.sort.key] : []),
    ...(config.pivot ? [config.pivot.rows, config.pivot.columns, config.pivot.value] : []),
  ];
  if (keys.some((k) => SYMBOL_KEYS.has(k))) return true;
  return config.formulas.some((f) =>
    [...SYMBOL_KEYS].some((k) => new RegExp(`\\b${k}\\b`).test(f.expr)),
  );
}

/** Does the view use an account's Trading field? It reads the broker links, a slower call. */
export const usesTrading = (config: CustomViewConfig) =>
  [
    ...config.columns,
    ...config.filters.fields,
    ...config.group.fields,
    ...config.filters.default.map((t) => t.key),
    config.group.default,
  ].includes('trading');

/**
 * Symbol facts for `symbols`, loaded only when `on`; the list settles first, so typing in the
 * filter sends one request.
 */
export function useSymbolFacts(symbols: string[], on: boolean) {
  const key = on ? [...new Set(symbols)].sort().join(',') : '';
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSettled(key), 300);
    return () => clearTimeout(t);
  }, [key]);
  const list = useMemo(() => (settled ? settled.split(',').slice(0, 1000) : []), [settled]);
  const q = useQuery(symbolsQuery(list));
  return { facts: q.data?.symbols ?? {}, read: q.data, query: q };
}

/** The status bar's word on symbol data: Robinhood's state (with a connect prompt) and DataEdge's day. */
export function SymbolStatus({ read }: { read: ReturnType<typeof useSymbolFacts> }) {
  const { openSettings } = useShell();
  const r = read.read;
  if (read.query.error)
    return <StatusItem label="Symbol data" value={read.query.error.message} ok={false} />;
  if (!r) return read.query.isFetching ? <StatusItem label="Symbol data…" /> : null;
  return (
    <>
      {r.robinhood.state === 'not_connected' ? (
        <Button
          variant="ghost"
          size="xs"
          className="h-5 px-1 text-xs"
          onClick={() => openSettings('integrations')}
        >
          <Plug />
          Connect Robinhood for symbol fields
        </Button>
      ) : (
        <StatusItem
          label="Robinhood"
          value={r.robinhood.state === 'ok' ? 'live' : (r.robinhood.error ?? 'failed')}
          ok={r.robinhood.state === 'ok'}
        />
      )}
      {r.dataedge.state !== 'off' && (
        <StatusItem
          label="DataEdge"
          value={r.dataedge.state === 'ok' ? (r.dataedge.as_of ?? 'no data') : 'failed'}
          ok={r.dataedge.state === 'ok' ? null : false}
        />
      )}
    </>
  );
}

/** How an account trades (Bikram, 2026-10-12): via SnapTrade, via Robinhood, else read only. */
export function useTrading(on: boolean): Map<string, string> {
  const q = useQuery({ ...integrationsQuery(), enabled: on });
  return useMemo(() => {
    const m = new Map<string, string>();
    const st = q.data?.snaptrade;
    if (!st?.connected) return m;
    for (const b of st.brokers ?? [])
      for (const a of b.accounts as SnapTradeAccount[])
        if (a.portfolio_id)
          m.set(
            a.portfolio_id,
            a.trading.via === 'snaptrade'
              ? 'via SnapTrade'
              : a.trading.via === 'robinhood'
                ? 'via Robinhood'
                : 'Read only',
          );
    return m;
  }, [q.data]);
}

/** An account's brokerage name, `Manual` for a manual account with none. */
export const brokerageOf = (a: Portfolio) => a.broker ?? (a.source === 'manual' ? 'Manual' : null);

/** The one value every account shares, else null (a line folding accounts at two brokers). */
const shared = (vs: (string | null)[]) =>
  vs.length && vs.every((v) => v === vs[0]) ? vs[0] : null;

/**
 * The account fields a row looks up by its accounts (Bikram, 2026-10-12): Brokerage (show, filter,
 * group), Trading and Cash. `of` lists the row's accounts (a folded holding has several). A
 * domain's own Account and Tax type fields join this group too.
 */
export function accountFields<T>(
  of: (row: T) => Portfolio[],
  trading: Map<string, string>,
): ViewField<T>[] {
  return [
    {
      key: 'brokerage',
      label: 'Brokerage',
      icon: Landmark,
      group: ACCOUNT_GROUP.id,
      value: (r) => shared(of(r).map(brokerageOf)) ?? null,
      format: 'text',
      formula: 'the broker the account is at',
      filterable: true,
      groupable: true,
    },
    {
      key: 'trading',
      label: 'Trading',
      icon: Repeat,
      group: ACCOUNT_GROUP.id,
      value: (r) => shared(of(r).map((a) => trading.get(a.id) ?? 'Read only')) ?? null,
      format: 'text',
      formula: 'via SnapTrade, via Robinhood, or Read only (Settings ▸ Brokers and accounts)',
      filterable: true,
      groupable: true,
    },
    {
      key: 'cash',
      label: 'Account cash',
      icon: Banknote,
      group: ACCOUNT_GROUP.id,
      value: (r) => {
        const as = of(r);
        return as.length === 1 ? (as[0]?.cash ?? null) : null;
      },
      format: 'price',
      amount: true,
      formula: "the account's cash balance",
    },
  ];
}

/** Puts a domain's own Account and Tax type fields in the Account group. */
export const inAccountGroup = <T,>(fields: ViewField<T>[]) =>
  fields.map((f) =>
    f.key === 'account' || f.key === 'tax_type' ? { ...f, group: ACCOUNT_GROUP.id } : f,
  );
