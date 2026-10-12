import { Tile } from '@/components/ticker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  type ClosedLot,
  type LotCheck,
  type LotSource,
  type Portfolio,
  type PortfolioDomain,
  type PortfolioView,
  type Position,
  type TagSet,
  type TaxLot,
  type Transaction,
  allTransactionsQuery,
  dataedgeSymbolsQuery,
  deletePortfolioView,
  holdingsAccountsQuery,
  portfolioViewPath,
  portfolioViewsQuery,
  quotesQuery,
  savePortfolioView,
  tagsQuery,
  transactionsQuery,
  watchlistQuery,
  writeBasket,
  writeLotCost,
  writeSectors,
} from '@/lib/api';
import { todayPT } from '@/lib/calendar';
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
import type { SymbolFacts } from '@edgedesk/types/symbols';
import { appView } from '@edgedesk/types/views';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  ArrowLeftRight,
  Banknote,
  Briefcase,
  CalendarDays,
  Check,
  CircleAlert,
  CircleDollarSign,
  Copy,
  Fingerprint,
  Hash,
  Landmark,
  Layers,
  Pencil,
  Percent,
  Plug,
  Sigma,
  Tag,
  Tags,
  TrendingUp,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorNote } from './chain';
import {
  ACCOUNT_GROUP,
  SYMBOL_GROUP,
  SymbolStatus,
  accountFields,
  brokerageOf,
  inAccountGroup,
  rowGroup,
  symbolFields,
  useSymbolFacts,
  useTrading,
  usesSymbolFields,
  usesTrading,
} from './lookups';

/** One position, with the account it sits in and, for shares, the live price and day change. */
interface Holding extends Position {
  key: string;
  account: Portfolio;
  /** Cash: the account's cash balance as a line, priced $1 (Bikram, 2026-10-12). */
  kind: 'Shares' | 'Option' | 'Cash';
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
  /** The account's lot checks for this symbol: lots that miss what is held, shares with no cost. */
  checks: LotCheck[];
  /** The one-account holdings this line folds together when grouped; empty for a single account. */
  parts: Holding[];
  /** Sold out this year: no shares left, kept for its realized gain and dividends. */
  closed: boolean;
}

const mult = (h: Holding) => (h.kind === 'Option' ? 100 : 1);
const basis = (h: Holding) => (h.avg_cost === null ? null : h.avg_cost * h.quantity * mult(h));
const value = (h: Holding) => (h.last === null || h.closed ? null : h.last * h.quantity * mult(h));
/** A per-share greek for the whole position: × 100 × contracts. Shares carry delta 1 each. */
const greek = (h: Holding, g: 'delta' | 'gamma' | 'theta' | 'vega') => {
  if (h.kind === 'Cash') return null;
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
  return {
    ...first,
    key: `merged:${parts.map((h) => h.key).join(',')}`,
    quantity,
    // A basket shows on the folded line only where every account agrees.
    basket: parts.every((h) => h.basket === first.basket) ? first.basket : null,
    avg_cost: total === null || quantity === 0 ? null : total / (quantity * mult(first)),
    checks: parts.flatMap((h) => h.checks),
    parts,
    closed: parts.every((h) => h.closed),
  };
}

/** The one-account holdings a line stands for: its parts when folded, else itself. */
const partsOf = (h: Holding) => (h.parts.length > 1 ? h.parts : [h]);
/** Gains closed on this holding (its closed lots, FIFO) across the accounts it folds; `year` keeps one year's. */
const realized = (h: Holding, year?: string) =>
  partsOf(h).reduce(
    (s, p) =>
      s +
      p.account.closed_lots
        .filter((c) => c.symbol === p.symbol && (!year || c.closed.startsWith(year)))
        .reduce((t, c) => t + (c.gain ?? 0), 0),
    0,
  );
/** Dividends this holding paid across the accounts it folds; `ytd` keeps this year's. Shares only. */
const dividends = (h: Holding, ytd?: boolean) =>
  h.kind === 'Option'
    ? null
    : partsOf(h).reduce((s, p) => {
        const d = p.account.dividends?.find((x) => x.symbol === p.symbol);
        return s + (d ? (ytd ? d.ytd : d.total) : 0);
      }, 0);
const qty = (v: number) => num(v, v % 1 ? 4 : 0);
/** A check in a few words: lots against held, or the shares with no cost. */
const checkNote = (c: LotCheck) =>
  c.kind === 'quantity'
    ? `lots ${qty(c.in_lots)} ≠ held ${qty(c.held)}`
    : `${qty(c.no_cost)} shares with no cost`;
