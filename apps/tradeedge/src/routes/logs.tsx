import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  type LogEntry,
  type LogView,
  deleteLogView,
  logViewPath,
  logViewsQuery,
  logsQuery,
  saveLogView,
} from '@/lib/api';
/**
 * Logs (Bikram, 2026-10-11): the person's own TradeEdge activity (SnapTrade, MCP, their changes,
 * backend failures), opened from the profile menu. The Logs app view is read-only; Duplicate copies
 * it into a view of the `logs` domain the person can change.
 */
import { ErrorNote } from '@/routes/chain';
import {
  type CustomViewConfig,
  CustomViewPage,
  Page,
  StatusItem,
  type ViewDomain,
  usePrefs,
} from '@edgedesk/app-shell';
import { appView } from '@edgedesk/types/views';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { CircleCheck, Clock, Copy, FileText, Tag, Timer, Zap } from 'lucide-react';

const CATEGORY: Record<LogEntry['category'], string> = {
  snaptrade: 'SnapTrade',
  mcp: 'MCP',
  user: 'User',
  backend: 'Backend',
  x: 'X',
  schedules: 'Schedules',
};

/** `Oct 11, 10:31:02` in the time zone the status bar shows. */
function When({ iso }: { iso: string }) {
  const { timeZone } = usePrefs();
  return (
    <span className="num whitespace-nowrap">
      {new Date(iso).toLocaleString('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })}
    </span>
  );
}

const LOGS: ViewDomain<LogEntry> = {
  id: 'logs',
  rowKey: (l) => l.id,
  text: (l) => [l.what, l.detail ?? ''],
  fields: [
    {
      key: 'at',
      label: 'Time',
      icon: Clock,
      value: (l) => l.at,
      format: 'text',
      render: (l) => <When iso={l.at} />,
    },
    {
      key: 'category',
      label: 'Category',
      icon: Tag,
      value: (l) => CATEGORY[l.category] ?? l.category,
      format: 'text',
      filterable: true,
      groupable: true,
    },
    {
      key: 'what',
      label: 'What',
      icon: Zap,
      value: (l) => l.what,
      format: 'text',
      filterable: true,
      groupable: true,
    },
    {
      key: 'outcome',
      label: 'Outcome',
      icon: CircleCheck,
      value: (l) => (l.ok ? 'OK' : 'Failed'),
      format: 'text',
      filterable: true,
      groupable: true,
      render: (l) => (
        <span className={l.ok ? 'text-gain' : 'text-loss'}>{l.ok ? '✓ OK' : '✗ Failed'}</span>
      ),
    },
    {
      key: 'ms',
      label: 'ms',
      icon: Timer,
      value: (l) => l.ms ?? null,
      format: 'integer',
    },
    {
      key: 'detail',
      label: 'Detail',
      icon: FileText,
      value: (l) => l.detail ?? null,
      format: 'text',
    },
  ],
};

function LogViewBody({ view }: { view: LogView }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logs = useQuery(logsQuery());
  const config: CustomViewConfig = { name: view.name, ...view.config };
  const listKey = logViewsQuery().queryKey;
  const save = useMutation({
    mutationFn: (c: CustomViewConfig) => saveLogView(c, view.id),
    onSuccess: (v) =>
      qc.setQueryData(listKey, (old: LogView[] | undefined) =>
        old?.map((o) => (o.id === v.id ? v : o)),
      ),
  });
  const copy = useMutation({
    mutationFn: () => saveLogView({ ...config, name: `${view.name} copy` }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: listKey });
      void navigate({ to: logViewPath(v) });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteLogView(view.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: listKey });
      void navigate({ to: '/logs' });
    },
  });
  const rows = logs.data ?? [];
  const failed = rows.filter((l) => !l.ok).length;
  return (
    <CustomViewPage
      key={`logs:${view.id}:${view.updated_at}`}
      viewId={view.app ? undefined : view.id}
      crumbs={[{ label: 'Logs' }, ...(view.app ? [] : [{ label: view.name }])]}
      domain={LOGS}
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
      rowTitle={(l) => `${CATEGORY[l.category] ?? l.category} · ${l.what}`}
      state={
        logs.data ? undefined : logs.isError ? (
          <ErrorNote>{logs.error.message}</ErrorNote>
        ) : (
          <Skeleton className="h-96 w-full" />
        )
      }
      status={
        <>
          <StatusItem label="Kept" value="30 days" />
          <StatusItem label="Failed" value={failed} ok={failed === 0} />
          {logs.data && logs.error ? (
            <StatusItem label="Refresh failed" value={logs.error.message} ok={false} />
          ) : null}
        </>
      }
    />
  );
}

function LogViewById({ id }: { id: string }) {
  const app = appView('logs', id);
  const views = useQuery({ ...logViewsQuery(), enabled: !app });
  const view = app
    ? ({ ...app, domain: 'logs', created_at: '', updated_at: '' } as LogView)
    : views.data?.find((v) => v.id === id);
  if (!view) {
    return (
      <Page crumbs={[{ label: 'Logs' }, { label: views.isPending ? '…' : 'Not found' }]}>
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
  return <LogViewBody view={view} />;
}

/** `/logs`: the Logs app view. */
export function LogsPage() {
  return <LogViewById id="logs" />;
}

/** `/logs/views/$id`: a person's own view of their logs. */
export function LogViewPage() {
  const { id } = useParams({ from: '/logs/views/$id' });
  return <LogViewById id={id} />;
}
