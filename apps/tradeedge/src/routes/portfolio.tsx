import { Tile } from '@/components/ticker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  type ClosedLot,
  type Portfolio,
  type PortfolioDomain,
  type PortfolioView,
  type Position,
  type TagSet,
  type Transaction,
  allTransactionsQuery,
  deletePortfolioView,
  holdingsAccountsQuery,
  portfolioViewPath,
  portfolioViewsQuery,
  quotesQuery,
  savePortfolioView,
  tagsQuery,
  transactionsQuery,
  writeBasket,
  writeSectors,
} from '@/lib/api';
import {
  DASH,
  expLabel,
  num,
  shortDate,
  signedPct,
  timePT,
  tone,
  usd,
  usdPlain,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  type CustomViewConfig,
  CustomViewPage,
  Page,
  StatusItem,
  type ViewDomain,
  type ViewField,
  ViewValueCell,
  maskAmount,
  useAmountsHidden,
  useShell,
} from '@edgedesk/app-shell';
import type { OptionQuote } from '@edgedesk/types';
import { appView } from '@edgedesk/types/views';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeftRight,
  Banknote,
  Briefcase,
  CalendarDays,
  CircleAlert,
  CircleDollarSign,
  Copy,
  Fingerprint,
  Hash,
  Landmark,
  Layers,
  Percent,
  Plug,
  Sigma,
  Tag,
  Tags,
  TrendingUp,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorNote } from './chain';

/** One position, with the account it sits in and, for shares, the live price and day change. */
interface Holding extends Position {
  key: string;
  account: Portfolio;
  kind: 'Shares' | 'Option';
  /** Live price: last for shares, mid for an option. */
  last: number | null;
  /** Today's change per share; shares only. */
  change: number | null;
  /** The option contract's live quote (iv, greeks per share, dte); options only. */
  option: OptionQuote | null;
  /** The ticker's sector (by underlying), shared by every account and option on it. */
  sector: string | null;
  /** The holding's basket: its account's own, else the one set for every account. */
  basket: string | null;
  /** The account's lot check for this symbol, when its lots miss the held quantity. */
  check: Portfolio['checks'][number] | null;
  /** The one-account holdings this line folds together when grouped; empty for a single account. */
  parts: Holding[];
}

const mult = (h: Holding) => (h.kind === 'Shares' ? 1 : 100);
const basis = (h: Holding) => (h.avg_cost === null ? null : h.avg_cost * h.quantity * mult(h));
const value = (h: Holding) => (h.last === null ? null : h.last * h.quantity * mult(h));
/** A per-share greek for the whole position: × 100 × contracts. Shares carry delta 1 each. */
const greek = (h: Holding, g: 'delta' | 'gamma' | 'theta' | 'vega') => {
  if (h.kind === 'Shares') return g === 'delta' ? h.quantity : null;
  const v = h.option?.[g];
  return v === null || v === undefined ? null : v * 100 * h.quantity;
};
const unrealized = (h: Holding) => {
  const v = value(h);
  const b = basis(h);
  return v === null || b === null ? null : v - b;
};
/** `SPY`, or an option as `SPY Nov 6 600 C`. */
const holdingLabel = (h: Position) =>
  h.right && h.expiration
    ? `${h.underlying} ${shortDate(h.expiration)} ${h.strike} ${h.right}`
    : h.symbol;
const taxLabel = (a: Portfolio) => (a.tax_type === 'retirement' ? 'Retirement' : 'Taxable');
const accountLabel = (h: Holding) =>
  h.parts.length > 1 ? `${h.parts.length} accounts` : h.account.name;

/** One line for the same symbol held in several accounts: quantities add, cost is weighted. */
function consolidate(parts: Holding[]): Holding {
  const first = parts[0] as Holding;
  const quantity = parts.reduce((s, h) => s + h.quantity, 0);
  const bases = parts.map(basis);
  const total = bases.every((b) => b !== null) ? bases.reduce((s, b) => s + (b ?? 0), 0) : null;
  const checks = parts.flatMap((h) => (h.check ? [h.check] : []));
  return {
    ...first,
    key: `merged:${parts.map((h) => h.key).join(',')}`,
    quantity,
    // A basket shows on the folded line only where every account agrees.
    basket: parts.every((h) => h.basket === first.basket) ? first.basket : null,
    avg_cost: total === null || quantity === 0 ? null : total / (quantity * mult(first)),
    check: checks.length
      ? {
          ...(checks[0] as Portfolio['checks'][number]),
          held: checks.reduce((s, c) => s + c.held, 0),
          in_lots: checks.reduce((s, c) => s + c.in_lots, 0),
        }
      : null,
    parts,
  };
}

/** The one-account holdings a line stands for: its parts when folded, else itself. */
const partsOf = (h: Holding) => (h.parts.length > 1 ? h.parts : [h]);
const checkNote = (c: Portfolio['checks'][number]) =>
  `lots ${num(c.in_lots, c.in_lots % 1 ? 4 : 0)} ≠ held ${num(c.held, c.held % 1 ? 4 : 0)}`;

