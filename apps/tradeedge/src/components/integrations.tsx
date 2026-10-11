// Settings ▸ Integrations (Bikram, 2026-10-10): the services TradeEdge connects to with the person's
// own keys, one list, each row expanding in place: SnapTrade (key, brokers and their accounts, sync,
// webhook), Manual accounts (only brokers SnapTrade can't reach) and Alpaca (live data key). Brokers
// are linked in SnapTrade's own portal, in a new tab. The header's sync status sits in the middle.
import {
  type IntegrationsStatus,
  type Portfolio,
  type SnapTradeBroker,
  type SyncReport,
  type TaxType,
  deleteAlpacaKey,
  deletePortfolio,
  deleteSnapTradeKey,
  holdingsAccountsQuery,
  integrationsQuery,
  saveAlpacaKey,
  saveSnapTradeKey,
  setSnapTradeAccount,
  snaptradePortal,
  syncSnapTrade,
  writeLots,
  writeManualAccount,
  writeTransactions,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { ConfirmDelete, type SettingsSectionDef, StatusItem, usePrefs } from '@edgedesk/app-shell';
import { Badge } from '@edgedesk/app-shell/ui/badge';
import { Button } from '@edgedesk/app-shell/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@edgedesk/app-shell/ui/collapsible';
import { Input } from '@edgedesk/app-shell/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@edgedesk/app-shell/ui/input-group';
import { Label } from '@edgedesk/app-shell/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@edgedesk/app-shell/ui/select';
import { Switch } from '@edgedesk/app-shell/ui/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  LinkIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';

const SNAPTRADE_DASHBOARD = 'https://dashboard.snaptrade.com';

/** `20:34 PT`-style time in the person's time zone. */
function useClock() {
  const { timeZone } = usePrefs();
  return (iso: string) =>
    new Date(iso).toLocaleString('en-US', {
      timeZone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
}

/** A fetch that never got an answer is a TypeError ("Load failed" in Safari, "Failed to fetch" in Chrome). */
const errorText = (e: unknown) =>
  e instanceof TypeError
    ? 'The request was cut off before TradeEdge answered (the page was left or the network dropped). Try again.'
    : e instanceof Error
      ? e.message
      : String(e);

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-loss">
      {errorText(error)}
    </p>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid grid-cols-1 gap-2">
      <div className="flex items-center gap-2">
        <h4 className="flex-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h4>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One integration: a row that expands in place. */
function IntegrationRow({
  name,
  meta,
  badge,
  open,
  onOpenChange,
  children,
}: {
  name: string;
  meta: string;
  badge: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="border-b last:border-b-0">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 px-1 py-3 text-left hover:bg-muted/50"
        >
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">{meta}</span>
          </span>
          {badge}
          <ChevronRightIcon
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid grid-cols-1 gap-5 px-1 pt-1 pb-5">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── SnapTrade ──

function SnapTradeConnect() {
  const qc = useQueryClient();
  const [clientId, setClientId] = useState('');
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: () => saveSnapTradeKey({ client_id: clientId.trim(), consumer_key: key.trim() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations'] }),
  });
  return (
    <Section title="Connect">
      <ol className="grid grid-cols-1 gap-4 text-sm">
        <li className="grid grid-cols-1 gap-2">
          <p>
            <span className="font-medium">1. Get a key.</span> Sign in at SnapTrade, turn on
            two-factor sign-in, and create a Personal key. It's free and covers up to 5 brokers.
          </p>
          <Button size="sm" variant="outline" className="justify-self-start" asChild>
            <a href={SNAPTRADE_DASHBOARD} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              Open SnapTrade
            </a>
          </Button>
        </li>
        <li className="grid grid-cols-1 gap-3">
          <p>
            <span className="font-medium">2. Paste it here.</span>
          </p>
          <form
            className="grid grid-cols-1 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (clientId.trim() && key.trim()) save.mutate();
            }}
          >
            <Field id="st-client" label="Client ID">
              <Input
                id="st-client"
                className="num"
                autoComplete="off"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </Field>
            <Field id="st-key" label="Consumer key">
              <Input
                id="st-key"
                type="password"
                className="num"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
            <ErrorLine error={save.error} />
            <Button
              type="submit"
              size="sm"
              className="justify-self-end"
              disabled={!clientId.trim() || !key.trim() || save.isPending}
            >
              {save.isPending ? <RefreshCwIcon className="animate-spin" /> : <CheckIcon />}
              {save.isPending ? 'Checking…' : 'Save and continue'}
            </Button>
          </form>
        </li>
      </ol>
    </Section>
  );
}

/** Opens SnapTrade's portal in a new tab (opened first, so the browser allows it). */
function usePortal() {
  return useMutation({
    mutationFn: async (reconnect?: string) => {
      const tab = window.open('', '_blank');
      try {
        const { url } = await snaptradePortal(reconnect);
        if (tab) tab.location.href = url;
        else window.location.href = url;
      } catch (err) {
        tab?.close();
        throw err;
      }
    },
  });
}

function BrokerBlock({ broker }: { broker: SnapTradeBroker }) {
  const qc = useQueryClient();
  const portal = usePortal();
  const [leaving, setLeaving] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: ({ id, ...c }: { id: string; import?: boolean; tax_type?: TaxType }) =>
      setSnapTradeAccount(id, c),
    onSuccess: (data) => {
      qc.setQueryData(integrationsQuery().queryKey, data);
      void qc.invalidateQueries({ queryKey: ['portfolios'] });
    },
  });
  const leavingAccount = broker.accounts.find((a) => a.id === leaving);
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 bg-muted/60 px-3 py-2">
        <span className="flex-1 font-medium">{broker.name}</span>
        {broker.broken ? (
          <>
            <Badge variant="outline" className="text-warning">
              <AlertTriangleIcon />
              Sign in again
            </Badge>
            <Button size="sm" variant="outline" onClick={() => portal.mutate(broker.id)}>
              <LinkIcon />
              Reconnect
            </Button>
          </>
        ) : (
          <Badge variant="outline" className="text-gain">
            <CheckIcon />
            Connected
          </Badge>
        )}
      </div>
      {broker.accounts.map((a) => (
        <div
          key={a.id}
          className="grid grid-cols-[minmax(0,1fr)_6.5rem_auto] items-center gap-x-2 border-t px-3 py-2 sm:grid-cols-[minmax(0,1fr)_4rem_8.5rem_auto] sm:gap-x-3"
        >
          <span className="truncate text-sm">{a.name}</span>
          <span className="num hidden text-xs text-muted-foreground sm:block">{a.number}</span>
          <Select
            value={a.tax_type}
            onValueChange={(v) => change.mutate({ id: a.id, tax_type: v as TaxType })}
            disabled={!a.import}
          >
            <SelectTrigger
              size="sm"
              aria-label={`${a.name} tax type`}
              className="w-full text-xs sm:text-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="taxable">Taxable</SelectItem>
              <SelectItem value="retirement">Retirement</SelectItem>
            </SelectContent>
          </Select>
          <Label
            htmlFor={`hold-${a.id}`}
            className="flex items-center gap-2 text-xs font-normal text-muted-foreground"
          >
            <span className="hidden sm:inline">In Holdings</span>
            <Switch
              id={`hold-${a.id}`}
              checked={a.import}
              aria-label={`${a.name} in Holdings`}
              onCheckedChange={(on) =>
                on ? change.mutate({ id: a.id, import: true }) : setLeaving(a.id)
              }
            />
          </Label>
        </div>
      ))}
      {!broker.accounts.length && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">No accounts yet.</p>
      )}
      <ConfirmDelete
        open={leaving !== null}
        onOpenChange={(o) => !o && setLeaving(null)}
        title={`Leave ${leavingAccount?.name ?? 'this account'} out of Holdings?`}
        description="Its holdings, transactions and lots are removed from TradeEdge. Turn it back on to sync it again."
        action="Leave out"
        onConfirm={() => leaving && change.mutate({ id: leaving, import: false })}
      />
      <ErrorLine error={change.error ?? portal.error} />
    </div>
  );
}

