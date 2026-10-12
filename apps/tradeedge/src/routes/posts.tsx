import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  type EarningsRow,
  POST_SOURCES,
  type Post,
  type PostDomain,
  type PostView,
  THEMES,
  deletePostView,
  earningsQuery,
  integrationsQuery,
  postViewPath,
  postViewsQuery,
  postsQuery,
  savePostView,
} from '@/lib/api';
/**
 * Posts (Bikram, 2026-10-12): what the X accounts the person tracks post and the news their own
 * Alpaca key reads, tagged with symbols, a macro theme and sentiment, each with its Source. Three app views (Feed, By symbol, Macro), read-only; Duplicate copies
 * one into a view of the person's own. Feed and Macro read one row per post (`posts`), By symbol
 * one row per post and symbol it names (`post_symbols`).
 */
import { ErrorNote } from '@/routes/chain';
import {
  type CustomViewConfig,
  CustomViewPage,
  Page,
  StatusItem,
  type ViewDomain,
  type ViewField,
  usePrefs,
  useShell,
} from '@edgedesk/app-shell';
import { appView } from '@edgedesk/types/views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowUpRight,
  AtSign,
  CalendarDays,
  CircleCheck,
  Clock,
  Copy,
  DollarSign,
  ExternalLink,
  Gauge,
  Globe,
  Hash,
  MessageSquareText,
  Newspaper,
  Percent,
  PlugIcon,
  Smile,
  User,
} from 'lucide-react';

/** `parts`: the post's repeats only, which a chevron opens under it (Bikram, 2026-10-12). */
type Row = Post & { key: string; symbol?: string; parts: Row[] };

/** `@zerohedge` for an X account, `Benzinga` for a news publisher, `SEC 8-K` for an earnings line. */
const who = (p: Post) =>
  p.source === 'sec'
    ? 'SEC 8-K'
    : p.source === 'alpaca'
      ? p.handle.charAt(0).toUpperCase() + p.handle.slice(1)
      : `@${p.handle}`;
const linkLabel = (p: Post) =>
  p.source === 'sec' ? 'Open filing' : p.source === 'alpaca' ? 'Open article' : 'Open on X';

const mood = (s: number | null) =>
  s === null ? null : s > 0.15 ? 'Bullish' : s < -0.15 ? 'Bearish' : 'Neutral';

/** `9:41 PM` today, else `Oct 11, 9:41 PM`, in the status bar's time zone. */
function When({ iso }: { iso: string }) {
  const { timeZone } = usePrefs();
  const d = new Date(iso);
  const day = (x: Date) => x.toLocaleDateString('en-US', { timeZone });
  return (
    <span className="num whitespace-nowrap">
      {d.toLocaleString('en-US', {
        timeZone,
        ...(day(d) === day(new Date()) ? {} : { month: 'short', day: 'numeric' }),
        hour: 'numeric',
        minute: '2-digit',
      })}
    </span>
  );
}