/** The red check first: lots that miss what is held. */
const firstCheck = (checks: LotCheck[]) =>
  checks.find((c) => c.kind === 'quantity') ?? checks[0] ?? null;

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
      key: 'realized',
      label: 'Realized',
      icon: CircleDollarSign,
      value: (h) => realized(h),
      format: 'signed',
      amount: true,
      formula: 'gains closed on this holding so far (closed lots)',
      aggregate: 'sum',
    },
    {
      key: 'realized_year',
      label: 'Realized YTD',
      icon: CircleDollarSign,
      value: (h) => realized(h, String(new Date().getFullYear())),
      format: 'signed',
      amount: true,
      formula: 'gains closed on this holding this calendar year (closed lots)',
      aggregate: 'sum',
    },
    {
      key: 'dividends',
      label: 'Dividends',
      icon: Banknote,
      value: (h) => dividends(h),
      format: 'signed',
      amount: true,
      formula: 'dividends paid on this holding so far (dividend transactions)',
      aggregate: 'sum',
    },
    {
      key: 'dividends_year',
      label: 'Dividends YTD',
      icon: Banknote,
      value: (h) => dividends(h, true),
      format: 'signed',
      amount: true,
      formula: 'dividends paid on this holding this calendar year (dividend transactions)',
      aggregate: 'sum',
    },
    {
      key: 'status',
      label: 'Status',
      icon: CircleAlert,
      value: (h) => STATUS[h.closed ? 'closed' : 'open'],
      format: 'text',
      formula: 'Closed: sold out this year, kept for its realized gain and dividends',
      filterable: true,
      groupable: true,
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
      // A folded line names its count; the chip lists the accounts, one per line.
      render: (h) =>
        h.parts.length > 1 ? (
          <CostChip label={accountLabel(h)} tip={h.parts.map((p) => p.account.name).join('\n')} />
        ) : (
          h.account.name
        ),
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
      value: (h) => {
        const c = firstCheck(h.checks);
        return c ? checkNote(c) : null;
      },
      format: 'text',
      amount: true,
      formula: 'open lots vs quantity held, then shares (open or sold) with no cost',
    },
  ],
  widgets: [
    { key: 'value', label: 'Value', icon: Banknote },
    { key: 'day_pnl', label: 'Day P&L', icon: TrendingUp },
    { key: 'unrealized', label: 'Unrealized', icon: TrendingUp },
    { key: 'realized_ytd', label: 'Realized YTD', icon: CircleDollarSign },
    { key: 'check', label: 'Data check', icon: CircleAlert },
  ],
  // Summary, Data check, Tax lots, Transactions (Bikram, 2026-10-12): the accounts sit in Summary.
  details: [
    {
      id: 'summary',
      label: 'Summary',
      icon: Tag,
      open: true,
      render: (h) => <SummaryDetails holding={h} />,
    },
    {
      id: 'check',
      label: 'Data check',
      icon: CircleAlert,
      open: (h) => h.checks.length > 0,
      hint: (h) =>
        h.checks.some((c) => c.kind === 'quantity')
          ? 'mismatch'
          : h.checks.length
            ? 'needs a cost'
            : null,
      render: (h) => <CheckDetails holding={h} />,
    },
    {
      id: 'lots',
      label: 'Tax lots',
      icon: Layers,
      open: true,
      render: (h) => <LotDetails holding={h} />,
    },
    {
      id: 'transactions',
      label: 'Transactions',
      icon: ArrowLeftRight,
      render: (h) => <TransactionDetails holding={h} />,
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
function holdingsDomain(
  saved: (set: TagSet) => void,
  known: () => { rows: Holding[]; set: TagSet | undefined },
  facts: Record<string, SymbolFacts>,
  trading: Map<string, string>,
): ViewDomain<Holding> {
  const at = HOLDINGS_BASE.fields.findIndex((f) => f.key === 'account');
  // Every sector or basket that exists, whatever the filter shows (Bikram, 2026-10-12): in use
  // when an open holding has it, else unused.
  const choices = (value: (h: Holding) => string | null, all: (set?: TagSet) => string[]) => () => {
    const { rows, set } = known();
    const used = new Set(
      rows
        .filter((h) => !h.closed)
        .map(value)
        .filter((v): v is string => !!v),
    );
    const sorted = (vs: Iterable<string>) => [...new Set(vs)].sort();
    return { inUse: sorted(used), unused: sorted(all(set).filter((v) => !used.has(v))) };
  };
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
        options: choices(
          (h) => h.sector,
          (set) => Object.values(set?.sectors ?? {}),
        ),
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
        options: choices(
          (h) => h.basket,
          (set) => (set?.baskets ?? []).map((b) => b.basket),
        ),
        note: (h) =>
          h.parts.length > 1
            ? `Sets ${holdingLabel(h)} in ${h.parts.length} accounts.`
            : `Sets ${holdingLabel(h)} in ${h.account.name} only.`,
      },
    },
  ];
  // Holding, Symbol and Account fields (Bikram, 2026-10-12): an option looks up its underlying.
  return {
    ...HOLDINGS_BASE,
    groups: [rowGroup('Holding'), SYMBOL_GROUP, ACCOUNT_GROUP],
    fields: [
      ...inAccountGroup([
        ...HOLDINGS_BASE.fields.slice(0, at),
        ...tags,
        ...HOLDINGS_BASE.fields.slice(at),
      ]),
      ...accountFields((h: Holding) => partsOf(h).map((p) => p.account), trading),
      ...symbolFields((h: Holding) => (h.kind === 'Cash' ? null : h.underlying), facts),
    ],
  };
}

/** One transaction with its account. */
interface Activity extends Transaction {
  account: Portfolio;
}

const ACTION: Record<string, string> = {
  buy: 'Buy',
  sell: 'Sell',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
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

const TRANSACTIONS_BASE: ViewDomain<Activity> = {
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

/** Transactions with their Account and Symbol fields (Bikram, 2026-10-12). */
const transactionsDomain = (
  facts: Record<string, SymbolFacts>,
  trading: Map<string, string>,
): ViewDomain<Activity> => ({
  ...TRANSACTIONS_BASE,
  groups: [rowGroup('Transaction'), SYMBOL_GROUP, ACCOUNT_GROUP],
  fields: [
    ...inAccountGroup(TRANSACTIONS_BASE.fields),
    {
      key: 'tax_type',
      label: 'Tax type',
      icon: Landmark,
      group: ACCOUNT_GROUP.id,
      value: (t) => taxLabel(t.account),
      format: 'text',
      filterable: true,
      groupable: true,
    },
    ...accountFields((t: Activity) => [t.account], trading),
    ...symbolFields((t: Activity) => t.underlying ?? t.symbol, facts),
  ],
});

/** Open or closed, on a holding or a lot (Bikram, 2026-10-11): one word in every view. */
type Status = 'open' | 'closed';
const STATUS = { open: 'Open', closed: 'Closed' } as const;
const STATUS_TIP = {
  open: 'Still held.',
  closed: 'Closed by a later trade; its gain is realized.',
} as const;
/** All, Open or Closed lots: the button group in a holding's drawer (Bikram, 2026-10-11). */
type Show = 'all' | Status;

function ShowToggle({ value, onChange }: { value: Show; onChange: (v: Show) => void }) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      value={value}
      onValueChange={(v) => v && onChange(v as Show)}
      aria-label="Show"
    >
      <ToggleGroupItem value="all">All</ToggleGroupItem>
      <ToggleGroupItem value="open">Open</ToggleGroupItem>
      <ToggleGroupItem value="closed">Closed</ToggleGroupItem>
    </ToggleGroup>
  );
}

/**
 * One tax lot, open or closed (Bikram, 2026-10-11: one Tax lots view). Amounts are per share
 * (cost, sell price) and in total (cost basis, proceeds, gain), fees included.
 */
interface LotRow {
  key: string;
  account: Portfolio;
  status: Status;
  symbol: string;
  label: string;
  underlying: string;
  acquired: string;
  /** Trade date of the closing trade; null while open. */
  closed: string | null;
  /** Shares or contracts, negative for a short lot. */
  quantity: number;
  /** null for shares transferred in, whose cost the broker never sent. */
  cost: number | null;
  /** What a closed lot sold for, per share (a short lot: what it opened at). */
  sell: number | null;
  basis: number | null;
  proceeds: number | null;
  gain: number | null;
  term: TaxLot['term'];
  source: LotSource;
  /** The open lot itself, for its cost chip. */
  lot: TaxLot | null;
  /** Shares held before the history starts: no buy on record. */
  before: boolean;
}

const OCC = /\d{6}[CP]\d{8}$/;
const lotMult = (symbol: string, right?: unknown) => (right || OCC.test(symbol) ? 100 : 1);

/** Every lot of every account, open then closed. Closed lots always come from the trades (FIFO). */
function lotRows(accounts: Portfolio[]): LotRow[] {
  return accounts.flatMap((a) => [
    ...a.lots.map((l, i): LotRow => {
      const mult = lotMult(l.symbol);
      return {
        key: `${a.id}:open:${i}`,
        account: a,
        status: 'open',
        symbol: l.symbol,
        label: l.symbol,
        underlying: l.symbol.replace(OCC, '').trim(),
        acquired: l.acquired,
        closed: null,
        quantity: l.quantity,
        cost: l.cost,
        sell: null,
        basis: l.cost * l.quantity * mult,
        proceeds: null,
        gain: null,
        term: l.term,
        source: l.source,
        lot: l,
        before: l.before_history === true,
      };
    }),
    ...(a.closed_lots ?? []).map((c, i): LotRow => {
      const size = Math.abs(c.quantity) * lotMult(c.symbol, c.right);
      return {
        key: `${a.id}:closed:${i}`,
        account: a,
        status: 'closed',
        symbol: c.symbol,
        label: closedLabel(c),
        underlying: c.underlying,
        acquired: c.acquired,
        closed: c.closed,
        quantity: c.quantity,
        cost: c.cost === null ? null : size ? c.cost / size : 0,
        sell: size ? c.proceeds / size : null,
        basis: c.cost,
        proceeds: c.proceeds,
        gain: c.gain,
        term: c.term,
        source: 'derived',
        lot: null,
        before: c.before_history === true,
      };
    }),
  ]);
}