const HOLDINGS_BASE: ViewDomain<Holding> = {
  id: 'holdings',
  formulas: true,
  rowKey: (h) => h.key,
  text: (h) => [h.symbol, h.underlying, h.account.name],
  fields: [
    {
      key: 'symbol',
      label: 'Symbol',
      icon: Tag,
      value: (h) => holdingLabel(h),
      format: 'text',
      formula: 'underlying, or underlying expiry strike right',
      filterable: true,
    },
    {
      key: 'underlying',
      label: 'Underlying',
      icon: Layers,
      value: (h) => h.underlying,
      format: 'text',
      formula: 'position.underlying',
      filterable: true,
      groupable: true,
    },
    {
      key: 'kind',
      label: 'Kind',
      icon: Hash,
      value: (h) => h.kind,
      format: 'text',
      formula: 'Shares or Option',
      filterable: true,
      groupable: true,
    },
    {
      key: 'expiration',
      label: 'Expiry',
      icon: CalendarDays,
      value: (h) => (h.expiration ? expLabel(h.expiration) : null),
      format: 'text',
      formula: 'position.expiration',
      groupable: true,
    },
    {
      key: 'strike',
      label: 'Strike',
      icon: Hash,
      value: (h) => h.strike,
      format: 'price',
      formula: 'position.strike',
    },
    {
      key: 'quantity',
      label: 'Quantity',
      icon: Hash,
      value: (h) => h.quantity,
      format: 'number',
      amount: true,
      formula: 'position.quantity',
    },
    {
      key: 'avg_cost',
      label: 'Avg cost',
      icon: CircleDollarSign,
      value: (h) => h.avg_cost,
      format: 'price',
      formula: 'position.avg_cost',
    },
    {
      key: 'price',
      label: 'Price',
      icon: CircleDollarSign,
      value: (h) => h.last,
      format: 'price',
      formula: 'option mid, else share last (live)',
    },
    {
      key: 'dte',
      label: 'DTE',
      icon: CalendarDays,
      value: (h) => h.option?.dte ?? null,
      format: 'integer',
      formula: 'expiration − today, calendar days',
    },
    {
      key: 'delta',
      label: 'Δ',
      icon: Sigma,
      value: (h) => greek(h, 'delta'),
      format: 'number',
      amount: true,
      formula: 'Δ × 100 × qty (shares: qty)',
      aggregate: 'sum',
    },
    {
      key: 'gamma',
      label: 'Γ',
      icon: Sigma,
      value: (h) => greek(h, 'gamma'),
      format: 'number',
      amount: true,
      formula: 'Γ × 100 × qty',
      aggregate: 'sum',
    },
    {
      key: 'theta',
      label: 'Θ/day',
      icon: Sigma,
      value: (h) => greek(h, 'theta'),
      format: 'signed',
      amount: true,
      formula: 'Θ × 100 × qty',
      aggregate: 'sum',
    },
    {
      key: 'vega',
      label: 'Vega',
      icon: Sigma,
      value: (h) => greek(h, 'vega'),
      format: 'number',
      amount: true,
      formula: 'vega × 100 × qty',
      aggregate: 'sum',
    },
    {
      key: 'iv',
      label: 'IV %',
      icon: Percent,
      value: (h) => (h.option?.iv == null ? null : h.option.iv * 100),
      format: 'number',
      formula: 'option IV × 100',
    },
    {
      key: 'cost_basis',
      label: 'Cost basis',
      icon: Banknote,
      value: basis,
      format: 'price',
      amount: true,
      formula: 'avg cost × qty (× 100 for options)',
      aggregate: 'sum',
    },
    {
      key: 'market_value',
      label: 'Value',
      icon: Banknote,
      value,
      format: 'price',
      amount: true,
      formula: 'price × qty (× 100 for options)',
      aggregate: 'sum',
    },
    {
      key: 'unrealized',
      label: 'Unrealized',
      icon: TrendingUp,
      value: unrealized,
      format: 'signed',
      amount: true,
      formula: 'value − cost basis',
      aggregate: 'sum',
    },
    {
      key: 'unrealized_pct',
      label: 'Unrealized %',
      icon: Percent,
      value: () => null,
      format: 'signed',
      formula: 'unrealized ÷ |cost basis| × 100; a group row works it out over the group',
      compute: (_h, { value: v }) => {
        const u = v('unrealized');
        const c = v('cost_basis');
        return typeof u === 'number' && typeof c === 'number' && c !== 0
          ? (u / Math.abs(c)) * 100
          : null;
      },
      rollFormula: true,
    },
    {
      key: 'pct_of_group',
      label: '% of group',
      icon: Percent,
      value: () => null,
      format: 'weight',
      formula: 'value ÷ the group’s value (all shown rows when not grouped)',
      share: { of: 'market_value', within: 'group' },
    },
    {
      key: 'pct_of_total',
      label: '% of total',
      icon: Percent,
      value: () => null,
      format: 'weight',
      formula: 'value ÷ the value of all shown rows; a group row shows its group’s share',
      share: { of: 'market_value', within: 'total' },
    },
    {
      key: 'account',
      label: 'Account',
      icon: Briefcase,
      value: accountLabel,
      format: 'text',
      formula: 'account name',
      filterable: true,
      groupable: true,
    },
    {
      key: 'tax_type',
      label: 'Tax type',
      icon: Landmark,
      value: (h) => taxLabel(h.account),
      format: 'text',
      formula: 'account.tax_type',
      filterable: true,
      groupable: true,
    },
    {
      key: 'check',
      label: 'Data check',
      icon: CircleAlert,
      value: (h) => (h.check ? checkNote(h.check) : null),
      format: 'text',
      amount: true,
      formula: 'lots bought (FIFO) vs quantity held',
    },
  ],
  widgets: [
    { key: 'value', label: 'Value', icon: Banknote },
    { key: 'day_pnl', label: 'Day P&L', icon: TrendingUp },
    { key: 'unrealized', label: 'Unrealized', icon: TrendingUp },
    { key: 'realized_ytd', label: 'Realized YTD', icon: CircleDollarSign },
    { key: 'check', label: 'Data check', icon: CircleAlert },
  ],
  details: [
    {
      id: 'check',
      label: 'Data check',
      icon: CircleAlert,
      render: (h) => <CheckDetails holding={h} />,
    },
    {
      id: 'position',
      label: 'Position',
      icon: Tag,
      render: (h) => <PositionDetails holding={h} />,
    },
    {
      id: 'lots',
      label: 'Tax lots',
      icon: Layers,
      render: (h) => <LotDetails holding={h} />,
    },
    {
      id: 'transactions',
      label: 'Transactions',
      icon: ArrowLeftRight,
      render: (h) => <TransactionDetails holding={h} />,
    },
    {
      id: 'account',
      label: 'Account',
      icon: Briefcase,
      render: (h) => <AccountDetails holding={h} />,
    },
  ],
  merge: { key: (h) => h.symbol, rows: consolidate },
  parts: { label: 'Holdings', by: 'account', rows: (h) => h.parts },
};