/** ▲ +0.70 / ▼ −0.40 / – 0.00, with its tone. */
function Sentiment({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">–</span>;
  const up = value > 0.15;
  const down = value < -0.15;
  return (
    <span className={`num whitespace-nowrap ${up ? 'text-gain' : down ? 'text-loss' : ''}`}>
      {up ? '▲ +' : down ? '▼ −' : '– '}
      {Math.abs(value).toFixed(2)}
    </span>
  );
}

const fields: ViewField<Row>[] = [
  {
    key: 'at',
    label: 'Time',
    icon: Clock,
    value: (p) => p.at,
    format: 'text',
    aggregate: 'max',
    render: (p) => <When iso={p.at} />,
  },
  {
    key: 'source',
    label: 'Source',
    icon: Newspaper,
    value: (p) => POST_SOURCES[p.source ?? 'x'],
    format: 'text',
    filterable: true,
    groupable: true,
  },
  {
    key: 'handle',
    label: 'Account',
    icon: AtSign,
    value: who,
    format: 'text',
    filterable: true,
    groupable: true,
  },
  { key: 'name', label: 'Name', icon: User, value: (p) => p.name, format: 'text' },
  {
    key: 'text',
    label: 'Post',
    icon: MessageSquareText,
    value: (p) => p.text,
    format: 'text',
    render: (p) => (
      <span className="line-clamp-3 block min-w-64 max-w-md whitespace-normal">{p.text}</span>
    ),
  },
  {
    key: 'theme',
    label: 'Theme',
    icon: Globe,
    value: (p) => (p.theme ? THEMES[p.theme] : null),
    format: 'text',
    filterable: true,
    groupable: true,
  },
  {
    key: 'theme_conf',
    label: 'Theme confidence',
    icon: Percent,
    value: (p) => (p.theme_conf === null ? null : p.theme_conf * 100),
    format: 'percent',
    note: 'Clef',
  },
  {
    key: 'sentiment',
    label: 'Sentiment',
    icon: Gauge,
    value: (p) => p.sentiment,
    format: 'signed',
    aggregate: 'mean',
    note: '−1 bearish … +1 bullish, Clef',
    render: (p) => <Sentiment value={p.sentiment} />,
  },
  {
    key: 'mood',
    label: 'Mood',
    icon: Smile,
    value: (p) => mood(p.sentiment),
    format: 'text',
    filterable: true,
    groupable: true,
  },
  {
    key: 'sentiment_conf',
    label: 'Sentiment confidence',
    icon: Percent,
    value: (p) => (p.sentiment_conf === null ? null : p.sentiment_conf * 100),
    format: 'percent',
    note: 'Clef',
  },
  {
    key: 'posts',
    label: 'Posts',
    icon: Hash,
    value: () => 1,
    format: 'integer',
    aggregate: 'sum',
  },
  {
    key: 'url',
    label: 'Link',
    icon: ExternalLink,
    value: (p) => p.url,
    format: 'text',
    render: (p) => (
      <Button variant="ghost" size="icon-xs" asChild>
        <a
          href={p.url}
          target="_blank"
          rel="noreferrer"
          aria-label={linkLabel(p)}
          title={linkLabel(p)}
          onClick={(e) => e.stopPropagation()}
        >
          <ArrowUpRight />
        </a>
      </Button>
    ),
  },
];

const symbolsField: ViewField<Row> = {
  key: 'symbols',
  label: 'Symbols',
  icon: DollarSign,
  value: (p) => p.symbols.join(' ') || null,
  values: (p) => p.symbols,
  format: 'text',
  filterable: true,
  note: 'Workers AI; news: its publisher',
  // News can name 20+ tickers: two lines at most, the full list on hover (Bikram, 2026-10-12).
  render: (p) => (
    <span
      className="line-clamp-2 block min-w-24 max-w-48 whitespace-normal"
      title={p.symbols.join(' ')}
    >
      {p.symbols.join(' ') || '–'}
    </span>
  ),
};
const symbolField: ViewField<Row> = {
  key: 'symbol',
  label: 'Symbol',
  icon: DollarSign,
  value: (p) => p.symbol ?? null,
  format: 'text',
  filterable: true,
  groupable: true,
  note: 'Workers AI; news: its publisher',
};

type FeedDomain = Exclude<PostDomain, 'earnings'>;
const DOMAINS: Record<FeedDomain, ViewDomain<Row>> = {
  posts: {
    id: 'posts',
    rowKey: (p) => p.key,
    text: (p) => [p.text, p.name],
    fields: [...fields.slice(0, 5), symbolsField, ...fields.slice(5)],
    parts: { label: 'Repeats', by: 'handle', rows: (p) => p.parts, others: true },
  },
  post_symbols: {
    id: 'post_symbols',
    rowKey: (p) => p.key,
    text: (p) => [p.text, p.name],
    fields: [symbolField, ...fields],
    parts: { label: 'Repeats', by: 'handle', rows: (p) => p.parts, others: true },
  },
};

/** One row per post, or one per post and symbol it names; each opens its repeats. */
function rowsOf(posts: Post[], domain: FeedDomain): Row[] {
  const row = (p: Post, key: string, symbol?: string): Row => {
    const self: Row = { ...p, key, symbol, parts: [] };
    self.parts = (p.repeats ?? []).map((r) => ({ ...r, key: `${key}:${r.id}`, symbol, parts: [] }));
    return self;
  };
  return domain === 'posts'
    ? posts.map((p) => row(p, p.id))
    : posts.flatMap((p) => p.symbols.map((symbol) => row(p, `${p.id}:${symbol}`, symbol)));
}

/** Save, Duplicate and Delete of a view under Posts, and the app views' Duplicate button. */
function useViewActions(view: PostView) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const config: CustomViewConfig = { name: view.name, ...view.config };
  const listKey = postViewsQuery().queryKey;
  const save = useMutation({
    mutationFn: (c: CustomViewConfig) => savePostView(view.domain, c, view.id),
    onSuccess: (v) =>
      qc.setQueryData(listKey, (old: PostView[] | undefined) =>
        old?.map((o) => (o.id === v.id && o.domain === v.domain ? v : o)),
      ),
  });
  const copy = useMutation({
    mutationFn: () => savePostView(view.domain, { ...config, name: `${view.name} copy` }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: listKey });
      void navigate({ to: postViewPath(v) });
    },
  });
  const remove = useMutation({
    mutationFn: () => deletePostView(view.domain, view.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: listKey });
      void navigate({ to: '/posts/$id', params: { id: 'feed' } });
    },
  });
  return {
    key: `posts:${view.domain}:${view.id}:${view.updated_at}`,
    viewId: view.app ? undefined : view.id,
    crumbs: [{ label: 'Posts' }, { label: view.name }],
    config,
    onConfigChange: view.app ? undefined : (c: CustomViewConfig) => save.mutate(c),
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
  };
}

