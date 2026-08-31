import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Box,
  CheckCircle2,
  Circle,
  GitBranch,
  LoaderCircle,
  Lock,
  MessageSquare,
  OctagonX,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import {
  Alert,
  Button,
  Select,
  SelectItem,
  SelectValue,
  SelectContent,
  SelectTrigger,
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
  EdgerunnerProfile,
  EdgerunnerSession,
  EdgerunnerArtifact,
  EdgerunnerRepository,
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
  useEdgerunnerRepositoriesQuery,
  useCreateEdgerunnerSessionMutation,
} from '~/data-provider';
import { useDocumentTitle, useLocalize } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { cn } from '~/utils';
import type { FormEvent } from 'react';

type DraftState = {
  repo: string;
  ref: string;
  profileId: string;
  prompt: string;
};

type TranscriptItem = {
  key: string;
  role: 'user' | 'agent' | 'tool' | 'system';
  title: string;
  body?: string;
  timestamp?: string;
  raw?: EdgerunnerJson;
};

const DEFAULT_REPO_VALUE = '__manual__';
const DEFAULT_PROFILE_VALUE = '__default__';

const emptyDraft: DraftState = {
  repo: '',
  ref: '',
  profileId: '',
  prompt: '',
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

const repoDisplayName = (repoUrl?: string): string => {
  if (!repoUrl) {
    return '';
  }
  const cleaned = repoUrl.replace(/\.git$/, '');
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  return parts.slice(-2).join('/') || repoUrl;
};

const shortSessionTitle = (session: EdgerunnerSession): string =>
  session.title || repoDisplayName(session.repo_url) || session.id;

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

const eventRole = (event: EdgerunnerEvent): TranscriptItem['role'] => {
  const kind = String(event.kind ?? '').toLowerCase();
  if (kind.includes('user') || kind === 'message') {
    return 'user';
  }
  if (kind.includes('tool') || kind.includes('call') || kind.includes('bash')) {
    return 'tool';
  }
  if (kind.includes('system') || kind.includes('status')) {
    return 'system';
  }
  return 'agent';
};

const eventTitle = (event: EdgerunnerEvent): string => {
  const kind = String(event.kind || 'Agent update');
  return kind
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
};

const eventBody = (event: EdgerunnerEvent): string | undefined => {
  if (typeof event.message === 'string' && event.message.trim()) {
    return event.message.trim();
  }
  const data = event.data ?? event.output ?? event.delta ?? event.text;
  return typeof data === 'string' && data.trim() ? data.trim() : undefined;
};

const transcriptFromEvents = (events: EdgerunnerEvent[], session: EdgerunnerSession) => {
  const transcript: TranscriptItem[] = [];
  if (session.prompt) {
    transcript.push({
      key: `${session.id}-prompt`,
      role: 'user',
      title: 'Request',
      body: String(session.prompt),
      timestamp: formatTimestamp(session.created_at),
    });
  }

  for (const [index, event] of events.entries()) {
    transcript.push({
      key: `${event.id ?? 'event'}-${index}`,
      role: eventRole(event),
      title: eventTitle(event),
      body: eventBody(event),
      timestamp: formatTimestamp(event.created_at ?? event.ts),
      raw: event,
    });
  }

  return transcript;
};

const profileLabel = (profiles: EdgerunnerProfile[], profileId: string): string => {
  if (!profileId) {
    return profiles[0]?.label || 'Default';
  }
  return profiles.find((profile) => profile.id === profileId)?.label || 'Default';
};

const sessionStatusIcon = (status?: string) => {
  if (status === 'running') {
    return <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />;
  }
  if (status === 'completed') {
    return <CheckCircle2 className="size-4" aria-hidden="true" />;
  }
  return <TerminalSquare className="size-4" aria-hidden="true" />;
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

function SidebarSessions({
  sessions,
  selectedId,
  loading,
  unavailable,
  onSelect,
  onNew,
  onRefresh,
}: {
  sessions: EdgerunnerSession[];
  selectedId?: string;
  loading: boolean;
  unavailable: boolean;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onRefresh: () => void;
}) {
  const localize = useLocalize();

  return (
    <aside className="flex min-h-0 w-full flex-col border-b border-border-light bg-surface-secondary md:w-80 md:border-b-0 md:border-r">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border-light px-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text-primary">
            {localize('com_edgerunner_sessions')}
          </div>
          <div className="text-xs text-text-tertiary">
            {localize('com_edgerunner_recent_sessions', { count: sessions.length })}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={localize('com_edgerunner_new_session')}
            onClick={onNew}
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={localize('com_ui_refresh')}
            onClick={onRefresh}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="space-y-2 p-3" aria-hidden="true">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : null}
        {!loading && unavailable ? (
          <div className="p-3">
            <Alert variant="warning">{localize('com_edgerunner_unavailable')}</Alert>
          </div>
        ) : null}
        {!loading && !unavailable && sessions.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center px-4 text-center text-sm text-text-secondary">
            {localize('com_edgerunner_no_sessions')}
          </div>
        ) : null}
        {!loading && !unavailable && sessions.length > 0 ? (
          <div className="p-2">
            {sessions.map((session) => {
              const selected = session.id === selectedId;
              return (
                <button
                  key={session.id}
                  type="button"
                  className={cn(
                    'flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2.5 text-left transition-colors',
                    'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-primary',
                    selected && 'bg-surface-active-alt',
                  )}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(session.id)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <TerminalSquare
                      className="size-4 shrink-0 text-text-secondary"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                      {shortSessionTitle(session)}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate text-xs text-text-secondary">
                      {repoDisplayName(session.repo_url) || session.id}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-text-tertiary">
                      {formatTimestamp(session.updated_at ?? session.created_at)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function RepoSelect({
  repos,
  value,
  disabled,
  onChange,
}: {
  repos: EdgerunnerRepository[];
  value: string;
  disabled?: boolean;
  onChange: (repoUrl: string) => void;
}) {
  const localize = useLocalize();
  const normalizedValue = value || DEFAULT_REPO_VALUE;

  return (
    <Select
      value={normalizedValue}
      onValueChange={(next) => onChange(next === DEFAULT_REPO_VALUE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 min-w-0 flex-1 border-border-light bg-surface-primary text-xs shadow-none sm:max-w-[280px]">
        <SelectValue placeholder={localize('com_edgerunner_repo_select')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_REPO_VALUE}>{localize('com_edgerunner_repo_manual')}</SelectItem>
        {repos.map((repo) => (
          <SelectItem
            key={repo.id}
            value={repo.ssh_url || repo.clone_url || repo.html_url || repo.full_name}
          >
            <span className="flex min-w-0 items-center gap-2">
              {repo.private ? <Lock className="size-3.5" aria-hidden="true" /> : null}
              <span className="truncate">{repo.full_name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ProfileSelect({
  profiles,
  value,
  disabled,
  onChange,
}: {
  profiles: EdgerunnerProfile[];
  value: string;
  disabled?: boolean;
  onChange: (profileId: string) => void;
}) {
  const localize = useLocalize();
  const normalizedValue = value || profiles[0]?.id || DEFAULT_PROFILE_VALUE;

  return (
    <Select
      value={normalizedValue}
      onValueChange={(next) => onChange(next === DEFAULT_PROFILE_VALUE ? '' : next)}
      disabled={disabled || profiles.length === 0}
    >
      <SelectTrigger className="h-8 min-w-0 flex-1 border-border-light bg-surface-primary text-xs shadow-none sm:max-w-[220px]">
        <SelectValue placeholder={localize('com_edgerunner_profile_select')} />
      </SelectTrigger>
      <SelectContent>
        {profiles.length === 0 ? (
          <SelectItem value={DEFAULT_PROFILE_VALUE}>
            {localize('com_edgerunner_profile_default')}
          </SelectItem>
        ) : null}
        {profiles.map((profile) => (
          <SelectItem key={profile.id} value={profile.id}>
            {profile.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NewSessionComposer({
  profiles,
  repositories,
  repositoriesLoading,
  repositoriesConfigured,
  onCreated,
}: {
  profiles: EdgerunnerProfile[];
  repositories: EdgerunnerRepository[];
  repositoriesLoading: boolean;
  repositoriesConfigured: boolean;
  onCreated: (sessionId: string) => void;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const createSession = useCreateEdgerunnerSessionMutation();
  const [draft, setDraft] = useState<DraftState>(() => ({
    ...emptyDraft,
    profileId: profiles[0]?.id || '',
  }));

  useEffect(() => {
    if (!draft.profileId && profiles[0]?.id) {
      setDraft((current) => ({ ...current, profileId: profiles[0].id }));
    }
  }, [draft.profileId, profiles]);

  const selectedRepo = repositories.find((repo) =>
    [repo.ssh_url, repo.clone_url, repo.html_url, repo.full_name].includes(draft.repo),
  );

  const updateDraft = (field: keyof DraftState, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const prompt = draft.prompt.trim();
    if (!prompt) {
      return;
    }

    const ref = draft.ref.trim() || selectedRepo?.default_branch || '';
    const payload: EdgerunnerCreateSessionRequest = {
      prompt,
      auto_start: true,
      ...(draft.profileId ? { profile_id: draft.profileId } : {}),
      ...(draft.repo.trim() ? { repo_url: draft.repo.trim() } : {}),
      ...(ref ? { ref } : {}),
    };

    createSession.mutate(payload, {
      onSuccess: (session) => {
        setDraft((current) => ({ ...current, prompt: '' }));
        onCreated(session.id);
        showToast({ status: 'success', message: localize('com_edgerunner_session_created') });
      },
      onError: () => {
        showToast({ status: 'error', message: localize('com_edgerunner_session_create_error') });
      },
    });
  };

  return (
    <form className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-4" onSubmit={submit}>
      <div className="rounded-2xl border border-border-light bg-surface-primary shadow-sm">
        <Textarea
          value={draft.prompt}
          rows={4}
          className="min-h-28 resize-none border-0 bg-transparent p-4 text-base shadow-none focus-visible:ring-0"
          onChange={(event) => updateDraft('prompt', event.target.value)}
          placeholder={localize('com_edgerunner_prompt_placeholder')}
        />
        <div className="flex flex-col gap-2 border-t border-border-light px-3 py-2 sm:flex-row sm:items-center">
          {repositories.length > 0 ? (
            <RepoSelect
              repos={repositories}
              value={draft.repo}
              disabled={repositoriesLoading || createSession.isLoading}
              onChange={(repoUrl) => updateDraft('repo', repoUrl)}
            />
          ) : (
            <input
              value={draft.repo}
              onChange={(event) => updateDraft('repo', event.target.value)}
              placeholder="git@github.com:FuturePresentLabs/repo.git"
              className="h-8 min-w-0 flex-1 rounded-md border border-border-light bg-transparent px-3 text-xs text-text-primary outline-none focus:ring-2 focus:ring-text-primary"
            />
          )}
          <input
            value={draft.ref}
            onChange={(event) => updateDraft('ref', event.target.value)}
            placeholder={selectedRepo?.default_branch || 'main'}
            className="h-8 w-full rounded-md border border-border-light bg-transparent px-3 text-xs text-text-primary outline-none focus:ring-2 focus:ring-text-primary sm:w-28"
            aria-label={localize('com_edgerunner_ref_label')}
          />
          <ProfileSelect
            profiles={profiles}
            value={draft.profileId}
            disabled={createSession.isLoading}
            onChange={(profileId) => updateDraft('profileId', profileId)}
          />
          <Button
            type="submit"
            size="icon"
            disabled={createSession.isLoading || !draft.prompt.trim()}
            aria-label={localize('com_edgerunner_start_session')}
            className="h-8 w-full shrink-0 sm:w-8"
          >
            {createSession.isLoading ? (
              <Spinner className="size-4" />
            ) : (
              <Send className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
      {!repositoriesConfigured ? (
        <p className="px-2 text-xs text-text-tertiary">
          {localize('com_edgerunner_repo_credentials_missing')}
        </p>
      ) : null}
    </form>
  );
}

function MessageComposer({ sessionId }: { sessionId: string }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [message, setMessage] = useState('');
  const action = useEdgerunnerActionMutation();

  const submit = (event: FormEvent) => {
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
            start_run: true,
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
    <form className="mx-auto w-full max-w-3xl px-4 pb-4" onSubmit={submit}>
      <div className="flex items-end gap-2 rounded-2xl border border-border-light bg-surface-primary p-2 shadow-sm">
        <Textarea
          value={message}
          rows={1}
          className="max-h-40 min-h-10 resize-none border-0 bg-transparent px-2 py-2 text-sm shadow-none focus-visible:ring-0"
          onChange={(event) => setMessage(event.target.value)}
          placeholder={localize('com_edgerunner_message_placeholder')}
        />
        <Button
          type="submit"
          size="icon"
          disabled={action.isLoading || !message.trim()}
          aria-label={localize('com_edgerunner_send')}
          className="size-9 shrink-0"
        >
          {action.isLoading ? <Spinner className="size-4" /> : <Send className="size-4" />}
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
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={action.isLoading}
        aria-label={localize('com_edgerunner_approve')}
        onClick={() => sendControl('approve')}
      >
        <ShieldCheck className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={action.isLoading}
        aria-label={localize('com_edgerunner_resume')}
        onClick={() => sendControl('resume')}
      >
        <Play className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={action.isLoading}
        aria-label={localize('com_edgerunner_suspend')}
        onClick={() => sendControl('suspend')}
      >
        <Pause className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={action.isLoading}
        aria-label={localize('com_ui_cancel')}
        className="hover:text-text-destructive"
        onClick={() => sendControl('cancel')}
      >
        <OctagonX className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

function TranscriptIcon({ role }: { role: TranscriptItem['role'] }) {
  if (role === 'user') {
    return <MessageSquare className="size-4" aria-hidden="true" />;
  }
  if (role === 'tool') {
    return <TerminalSquare className="size-4" aria-hidden="true" />;
  }
  if (role === 'system') {
    return <Circle className="size-4" aria-hidden="true" />;
  }
  return <Bot className="size-4" aria-hidden="true" />;
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  const isUser = item.role === 'user';
  return (
    <article
      className={cn('group mx-auto flex w-full max-w-3xl gap-3 px-4 py-3', isUser && 'justify-end')}
    >
      {!isUser ? (
        <div className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-md border border-border-light bg-surface-secondary text-text-secondary">
          <TranscriptIcon role={item.role} />
        </div>
      ) : null}
      <div
        className={cn(
          'min-w-0 rounded-xl px-3 py-2 text-sm',
          isUser
            ? 'max-w-[85%] bg-surface-active-alt text-text-primary'
            : 'flex-1 border border-border-light bg-surface-primary text-text-primary',
        )}
      >
        <div className="mb-1 flex min-w-0 items-center justify-between gap-3">
          <span className="truncate text-xs font-medium text-text-secondary">{item.title}</span>
          {item.timestamp ? (
            <span className="shrink-0 text-xs tabular-nums text-text-tertiary">
              {item.timestamp}
            </span>
          ) : null}
        </div>
        {item.body ? <p className="whitespace-pre-wrap leading-6">{item.body}</p> : null}
      </div>
    </article>
  );
}

function EmptyChat({ profiles }: { profiles: EdgerunnerProfile[] }) {
  const localize = useLocalize();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-4 py-10">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg border border-border-light bg-surface-secondary text-text-secondary">
          <TerminalSquare className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-text-primary">
            {localize('com_edgerunner_title')}
          </h1>
          <p className="text-sm text-text-secondary">{localize('com_edgerunner_empty_prompt')}</p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {profiles.slice(0, 3).map((profile) => (
          <div
            key={profile.id}
            className="rounded-lg border border-border-light bg-surface-primary p-3"
          >
            <div className="text-sm font-medium text-text-primary">{profile.label}</div>
            {profile.description ? (
              <div className="mt-1 text-xs text-text-secondary">{profile.description}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function EventsTranscript({
  transcript,
  loading,
  profiles,
}: {
  transcript: TranscriptItem[];
  loading: boolean;
  profiles: EdgerunnerProfile[];
}) {
  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6" aria-hidden="true">
        <Skeleton className="h-14 w-2/3" />
        <Skeleton className="ml-auto h-20 w-3/4" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (transcript.length === 0) {
    return <EmptyChat profiles={profiles} />;
  }

  return (
    <div className="py-4">
      {transcript.map((item) => (
        <TranscriptRow key={item.key} item={item} />
      ))}
    </div>
  );
}

function Inspector({
  events,
  lines,
  artifacts,
}: {
  events: EdgerunnerEvent[];
  lines: string[];
  artifacts: EdgerunnerArtifact[];
}) {
  const localize = useLocalize();

  return (
    <aside className="hidden w-80 shrink-0 border-l border-border-light bg-surface-secondary lg:flex lg:flex-col">
      <Tabs defaultValue="events" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="m-3 grid grid-cols-3 bg-surface-tertiary">
          <TabsTrigger value="events" className="min-w-0 text-xs">
            {localize('com_edgerunner_events')}
          </TabsTrigger>
          <TabsTrigger value="logs" className="min-w-0 text-xs">
            {localize('com_edgerunner_logs')}
          </TabsTrigger>
          <TabsTrigger value="artifacts" className="min-w-0 text-xs">
            {localize('com_edgerunner_artifacts')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="events" className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          {events.length === 0 ? (
            <div className="p-4 text-sm text-text-secondary">
              {localize('com_edgerunner_no_events')}
            </div>
          ) : (
            <div className="space-y-2">
              {events
                .slice()
                .reverse()
                .map((event, index) => (
                  <pre
                    key={`${event.id ?? 'event'}-${index}`}
                    className="max-h-56 overflow-auto rounded-lg border border-border-light bg-surface-primary p-3 text-xs text-text-secondary"
                  >
                    {JSON.stringify(event, null, 2)}
                  </pre>
                ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="logs" className="min-h-0 flex-1 overflow-auto">
          {lines.length === 0 ? (
            <div className="p-4 text-sm text-text-secondary">
              {localize('com_edgerunner_no_logs')}
            </div>
          ) : (
            <pre className="min-h-full bg-surface-primary p-3 font-mono text-xs leading-relaxed text-text-primary">
              {lines.join('\n')}
            </pre>
          )}
        </TabsContent>
        <TabsContent value="artifacts" className="min-h-0 flex-1 overflow-auto px-3 pb-3">
          {artifacts.length === 0 ? (
            <div className="p-4 text-sm text-text-secondary">
              {localize('com_edgerunner_no_artifacts')}
            </div>
          ) : (
            <div className="space-y-2">
              {artifacts.map((artifact, index) => (
                <article
                  key={`${artifact.name ?? 'artifact'}-${index}`}
                  className="rounded-lg border border-border-light bg-surface-primary p-3"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Box className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                      {artifact.name || localize('com_edgerunner_artifact')}
                    </span>
                  </div>
                  <pre className="mt-2 max-h-56 overflow-auto text-xs text-text-secondary">
                    {jsonPreview(artifact.data)}
                  </pre>
                </article>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function ChatHeader({
  session,
  profile,
  onRefresh,
}: {
  session?: EdgerunnerSession;
  profile: string;
  onRefresh: () => void;
}) {
  const localize = useLocalize();
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-light bg-surface-primary px-3 md:px-4">
      <div className="flex min-w-0 items-center gap-3">
        <OpenSidebar className="md:hidden" />
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-secondary text-text-secondary">
          {sessionStatusIcon(session?.status)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text-primary">
            {session ? shortSessionTitle(session) : localize('com_edgerunner_title')}
          </div>
          <div className="flex min-w-0 items-center gap-2 text-xs text-text-tertiary">
            {session ? <StateBadge status={session.status} /> : null}
            <span className="truncate">{profile}</span>
            {session?.repo_url ? (
              <>
                <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{repoDisplayName(session.repo_url)}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {session ? <SessionControls sessionId={session.id} /> : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={localize('com_ui_refresh')}
          onClick={onRefresh}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}

function SessionWorkspace({
  sessionId,
  profiles,
  repositories,
  repositoriesLoading,
  repositoriesConfigured,
  onCreated,
  onRefreshSessions,
}: {
  sessionId?: string;
  profiles: EdgerunnerProfile[];
  repositories: EdgerunnerRepository[];
  repositoriesLoading: boolean;
  repositoriesConfigured: boolean;
  onCreated: (sessionId: string) => void;
  onRefreshSessions: () => void;
}) {
  const localize = useLocalize();
  const sessionQuery = useEdgerunnerSessionQuery(sessionId);
  const eventsQuery = useEdgerunnerEventsQuery(sessionId);
  const logsQuery = useEdgerunnerLogsQuery(sessionId);
  const artifactsQuery = useEdgerunnerArtifactsQuery(sessionId);
  useEdgerunnerEventStream(sessionId, Boolean(sessionId));

  const events = useMemo(() => getEdgerunnerEvents(eventsQuery.data), [eventsQuery.data]);
  const session = sessionQuery.data;
  const transcript = useMemo(
    () => (session ? transcriptFromEvents(events, session) : []),
    [events, session],
  );
  const logLines = logsQuery.data?.lines ?? [];
  const artifacts = Array.isArray(artifactsQuery.data)
    ? artifactsQuery.data
    : (artifactsQuery.data?.items ?? artifactsQuery.data?.data ?? []);

  const refetchAll = () => {
    onRefreshSessions();
    if (!sessionId) {
      return;
    }
    void sessionQuery.refetch();
    void eventsQuery.refetch();
    void logsQuery.refetch();
    void artifactsQuery.refetch();
  };

  if (sessionId && !sessionQuery.isLoading && !session) {
    return (
      <main className="flex min-w-0 flex-1 flex-col bg-surface-primary">
        <ChatHeader profile={profileLabel(profiles, '')} onRefresh={refetchAll} />
        <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-text-secondary">
          {localize('com_edgerunner_session_not_found')}
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-w-0 flex-1 bg-surface-primary">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          session={session}
          profile={profileLabel(
            profiles,
            String(session?.labels?.['fpl.edgerunner.profile'] ?? ''),
          )}
          onRefresh={refetchAll}
        />
        <div className="min-h-0 flex-1 overflow-auto bg-surface-primary">
          {session ? (
            <EventsTranscript
              transcript={transcript}
              loading={sessionQuery.isLoading || eventsQuery.isLoading}
              profiles={profiles}
            />
          ) : (
            <EmptyChat profiles={profiles} />
          )}
        </div>
        {sessionId ? (
          <MessageComposer sessionId={sessionId} />
        ) : (
          <NewSessionComposer
            profiles={profiles}
            repositories={repositories}
            repositoriesLoading={repositoriesLoading}
            repositoriesConfigured={repositoriesConfigured}
            onCreated={onCreated}
          />
        )}
      </div>
      {session ? <Inspector events={events} lines={logLines} artifacts={artifacts} /> : null}
    </main>
  );
}

export default function EdgerunnerView() {
  const localize = useLocalize();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const configQuery = useEdgerunnerConfigQuery();
  const enabled = configQuery.data?.enabled === true;
  const healthQuery = useEdgerunnerHealthQuery({ enabled });
  const sessionsQuery = useEdgerunnerSessionsQuery({ enabled });
  const repositoriesQuery = useEdgerunnerRepositoriesQuery({ enabled });
  const sessions = useMemo(() => getEdgerunnerSessions(sessionsQuery.data), [sessionsQuery.data]);
  const profiles = configQuery.data?.profiles ?? [];
  const repositories = repositoriesQuery.data?.repositories ?? [];
  const repositoriesConfigured = repositoriesQuery.data?.credentialPresent !== false;
  useDocumentTitle(localize('com_edgerunner_title'));

  useEffect(() => {
    if (selectedSessionId || sessions.length === 0 || isSmallScreen) {
      return;
    }
    setSelectedSessionId(sessions[0].id);
  }, [isSmallScreen, selectedSessionId, sessions]);

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-surface-primary text-text-primary md:flex-row">
      <SidebarSessions
        sessions={sessions}
        selectedId={selectedSessionId}
        loading={configQuery.isLoading || sessionsQuery.isLoading}
        unavailable={enabled === false || healthQuery.isError || sessionsQuery.isError}
        onSelect={setSelectedSessionId}
        onNew={() => setSelectedSessionId(undefined)}
        onRefresh={() => {
          void configQuery.refetch();
          void healthQuery.refetch();
          void sessionsQuery.refetch();
          void repositoriesQuery.refetch();
        }}
      />
      <SessionWorkspace
        sessionId={selectedSessionId}
        profiles={profiles}
        repositories={repositories}
        repositoriesLoading={repositoriesQuery.isLoading}
        repositoriesConfigured={repositoriesConfigured}
        onCreated={setSelectedSessionId}
        onRefreshSessions={() => {
          void sessionsQuery.refetch();
        }}
      />
    </div>
  );
}