/** A holding's sector (by underlying) and basket (its account's own, else every account's). */
function tagsOf(set: TagSet | undefined, p: { symbol: string; underlying: string }, id: string) {
  const own = set?.baskets.find((b) => b.symbol === p.symbol && b.portfolio_id === id);
  const all = set?.baskets.find((b) => b.symbol === p.symbol && b.portfolio_id === null);
  return { sector: set?.sectors[p.underlying] ?? null, basket: (own ?? all)?.basket ?? null };
}

/**
 * Holdings with Sector and Basket before Account, edited in place (Bikram, 2026-10-09): a sector
 * belongs to the ticker, a basket to the holding (a folded line sets every account it folds).
 */
function holdingsDomain(saved: (set: TagSet) => void): ViewDomain<Holding> {
  const at = HOLDINGS_BASE.fields.findIndex((f) => f.key === 'account');
  const tags: ViewField<Holding>[] = [
    {
      key: 'sector',
      label: 'Sector',
      icon: Tags,
      value: (h) => h.sector,
      format: 'text',
      formula: 'per ticker: every account and every option on it',
      filterable: true,
      groupable: true,
      edit: {
        save: (h, v) => writeSectors({ [h.underlying]: v }).then(saved),
        note: (h) => `Sets every ${h.underlying} holding, options included.`,
      },
    },
    {
      key: 'basket',
      label: 'Basket',
      icon: Tag,
      value: (h) => h.basket,
      format: 'text',
      formula: 'per holding: one account, or every account',
      filterable: true,
      groupable: true,
      edit: {
        save: async (h, v) => {
          const parts = h.parts.length ? h.parts : [h];
          let set: TagSet | undefined;
          for (const p of parts)
            set = await writeBasket({ basket: v, symbols: [h.symbol], portfolio_id: p.account.id });
          if (set) saved(set);
        },
        note: (h) =>
          h.parts.length > 1
            ? `Sets ${holdingLabel(h)} in ${h.parts.length} accounts.`
            : `Sets ${holdingLabel(h)} in ${h.account.name} only.`,
      },
    },
  ];
  return {
    ...HOLDINGS_BASE,
    fields: [...HOLDINGS_BASE.fields.slice(0, at), ...tags, ...HOLDINGS_BASE.fields.slice(at)],
  };
}

/** One transaction with its account. */
interface Activity extends Transaction {
  account: Portfolio;
}

const ACTION: Record<string, string> = {
  buy: 'Buy',
  sell: 'Sell',
  dividend: 'Dividend',
  interest: 'Interest',
  fee: 'Fee',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
};

const instrument = (t: Transaction) =>
  t.right && t.underlying
    ? `${t.underlying} ${t.expiration ? expLabel(t.expiration) : ''} ${t.strike ?? ''} ${t.right}`.replace(
        /\s+/g,
        ' ',
      )
    : (t.symbol ?? null);

const TRANSACTIONS: ViewDomain<Activity> = {
  id: 'transactions',
  formulas: true,
  rowKey: (t) => `${t.account.id}:${t.id}`,
  text: (t) => [t.symbol ?? '', t.underlying ?? '', t.account.name, t.id],
  fields: [
    { key: 'date', label: 'Date', icon: CalendarDays, value: (t) => t.date, format: 'text' },
    {
      key: 'action',
      label: 'Action',
      icon: ArrowLeftRight,
      value: (t) => ACTION[t.kind] ?? t.kind,
      format: 'text',
      filterable: true,
      groupable: true,
    },
    {
      key: 'instrument',
      label: 'Instrument',
      icon: Tag,
      value: instrument,
      format: 'text',
      filterable: true,
    },
    {
      key: 'underlying',
      label: 'Underlying',
      icon: Layers,
      value: (t) => t.underlying,
      format: 'text',
      filterable: true,
      groupable: true,
    },
    {
      key: 'quantity',
      label: 'Qty',
      icon: Hash,
      value: (t) => t.quantity,
      format: 'number',
      amount: true,
    },
    {
      key: 'price',
      label: 'Price',
      icon: CircleDollarSign,
      value: (t) => t.price,
      format: 'price',
    },
    {
      key: 'fees',
      label: 'Fees',
      icon: Banknote,
      value: (t) => t.fees || null,
      format: 'price',
      amount: true,
      aggregate: 'sum',
    },
    {
      key: 'amount',
      label: 'Amount',
      icon: Banknote,
      value: (t) => t.amount,
      format: 'signed',
      amount: true,
      aggregate: 'sum',
    },
    {
      key: 'account',
      label: 'Account',
      icon: Briefcase,
      value: (t) => t.account.name,
      format: 'text',
      filterable: true,
      groupable: true,
    },
    {
      key: 'source_id',
      label: 'Source id',
      icon: Fingerprint,
      value: (t) => t.id,
      format: 'text',
      formula: "the broker's transaction id",
    },
  ],
};