function PostViewBody({ view, domain }: { view: PostView; domain: FeedDomain }) {
  const { openSettings } = useShell();
  const { timeZone } = usePrefs();
  const posts = useQuery(postsQuery());
  const status = useQuery(integrationsQuery(false)).data;
  const x = status?.x;
  const alpaca = status?.alpaca;
  const { key, ...frame } = useViewActions(view);
  const notConnected = !!status && !x?.connected && !alpaca?.connected;
  const rows = notConnected ? [] : rowsOf(posts.data?.posts ?? [], domain);
  const check = x?.connected ? x.last_check : null;
  const news = alpaca?.connected ? alpaca.last_news : null;
  return (
    <CustomViewPage
      key={key}
      {...frame}
      domain={DOMAINS[domain]}
      rows={rows}
      rowTitle={(p) => `${who(p)}${p.symbol ? ` · ${p.symbol}` : ''}`}
      state={
        notConnected ? (
          <div className="grid justify-items-start gap-3 rounded-lg border p-6">
            <p className="text-sm">
              Connect X to see posts from the accounts you track (your own twitterapi.io key), or
              Alpaca to see the news (your own Alpaca key), in Settings ▸ Integrations.
            </p>
            <Button size="sm" variant="outline" onClick={() => openSettings('integrations')}>
              <PlugIcon />
              Open Integrations
            </Button>
          </div>
        ) : posts.data ? undefined : posts.isError ? (
          <ErrorNote>{posts.error.message}</ErrorNote>
        ) : (
          <Skeleton className="h-96 w-full" />
        )
      }
      status={
        <>
          <StatusItem label="Showing" value="7 days" />
          {posts.data ? <StatusItem label="Kept" value={posts.data.kept} /> : null}
          {check ? (
            <StatusItem
              label="X checked"
              ok={check.ok}
              value={new Date(check.at).toLocaleString('en-US', {
                timeZone,
                hour: 'numeric',
                minute: '2-digit',
                timeZoneName: 'short',
              })}
            />
          ) : null}
          {news ? (
            <StatusItem
              label="News checked"
              ok={news.ok}
              value={new Date(news.at).toLocaleString('en-US', {
                timeZone,
                hour: 'numeric',
                minute: '2-digit',
                timeZoneName: 'short',
              })}
            />
          ) : null}
          {posts.data && posts.error ? (
            <StatusItem label="Refresh failed" value={posts.error.message} ok={false} />
          ) : null}
        </>
      }
    />
  );
}

