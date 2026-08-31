import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Box,
  GitBranch,
  OctagonX,
  Pause,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Skeleton,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useMediaQuery,
  useToastContext,
} from '@librechat/client';
import type {
  EdgerunnerEvent,
  EdgerunnerJson,
  EdgerunnerSession,
  EdgerunnerArtifact,
  EdgerunnerCreateSessionRequest,
} from 'librechat-data-provider';
import {
  getEdgerunnerEvents,
  getEdgerunnerSessions,
  useEdgerunnerLogsQuery,
  useEdgerunnerConfigQuery,
  useEdgerunnerActionMutation,
  useEdgerunnerEventsQuery,
  useEdgerunnerHealthQuery,
  useEdgerunnerSessionQuery,
  useEdgerunnerEventStream,
  useEdgerunnerSessionsQuery,
  useEdgerunnerArtifactsQuery,
  useCreateEdgerunnerSessionMutation,
} from '~/data-provider';
import { useDocumentTitle, useLocalize } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { cn } from '~/utils';

type SessionFormState = {
  title: string;
  repoUrl: string;
  ref: string;
  prompt: string;
  model: string;
  agent: string;
  validate: string;
  autoStart: boolean;
};

const emptySessionForm: SessionFormState = {
  title: '',
  repoUrl: '',
  ref: '',
  prompt: '',
  model: '',
  agent: '',
  validate: '',
  autoStart: true,
};

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

const jsonPreview = (value: EdgerunnerJson | undefined): string => {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
};

const statusTone = (status?: string) => {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'running' || normalized === 'dispatched') {
    return 'border-status-info-border bg-status-info-subtle text-status-info';
  }
  if (normalized === 'completed' || normalized === 'waiting') {
    return 'border-status-success-border bg-status-success-subtle text-status-success';
  }
  if (normalized === 'failed' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'border-status-error-border bg-status-error-subtle text-status-error';
  }
  return 'border-border-light bg-surface-tertiary text-text-secondary';
};

const toCreatePayload = (form: SessionFormState): EdgerunnerCreateSessionRequest => {
  const run =
    form.validate.trim() || form.model.trim() || form.agent.trim()
      ? {
          ...(form.validate.trim() ? { validate: form.validate.trim() } : {}),
          ...(form.model.trim() ? { model: form.model.trim() } : {}),
          ...(form.agent.trim() ? { agent: form.agent.trim() } : {}),
          retention: 'snapshot',
        }
      : undefined;

  return {
    ...(form.title.trim() ? { title: form.title.trim() } : {}),
    ...(form.repoUrl.trim() ? { repo_url: form.repoUrl.trim() } : {}),
    ...(form.ref.trim() ? { ref: form.ref.trim() } : {}),
    ...(form.prompt.trim() ? { prompt: form.prompt.trim() } : {}),
    ...(form.model.trim() ? { model: form.model.trim() } : {}),
    ...(form.agent.trim() ? { agent: form.agent.trim() } : {}),
    auto_start: form.autoStart,
    ...(run ? { run } : {}),
  };
};

function StateBadge({ status }: { status?: string }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-md border px-2 py-1 text-xs font-medium capitalize',
        statusTone(status),
      )}
    >
      <span className="truncate">{status || 'unknown'}</span>
    </span>
  );
}