interface ClosedRow extends ClosedLot {
  key: string;
  account: Portfolio;
}

const closedLabel = (l: ClosedLot) =>
  l.right && l.expiration
    ? `${l.underlying} ${expLabel(l.expiration)} ${l.strike ?? ''} ${l.right}`.replace(/\s+/g, ' ')
    : l.symbol;
const TERM = { short: 'Short', long: 'Long' } as const;

/** Closed lots (Bikram, 2026-10-11): every lot a trade closed, FIFO from the buys and sells. */
const CLOSED_LOTS: ViewDomain<ClosedRow> = {
  id: 'closed_lots',
  formulas: true,
  rowKey: (l) => l.key,
  text: (l) => [l.symbol, l.underlying, l.account.name],
  fields: [
    {
      key: 'instrument',
      label: 'Symbol',
      icon: Tag,
      value: closedLabel,
      format: 'text',
      formula: 'underlying, or underlying expiry strike right',
      filterable: true,
    },
    {
      key: 'underlying',
      label: 'Underlying',
      icon: Layers,
      value: (l) => l.underlying,
      format: 'text',
      filterable: true,
      groupable: true,
    },
    {
      key: 'acquired',
      label: 'Opened',
      icon: CalendarDays,
      value: (l) => l.acquired,
      format: 'text',
      formula: 'trade date of the opening buy (or sell, for a short lot)',
    },
    {
      key: 'closed',
      label: 'Closed',
      icon: CalendarDays,
      value: (l) => l.closed,
      format: 'text',
      formula: 'trade date of the closing trade',
    },
    {
      key: 'year',
      label: 'Year',
      icon: CalendarDays,
      value: (l) => l.closed.slice(0, 4),
      format: 'text',
      formula: 'year closed',
      filterable: true,
      groupable: true,
    },
    {
      key: 'quantity',
      label: 'Qty',
      icon: Hash,
      value: (l) => l.quantity,
      format: 'number',
      amount: true,
      formula: 'shares or contracts closed, negative for a short lot',
    },
    {
      key: 'cost',
      label: 'Cost',
      icon: Banknote,
      value: (l) => l.cost,
      format: 'price',
      amount: true,
      formula: 'paid, fees included (a short lot: paid to buy back)',
      aggregate: 'sum',
    },
    {
      key: 'proceeds',
      label: 'Proceeds',
      icon: Banknote,
      value: (l) => l.proceeds,
      format: 'price',
      amount: true,
      formula: 'received, fees included (a short lot: received to open)',
      aggregate: 'sum',
    },
    {
      key: 'gain',
      label: 'Gain',
      icon: TrendingUp,
      value: (l) => l.gain,
      format: 'signed',
      amount: true,
      formula: 'proceeds − cost',
      aggregate: 'sum',
    },
    {
      key: 'gain_pct',
      label: 'Gain %',
      icon: Percent,
      value: () => null,
      format: 'signed',
      formula: 'gain ÷ cost × 100; a group row works it out over the group',
      compute: (_l, { value: v }) => {
        const g = v('gain');
        const c = v('cost');
        return typeof g === 'number' && typeof c === 'number' && c !== 0
          ? (g / Math.abs(c)) * 100
          : null;
      },
      rollFormula: true,
    },
    {
      key: 'term',
      label: 'Term',
      icon: Hash,
      value: (l) => TERM[l.term],
      format: 'text',
      formula: 'Long when held more than a year',
      filterable: true,
      groupable: true,
    },
    {
      key: 'account',
      label: 'Account',
      icon: Briefcase,
      value: (l) => l.account.name,
      format: 'text',
      filterable: true,
      groupable: true,
    },
    {
      key: 'tax_type',
      label: 'Tax type',
      icon: Landmark,
      value: (l) => taxLabel(l.account),
      format: 'text',
      filterable: true,
      groupable: true,
    },
  ],
  widgets: [
    { key: 'realized_ytd', label: 'Realized YTD', icon: CircleDollarSign },
    { key: 'realized_all', label: 'Realized, all years', icon: Sigma },
  ],
};

/** The Closed lots widgets over the shown lots: this year's gain and every gain shown. */
function closedWidget(key: string, shown: ClosedRow[], hidden: boolean): ReactNode {
  const m = (text: string) => (hidden ? maskAmount(text) : text);
  const year = String(new Date().getFullYear());
  const pick = key === 'realized_ytd' ? shown.filter((l) => l.closed.startsWith(year)) : shown;
  if (key !== 'realized_ytd' && key !== 'realized_all') return null;
  const total = pick.reduce((s, l) => s + l.gain, 0);
  const short = pick.reduce((s, l) => s + (l.term === 'short' ? l.gain : 0), 0);
  return (
    <Tile
      label={key === 'realized_ytd' ? 'Realized YTD' : 'Realized, all years'}
      value={m(usd(total))}
      valueClassName={toneClass(total)}
      caption={`short-term ${m(usd(short))}`}
    />
  );
}