/** One row per symbol's next report (Robinhood calendar) with its last 8-K one-liner (SEC). */
type EarningsViewRow = EarningsRow & { key: string };
const earningsFields: ViewField<EarningsViewRow>[] = [
  {
    key: 'symbol',
    label: 'Symbol',
    icon: DollarSign,
    value: (e) => e.symbol,
    format: 'text',
    filterable: true,
  },
  {
    key: 'date',
    label: 'Report',
    icon: CalendarDays,
    value: (e) => e.date,
    format: 'text',
    filterable: true,
    groupable: true,
    render: (e) => (
      <span className="num whitespace-nowrap">
        {new Date(`${e.date}T12:00:00Z`).toLocaleDateString('en-US', {
          timeZone: 'UTC',
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        })}
      </span>
    ),
  },
  {
    key: 'timing',
    label: 'When',
    icon: Clock,
    value: (e) =>
      e.timing === 'am' ? 'Before open' : e.timing === 'pm' ? 'After close' : 'Not known',
    format: 'text',
    filterable: true,
    groupable: true,
  },
  {
    key: 'confirmed',
    label: 'Confirmed',
    icon: CircleCheck,
    value: (e) => (e.verified ? 'Confirmed' : 'Expected'),
    format: 'text',
    filterable: true,
    groupable: true,
  },
  {
    key: 'eps_estimate',
    label: 'EPS est',
    icon: Hash,
    value: (e) => e.eps_estimate,
    format: 'price',
    filterable: true,
    note: 'Robinhood',
  },
  {
    key: 'last',
    label: 'Last result',
    icon: MessageSquareText,
    value: (e) => e.last?.line ?? null,
    format: 'text',
    note: 'SEC 8-K, Workers AI',
    render: (e) =>
      e.last ? (
        <span className="line-clamp-2 block min-w-64 max-w-md whitespace-normal">
          {e.last.line}
        </span>
      ) : (
        <span className="text-muted-foreground">–</span>
      ),
  },
  {
    key: 'reported_at',
    label: 'Reported',
    icon: Clock,
    value: (e) => e.last?.at ?? null,
    format: 'text',
    render: (e) =>
      e.last ? <When iso={e.last.at} /> : <span className="text-muted-foreground">–</span>,
  },
  {
    key: 'url',
    label: 'Filing',
    icon: ExternalLink,
    value: (e) => e.last?.url ?? null,
    format: 'text',
    render: (e) =>
      e.last ? (
        <Button variant="ghost" size="icon-xs" asChild>
          <a
            href={e.last.url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open filing"
            title="Open filing"
            onClick={(ev) => ev.stopPropagation()}
          >
            <ArrowUpRight />
          </a>
        </Button>
      ) : null,
  },
];
const EARNINGS: ViewDomain<EarningsViewRow> = {
  id: 'earnings',
  rowKey: (e) => e.key,
  text: (e) => [e.symbol, e.last?.line ?? ''],
  fields: earningsFields,
};

function EarningsViewBody({ view }: { view: PostView }) {
  const { openSettings } = useShell();
  const { timeZone } = usePrefs();
  const q = useQuery(earningsQuery());
  const { key, ...frame } = useViewActions(view);
  const rows = (q.data?.rows ?? []).map((e) => ({ ...e, key: e.symbol }));
  return (
    <CustomViewPage
      key={key}
      {...frame}
      domain={EARNINGS}
      rows={rows}
      rowTitle={(e) => e.symbol}
      state={
        q.data && !q.data.connected ? (
          <div className="grid justify-items-start gap-3 rounded-lg border p-6">
            <p className="text-sm">
              Connect Robinhood in Settings ▸ Integrations to see when the symbols you hold or watch
              report, with the EPS estimate, and a one-line result from the SEC filing.
            </p>
            <Button size="sm" variant="outline" onClick={() => openSettings('integrations')}>
              <PlugIcon />
              Open Integrations
            </Button>
          </div>
        ) : q.data ? undefined : q.isError ? (
          <ErrorNote>{q.error.message}</ErrorNote>
        ) : (
          <Skeleton className="h-96 w-full" />
        )
      }
      status={
        q.data?.refreshed_at ? (
          <StatusItem
            label="Calendar"
            value={new Date(q.data.refreshed_at).toLocaleString('en-US', {
              timeZone,
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          />
        ) : null
      }
    />
  );
}

function PostViewFind({ domain, id }: { domain?: PostDomain; id: string }) {
  const app = domain
    ? undefined
    : (appView('posts', id) ?? appView('post_symbols', id) ?? appView('earnings', id));
  const views = useQuery({ ...postViewsQuery(), enabled: !app });
  const view = app
    ? ({ ...app, created_at: '', updated_at: '' } as PostView)
    : views.data?.find((v) => v.id === id && v.domain === domain);
  if (!view) {
    return (
      <Page crumbs={[{ label: 'Posts' }, { label: views.isPending ? '…' : 'Not found' }]}>
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
  return view.domain === 'earnings' ? (
    <EarningsViewBody view={view} />
  ) : (
    <PostViewBody view={view} domain={view.domain} />
  );
}

/** `/posts/$id`: an app view (Feed, By symbol, Macro). */
export function PostsAppViewPage() {
  const { id } = useParams({ from: '/posts/$id' });
  return <PostViewFind id={id} />;
}

/** `/posts/views/$domain/$id`: a person's own view of their posts. */
export function PostViewPage() {
  const { domain, id } = useParams({ from: '/posts/views/$domain/$id' });
  return <PostViewFind domain={domain as PostDomain} id={id} />;
}
