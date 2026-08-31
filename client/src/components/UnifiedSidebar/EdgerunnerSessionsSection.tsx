import { memo, useCallback, useMemo } from 'react';
import { CheckCircle2, LoaderCircle, Plus, RefreshCw, TerminalSquare } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Skeleton, Spinner, useMediaQuery } from '@librechat/client';
import type { EdgerunnerSession } from 'librechat-data-provider';
import { getEdgerunnerSessions, useEdgerunnerSessionsQuery } from '~/data-provider';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import { useAuthContext, useLocalize } from '~/hooks';
import { cn } from '~/utils';

const formatTimestamp = (value: number | string | undefined): string => {
  if (value == null || value === '') {
    return '';
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(String(value));
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
};

const repoDisplayName = (repoUrl?: string): string => {
  if (!repoUrl) {
    return '';
  }
  const cleaned = repoUrl.replace(/\.git$/, '');
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  return parts.slice(-2).join('/') || repoUrl;
};

const sessionTitle = (session: EdgerunnerSession): string =>
  session.title || repoDisplayName(session.repo_url) || session.id;

const sessionStatusIcon = (status?: string) => {
  if (status === 'running' || status === 'dispatched') {
    return <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />;
  }
  if (status === 'completed') {
    return <CheckCircle2 className="size-4" aria-hidden="true" />;
  }
  return <TerminalSquare className="size-4" aria-hidden="true" />;
};

function AgentSessionRow({
  session,
  selected,
  onSelect,
}: {
  session: EdgerunnerSession;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'group flex w-full min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 text-left outline-none transition-colors',
        'hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-primary',
        selected && 'bg-surface-active-alt',
      )}
      onClick={onSelect}
    >
      <span className="mt-0.5 shrink-0 text-text-secondary">
        {sessionStatusIcon(session.status)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">
          {sessionTitle(session)}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-text-tertiary">
          <span className="truncate">
            {repoDisplayName(session.repo_url) || session.status || session.id}
          </span>
          <span className="shrink-0 tabular-nums">
            {formatTimestamp(session.updated_at ?? session.created_at)}
          </span>
        </span>
      </span>
    </button>
  );
}

function EdgerunnerSessionsSection() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const { setSidebarOpen } = useSidebarToggle();
  const { isAuthenticated } = useAuthContext();
  const sessionsQuery = useEdgerunnerSessionsQuery({
    enabled: isAuthenticated,
  });
  const sessions = useMemo(() => getEdgerunnerSessions(sessionsQuery.data), [sessionsQuery.data]);

  const navigateAndMaybeClose = useCallback(
    (path: string) => {
      if (isSmallScreen) {
        setSidebarOpen(false, () => navigate(path));
        return;
      }
      navigate(path);
    },
    [isSmallScreen, navigate, setSidebarOpen],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden pb-3 pt-2"
      role="region"
      aria-label={localize('com_edgerunner_sessions')}
    >
      <div className="flex h-8 items-center gap-1 px-3">
        <div className="min-w-0 flex-1 truncate text-xs font-bold text-text-secondary">
          {localize('com_edgerunner_sessions')}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={localize('com_edgerunner_new_session')}
          className="size-7 rounded-lg"
          onClick={() => navigateAndMaybeClose('/edgerunner')}
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={localize('com_ui_refresh')}
          className="size-7 rounded-lg"
          onClick={() => void sessionsQuery.refetch()}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3">
        {sessionsQuery.isLoading ? (
          <div className="space-y-2 pt-2" aria-hidden="true">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : null}
        {!sessionsQuery.isLoading && sessionsQuery.isError ? (
          <div className="px-2 py-4 text-sm text-text-secondary">
            {localize('com_edgerunner_unavailable')}
          </div>
        ) : null}
        {!sessionsQuery.isLoading && !sessionsQuery.isError && sessions.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center px-2 text-center text-sm text-text-secondary">
            {localize('com_edgerunner_no_sessions')}
          </div>
        ) : null}
        {!sessionsQuery.isLoading && !sessionsQuery.isError && sessions.length > 0 ? (
          <div className="space-y-1 pt-1">
            {sessions.map((session) => (
              <AgentSessionRow
                key={session.id}
                session={session}
                selected={session.id === sessionId}
                onSelect={() =>
                  navigateAndMaybeClose(`/edgerunner/${encodeURIComponent(session.id)}`)
                }
              />
            ))}
            {sessionsQuery.isFetching ? (
              <div className="flex items-center justify-center gap-2 py-2 text-xs text-text-tertiary">
                <Spinner className="size-3" />
                {localize('com_ui_loading')}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default memo(EdgerunnerSessionsSection);