/** Holdings fields read from live prices (Bikram, 2026-10-09: prices load only for views that show one). */
const LIVE_FIELDS = new Set([
  'price',
  'dte',
  'delta',
  'gamma',
  'theta',
  'vega',
  'iv',
  'market_value',
  'unrealized',
  'pct_of_group',
  'pct_of_total',
]);
const LIVE_WIDGETS = new Set(['value', 'day_pnl', 'unrealized']);

/** Does the view show a live field: a column, a tile, the pivot value, a widget, or a formula over one? */
function showsLive(config: CustomViewConfig): boolean {
  if (config.columns.length === 0) return true;
  const live = new Set(LIVE_FIELDS);
  for (const f of config.formulas) {
    if ([...live].some((k) => new RegExp(`\\b${k}\\b`).test(f.expr))) live.add(f.key);
  }
  return (
    config.columns.some((k) => live.has(k)) ||
    config.tiles.some((t) => live.has(t.field)) ||
    (config.pivot !== null && live.has(config.pivot.value)) ||
    config.widgets.some((k) => LIVE_WIDGETS.has(k))
  );
}

/** The symbol a holding is priced by: the OCC symbol for an option, the ticker for shares. */
const priceSymbol = (p: { right?: unknown; symbol: string; underlying: string }) =>
  p.right ? p.symbol : p.underlying;

/**
 * Every account the signed-in person has, its positions as holdings, and live share and option
 * prices for the rows the view shows only (Bikram, 2026-10-09): `setShown` takes those rows, and
 * prices load only when `live`. Shares by ticker, options by OCC symbol, in one batch request.
 */
function useHoldings(live: boolean) {
  const list = useQuery(holdingsAccountsQuery());
  const accounts = list.data ?? [];
  // Sorted symbols of the shown rows, joined: an unchanged list keeps the same query.
  const [shown, setShownKey] = useState('');
  const setShown = useCallback(
    (rows: Holding[]) =>
      setShownKey([...new Set(rows.flatMap((h) => partsOf(h).map(priceSymbol)))].sort().join(',')),
    [],
  );
  // Settle the list before asking, so typing in the filter sends one request, not one per key.
  const [symbols, setSymbols] = useState<string[]>([]);
  useEffect(() => {
    const t = setTimeout(() => setSymbols(live && shown ? shown.split(',') : []), 300);
    return () => clearTimeout(t);
  }, [live, shown]);
  const quotes = useQuery(quotesQuery(symbols));
  const priced = quotes.data?.quotes ?? {};
  const liveKey = quotes.dataUpdatedAt;
  const tags = useQuery(tagsQuery());
  const tagsKey = tags.dataUpdatedAt;
  const accountsKey = accounts.map((a) => a.updated_at).join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on loaded accounts and prices
  const rows = useMemo<Holding[]>(
    () =>
      accounts.flatMap((a) =>
        a.positions.map((p) => {
          const q = priced[priceSymbol(p)] ?? null;
          const option = p.right && q && 'mid' in q ? q : null;
          const stock = !p.right && q && !('mid' in q) ? q : null;
          return {
            ...p,
            key: `${a.id}:${p.symbol}`,
            account: a,
            kind: p.right ? 'Option' : 'Shares',
            last: option ? option.mid : (stock?.last ?? null),
            change: stock?.change ?? null,
            option,
            ...tagsOf(tags.data, p, a.id),
            check: a.checks.find((c) => c.symbol === p.symbol) ?? null,
            parts: [],
          } satisfies Holding;
        }),
      ),
    [accountsKey, liveKey, tagsKey],
  );
  const loading = list.isPending;
  const error = list.error;
  return { list, accounts, rows, loading, error, quotes, setShown };
}

function loadState({
  error,
  loading,
  empty,
}: {
  error: Error | null;
  loading: boolean;
  empty: boolean;
}): ReactNode {
  if (error) return <ErrorNote>{error.message}</ErrorNote>;
  if (loading) return <Skeleton className="h-96 w-full" />;
  if (empty) return <NoAccounts />;
  return undefined;
}

/** No accounts yet: link a broker in Settings ▸ Integrations (Bikram, 2026-10-11). */
function NoAccounts() {
  const { openSettings } = useShell();
  return (
    <Card>
      <CardHeader>
        <CardTitle>No accounts yet</CardTitle>
        <CardDescription>
          Connect your broker through SnapTrade, or add a manual account for a broker SnapTrade
          can't reach.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button size="sm" onClick={() => openSettings('integrations')}>
          <Plug />
          Connect a broker
        </Button>
      </CardContent>
    </Card>
  );
}

function PortfolioStatus({ accounts }: { accounts: Portfolio[] }) {
  const last = accounts
    .map((a) => a.updated_at)
    .sort()
    .at(-1);
  return (
    <>
      <StatusItem label="Accounts" value={accounts.length} ok={accounts.length ? true : null} />
      {last ? (
        <StatusItem label="Last import" value={`${last.slice(0, 10)} ${timePT(last)} PT`} />
      ) : null}
    </>
  );
}

const toneClass = (v: number | null) =>
  cn(tone(v) === 'gain' && 'text-gain', tone(v) === 'loss' && 'text-loss');

/**
 * One holdings widget over the rows the view shows (Bikram, 2026-10-09): unfiltered, every account;
 * filtered, the shown rows, with cash, realized and lot checks of the accounts they sit in.
 */