function SectionPanel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn('min-w-0 rounded-lg border border-border-light bg-surface-primary', className)}
    >
      <div className="border-b border-border-light px-4 py-3">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function SessionList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: EdgerunnerSession[];
  selectedId?: string;
  onSelect: (sessionId: string) => void;
}) {
  const localize = useLocalize();

  if (sessions.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center px-4 text-center text-sm text-text-secondary">
        {localize('com_edgerunner_no_sessions')}
      </div>
    );
  }

  return (
    <div className="divide-y divide-border-light">
      {sessions.map((session) => {
        const createdAt = formatTimestamp(session.created_at);
        const selected = session.id === selectedId;
        return (
          <button
            key={session.id}
            type="button"
            className={cn(
              'flex w-full min-w-0 flex-col gap-2 px-4 py-3 text-left transition-colors',
              'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-primary',
              selected && 'bg-surface-active-alt',
            )}
            aria-current={selected ? 'true' : undefined}
            onClick={() => onSelect(session.id)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <TerminalSquare className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                {session.title || session.id}
              </span>
            </span>
            <span className="flex min-w-0 items-center justify-between gap-3">
              <StateBadge status={session.status} />
              {createdAt ? (
                <span className="truncate text-xs tabular-nums text-text-tertiary">
                  {createdAt}
                </span>
              ) : null}
            </span>
            {session.repo_url ? (
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
                <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{session.repo_url}</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function CreateSessionPanel({ onCreated }: { onCreated: (sessionId: string) => void }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [form, setForm] = useState<SessionFormState>(emptySessionForm);
  const createSession = useCreateEdgerunnerSessionMutation();

  const updateField = (field: keyof SessionFormState, value: string | boolean) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    createSession.mutate(toCreatePayload(form), {
      onSuccess: (session) => {
        setForm(emptySessionForm);
        onCreated(session.id);
        showToast({ status: 'success', message: localize('com_edgerunner_session_created') });
      },
      onError: () => {
        showToast({ status: 'error', message: localize('com_edgerunner_session_create_error') });
      },
    });
  };

  return (
    <SectionPanel title={localize('com_edgerunner_new_session')}>
      <form className="space-y-3 p-4" onSubmit={submit}>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-text-secondary">
            {localize('com_edgerunner_title_label')}
          </span>
          <Input
            value={form.title}
            onChange={(event) => updateField('title', event.target.value)}
            placeholder={localize('com_edgerunner_title_placeholder')}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-text-secondary">
            {localize('com_edgerunner_repo_label')}
          </span>
          <Input
            value={form.repoUrl}
            onChange={(event) => updateField('repoUrl', event.target.value)}
            placeholder="git@github.com:FuturePresentLabs/repo.git"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-secondary">
              {localize('com_edgerunner_ref_label')}
            </span>
            <Input
              value={form.ref}
              onChange={(event) => updateField('ref', event.target.value)}
              placeholder="main"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-secondary">
              {localize('com_edgerunner_validate_label')}
            </span>
            <Input
              value={form.validate}
              onChange={(event) => updateField('validate', event.target.value)}
              placeholder="npm test"
            />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-secondary">
              {localize('com_edgerunner_model_label')}
            </span>
            <Input
              value={form.model}
              onChange={(event) => updateField('model', event.target.value)}
              placeholder="fpl/llm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-secondary">
              {localize('com_edgerunner_agent_label')}
            </span>
            <Input
              value={form.agent}
              onChange={(event) => updateField('agent', event.target.value)}
              placeholder="codex"
            />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-text-secondary">
            {localize('com_edgerunner_prompt_label')}
          </span>
          <Textarea
            value={form.prompt}
            rows={4}
            onChange={(event) => updateField('prompt', event.target.value)}
            placeholder={localize('com_edgerunner_prompt_placeholder')}
          />
        </label>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <Checkbox
              aria-label={localize('com_edgerunner_auto_start')}
              checked={form.autoStart}
              onCheckedChange={(checked) => updateField('autoStart', checked === true)}
            />
            <span>{localize('com_edgerunner_auto_start')}</span>
          </label>
          <Button type="submit" disabled={createSession.isLoading} className="shrink-0">
            {createSession.isLoading ? <Spinner className="size-4" /> : <Play className="size-4" />}
            {localize('com_edgerunner_start_session')}
          </Button>
        </div>
      </form>
    </SectionPanel>
  );
}

function SessionHeader({
  session,
  onRefresh,
}: {
  session: EdgerunnerSession;
  onRefresh: () => void;
}) {
  const localize = useLocalize();
  const createdAt = formatTimestamp(session.created_at);
  return (
    <div className="flex flex-col gap-4 border-b border-border-light p-4 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <TerminalSquare className="size-5 shrink-0 text-text-secondary" aria-hidden="true" />
          <h1 className="truncate text-xl font-semibold text-text-primary">
            {session.title || session.id}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
          <StateBadge status={session.status} />
          {session.run_id ? <span className="font-mono">{session.run_id}</span> : null}
          {createdAt ? <span>{createdAt}</span> : null}
        </div>
        {session.repo_url ? (
          <p className="mt-3 flex min-w-0 items-center gap-1.5 text-sm text-text-secondary">
            <GitBranch className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{session.repo_url}</span>
            {session.ref ? <span className="shrink-0">#{session.ref}</span> : null}
          </p>
        ) : null}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
        <RefreshCw className="size-4" aria-hidden="true" />
        {localize('com_ui_refresh')}
      </Button>
    </div>
  );
}

function MessageComposer({ sessionId }: { sessionId: string }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [message, setMessage] = useState('');
  const [startRun, setStartRun] = useState(false);
  const action = useEdgerunnerActionMutation();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const content = message.trim();
    if (!content) {
      return;
    }
    action.mutate(
      {
        sessionId,
        action: {
          type: 'message',
          message: {
            content,
            start_run: startRun,
          },
        },
      },
      {
        onSuccess: () => {
          setMessage('');
          showToast({ status: 'success', message: localize('com_edgerunner_message_sent') });
        },
        onError: () => {
          showToast({ status: 'error', message: localize('com_edgerunner_action_error') });
        },
      },
    );
  };

  return (
    <form className="space-y-3 border-t border-border-light p-4" onSubmit={submit}>
      <label className="block">
        <span className="sr-only">{localize('com_edgerunner_message_label')}</span>
        <Textarea
          value={message}
          rows={3}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={localize('com_edgerunner_message_placeholder')}
        />
      </label>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <Checkbox
            aria-label={localize('com_edgerunner_start_run')}
            checked={startRun}
            onCheckedChange={(checked) => setStartRun(checked === true)}
          />
          <span>{localize('com_edgerunner_start_run')}</span>
        </label>
        <Button type="submit" disabled={action.isLoading || !message.trim()} className="shrink-0">
          {action.isLoading ? <Spinner className="size-4" /> : <Send className="size-4" />}
          {localize('com_edgerunner_send')}
        </Button>
      </div>
    </form>
  );
}

function SessionControls({ sessionId }: { sessionId: string }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const action = useEdgerunnerActionMutation();

  const sendControl = useCallback(
    (type: 'approve' | 'cancel' | 'suspend' | 'resume') => {
      action.mutate(
        {
          sessionId,
          action:
            type === 'cancel' || type === 'suspend' ? { type, reason: 'user_request' } : { type },
        },
        {
          onSuccess: () => {
            showToast({ status: 'success', message: localize('com_edgerunner_action_sent') });
          },
          onError: () => {
            showToast({ status: 'error', message: localize('com_edgerunner_action_error') });
          },
        },
      );
    },
    [action, localize, sessionId, showToast],
  );

  return (
    <div className="flex flex-wrap gap-2 p-4">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={action.isLoading}
        onClick={() => sendControl('approve')}
      >
        <ShieldCheck className="size-4" aria-hidden="true" />
        {localize('com_edgerunner_approve')}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={action.isLoading}
        onClick={() => sendControl('resume')}
      >
        <Play className="size-4" aria-hidden="true" />
        {localize('com_edgerunner_resume')}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={action.isLoading}
        onClick={() => sendControl('suspend')}
      >
        <Pause className="size-4" aria-hidden="true" />
        {localize('com_edgerunner_suspend')}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={action.isLoading}
        className="hover:text-text-destructive"
        onClick={() => sendControl('cancel')}
      >
        <OctagonX className="size-4" aria-hidden="true" />
        {localize('com_ui_cancel')}
      </Button>
    </div>
  );
}

function EventsPanel({ events }: { events: EdgerunnerEvent[] }) {
  const localize = useLocalize();
  if (events.length === 0) {
    return (
      <div className="flex min-h-64 items-center justify-center p-6 text-center text-sm text-text-secondary">
        {localize('com_edgerunner_no_events')}
      </div>
    );
  }

  return (
    <div className="divide-y divide-border-light">
      {events
        .slice()
        .reverse()
        .map((event, index) => {
          const timestamp = formatTimestamp(event.created_at ?? event.ts);
          return (
            <article key={`${event.id ?? 'event'}-${index}`} className="px-4 py-3">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="truncate text-sm font-medium text-text-primary">
                  {event.kind || localize('com_edgerunner_event')}
                </span>
                {timestamp ? (
                  <span className="shrink-0 text-xs tabular-nums text-text-tertiary">
                    {timestamp}
                  </span>
                ) : null}
              </div>
              {event.message ? (
                <p className="mt-1 text-sm text-text-secondary">{event.message}</p>
              ) : null}
              <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-surface-secondary p-3 text-xs text-text-secondary">
                {JSON.stringify(event, null, 2)}
              </pre>
            </article>
          );
        })}
    </div>
  );
}

function LogsPanel({ lines }: { lines: string[] }) {
  const localize = useLocalize();
  if (lines.length === 0) {
    return (
      <div className="flex min-h-64 items-center justify-center p-6 text-center text-sm text-text-secondary">
        {localize('com_edgerunner_no_logs')}
      </div>
    );
  }

  return (
    <pre className="min-h-64 overflow-auto bg-surface-secondary p-4 font-mono text-xs leading-relaxed text-text-primary">
      {lines.join('\n')}
    </pre>
  );
}

function ArtifactsPanel({ artifacts }: { artifacts: EdgerunnerArtifact[] }) {
  const localize = useLocalize();
  if (artifacts.length === 0) {
    return (
      <div className="flex min-h-64 items-center justify-center p-6 text-center text-sm text-text-secondary">
        {localize('com_edgerunner_no_artifacts')}
      </div>
    );
  }

  return (
    <div className="divide-y divide-border-light">
      {artifacts.map((artifact, index) => (
        <article key={`${artifact.name ?? 'artifact'}-${index}`} className="px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Box className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
              {artifact.name || localize('com_edgerunner_artifact')}
            </span>
            {artifact.kind ? <StateBadge status={artifact.kind} /> : null}
          </div>
          <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-surface-secondary p-3 text-xs text-text-secondary">
            {jsonPreview(artifact.data)}
          </pre>
        </article>
      ))}
    </div>
  );
}

function DetailEmptyState() {
  const localize = useLocalize();
  return (
    <SectionPanel title={localize('com_edgerunner_session')}>
      <div className="flex min-h-[28rem] flex-col items-center justify-center gap-3 p-8 text-center">
        <TerminalSquare className="size-10 text-text-tertiary" aria-hidden="true" />
        <p className="text-sm text-text-secondary">{localize('com_edgerunner_select_session')}</p>
      </div>
    </SectionPanel>
  );
}

function SessionsPanelContent({
  loading,
  unavailable,
  sessions,
  selectedSessionId,
  onSelect,
}: {
  loading: boolean;
  unavailable: boolean;
  sessions: EdgerunnerSession[];
  selectedSessionId?: string;
  onSelect: (sessionId: string) => void;
}) {
  const localize = useLocalize();

  if (loading) {
    return (
      <div className="space-y-3 p-4" aria-hidden="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="p-4">
        <Alert variant="warning">{localize('com_edgerunner_unavailable')}</Alert>
      </div>
    );
  }

  return <SessionList sessions={sessions} selectedId={selectedSessionId} onSelect={onSelect} />;
}

function SessionDetail({ sessionId }: { sessionId: string }) {
  const localize = useLocalize();
  const sessionQuery = useEdgerunnerSessionQuery(sessionId);
  const eventsQuery = useEdgerunnerEventsQuery(sessionId);
  const logsQuery = useEdgerunnerLogsQuery(sessionId);
  const artifactsQuery = useEdgerunnerArtifactsQuery(sessionId);
  useEdgerunnerEventStream(sessionId, true);

  const refetchAll = () => {
    void sessionQuery.refetch();
    void eventsQuery.refetch();
    void logsQuery.refetch();
    void artifactsQuery.refetch();
  };

  const events = useMemo(() => getEdgerunnerEvents(eventsQuery.data), [eventsQuery.data]);
  const logLines = logsQuery.data?.lines ?? [];
  const artifacts = Array.isArray(artifactsQuery.data)
    ? artifactsQuery.data
    : (artifactsQuery.data?.items ?? artifactsQuery.data?.data ?? []);

  if (sessionQuery.isLoading) {
    return (
      <SectionPanel title={localize('com_edgerunner_session')}>
        <div className="space-y-4 p-4" aria-hidden="true">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-80 w-full" />
        </div>
      </SectionPanel>
    );
  }

  if (!sessionQuery.data) {
    return (
      <SectionPanel title={localize('com_edgerunner_session')}>
        <div className="flex min-h-[28rem] items-center justify-center p-8 text-center text-sm text-text-secondary">
          {localize('com_edgerunner_session_not_found')}
        </div>
      </SectionPanel>
    );
  }

  return (
    <SectionPanel title={localize('com_edgerunner_session')} className="overflow-hidden">
      <SessionHeader session={sessionQuery.data} onRefresh={refetchAll} />
      <SessionControls sessionId={sessionId} />
      <Tabs defaultValue="events" className="px-4 pb-4">
        <TabsList className="mt-1 grid w-full grid-cols-3 bg-surface-secondary">
          <TabsTrigger value="events" className="min-w-0">
            {localize('com_edgerunner_events')}
          </TabsTrigger>
          <TabsTrigger value="logs" className="min-w-0">
            {localize('com_edgerunner_logs')}
          </TabsTrigger>
          <TabsTrigger value="artifacts" className="min-w-0">
            {localize('com_edgerunner_artifacts')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="events" className="mt-3 rounded-lg border border-border-light p-0">
          <EventsPanel events={events} />
        </TabsContent>
        <TabsContent value="logs" className="mt-3 rounded-lg border border-border-light p-0">
          <LogsPanel lines={logLines} />
        </TabsContent>
        <TabsContent value="artifacts" className="mt-3 rounded-lg border border-border-light p-0">
          <ArtifactsPanel artifacts={artifacts} />
        </TabsContent>
      </Tabs>
      <MessageComposer sessionId={sessionId} />
    </SectionPanel>
  );
}

export default function EdgerunnerView() {
  const localize = useLocalize();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const configQuery = useEdgerunnerConfigQuery();
  const healthQuery = useEdgerunnerHealthQuery({ enabled: configQuery.data?.enabled === true });
  const sessionsQuery = useEdgerunnerSessionsQuery({ enabled: configQuery.data?.enabled === true });
  const sessions = useMemo(() => getEdgerunnerSessions(sessionsQuery.data), [sessionsQuery.data]);
  useDocumentTitle(localize('com_edgerunner_title'));

  useEffect(() => {
    if (selectedSessionId || sessions.length === 0) {
      return;
    }
    setSelectedSessionId(sessions[0].id);
  }, [selectedSessionId, sessions]);

  const refresh = () => {
    void configQuery.refetch();
    void healthQuery.refetch();
    void sessionsQuery.refetch();
  };

  const healthLabel =
    healthQuery.data?.ok === true
      ? localize('com_edgerunner_online')
      : localize('com_edgerunner_status_unknown');

  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-presentation text-text-primary">
      <header className="shrink-0 border-b border-border-light bg-presentation">
        <div className="flex min-h-14 items-center gap-3 px-4 md:min-h-16 md:px-6">
          {isSmallScreen ? <OpenSidebar className="size-9 shrink-0" /> : null}
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-secondary text-text-primary">
            <Bot className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-text-primary">
              {localize('com_edgerunner_title')}
            </h1>
            <p className="truncate text-xs text-text-secondary">
              {localize('com_edgerunner_subtitle')}
            </p>
          </div>
          <span
            className={cn(
              'hidden rounded-md border px-2 py-1 text-xs font-medium sm:inline-flex',
              healthQuery.data?.ok === true
                ? 'border-status-success-border bg-status-success-subtle text-status-success'
                : 'border-border-light bg-surface-tertiary text-text-secondary',
            )}
          >
            {healthLabel}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="size-4" aria-hidden="true" />
            {localize('com_ui_refresh')}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-4 md:grid-cols-[23rem_minmax(0,1fr)] md:px-6 md:py-6">
          <div className="min-w-0 space-y-4">
            <CreateSessionPanel onCreated={setSelectedSessionId} />
            <SectionPanel title={localize('com_edgerunner_sessions')}>
              <SessionsPanelContent
                sessions={sessions}
                selectedSessionId={selectedSessionId}
                onSelect={setSelectedSessionId}
                loading={configQuery.isLoading || sessionsQuery.isLoading}
                unavailable={configQuery.isError || configQuery.data?.enabled !== true}
              />
            </SectionPanel>
          </div>
          <div className="min-w-0">
            {selectedSessionId ? (
              <SessionDetail sessionId={selectedSessionId} />
            ) : (
              <DetailEmptyState />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