function SyncLine({ report }: { report: SyncReport | null }) {
  const clock = useClock();
  if (!report) return <span className="text-muted-foreground">Not synced yet</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {report.ok ? (
        <CheckIcon className="size-4 shrink-0 text-gain" />
      ) : (
        <AlertTriangleIcon className="size-4 shrink-0 text-warning" />
      )}
      <span className="num truncate">
        {clock(report.at)} · {report.accounts} accounts · {report.positions} positions ·{' '}
        {report.transactions.toLocaleString()} transactions
      </span>
    </span>
  );
}

function SnapTradeConnected({
  st,
}: { st: Extract<IntegrationsStatus['snaptrade'], { connected: true }> }) {
  const qc = useQueryClient();
  const clock = useClock();
  const portal = usePortal();
  const [copied, setCopied] = useState(false);
  const hookInput = useRef<HTMLInputElement>(null);
  /** Phone browsers can refuse the async clipboard; fall back to copying the selected field. */
  const copyHook = async () => {
    try {
      await navigator.clipboard.writeText(st.webhook_url);
      setCopied(true);
    } catch {
      hookInput.current?.select();
      setCopied(document.execCommand('copy'));
    }
  };
  const sync = useMutation({
    mutationFn: syncSnapTrade,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['integrations'] });
      void qc.invalidateQueries({ queryKey: ['portfolios'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
  const disconnect = useMutation({
    mutationFn: deleteSnapTradeKey,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations'] }),
  });
  const report = sync.data ?? st.last_sync;
  // The add-on note goes once SnapTrade sends lots for any synced account.
  const holdings = useQuery(holdingsAccountsQuery());
  const brokerLots = holdings.data?.some((a) => a.lots_source === 'broker') ?? false;
  return (
    <>
      <Section
        title="Brokers and accounts"
        action={
          <Button size="sm" variant="outline" onClick={() => portal.mutate(undefined)}>
            <PlusIcon />
            Add broker
          </Button>
        }
      >
        <ErrorLine error={portal.error} />
        {st.error ? (
          <p role="alert" className="text-xs text-loss">
            SnapTrade couldn't be reached: {st.error}
          </p>
        ) : (st.brokers ?? []).length ? (
          (st.brokers ?? []).map((b) => <BrokerBlock key={b.id} broker={b} />)
        ) : (
          <p className="text-sm text-muted-foreground">
            No brokers yet. Add one: you sign in on SnapTrade's page, and EdgeDesk never sees your
            broker password.
          </p>
        )}
      </Section>
      <Section title="Sync">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <SyncLine report={report} />
          <span className="flex-1" />
          <span className="text-xs text-muted-foreground">
            {st.last_event ? 'Live via webhook' : 'When you sync'}
          </span>
          <Button
            size="sm"
            variant={report ? 'outline' : 'default'}
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            <RefreshCwIcon className={cn(sync.isPending && 'animate-spin')} />
            {sync.isPending ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>
        {report?.errors.map((e) => (
          <p key={e} role="alert" className="text-xs text-loss">
            {e}
          </p>
        ))}
        {report?.skipped.length ? (
          <p className="text-xs text-muted-foreground">
            Not in Holdings (kinds it can't hold): {report.skipped.join(', ')}
          </p>
        ) : null}
        <ErrorLine error={sync.error} />
        {brokerLots ? null : (
          <p className="text-xs text-muted-foreground">
            Broker tax lots need SnapTrade's Tax lots add-on (SnapTrade ▸ Add-ons). Without it, lots
            come from the transactions, first in first out.
          </p>
        )}
      </Section>
      <Section title="Live updates">
        <p className="text-sm">
          SnapTrade calls this address whenever holdings, transactions or a broker login change, and
          TradeEdge updates right away. In SnapTrade, open Webhooks and paste it.
        </p>
        <InputGroup>
          <InputGroupInput
            ref={hookInput}
            readOnly
            aria-label="Webhook URL"
            className="num text-xs"
            value={st.webhook_url}
            onFocus={(e) => e.currentTarget.select()}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="xs" onClick={() => void copyHook()}>
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? 'Copied' : 'Copy'}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {st.last_event ? (
            <>
              <Badge variant="outline" className="text-gain">
                <CheckIcon />
                Receiving
              </Badge>
              <span className="text-muted-foreground">
                Last event {clock(st.last_event.at)} ·{' '}
                {st.last_event.type.toLowerCase().replaceAll('_', ' ')}
              </span>
            </>
          ) : (
            <>
              <Badge variant="outline">Waiting for the first event</Badge>
              <span className="text-muted-foreground">
                Turns green when SnapTrade's first call arrives
              </span>
            </>
          )}
          <span className="flex-1" />
          <Button size="sm" variant="outline" asChild>
            <a href={SNAPTRADE_DASHBOARD} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              Open SnapTrade
            </a>
          </Button>
        </div>
      </Section>
      <Section title="Key">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="num">
            {st.client_id} · {st.consumer_key}
          </span>
          <span className="text-xs text-muted-foreground">saved {clock(st.saved_at)}</span>
          <span className="flex-1" />
          <ConfirmDelete
            title="Disconnect SnapTrade?"
            description="Your key is deleted and syncing stops. Holdings and transactions already synced stay."
            action="Disconnect"
            onConfirm={() => disconnect.mutate()}
          >
            <Button size="sm" variant="destructive">
              <Trash2Icon />
              Disconnect
            </Button>
          </ConfirmDelete>
        </div>
        <ErrorLine error={disconnect.error} />
      </Section>
    </>
  );
}

// ── Manual accounts ──

const today = () => new Date().toISOString().slice(0, 10);
const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

/** A tiny CSV reader for an export with a header row named like the API fields. */
function parseCsv(text: string) {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted && ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.toLowerCase(), r[i] ?? ''])));
}