function holdingsWidget(
  key: string,
  all: Portfolio[],
  allRows: Holding[],
  shown: Holding[],
  hidden: boolean,
) {
  const ids = new Set(shown.map((h) => h.account.id));
  const accounts = shown.length === allRows.length ? all : all.filter((a) => ids.has(a.id));
  return holdingsWidgets(accounts, shown, hidden)[key] ?? null;
}

/**
 * Holdings widgets over these accounts and rows: value, day P&L, unrealized, realized this year,
 * lot check. `hidden` (Hide amounts) masks their dollars and quantities; percents stay.
 */
function holdingsWidgets(
  accounts: Portfolio[],
  rows: Holding[],
  hidden: boolean,
): Record<string, ReactNode> {
  const m = (text: string) => (hidden ? maskAmount(text) : text);
  const cash = accounts.reduce((s, a) => s + a.cash, 0);
  const sum = (f: (h: Holding) => number | null) => rows.reduce((s, h) => s + (f(h) ?? 0), 0);
  const shares = sum(value);
  const day = sum((h) => (h.change === null ? null : h.change * h.quantity));
  const before = shares - day;
  const unpriced = rows.some((h) => h.last === null);
  const realized = accounts.reduce((s, a) => s + a.realized_ytd.total, 0);
  const shortTerm = accounts.reduce((s, a) => s + a.realized_ytd.short_term, 0);
  const checks = accounts.flatMap((a) => a.checks.map((c) => ({ ...c, account: a.name })));
  const unreal = sum(unrealized);
  return {
    value: (
      <Tile
        label="Value"
        value={m(usdPlain(shares + cash))}
        caption={`incl. cash ${m(usdPlain(cash))}${unpriced ? ', some not priced' : ''}`}
      />
    ),
    day_pnl: (
      <Tile
        label="Day P&L"
        value={m(usd(day))}
        valueClassName={toneClass(day)}
        caption={<span className={toneClass(day)}>{before ? signedPct(day / before) : DASH}</span>}
      />
    ),
    unrealized: (
      <Tile
        label="Unrealized"
        value={m(usd(unreal))}
        valueClassName={toneClass(unreal)}
        caption="since cost"
      />
    ),
    realized_ytd: (
      <Link
        to="/portfolio/closed-lots"
        aria-label="Realized YTD: open Closed lots"
        className="min-w-0"
      >
        <Tile
          label="Realized YTD"
          value={m(usd(realized))}
          valueClassName={toneClass(realized)}
          caption={`short-term ${m(usd(shortTerm))} · see lots`}
          className="h-full hover:bg-muted/50"
        />
      </Link>
    ),
    check: (
      <Tile
        label="Data check"
        value={
          checks.length ? (
            <span className="flex items-center gap-1.5 text-base text-loss">
              <CircleAlert className="size-4" />
              {checks.length} mismatch{checks.length > 1 ? 'es' : ''}
            </span>
          ) : (
            <span className="text-base text-gain">All lots match</span>
          )
        }
        caption={
          checks[0]
            ? `${checks[0].symbol}: ${m(checkNote(checks[0]))}`
            : 'lots against held quantity'
        }
      />
    ),
  };
}

/** Every account's transactions with their account, newest first, in one request; loads only when `on`. */
function useActivity(accounts: Portfolio[], on: boolean) {
  const txs = useQuery({ ...allTransactionsQuery(), enabled: on });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on loaded transactions and accounts
  const rows = useMemo<Activity[]>(
    () =>
      (txs.data ?? []).flatMap(({ portfolio_id, ...t }) => {
        const account = byId.get(portfolio_id);
        return account ? [{ ...t, account }] : [];
      }),
    [txs.dataUpdatedAt, accounts.map((a) => a.id).join(',')],
  );
  return { rows, error: txs.error, loading: on && txs.isPending };
}

/**
 * One portfolio view on the shared CustomViewPage (Bikram, 2026-10-09). App views (All accounts,
 * Transactions) are read-only: no Edit, no Delete, and Duplicate copies one into a view of your own.
 */