/** A lot's source as its chip says it (Bikram, 2026-10-11). */
const SOURCE = { snaptrade: 'SnapTrade', derived: 'Derived', manual: 'Manual' } as const;
const sourceTip = (l: { source: LotSource; status?: Status }) =>
  l.status === 'closed'
    ? "Worked out first in first out from this account's buys, sells and transfers: brokers send no closed lots, so every closed lot is derived. Shares transferred in come with no cost, so their gain is unknown and left out of Realized."
    : l.source === 'snaptrade'
      ? "The broker's own lot, synced from SnapTrade (its Tax lots add-on)."
      : l.source === 'manual'
        ? 'Entered for this manual account (in the app, or by an agent with portfolio_lot_write).'
        : "Worked out first in first out from this account's buys, sells and transfers, because neither the broker nor you set lots for this holding. Shares transferred in come with no cost.";

/** The source chip with its tooltip. */
function SourceChip({ lot }: { lot: { source: LotSource; status?: Status } }) {
  return <CostChip label={SOURCE[lot.source]} tip={sourceTip(lot)} />;
}

const closedLabel = (l: ClosedLot) =>
  l.right && l.expiration
    ? `${l.underlying} ${expLabel(l.expiration)} ${l.strike ?? ''} ${l.right}`.replace(/\s+/g, ' ')
    : l.symbol;
const TERM = { short: 'Short', long: 'Long' } as const;