function ManualAccount({ account }: { account: Portfolio }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<'holding' | 'lot' | 'transaction' | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const set = (k: string) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const done = () => {
    setForm(null);
    setF({});
    void qc.invalidateQueries({ queryKey: ['portfolios'] });
    void qc.invalidateQueries({ queryKey: ['transactions'] });
  };
  const positions = account.positions.map((p) => ({
    underlying: p.underlying,
    quantity: p.quantity,
    avg_cost: p.avg_cost ?? undefined,
    ...(p.expiration !== null && p.strike !== null && p.right
      ? { expiration: p.expiration, strike: p.strike, right: p.right }
      : {}),
  }));
  const write = useMutation({
    mutationFn: async () => {
      const symbol = (f.symbol ?? '').trim().toUpperCase();
      if (form === 'holding') {
        await writeManualAccount({
          id: account.id,
          name: account.name,
          tax_type: account.tax_type,
          cash: account.cash,
          positions: [
            ...positions.filter((p) => p.underlying !== symbol || p.expiration !== undefined),
            { underlying: symbol, quantity: Number(f.quantity), avg_cost: num(f.cost ?? '') },
          ],
        });
      } else if (form === 'lot') {
        const mine = account.lots_source === 'yours' ? account.lots : [];
        await writeLots(account.id, [
          ...mine
            .filter((l) => !/\s/.test(l.symbol))
            .map((l) => ({
              underlying: l.symbol,
              acquired: l.acquired,
              quantity: l.quantity,
              cost: l.cost,
            })),
          {
            underlying: symbol,
            acquired: f.acquired || today(),
            quantity: Number(f.quantity),
            cost: Number(f.cost),
          },
        ]);
      } else if (form === 'transaction') {
        const kind = f.kind || 'buy';
        await writeTransactions(account.id, [
          {
            id: `manual-${Date.now()}`,
            date: f.date || today(),
            kind,
            ...(symbol ? { underlying: symbol } : {}),
            quantity: num(f.quantity ?? ''),
            price: num(f.price ?? ''),
            amount: Number(f.amount || 0),
          },
        ]);
      }
    },
    onSuccess: done,
  });
  const csv = useMutation({
    mutationFn: async (file: File) => {
      const rows = parseCsv(await file.text()).map((r) => ({
        id: r.id ?? '',
        date: r.date ?? '',
        kind: r.kind ?? '',
        underlying: r.underlying || undefined,
        quantity: num(r.quantity ?? ''),
        price: num(r.price ?? ''),
        fees: num(r.fees ?? ''),
        amount: Number(r.amount || 0),
        expiration: num(r.expiration ?? ''),
        strike: num(r.strike ?? ''),
        right: (r.right?.toUpperCase() as 'C' | 'P') || undefined,
        description: r.description || undefined,
      }));
      return writeTransactions(account.id, rows);
    },
    onSuccess: done,
  });
  const remove = useMutation({ mutationFn: () => deletePortfolio(account.id), onSuccess: done });
  const lotFor = new Set(account.lots.map((l) => l.symbol));
  const fields: Record<'holding' | 'lot' | 'transaction', [string, string, string?][]> = {
    holding: [
      ['symbol', 'Symbol'],
      ['quantity', 'Quantity'],
      ['cost', 'Cost per share'],
    ],
    lot: [
      ['symbol', 'Symbol'],
      ['acquired', 'Acquired', 'date'],
      ['quantity', 'Quantity'],
      ['cost', 'Cost per share'],
    ],
    transaction: [
      ['date', 'Date', 'date'],
      ['symbol', 'Symbol'],
      ['quantity', 'Quantity'],
      ['price', 'Price'],
      ['amount', 'Cash amount'],
    ],
  };
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex flex-wrap items-center gap-2 bg-muted/60 px-3 py-2">
        <span className="min-w-0 flex-1 basis-full sm:basis-auto">
          <span className="block font-medium">{account.name}</span>
          <span className="block text-xs text-muted-foreground">
            {account.broker} · {account.tax_type} · {account.positions.length} positions
          </span>
        </span>
        <Button size="sm" variant="outline" onClick={() => setForm('holding')}>
          <PlusIcon />
          Holding
        </Button>
        <Button size="sm" variant="outline" onClick={() => setForm('lot')}>
          <PlusIcon />
          Lot
        </Button>
        <Button size="sm" variant="outline" onClick={() => setForm('transaction')}>
          <PlusIcon />
          Transaction
        </Button>
        <Button size="sm" variant="outline" asChild>
          <label>
            <UploadIcon />
            Import CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) csv.mutate(file);
                e.target.value = '';
              }}
            />
          </label>
        </Button>
        <ConfirmDelete
          title={`Delete ${account.name}?`}
          description="Its holdings, transactions and lots are deleted."
          onConfirm={() => remove.mutate()}
        >
          <Button size="icon-sm" variant="ghost" aria-label={`Delete ${account.name}`}>
            <Trash2Icon />
          </Button>
        </ConfirmDelete>
      </div>
      {account.positions.map((p) => (
        <div
          key={p.symbol}
          className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-t px-3 py-1.5 text-sm"
        >
          <span className="num truncate">{p.symbol}</span>
          <span className="num text-right">{p.quantity.toLocaleString()}</span>
          {lotFor.has(p.symbol) || p.avg_cost !== null ? (
            <span className="text-xs text-muted-foreground">
              {lotFor.has(p.symbol) ? 'lots on record' : `$${p.avg_cost} avg`}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-warning">
              <AlertTriangleIcon className="size-3.5" />
              needs a lot
            </span>
          )}
        </div>
      ))}
      {form && (
        <form
          className="grid grid-cols-2 items-end gap-2 border-t p-3 sm:grid-cols-[repeat(auto-fit,minmax(7rem,1fr))]"
          onSubmit={(e) => {
            e.preventDefault();
            write.mutate();
          }}
        >
          {form === 'transaction' && (
            <Field id={`${account.id}-kind`} label="Kind">
              <Select
                value={f.kind ?? 'buy'}
                onValueChange={(v) => setF((x) => ({ ...x, kind: v }))}
              >
                <SelectTrigger id={`${account.id}-kind`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['buy', 'sell', 'dividend', 'interest', 'fee', 'deposit', 'withdrawal'].map(
                    (k) => (
                      <SelectItem key={k} value={k}>
                        {k}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </Field>
          )}
          {fields[form].map(([k, label, type]) => (
            <Field key={k} id={`${account.id}-${k}`} label={label}>
              <Input
                id={`${account.id}-${k}`}
                type={type ?? 'text'}
                inputMode={type ? undefined : k === 'symbol' ? 'text' : 'decimal'}
                className={cn('num', k === 'symbol' && 'uppercase')}
                value={f[k] ?? ''}
                onChange={set(k)}
              />
            </Field>
          ))}
          <div className="col-span-full flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={write.isPending}>
              <CheckIcon />
              Save {form}
            </Button>
          </div>
        </form>
      )}
      <div className="px-3">
        <ErrorLine error={write.error ?? csv.error ?? remove.error} />
      </div>
    </div>
  );
}

function ManualAccounts({ onSnapTrade }: { onSnapTrade: () => void }) {
  const qc = useQueryClient();
  const accounts = useQuery(holdingsAccountsQuery());
  const manual = (accounts.data ?? []).filter((a) => a.source === 'manual');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [broker, setBroker] = useState('');
  const [tax, setTax] = useState<TaxType>('taxable');
  const add = useMutation({
    mutationFn: () =>
      writeManualAccount({
        name: name.trim(),
        broker: broker.trim(),
        tax_type: tax,
        cash: 0,
        positions: [],
      }),
    onSuccess: () => {
      setAdding(false);
      setName('');
      setBroker('');
      void qc.invalidateQueries({ queryKey: ['portfolios'] });
    },
  });
  const blocked = add.error && /supported by SnapTrade/.test(errorText(add.error));
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Only for brokers SnapTrade can't reach, like SoFi. A broker SnapTrade supports is linked
        under SnapTrade instead.
      </p>
      {manual.map((a) => (
        <ManualAccount key={a.id} account={a} />
      ))}
      {adding ? (
        <form
          className="grid grid-cols-1 gap-3 rounded-md border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && broker.trim()) add.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_9rem]">
            <Field id="man-name" label="Account name">
              <Input
                id="man-name"
                value={name}
                placeholder="SoFi Invest"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field id="man-broker" label="Broker">
              <Input
                id="man-broker"
                value={broker}
                placeholder="SoFi"
                onChange={(e) => setBroker(e.target.value)}
              />
            </Field>
            <Field id="man-tax" label="Tax type">
              <Select value={tax} onValueChange={(v) => setTax(v as TaxType)}>
                <SelectTrigger id="man-tax" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="taxable">Taxable</SelectItem>
                  <SelectItem value="retirement">Retirement</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {blocked ? (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-loss">
              {errorText(add.error)}
              <Button type="button" size="xs" variant="outline" onClick={onSnapTrade}>
                Open SnapTrade
              </Button>
            </p>
          ) : (
            <ErrorLine error={add.error} />
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!name.trim() || !broker.trim() || add.isPending}
            >
              <CheckIcon />
              Add account
            </Button>
          </div>
        </form>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          onClick={() => setAdding(true)}
        >
          <PlusIcon />
          Add manual account
        </Button>
      )}
    </>
  );
}

// ── Alpaca ──

function Alpaca({ status }: { status: IntegrationsStatus['alpaca'] }) {
  const qc = useQueryClient();
  const clock = useClock();
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const save = useMutation({
    mutationFn: () => saveAlpacaKey({ key_id: keyId.trim(), secret_key: secret.trim() }),
    onSuccess: (data) => {
      qc.setQueryData(integrationsQuery().queryKey, data);
      setKeyId('');
      setSecret('');
      void qc.invalidateQueries({ queryKey: ['quotes'] });
    },
  });
  const remove = useMutation({
    mutationFn: deleteAlpacaKey,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['integrations'] });
      void qc.invalidateQueries({ queryKey: ['quotes'] });
    },
  });
  if (status.connected)
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="num">{status.key_id}</span>
        <span className="text-xs text-muted-foreground">
          Live data uses your key · saved {clock(status.saved_at)}
        </span>
        <span className="flex-1" />
        <ConfirmDelete
          title="Disconnect Alpaca?"
          description="Your key is deleted and live data goes back to EdgeDesk's key."
          action="Disconnect"
          onConfirm={() => remove.mutate()}
        >
          <Button size="sm" variant="destructive">
            <Trash2Icon />
            Disconnect
          </Button>
        </ConfirmDelete>
        <ErrorLine error={remove.error} />
      </div>
    );
  return (
    <form
      className="grid grid-cols-1 gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (keyId.trim() && secret.trim()) save.mutate();
      }}
    >
      <p className="text-sm">
        Create a free market-data key at Alpaca, then paste it here. TradeEdge then uses it for live
        quotes and option chains. Until then, live data uses EdgeDesk's key.
      </p>
      <Button size="sm" variant="outline" className="justify-self-start" asChild>
        <a href="https://app.alpaca.markets" target="_blank" rel="noreferrer">
          <ExternalLinkIcon />
          Open Alpaca
        </a>
      </Button>
      <Field id="alp-id" label="API key ID">
        <Input
          id="alp-id"
          className="num"
          autoComplete="off"
          value={keyId}
          onChange={(e) => setKeyId(e.target.value)}
        />
      </Field>
      <Field id="alp-secret" label="Secret key">
        <Input
          id="alp-secret"
          type="password"
          className="num"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </Field>
      <ErrorLine error={save.error} />
      <Button
        type="submit"
        size="sm"
        className="justify-self-end"
        disabled={!keyId.trim() || !secret.trim() || save.isPending}
      >
        {save.isPending ? <RefreshCwIcon className="animate-spin" /> : <CheckIcon />}
        {save.isPending ? 'Checking…' : 'Save key'}
      </Button>
    </form>
  );
}