function PortfolioViewBody({ view }: { view: PortfolioView }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const config: CustomViewConfig = { name: view.name, ...view.config };
  const { list, accounts, rows, loading, error, quotes, setShown } = useHoldings(
    view.domain === 'holdings' && showsLive(config),
  );
  const holdings = useMemo(
    () => holdingsDomain((set) => qc.setQueryData(tagsQuery().queryKey, set)),
    [qc],
  );
  const activity = useActivity(accounts, view.domain === 'transactions');
  const closed = useMemo<ClosedRow[]>(
    () =>
      view.domain === 'closed_lots'
        ? accounts.flatMap((a) =>
            (a.closed_lots ?? []).map((l, i) => ({ ...l, key: `${a.id}:${i}`, account: a })),
          )
        : [],
    [accounts, view.domain],
  );
  const hidden = useAmountsHidden();
  const listKey = portfolioViewsQuery(view.domain).queryKey;
  const save = useMutation({
    mutationFn: (c: CustomViewConfig) => savePortfolioView(view.domain, c, view.id),
    onSuccess: (v) =>
      qc.setQueryData(listKey, (old: PortfolioView[] | undefined) =>
        old?.map((o) => (o.id === v.id ? v : o)),
      ),
  });
  const copy = useMutation({
    mutationFn: () => savePortfolioView(view.domain, { ...view.config, name: `${view.name} copy` }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: listKey });
      void navigate({ to: portfolioViewPath(v) });
    },
  });
  const remove = useMutation({
    mutationFn: () => deletePortfolioView(view.domain, view.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: listKey });
      void navigate({ to: '/portfolio' });
    },
  });
  // Loaded data stays on screen when a refresh fails; the status bar says so (Bikram, 2026-10-09).
  const state = loadState({
    error: list.data ? null : error,
    loading,
    empty: list.data?.length === 0,
  });
  const stale = quotes.data?.stale.length ?? 0;
  const common = {
    key: `${view.domain}:${view.id}:${view.updated_at}`,
    viewId: view.app ? undefined : view.id,
    crumbs: [{ label: 'Portfolio' }, { label: view.name }],
    config,
    onConfigChange: view.app ? undefined : (c: CustomViewConfig) => save.mutate(c),
    // Your own views duplicate and delete from the Edit dialog's More section; an app view has no
    // Edit, so it keeps Duplicate in the header.
    onDuplicate: view.app ? undefined : () => copy.mutate(),
    onDelete: view.app ? undefined : () => remove.mutate(),
    actions: view.app && (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Duplicate view"
            disabled={copy.isPending}
            onClick={() => copy.mutate()}
          >
            <Copy />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Duplicate into a view of your own</TooltipContent>
      </Tooltip>
    ),
    status: (
      <>
        <PortfolioStatus accounts={accounts} />
        <StatusItem label="Made by" value={view.app ? 'App' : 'You'} />
        {(list.data && error) || quotes.error ? (
          <StatusItem label="Refresh failed" value={(error ?? quotes.error)?.message} ok={false} />
        ) : stale ? (
          <StatusItem label="Prices stale" value={stale} ok={false} />
        ) : null}
        {save.isPending ? (
          <StatusItem label="Saving…" />
        ) : save.isError ? (
          <StatusItem label="Not saved" ok={false} />
        ) : null}
      </>
    ),
  };
  if (view.domain === 'closed_lots') {
    return (
      <CustomViewPage
        {...common}
        domain={CLOSED_LOTS}
        rows={closed}
        widget={(k, shown) => closedWidget(k, shown, hidden)}
        rowTitle={(l) => `${closedLabel(l)} · ${l.account.name}`}
        state={state}
      />
    );
  }
  if (view.domain === 'transactions') {
    return (
      <CustomViewPage
        {...common}
        domain={TRANSACTIONS}
        rows={activity.rows}
        rowTitle={(t) => instrument(t) ?? ACTION[t.kind] ?? t.kind}
        state={
          state ?? loadState({ error: activity.error, loading: activity.loading, empty: false })
        }
      />
    );
  }
  return (
    <CustomViewPage
      {...common}
      domain={holdings}
      rows={rows}
      onShownRows={setShown}
      widget={
        accounts.length ? (k, shown) => holdingsWidget(k, accounts, rows, shown, hidden) : undefined
      }
      rowTitle={(h) => `${holdingLabel(h)} · ${accountLabel(h)}`}
      state={state}
    />
  );
}

/** Reads one view (an app view or the person's own) and shows it. */
function PortfolioViewById({ domain, id }: { domain: PortfolioDomain; id: string }) {
  const app = appView(domain, id);
  const views = useQuery({ ...portfolioViewsQuery(domain), enabled: !app });
  // App views are defined in code: no need to wait for the list.
  const view = app
    ? ({ ...app, domain, created_at: '', updated_at: '' } as PortfolioView)
    : views.data?.find((v) => v.id === id);
  if (!view) {
    return (
      <Page crumbs={[{ label: 'Portfolio' }, { label: views.isPending ? '…' : 'Not found' }]}>
        {views.isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : views.isError ? (
          <ErrorNote>{views.error.message}</ErrorNote>
        ) : (
          <ErrorNote>No saved view with this id. It may have been deleted.</ErrorNote>
        )}
      </Page>
    );
  }
  return <PortfolioViewBody view={view} />;
}

/** `/portfolio`: the All accounts app view. */
export function AllAccountsPage() {
  return <PortfolioViewById domain="holdings" id={ALL_ACCOUNTS} />;
}

/** `/portfolio/transactions`: the Transactions app view. */
export function TransactionsPage() {
  return <PortfolioViewById domain="transactions" id={TRANSACTIONS_ID} />;
}

/** `/portfolio/closed-lots`: the Closed lots app view. */
export function ClosedLotsPage() {
  return <PortfolioViewById domain="closed_lots" id={CLOSED_LOTS_ID} />;
}

/** `/portfolio/views/$domain/$id`: a person's own view. */
export function PortfolioViewPage() {
  const { domain, id } = useParams({ from: '/portfolio/views/$domain/$id' });
  if (domain !== 'holdings' && domain !== 'transactions' && domain !== 'closed_lots') {
    return (
      <Page crumbs={[{ label: 'Portfolio' }, { label: 'Not found' }]}>
        <ErrorNote>No portfolio views of {domain}.</ErrorNote>
      </Page>
    );
  }
  return <PortfolioViewById domain={domain} id={id} />;
}

const ALL_ACCOUNTS = 'all-accounts';
const TRANSACTIONS_ID = 'transactions';
const CLOSED_LOTS_ID = 'closed-lots';