/** Tax lots (Bikram, 2026-10-11): every lot of every account, open and closed, each with its source. */
const TAX_LOTS_BASE: ViewDomain<LotRow> = {
  id: 'tax_lots',
  formulas: true,
  rowKey: (l) => l.key,
  text: (l) => [l.symbol, l.underlying, l.account.name],
  fields: [
    {
      key: 'symbol',
      label: 'Symbol',
      icon: Tag,
      value: (l) => l.label,
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
      key: 'status',
      label: 'Status',
      icon: CircleAlert,
      value: (l) => STATUS[l.status],
      format: 'text',
      formula: 'Open, or Closed by a later trade',
      filterable: true,
      groupable: true,
    },
    {
      key: 'acquired',
      label: 'Acquired',
      icon: CalendarDays,
      value: (l) => l.acquired,
      format: 'text',
      formula: 'trade date the lot was bought (or sold short)',
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
      label: 'Year closed',
      icon: CalendarDays,
      value: (l) => l.closed?.slice(0, 4) ?? null,
      format: 'text',
      formula: 'year the lot closed',
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
      formula: 'shares or contracts, negative for a short lot',
      aggregate: 'sum',
    },
    {
      key: 'cost',
      label: 'Cost',
      icon: Banknote,
      value: (l) => l.cost,
      format: 'price',
      formula: 'per share, fees included (a short lot: what it was bought back at)',
      render: (l) => (l.lot ? <LotCost lot={l.lot} /> : l.cost === null ? DASH : num(l.cost)),
    },
    {
      key: 'sell_price',
      label: 'Sell price',
      icon: Banknote,
      value: (l) => l.sell,
      format: 'price',
      formula: 'per share, fees included (a short lot: what it was sold at to open)',
      render: (l) => (l.sell === null ? DASH : num(l.sell)),
    },
    {
      key: 'cost_basis',
      label: 'Cost basis',
      icon: Banknote,
      value: (l) => l.basis,
      format: 'price',
      amount: true,
      formula: 'cost × qty (× 100 for options)',
      aggregate: 'sum',
    },
    {
      key: 'proceeds',
      label: 'Proceeds',
      icon: Banknote,
      value: (l) => l.proceeds,
      format: 'price',
      amount: true,
      formula: 'sell price × qty (× 100 for options)',
      aggregate: 'sum',
    },
    {
      key: 'gain',
      label: 'Gain',
      icon: TrendingUp,
      value: (l) => l.gain,
      format: 'signed',
      amount: true,
      formula: 'proceeds − cost basis, closed lots',
      aggregate: 'sum',
    },
    {
      key: 'gain_pct',
      label: 'Gain %',
      icon: Percent,
      value: () => null,
      format: 'signed',
      formula: 'gain ÷ cost basis × 100; a group row works it out over the group',
      compute: (_l, { value: v }) => {
        const g = v('gain');
        const c = v('cost_basis');
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
      value: (l) => (l.account.tax_type === 'retirement' ? 'n/a' : TERM[l.term]),
      format: 'text',
      formula: 'Long when held more than a year; n/a in a retirement account',
      filterable: true,
      groupable: true,
    },
    {
      key: 'source',
      label: 'Source',
      icon: Layers,
      value: (l) => SOURCE[l.source],
      format: 'text',
      formula: "SnapTrade (the broker's lot), Derived (first in first out from trades) or Manual",
      filterable: true,
      groupable: true,
      render: (l) => <SourceChip lot={l} />,
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

/** Tax lots with their Account and Symbol fields (Bikram, 2026-10-12). */
const taxLotsDomain = (
  facts: Record<string, SymbolFacts>,
  trading: Map<string, string>,
): ViewDomain<LotRow> => ({
  ...TAX_LOTS_BASE,
  groups: [rowGroup('Lot'), SYMBOL_GROUP, ACCOUNT_GROUP],
  fields: [
    ...inAccountGroup(TAX_LOTS_BASE.fields),
    ...accountFields((l: LotRow) => [l.account], trading),
    ...symbolFields((l: LotRow) => l.underlying, facts),
  ],
});

/** The Tax lots widgets over the shown closed lots: this year's gain and every gain shown. */
function lotsWidget(key: string, shown: LotRow[], hidden: boolean): ReactNode {
  const m = (text: string) => (hidden ? maskAmount(text) : text);
  const year = String(new Date().getFullYear());
  const closed = shown.filter((l) => l.closed !== null);
  const pick = key === 'realized_ytd' ? closed.filter((l) => l.closed?.startsWith(year)) : closed;
  if (key !== 'realized_ytd' && key !== 'realized_all') return null;
  const total = pick.reduce((s, l) => s + (l.gain ?? 0), 0);
  const short = pick.reduce((s, l) => s + (l.term === 'short' ? (l.gain ?? 0) : 0), 0);
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
/** The line an account's cash balance shows as; not upper case, so it never meets a ticker. */
const CASH = 'Cash';
const priceSymbol = (p: { right?: unknown; symbol: string; underlying: string }) =>
  p.right ? p.symbol : p.underlying;

/** An option past its expiration: no feed quotes it, so it stays unpriced. */
const expired = (p: Position) => p.expiration !== null && p.expiration < todayPT();

/**
 * Every account the signed-in person has, its positions as holdings, and live share and option
 * prices for the rows the view shows only (Bikram, 2026-10-09): `setShown` takes those rows, and
 * prices load only when `live`. Shares by ticker, options by OCC symbol, in one batch request.
 * Closed rows are priced too, so a sold-out symbol keeps its price (Bikram, 2026-10-12).
 */
function useHoldings(live: boolean) {
  const list = useQuery(holdingsAccountsQuery());
  const accounts = list.data ?? [];
  // Sorted symbols of the shown rows, joined: an unchanged list keeps the same query.
  const [shown, setShownKey] = useState('');
  const setShown = useCallback(
    (rows: Holding[]) =>
      setShownKey(
        [
          ...new Set(
            rows.flatMap((h) =>
              partsOf(h)
                .filter((p) => p.kind !== 'Cash' && !expired(p))
                .map(priceSymbol),
            ),
          ),
        ]
          .sort()
          .join(','),
      ),
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
  // Every fetch counts, not only a changed updated_at: a cost you set changes lots, not the account.
  const accountsKey = `${list.dataUpdatedAt}:${accounts.map((a) => a.updated_at).join(',')}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on loaded accounts and prices
  const rows = useMemo<Holding[]>(
    () =>
      accounts.flatMap((a) => {
        const row = (p: Position, closed: boolean): Holding => {
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
            checks: a.checks.filter((c) => c.symbol === p.symbol),
            parts: [],
            closed,
          };
        };
        // The account's cash as its own line, so an all-cash account still shows what it holds.
        const cash: Holding[] = a.cash
          ? [
              {
                symbol: CASH,
                underlying: CASH,
                expiration: null,
                strike: null,
                right: null,
                quantity: a.cash,
                avg_cost: 1,
                key: `${a.id}:${CASH}`,
                account: a,
                kind: 'Cash',
                last: 1,
                change: 0,
                option: null,
                ...tagsOf(tags.data, { symbol: CASH, underlying: CASH }, a.id),
                checks: [],
                parts: [],
                closed: false,
              },
            ]
          : [];
        return [
          ...a.positions.map((p) => row(p, false)),
          ...cash,
          ...soldOut(a).map((p) => row(p, true)),
        ];
      }),
    [accountsKey, liveKey, tagsKey],
  );
  const loading = list.isPending;
  const error = list.error;
  return { list, accounts, rows, loading, error, quotes, setShown };
}

/**
 * What an account sold out of this year (Bikram, 2026-10-11): a closed lot this year and nothing held
 * now. Each is a zero-quantity position.
 */
function soldOut(a: Portfolio): Position[] {
  const year = String(new Date().getFullYear());
  const held = new Set(a.positions.map((p) => p.symbol));
  const out = new Map<string, Position>();
  for (const c of a.closed_lots)
    if (c.closed.startsWith(year) && !held.has(c.symbol))
      out.set(c.symbol, { ...c, quantity: 0, avg_cost: null });
  return [...out.values()].map(
    ({ symbol, underlying, expiration, strike, right, quantity, avg_cost }) => ({
      symbol,
      underlying,
      expiration,
      strike,
      right,
      quantity,
      avg_cost,
    }),
  );
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

/** No accounts yet: link a broker in Settings ▸ Brokers and accounts (Bikram, 2026-10-11). */
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
        <Button size="sm" onClick={() => openSettings('accounts')}>
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
  const sum = (f: (h: Holding) => number | null) => rows.reduce((s, h) => s + (f(h) ?? 0), 0);
  const cash = sum((h) => (h.kind === 'Cash' ? h.quantity : null));
  const shares = sum((h) => (h.kind === 'Cash' ? null : value(h)));
  const day = sum((h) => (h.change === null ? null : h.change * h.quantity));
  const before = shares - day;
  const unpriced = rows.some((h) => h.last === null && !h.closed);
  const realized = accounts.reduce((s, a) => s + a.realized_ytd.total, 0);
  const shortTerm = accounts.reduce((s, a) => s + a.realized_ytd.short_term, 0);
  const checks = accounts.flatMap((a) => a.checks.map((c) => ({ ...c, account: a.name })));
  const mismatches = checks.filter((c) => c.kind === 'quantity');
  const noCost = checks.filter((c) => c.kind === 'cost');
  const sold = accounts.reduce((s, a) => s + (a.realized_ytd.sold ?? 0), 0);
  const unknown = accounts.reduce((s, a) => s + (a.realized_ytd.no_cost ?? 0), 0);
  // Realized is partial while some of this year's sales have no cost (Bikram, 2026-10-12).
  const covered = sold > 0 && unknown > 0 ? Math.floor(((sold - unknown) / sold) * 100) : null;
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
        to="/portfolio/tax-lots"
        search={{ show: 'closed' }}
        aria-label="Realized YTD: open the closed tax lots"
        className="min-w-0"
      >
        <Tile
          label="Realized YTD"
          value={m(usd(realized))}
          valueClassName={toneClass(realized)}
          caption={
            covered === null
              ? `short-term ${m(usd(shortTerm))} · see lots`
              : `partial: ${covered}% of sales have a cost`
          }
          className="h-full hover:bg-muted/50"
        />
      </Link>
    ),
    check: (
      <Tile
        label="Data check"
        value={
          mismatches.length ? (
            <span className="flex items-center gap-1.5 text-base text-loss">
              <CircleAlert className="size-4" />
              {mismatches.length} mismatch{mismatches.length > 1 ? 'es' : ''}
            </span>
          ) : (
            <span className="text-base text-gain">All lots match</span>
          )
        }
        caption={
          <span className="flex flex-col">
            <span>
              {mismatches[0]
                ? `${mismatches[0].symbol}: ${m(checkNote(mismatches[0]))}`
                : 'lots against held quantity'}
            </span>
            {noCost.length > 0 && (
              <span className="text-warning">
                {noCost.length} holding{noCost.length > 1 ? 's have' : ' has'} shares with no cost
              </span>
            )}
          </span>
        }
      />
    ),
  };
}

/**
 * One symbol you hold or watch, or in DataEdge's list (Bikram, 2026-10-12): the Symbols rows. `in`
 * says where it is from (several at once); saved views over them are stock screens.
 */
interface SymbolRow {
  symbol: string;
  in: string[];
  /** Live price; loaded for the rows the view shows. */
  price: number | null;
  /** Shares held across your accounts; null when you hold none. */
  quantity: number | null;
  accounts: string[];
}
const IN = { holdings: 'Holdings', watchlist: 'Watchlist', dataedge: 'DataEdge' } as const;
/** The `in` filter's picks: which lists the Symbols rows come from. */
const inValues = (tokens: { key: string; value: string }[]) =>
  tokens.filter((t) => t.key === 'in').map((t) => t.value);

function symbolsDomain(facts: Record<string, SymbolFacts>): ViewDomain<SymbolRow> {
  return {
    id: 'symbols',
    formulas: true,
    groups: [rowGroup('Holding'), SYMBOL_GROUP],
    rowKey: (r) => r.symbol,
    text: (r) => [r.symbol],
    fields: [
      {
        key: 'symbol',
        label: 'Symbol',
        icon: Tag,
        value: (r) => r.symbol,
        format: 'text',
        formula: 'the ticker',
        filterable: true,
      },
      {
        key: 'in',
        label: 'In',
        icon: Layers,
        value: (r) => r.in.join(', '),
        values: (r) => r.in,
        format: 'text',
        formula: 'Holdings, Watchlist or DataEdge (its symbol list); pick with the In filter',
        filterable: true,
        groupable: true,
      },
      {
        key: 'price',
        label: 'Price',
        icon: CircleDollarSign,
        value: (r) => r.price,
        format: 'price',
        formula: 'last trade (live)',
      },
      {
        key: 'quantity',
        label: 'Shares',
        icon: Hash,
        value: (r) => r.quantity,
        format: 'number',
        amount: true,
        formula: 'shares held across your accounts',
        aggregate: 'sum',
      },
      {
        key: 'market_value',
        label: 'Value',
        icon: Banknote,
        value: (r) => (r.price === null || r.quantity === null ? null : r.price * r.quantity),
        format: 'price',
        amount: true,
        formula: 'price × shares',
        aggregate: 'sum',
      },
      {
        key: 'accounts',
        label: 'Accounts',
        icon: Briefcase,
        value: (r) => (r.accounts.length ? r.accounts.join(', ') : null),
        values: (r) => r.accounts,
        format: 'text',
        formula: 'the accounts that hold it',
      },
      ...symbolFields((r: SymbolRow) => r.symbol, facts),
    ],
  };
}

/** Holdings, Watchlist and (when picked) DataEdge's symbols as one row each. */
function symbolRows(
  holdings: Holding[],
  watch: string[],
  dataedge: string[],
  prices: Record<string, { last?: number | null } | null>,
): SymbolRow[] {
  const m = new Map<string, SymbolRow>();
  const row = (symbol: string) => {
    let r = m.get(symbol);
    if (!r) {
      r = { symbol, in: [], price: null, quantity: null, accounts: [] };
      m.set(symbol, r);
    }
    return r;
  };
  const add = (r: SymbolRow, where: string) => {
    if (!r.in.includes(where)) r.in.push(where);
  };
  for (const h of holdings) {
    if (h.kind === 'Cash' || h.closed) continue;
    const r = row(h.underlying);
    add(r, IN.holdings);
    if (!r.accounts.includes(h.account.name)) r.accounts.push(h.account.name);
    if (h.kind === 'Shares') r.quantity = (r.quantity ?? 0) + h.quantity;
  }
  for (const w of watch) add(row(w), IN.watchlist);
  for (const d of dataedge) add(row(d), IN.dataedge);
  for (const r of m.values()) {
    const q = prices[r.symbol];
    r.price = q && typeof q.last === 'number' ? q.last : null;
  }
  return [...m.values()];
}

/** One account (Bikram, 2026-10-12): the Accounts rows, rolled up from its holdings. */
interface AccountRow {
  account: Portfolio;
  holdings: number;
  basis: number | null;
  value: number | null;
  unrealized: number | null;
}

function accountRows(accounts: Portfolio[], holdings: Holding[]): AccountRow[] {
  return accounts.map((a) => {
    const own = holdings.filter((h) => h.account.id === a.id && h.kind !== 'Cash' && !h.closed);
    const sum = (f: (h: Holding) => number | null) =>
      own.reduce<number | null>((s, h) => {
        const v = f(h);
        return s === null || v === null ? null : s + v;
      }, 0);
    return {
      account: a,
      holdings: own.length,
      basis: sum(basis),
      value: own.some((h) => h.last === null) ? null : (sum(value) ?? 0) + a.cash,
      unrealized: sum(unrealized),
    };
  });
}

const SOURCE_LABEL = { snaptrade: 'SnapTrade', manual: 'Manual' } as const;

function accountsDomain(trading: Map<string, string>): ViewDomain<AccountRow> {
  return {
    id: 'accounts',
    formulas: true,
    groups: [ACCOUNT_GROUP],
    rowKey: (r) => r.account.id,
    text: (r) => [r.account.name, r.account.broker ?? ''],
    fields: [
      {
        key: 'account',
        label: 'Account',
        icon: Briefcase,
        value: (r) => r.account.name,
        format: 'text',
        formula: 'account name',
        filterable: true,
      },
      ...accountFields((r: AccountRow) => [r.account], trading).filter((f) => f.key !== 'cash'),
      {
        key: 'tax_type',
        label: 'Tax type',
        icon: Landmark,
        value: (r) => taxLabel(r.account),
        format: 'text',
        formula: 'account.tax_type',
        filterable: true,
        groupable: true,
      },
      {
        key: 'source',
        label: 'Source',
        icon: Plug,
        value: (r) => SOURCE_LABEL[r.account.source],
        format: 'text',
        formula: 'SnapTrade (synced from the broker) or Manual',
        filterable: true,
        groupable: true,
      },
      {
        key: 'holdings',
        label: 'Holdings',
        icon: Hash,
        value: (r) => r.holdings,
        format: 'integer',
        formula: 'open positions, cash aside',
        aggregate: 'sum',
      },
      {
        key: 'cash',
        label: 'Cash',
        icon: Banknote,
        value: (r) => r.account.cash,
        format: 'price',
        amount: true,
        formula: "the account's cash balance",
        aggregate: 'sum',
      },
      {
        key: 'cost_basis',
        label: 'Cost basis',
        icon: Banknote,
        value: (r) => r.basis,
        format: 'price',
        amount: true,
        formula: 'sum of its holdings’ cost basis',
        aggregate: 'sum',
      },
      {
        key: 'market_value',
        label: 'Value',
        icon: Banknote,
        value: (r) => r.value,
        format: 'price',
        amount: true,
        formula: 'its holdings’ value (live) + cash',
        aggregate: 'sum',
      },
      {
        key: 'unrealized',
        label: 'Unrealized',
        icon: TrendingUp,
        value: (r) => r.unrealized,
        format: 'signed',
        amount: true,
        formula: 'value − cost basis, cash aside',
        aggregate: 'sum',
      },
      {
        key: 'realized_ytd',
        label: 'Realized YTD',
        icon: CircleDollarSign,
        value: (r) => r.account.realized_ytd.total,
        format: 'signed',
        amount: true,
        formula: 'gains closed this calendar year (closed lots)',
        aggregate: 'sum',
      },
      {
        key: 'as_of',
        label: 'As of',
        icon: CalendarDays,
        value: (r) => r.account.as_of.slice(0, 10),
        format: 'text',
        formula: 'when its positions were last synced or written',
      },
    ],
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
function PortfolioViewBody({ view, show }: { view: PortfolioView; show?: Status }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // In a main view Open and Closed are a Status filter token; `show` opens it on one of them.
  const config: CustomViewConfig = show
    ? {
        name: view.name,
        ...view.config,
        filters: { ...view.config.filters, default: [{ key: 'status', value: STATUS[show] }] },
      }
    : { name: view.name, ...view.config };
  const { list, accounts, rows, loading, error, quotes, setShown } = useHoldings(
    (view.domain === 'holdings' || view.domain === 'accounts') && showsLive(config),
  );
  // Every holding and tag, unfiltered, for the Sector and Basket pickers.
  const tags = qc.getQueryData(tagsQuery().queryKey);
  const known = useRef({ rows, set: tags });
  known.current = { rows, set: tags };
  const activity = useActivity(accounts, view.domain === 'transactions');
  const lots = useMemo<LotRow[]>(
    () => (view.domain === 'tax_lots' ? lotRows(accounts) : []),
    [accounts, view.domain],
  );
  // Symbols (Bikram, 2026-10-12): your holdings and watchlist, and DataEdge's list once `in` picks it.
  const symbolsView = view.domain === 'symbols';
  const [inScope, setInScope] = useState(() => inValues(config.filters.default));
  const onTokens = useCallback((tokens: { key: string; value: string }[]) => {
    const next = inValues(tokens);
    setInScope((was) => (was.join() === next.join() ? was : next));
  }, []);
  const watch = useQuery({ ...watchlistQuery(), enabled: symbolsView });
  const dataedge = useQuery(dataedgeSymbolsQuery(symbolsView && inScope.includes(IN.dataedge)));
  // Symbol prices for the rows the view shows (a page at most), when it shows a price.
  const [shownSymbols, setShownSymbols] = useState('');
  const onShownSymbols = useCallback(
    (shown: SymbolRow[]) =>
      setShownSymbols(
        shown
          .slice(0, 100)
          .map((r) => r.symbol)
          .sort()
          .join(','),
      ),
    [],
  );
  const symbolPrices = useQuery(
    quotesQuery(symbolsView && shownSymbols && showsLive(config) ? shownSymbols.split(',') : []),
  );
  const symbolList = useMemo(
    () =>
      symbolsView
        ? symbolRows(
            rows,
            (watch.data ?? []).map((w) => w.symbol),
            dataedge.data ?? [],
            (symbolPrices.data?.quotes ?? {}) as Record<string, { last?: number | null } | null>,
          )
        : [],
    [symbolsView, rows, watch.data, dataedge.data, symbolPrices.data],
  );
  // Symbol and account lookups load only for views that use them (Bikram, 2026-10-12).
  const trading = useTrading(usesTrading(config));
  const factSymbols = useMemo(() => {
    if (view.domain === 'holdings')
      return rows.filter((h) => h.kind !== 'Cash').map((h) => h.underlying);
    if (view.domain === 'transactions')
      return activity.rows.flatMap((t) =>
        (t.underlying ?? t.symbol) ? [t.underlying ?? t.symbol ?? ''] : [],
      );
    if (view.domain === 'tax_lots') return lots.map((l) => l.underlying);
    if (symbolsView)
      return symbolList
        .filter((r) => !inScope.length || r.in.some((w) => inScope.includes(w)))
        .map((r) => r.symbol);
    return [];
  }, [view.domain, rows, activity.rows, lots, symbolsView, symbolList, inScope]);
  const symbolFacts = useSymbolFacts(factSymbols, usesSymbolFields(config));
  const facts = symbolFacts.facts;
  const holdings = useMemo(
    () =>
      holdingsDomain(
        (set) => qc.setQueryData(tagsQuery().queryKey, set),
        () => known.current,
        facts,
        trading,
      ),
    [qc, facts, trading],
  );
  const symbolsDom = useMemo(() => symbolsDomain(facts), [facts]);
  const accountsDom = useMemo(() => accountsDomain(trading), [trading]);
  const lotsDom = useMemo(() => taxLotsDomain(facts, trading), [facts, trading]);
  const activityDom = useMemo(() => transactionsDomain(facts, trading), [facts, trading]);
  const accountList = useMemo(
    () => (view.domain === 'accounts' ? accountRows(accounts, rows) : []),
    [view.domain, accounts, rows],
  );
  // Accounts price every holding they roll up.
  useEffect(() => {
    if (view.domain === 'accounts') setShown(rows);
  }, [view.domain, rows, setShown]);
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
      void navigate({ to: symbolsView ? '/symbols' : '/portfolio' });
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
    crumbs: [{ label: symbolsView ? 'Symbols' : 'Portfolio' }, { label: view.name }],
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
        {!symbolsView && <PortfolioStatus accounts={accounts} />}
        <StatusItem label="Made by" value={view.app ? 'App' : 'You'} />
        {usesSymbolFields(config) && <SymbolStatus read={symbolFacts} />}
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
  if (symbolsView) {
    return (
      <CustomViewPage
        {...common}
        domain={symbolsDom}
        rows={symbolList}
        onTokens={onTokens}
        onShownRows={onShownSymbols}
        rowTitle={(r) => r.symbol}
        state={loadState({
          error: list.data ? null : (error ?? watch.error),
          loading: loading || watch.isPending,
          empty: false,
        })}
      />
    );
  }
  if (view.domain === 'accounts') {
    return (
      <CustomViewPage
        {...common}
        domain={accountsDom}
        rows={accountList}
        rowTitle={(r) => r.account.name}
        state={state}
      />
    );
  }
  if (view.domain === 'tax_lots') {
    return (
      <CustomViewPage
        {...common}
        domain={lotsDom}
        rows={lots}
        widget={(k, shown) => lotsWidget(k, shown, hidden)}
        rowTitle={(l) => `${l.label} · ${l.account.name}`}
        state={state}
      />
    );
  }
  if (view.domain === 'transactions') {
    return (
      <CustomViewPage
        {...common}
        domain={activityDom}
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
function PortfolioViewById({
  domain,
  id,
  show,
}: { domain: PortfolioDomain; id: string; show?: Status }) {
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
  return <PortfolioViewBody view={view} show={show} />;
}

/** `/portfolio`: the All accounts app view. */
export function AllAccountsPage() {
  return <PortfolioViewById domain="holdings" id={ALL_ACCOUNTS} />;
}

/** `/portfolio/transactions`: the Transactions app view. */
export function TransactionsPage() {
  return <PortfolioViewById domain="transactions" id={TRANSACTIONS_ID} />;
}

/** `/portfolio/tax-lots`: the Tax lots app view; `?show=closed` opens it on the closed lots. */
export function TaxLotsPage() {
  const { show } = useSearch({ from: '/portfolio/tax-lots' });
  return <PortfolioViewById domain="tax_lots" id={TAX_LOTS_ID} show={show} />;
}

/** `/portfolio/accounts`: the Accounts app view (Bikram, 2026-10-12). */
export function AccountsPage() {
  return <PortfolioViewById domain="accounts" id="accounts" />;
}

/** `/symbols`: the My symbols app view, a stock screen over your symbols (Bikram, 2026-10-12). */
export function SymbolsPage() {
  return <PortfolioViewById domain="symbols" id="my-symbols" />;
}

/** `/symbols/views/$id`: a person's own stock screen. */
export function SymbolViewPage() {
  const { id } = useParams({ from: '/symbols/views/$id' });
  return <PortfolioViewById domain="symbols" id={id} />;
}

/** `/portfolio/views/$domain/$id`: a person's own view. */
export function PortfolioViewPage() {
  const { domain, id } = useParams({ from: '/portfolio/views/$domain/$id' });
  if (
    domain !== 'holdings' &&
    domain !== 'transactions' &&
    domain !== 'tax_lots' &&
    domain !== 'accounts'
  ) {
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
const TAX_LOTS_ID = 'tax-lots';

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
  const off = partsOf(h).flatMap((p) => p.checks.map((c) => ({ p, c })));
  const fine = partsOf(h).some((p) => !p.checks.some((c) => c.kind === 'quantity'));
  return (
    <div className="flex flex-col gap-2 text-sm">
      {fine && (
        <p className="text-gain">
          {h.closed
            ? `Lots match: ${h.symbol} is sold out and has no open lots.`
            : `Lots match: the open lots of ${h.symbol} add up to the quantity held.`}
        </p>
      )}
      {off.map(({ p, c }) => (
        <div key={`${p.key}:${c.kind}`} className="flex flex-col gap-1">
          <p className={c.kind === 'quantity' ? 'text-loss' : 'text-warning'}>
            {checkSentence(c, p.account.name, m)}
          </p>
          <p className="text-xs text-muted-foreground">{checkFix(c, p.account)}</p>
        </div>
      ))}
    </div>
  );
}

/** What a check means, in the words of where the holding's lots come from (`lots.ts` on the server). */
function checkSentence(c: LotCheck, account: string, m: (s: string) => string) {
  const q = (v: number) => m(qty(v));
  if (c.kind === 'cost')
    return `${q(c.no_cost)} shares of ${c.symbol} in ${account} have no buy on record (transferred in, an RSU vest, or bought before the history starts), so their gain is left out of Realized.`;
  if (c.source === 'manual')
    return `Your lots add up to ${q(c.in_lots)}; ${account} holds ${q(c.held)}.`;
  if (c.source === 'derived')
    return `The trades leave ${q(c.in_lots)} open; ${account} holds ${q(c.held)}.`;
  return `The broker's lots add up to ${q(c.in_lots)}; ${account} holds ${q(c.held)}.`;
}

/** Who can fix a check, and how. */
const checkFix = (c: LotCheck, account: Portfolio) =>
  c.kind === 'cost'
    ? 'Set the cost on the lot under Tax lots (from your old broker or statement), or an agent sets it with portfolio_lot_cost_write.'
    : account.source === 'snaptrade'
      ? "The broker's own lots differ from its position: usually its rounding. Sync again; if it stays, the broker's data is off."
      : 'Fix the lots in the app, or an agent sends them with portfolio_lot_write.';

/** The holding at a glance: position, gains and dividends, then the accounts it sits in. */
function SummaryDetails({ holding: h }: { holding: Holding }) {
  const m = useMask();
  const year = String(new Date().getFullYear());
  // Shares with no buy on record carry no cost, so their gain is left out of Realized.
  const unknown = partsOf(h)
    .flatMap((p) => p.account.closed_lots.filter((c) => c.symbol === p.symbol && c.gain === null))
    .reduce((s, c) => s + Math.abs(c.quantity), 0);
  const gains = (v: number | null) => (
    <span key="r" className="inline-flex items-center gap-1.5">
      {unknown > 0 && (
        <CostChip
          label="partial"
          tip={`${num(unknown, unknown % 1 ? 4 : 0)} shares sold have no buy on record (transferred in, an RSU vest, or bought before the history starts), so their gain is left out until you set their cost under Tax lots.`}
        />
      )}
      <ViewValueCell amount value={v} format="signed" />
    </span>
  );
  return (
    <div className="flex flex-col gap-3">
      <Facts
        items={[
          ['Symbol', h.symbol],
          ['Kind', h.kind],
          ['Expiry', h.expiration ? expLabel(h.expiration) : DASH],
          ['Strike', h.strike === null ? DASH : num(h.strike)],
          ['Quantity', m(num(h.quantity, h.quantity % 1 ? 4 : 0))],
          [
            'Avg cost',
            h.avg_cost === null ? (
              DASH
            ) : lotsOf(h).some((l) => l.cost_from === 'estimate') ? (
              <span key="a" className="inline-flex items-center gap-1.5">
                <CostChip
                  label="est."
                  tip={`The broker sent no average cost, so this is the average of the open lots, and some lot costs are estimates (the close on the acquired day; see Tax lots). ${FIX_COST}`}
                />
                {num(h.avg_cost)}
              </span>
            ) : (
              num(h.avg_cost)
            ),
          ],
          ['Price', h.last === null ? DASH : num(h.last)],
          ['Cost basis', <ViewValueCell key="b" amount value={basis(h)} format="price" />],
          ['Value', <ViewValueCell key="v" amount value={value(h)} format="price" />],
          ['Unrealized', <ViewValueCell key="u" amount value={unrealized(h)} format="signed" />],
          ['Realized', gains(realized(h))],
          ['Realized YTD', gains(realized(h, year))],
          ['Dividends', <ViewValueCell key="d" amount value={dividends(h)} format="signed" />],
          [
            'Dividends YTD',
            <ViewValueCell key="dy" amount value={dividends(h, true)} format="signed" />,
          ],
        ]}
      />
      <AccountDetails holding={h} />
    </div>
  );
}

/**
 * A small details table; the Account column shows only when the line spans accounts. Every column
 * but the last fits its content and the last takes the rest, so the drawer's tables line up the
 * same way whatever their values (Bikram, 2026-10-11).
 */
function DetailsTable({
  head,
  rows,
}: {
  /** `grow` marks the column that takes the spare width; the last column does by default. */
  head: { label: string; right?: boolean; grow?: boolean }[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  const marked = head.findIndex((h) => h.grow);
  const grow = marked >= 0 ? marked : head.length - 1;
  return (
    <div className="-mx-1 overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {head.map((h, i) => (
              <TableHead
                key={h.label}
                className={cn(h.right && 'text-right', i !== grow && 'w-px')}
              >
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
                  className={cn('num', head[i]?.right && 'text-right', i !== grow && 'w-px')}
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

/** The holding's open lots, in every account it spans. */
const lotsOf = (h: Holding) =>
  partsOf(h).flatMap((p) => p.account.lots.filter((l) => l.symbol === h.symbol));

const FIX_COST =
  'To fix it, ask an agent to set the exact cost with portfolio_lot_cost_write, e.g. the vest-day value on your stock plan statement or W-2.';

/**
 * A chip with the reason behind a number (Bikram, 2026-10-11: chip left of the cost, tooltip with
 * the derivation and the fix). A tap opens it too, so it works on phones.
 */
function CostChip({ label, tip }: { label: string; tip: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            // Radix closes a tooltip on click; a tap opens this one instead, not the row's drawer.
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
          className="cursor-help"
        >
          <Badge variant="outline" className="h-4 px-1 font-sans text-[10px]">
            {label}
          </Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 whitespace-pre-line text-left">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** A lot's cost cell: an `est.` chip when it is the close that day, `no cost` when there is none. */
function LotCost({ lot: l }: { lot: TaxLot }) {
  if (l.cost_from !== 'estimate' && l.cost_from !== 'missing') return <>{num(l.cost)}</>;
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      {l.cost_from === 'estimate' ? (
        <CostChip
          label="est."
          tip={`The broker sent cost 0 for this lot (common for RSU, ESPP or transferred-in shares), so this is ${l.symbol}'s close on ${l.acquired}, or the last trading day before it. ${FIX_COST}`}
        />
      ) : (
        <CostChip
          label="no cost"
          tip={`The broker sent cost 0 for this lot and there is no close on record for ${l.symbol} on ${l.acquired}. ${FIX_COST}`}
        />
      )}
      {l.cost_from === 'estimate' ? num(l.cost) : DASH}
    </span>
  );
}

/** A share lot with no cost on record: sold with none, or open with none found. */
const noCost = (l: LotRow) =>
  l.lot === null ? l.cost === null && l.quantity > 0 : l.lot.cost_from === 'missing';

/**
 * A lot's missing cost and a pencil to set it (Bikram, 2026-10-12): your cost per share for that
 * symbol's lots acquired that day, kept across syncs (PUT lot-costs, as portfolio_lot_cost_write).
 */
function SetCost({ row: l }: { row: LotRow }) {
  const [editing, setEditing] = useState(false);
  const [cost, setCost] = useState('');
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      writeLotCost(l.account.id, {
        underlying: l.symbol,
        acquired: l.acquired,
        cost: Number(cost),
      }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['portfolios'] });
    },
  });
  const valid = cost.trim() !== '' && Number.isFinite(Number(cost)) && Number(cost) >= 0;
  if (!editing)
    return (
      <span className="inline-flex items-center justify-end gap-1.5">
        <CostChip
          label="no cost"
          tip={`No buy on record for these ${l.symbol} shares (transferred in, an RSU vest, or bought before the history starts), so their gain is left out of Realized. Set your cost per share for the lots acquired ${l.acquired}.`}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`Set the cost of ${l.symbol} acquired ${l.acquired}`}
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          <Pencil className="size-3.5" />
        </Button>
      </span>
    );
  return (
    <form
      className="inline-flex items-center justify-end gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <Input
        autoFocus
        inputMode="decimal"
        aria-label={`Cost per share of ${l.symbol}`}
        placeholder="cost / share"
        value={cost}
        onChange={(e) => setCost(e.target.value)}
        className="h-7 w-24 text-right font-mono text-xs"
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={!valid || save.isPending}
        aria-label="Save cost"
      >
        <Check className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Cancel"
        onClick={() => setEditing(false)}
      >
        <X className="size-3.5" />
      </Button>
    </form>
  );
}

/** The holding's tax lots, open and closed, in every account it spans; All / Open / Closed picks. */
function LotDetails({ holding: h }: { holding: Holding }) {
  const m = useMask();
  const [show, setShow] = useState<Show>('all');
  const parts = partsOf(h);
  const many = parts.length > 1;
  const all = parts.flatMap((p) => lotRows([p.account]).filter((l) => l.symbol === h.symbol));
  const lots = show === 'all' ? all : all.filter((l) => l.status === show);
  const amount = (v: number | null) => (v === null ? DASH : m(num(v)));
  return (
    <div className="flex flex-col gap-2">
      <ShowToggle value={show} onChange={setShow} />
      {lots.length ? (
        <DetailsTable
          head={[
            { label: 'Status' },
            ...(many ? [{ label: 'Account' }] : []),
            { label: 'Acquired' },
            { label: 'Closed' },
            { label: 'Qty', right: true },
            { label: 'Cost', right: true },
            { label: 'Sell price', right: true },
            { label: 'Gain', right: true },
            { label: 'Term' },
            { label: 'Source' },
          ]}
          rows={lots.map((l) => ({
            key: l.key,
            cells: [
              <CostChip key="st" label={STATUS[l.status]} tip={STATUS_TIP[l.status]} />,
              ...(many ? [l.account.name] : []),
              l.before ? 'Before history' : l.acquired,
              l.closed ?? DASH,
              m(num(l.quantity, l.quantity % 1 ? 4 : 0)),
              noCost(l) ? (
                <SetCost key="c" row={l} />
              ) : l.lot ? (
                <LotCost key="c" lot={l.lot} />
              ) : (
                amount(l.cost)
              ),
              amount(l.sell),
              l.gain === null ? (
                DASH
              ) : (
                <span key="g" className={toneClass(l.gain)}>
                  {m(usd(l.gain))}
                </span>
              ),
              // Retirement accounts are not taxed on sales, so lots carry no term.
              l.account.tax_type === 'retirement' ? 'n/a' : TERM[l.term],
              <SourceChip key="s" lot={l} />,
            ],
          }))}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {show === 'closed'
            ? `No closed lots of ${h.symbol} yet.`
            : `No open lots: no buys of ${h.symbol} on record.`}
        </p>
      )}
    </div>
  );
}

/** All, Buy, Sell or Transfer: the transactions button group in a holding's drawer (Bikram, 2026-10-12). */
type Moves = 'all' | 'buy' | 'sell' | 'transfer';
const movesOf = (kind: string): Moves | null =>
  kind === 'buy' || kind === 'sell'
    ? kind
    : kind === 'transfer_in' || kind === 'transfer_out'
      ? 'transfer'
      : null;

/** A transaction's action: Buy and Sell in their own colours, a transfer with the broker's text on hover. */
function ActionChip({ t }: { t: Transaction }) {
  const label = ACTION[t.kind] ?? t.kind;
  const move = movesOf(t.kind);
  if (!move) return <>{label}</>;
  const chip = (
    <Badge
      variant="outline"
      className={cn(
        'font-sans',
        move === 'buy' && 'border-gain/40 text-gain',
        move === 'sell' && 'border-loss/40 text-loss',
      )}
    >
      {label}
    </Badge>
  );
  return move === 'transfer' && t.description ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{chip}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-left">{t.description}</TooltipContent>
    </Tooltip>
  ) : (
    chip
  );
}

function TransactionDetails({ holding: h }: { holding: Holding }) {
  const m = useMask();
  const [show, setShow] = useState<Moves>('all');
  const parts = partsOf(h);
  const many = parts.length > 1;
  const qs = useQueries({ queries: parts.map((p) => transactionsQuery(p.account.id, h.symbol)) });
  if (qs.some((q) => q.isPending)) return <Skeleton className="h-24 w-full" />;
  const failed = qs.find((q) => q.isError);
  if (failed?.error) return <ErrorNote>{failed.error.message}</ErrorNote>;
  const all = parts
    .flatMap((p, i) => (qs[i]?.data ?? []).map((t) => ({ p, t })))
    .sort((a, b) => b.t.date.localeCompare(a.t.date));
  if (!all.length)
    return <p className="text-sm text-muted-foreground">No transactions for {h.symbol}.</p>;
  const rows = show === 'all' ? all : all.filter(({ t }) => movesOf(t.kind) === show);
  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={show}
        onValueChange={(v) => v && setShow(v as Moves)}
        aria-label="Show"
      >
        <ToggleGroupItem value="all">All</ToggleGroupItem>
        <ToggleGroupItem value="buy">Buy</ToggleGroupItem>
        <ToggleGroupItem value="sell">Sell</ToggleGroupItem>
        <ToggleGroupItem value="transfer">Transfer</ToggleGroupItem>
      </ToggleGroup>
      {rows.length ? (
        <DetailsTable
          head={[
            ...(many ? [{ label: 'Account' }] : []),
            { label: 'Date' },
            { label: 'Action', grow: true },
            { label: 'Qty @ price', right: true },
            { label: 'Amount', right: true },
          ]}
          rows={rows.map(({ p, t }) => ({
            key: `${p.key}:${t.id}`,
            cells: [
              ...(many ? [p.account.name] : []),
              t.date,
              <ActionChip key="a" t={t} />,
              t.quantity === null
                ? DASH
                : movesOf(t.kind) === 'transfer'
                  ? m(num(t.quantity, t.quantity % 1 ? 4 : 0))
                  : `${m(num(t.quantity, t.quantity % 1 ? 4 : 0))} @ ${num(t.price)}`,
              m(usd(t.amount)),
            ],
          }))}
        />
      ) : (
        <p className="text-sm text-muted-foreground">None of these for {h.symbol}.</p>
      )}
    </div>
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