// ── the section ──

function Integrations() {
  const q = useQuery(integrationsQuery());
  const accounts = useQuery(holdingsAccountsQuery());
  const [open, setOpen] = useState<string | null>('snaptrade');
  const toggle = (id: string) => (o: boolean) => setOpen(o ? id : null);
  if (q.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.isError) return <ErrorLine error={q.error} />;
  const st = q.data.snaptrade;
  const brokers = st.connected ? (st.brokers ?? []) : [];
  const broken = brokers.filter((b) => b.broken).length;
  const manualCount = (accounts.data ?? []).filter((a) => a.source === 'manual').length;
  return (
    <div className="grid grid-cols-1">
      <IntegrationRow
        name="SnapTrade"
        meta="Brokerage accounts into Holdings · read-only"
        open={open === 'snaptrade'}
        onOpenChange={toggle('snaptrade')}
        badge={
          !st.connected ? (
            <Badge variant="outline">Not connected</Badge>
          ) : broken ? (
            <Badge variant="outline" className="text-warning">
              <AlertTriangleIcon />
              {broken} needs sign-in
            </Badge>
          ) : (
            <Badge variant="outline" className="text-gain">
              <CheckIcon />
              {brokers.length} broker{brokers.length === 1 ? '' : 's'}
            </Badge>
          )
        }
      >
        {st.connected ? <SnapTradeConnected st={st} /> : <SnapTradeConnect />}
      </IntegrationRow>
      <IntegrationRow
        name="Manual accounts"
        meta="Brokers SnapTrade can't reach"
        open={open === 'manual'}
        onOpenChange={toggle('manual')}
        badge={
          <Badge variant="outline">
            {manualCount} account{manualCount === 1 ? '' : 's'}
          </Badge>
        }
      >
        <ManualAccounts onSnapTrade={() => setOpen('snaptrade')} />
      </IntegrationRow>
      <IntegrationRow
        name="Alpaca"
        meta="Live quotes and option chains"
        open={open === 'alpaca'}
        onOpenChange={toggle('alpaca')}
        badge={
          q.data.alpaca.connected ? (
            <Badge variant="outline" className="text-gain">
              <CheckIcon />
              Your key
            </Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )
        }
      >
        <Alpaca status={q.data.alpaca} />
      </IntegrationRow>
    </div>
  );
}

export const INTEGRATION_SETTINGS: SettingsSectionDef[] = [
  {
    id: 'integrations',
    title: 'Integrations',
    icon: PlugIcon,
    description: 'SnapTrade, manual accounts and Alpaca, with your own keys.',
    content: <Integrations />,
  },
];

/** The status bar's broker sync state (every page): only once SnapTrade is connected. */
export function SyncStatus() {
  const q = useQuery(integrationsQuery(false));
  const clock = useClock();
  const st = q.data?.snaptrade;
  if (!st?.connected) return null;
  const sync = st.last_sync;
  const broken =
    st.last_event?.type === 'CONNECTION_BROKEN' && (!sync || st.last_event.at > sync.at);
  return (
    <StatusItem
      label="Brokers"
      ok={broken ? false : sync ? sync.ok : null}
      value={
        broken
          ? 'needs sign-in'
          : !sync
            ? 'not synced yet'
            : sync.ok
              ? `synced ${clock(sync.at)}`
              : 'last sync had errors'
      }
    />
  );
}