/** Masks a holding amount's text while Hide amounts is on. */
function useMask() {
  const hidden = useAmountsHidden();
  return (text: string) => (hidden ? maskAmount(text) : text);
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="num">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CheckDetails({ holding: h }: { holding: Holding }) {
  const m = useMask();
  const off = partsOf(h).filter((p) => p.check);
  if (!off.length)
    return (
      <p className="text-sm text-muted-foreground">
        Lots match: every {h.symbol} held has a buy on record.
      </p>
    );
  return (
    <div className="flex flex-col gap-2 text-sm text-loss">
      {off.map((p) => {
        const missing = (p.check?.held ?? 0) - (p.check?.in_lots ?? 0);
        return (
          <p key={p.key}>
            {missing > 0
              ? `${m(num(missing, missing % 1 ? 4 : 0))} held in ${p.account.name} have no buy transaction yet, so no lot.`
              : `The lots hold ${m(num(-missing, missing % 1 ? 4 : 0))} more than ${p.account.name} reports.`}
          </p>
        );
      })}
      <p className="text-xs text-muted-foreground">
        An agent sends the missing transactions with portfolio_transaction_write to fix it.
      </p>
    </div>
  );
}

function PositionDetails({ holding: h }: { holding: Holding }) {
  const m = useMask();
  return (
    <Facts
      items={[
        ['Symbol', h.symbol],
        ['Kind', h.kind],
        ['Expiry', h.expiration ? expLabel(h.expiration) : DASH],
        ['Strike', h.strike === null ? DASH : num(h.strike)],
        ['Quantity', m(num(h.quantity, h.quantity % 1 ? 4 : 0))],
        ['Avg cost', h.avg_cost === null ? DASH : num(h.avg_cost)],
        ['Price', h.last === null ? DASH : num(h.last)],
        ['Cost basis', <ViewValueCell key="b" amount value={basis(h)} format="price" />],
        ['Value', <ViewValueCell key="v" amount value={value(h)} format="price" />],
        ['Unrealized', <ViewValueCell key="u" amount value={unrealized(h)} format="signed" />],
      ]}
    />
  );
}

/** A small details table; the Account column shows only when the line spans accounts. */
function DetailsTable({
  head,
  rows,
}: {
  head: { label: string; right?: boolean }[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  return (
    <div className="-mx-1 overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {head.map((h) => (
              <TableHead key={h.label} className={cn(h.right && 'text-right')}>
                {h.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              {r.cells.map((c, i) => (
                <TableCell
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  key={i}
                  className={cn('num', head[i]?.right && 'text-right')}
                >
                  {c}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LotDetails({ holding: h }: { holding: Holding }) {
  const m = useMask();
  const parts = partsOf(h);
  const many = parts.length > 1;
  const lots = parts.flatMap((p) =>
    p.account.lots.filter((l) => l.symbol === h.symbol).map((l) => ({ p, l })),
  );
  if (!lots.length)
    return (
      <p className="text-sm text-muted-foreground">No lots: no buys of {h.symbol} on record.</p>
    );
  return (
    <DetailsTable
      head={[
        ...(many ? [{ label: 'Account' }] : []),
        { label: 'Acquired' },
        { label: 'Qty', right: true },
        { label: 'Cost', right: true },
        { label: 'Term' },
      ]}
      rows={lots.map(({ p, l }) => ({
        key: `${p.key}:${l.acquired}:${l.cost}:${l.quantity}`,
        cells: [
          ...(many ? [p.account.name] : []),
          l.acquired,
          m(num(l.quantity, l.quantity % 1 ? 4 : 0)),
          num(l.cost),
          // Retirement accounts are not taxed on sales, so lots carry no term.
          p.account.tax_type === 'retirement' ? 'n/a' : l.term === 'long' ? 'Long' : 'Short',
        ],
      }))}
    />
  );
}

function TransactionDetails({ holding: h }: { holding: Holding }) {
  const m = useMask();
  const parts = partsOf(h);
  const many = parts.length > 1;
  const qs = useQueries({ queries: parts.map((p) => transactionsQuery(p.account.id, h.symbol)) });
  if (qs.some((q) => q.isPending)) return <Skeleton className="h-24 w-full" />;
  const failed = qs.find((q) => q.isError);
  if (failed?.error) return <ErrorNote>{failed.error.message}</ErrorNote>;
  const rows = parts
    .flatMap((p, i) => (qs[i]?.data ?? []).map((t) => ({ p, t })))
    .sort((a, b) => b.t.date.localeCompare(a.t.date));
  if (!rows.length)
    return <p className="text-sm text-muted-foreground">No transactions for {h.symbol}.</p>;
  return (
    <DetailsTable
      head={[
        ...(many ? [{ label: 'Account' }] : []),
        { label: 'Date' },
        { label: 'Action' },
        { label: 'Qty @ price', right: true },
        { label: 'Amount', right: true },
      ]}
      rows={rows.map(({ p, t }) => ({
        key: `${p.key}:${t.id}`,
        cells: [
          ...(many ? [p.account.name] : []),
          t.date,
          ACTION[t.kind] ?? t.kind,
          t.quantity !== null
            ? `${m(num(t.quantity, t.quantity % 1 ? 4 : 0))} @ ${num(t.price)}`
            : DASH,
          m(usd(t.amount)),
        ],
      }))}
    />
  );
}

/** Each account the line sits in (Bikram, 2026-10-09: no cash here, it is the account's, not the holding's). */
function AccountDetails({ holding: h }: { holding: Holding }) {
  return (
    <DetailsTable
      head={[{ label: 'Account' }, { label: 'Broker' }, { label: 'Tax type' }, { label: 'As of' }]}
      rows={partsOf(h).map((p) => ({
        key: p.key,
        cells: [
          p.account.name,
          p.account.broker ?? DASH,
          taxLabel(p.account),
          p.account.as_of.slice(0, 10),
        ],
      }))}
    />
  );
}
