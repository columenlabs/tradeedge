import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  type Post,
  type PostDomain,
  type PostView,
  THEMES,
  deletePostView,
  integrationsQuery,
  postViewPath,
  postViewsQuery,
  postsQuery,
  savePostView,
} from '@/lib/api';
/**
 * Posts (Bikram, 2026-10-12): what the X accounts the person tracks post, tagged with symbols, a
 * macro theme and sentiment. Three app views (Feed, By symbol, Macro), read-only; Duplicate copies
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
  AtSign,
  Clock,
  Copy,
  DollarSign,
  ExternalLink,
  Gauge,
  Globe,
  Hash,
  MessageSquareText,
  Percent,
  PlugIcon,
  Smile,
  User,
} from 'lucide-react';

type Row = Post & { key: string; symbol?: string };

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
    key: 'handle',
    label: 'Account',
    icon: AtSign,
    value: (p) => `@${p.handle}`,
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
      <a href={p.url} target="_blank" rel="noreferrer" className="underline">
        Open
      </a>
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
  note: 'Workers AI',
};
const symbolField: ViewField<Row> = {
  key: 'symbol',
  label: 'Symbol',
  icon: DollarSign,
  value: (p) => p.symbol ?? null,
  format: 'text',
  filterable: true,
  groupable: true,
  note: 'Workers AI',
};

const DOMAINS: Record<PostDomain, ViewDomain<Row>> = {
  posts: {
    id: 'posts',
    rowKey: (p) => p.key,
    text: (p) => [p.text, p.name],
    fields: [...fields.slice(0, 4), symbolsField, ...fields.slice(4)],
  },
  post_symbols: {
    id: 'post_symbols',
    rowKey: (p) => p.key,
    text: (p) => [p.text, p.name],
    fields: [symbolField, ...fields],
  },
};

/** One row per post, or one per post and symbol it names. */
const rowsOf = (posts: Post[], domain: PostDomain): Row[] =>
  domain === 'posts'
    ? posts.map((p) => ({ ...p, key: p.id }))
    : posts.flatMap((p) => p.symbols.map((symbol) => ({ ...p, symbol, key: `${p.id}:${symbol}` })));

function PostViewBody({ view }: { view: PostView }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { openSettings } = useShell();
  const { timeZone } = usePrefs();
  const posts = useQuery(postsQuery());
  const x = useQuery(integrationsQuery(false)).data?.x;
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
  const rows = x && !x.connected ? [] : rowsOf(posts.data?.posts ?? [], view.domain);
  const check = x?.connected ? x.last_check : null;
  const notConnected = x && !x.connected;
  return (
    <CustomViewPage
      key={`posts:${view.domain}:${view.id}:${view.updated_at}`}
      viewId={view.app ? undefined : view.id}
      crumbs={[{ label: 'Posts' }, { label: view.name }]}
      domain={DOMAINS[view.domain]}
      config={config}
      rows={rows}
      onConfigChange={view.app ? undefined : (c) => save.mutate(c)}
      onDuplicate={view.app ? undefined : () => copy.mutate()}
      onDelete={view.app ? undefined : () => remove.mutate()}
      actions={
        view.app && (
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
        )
      }
      rowTitle={(p) => `@${p.handle}${p.symbol ? ` · ${p.symbol}` : ''}`}
      state={
        notConnected ? (
          <div className="grid justify-items-start gap-3 rounded-lg border p-6">
            <p className="text-sm">
              Connect X to see posts from the accounts you track: your own twitterapi.io key, in
              Settings ▸ Integrations.
            </p>
            <Button size="sm" variant="outline" onClick={() => openSettings('integrations')}>
              <PlugIcon />
              Connect X
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
              label="Checked"
              ok={check.ok}
              value={new Date(check.at).toLocaleString('en-US', {
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

function PostViewFind({ domain, id }: { domain?: PostDomain; id: string }) {
  const app = domain ? undefined : (appView('posts', id) ?? appView('post_symbols', id));
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
  return <PostViewBody view={view} />;
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
