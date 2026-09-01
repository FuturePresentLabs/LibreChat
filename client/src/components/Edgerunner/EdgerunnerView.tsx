import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  ChevronDown,
  CheckCircle2,
  GitBranch,
  LoaderCircle,
  Lock,
  OctagonX,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import {
  Button,
  ControlCombobox,
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
  TextareaAutosize,
  SendIcon,
  useToastContext,
  TooltipAnchor,
} from '@librechat/client';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  TMessage,
  EdgerunnerEvent,
  EdgerunnerJson,
  EdgerunnerJsonObject,
  EdgerunnerProfile,
  EdgerunnerSession,
  EdgerunnerArtifact,
  EdgerunnerBranch,
  EdgerunnerRepository,
  EdgerunnerTranscriptMessage,
  EdgerunnerCreateSessionRequest,
} from 'librechat-data-provider';
import {
  getEdgerunnerEvents,
  getEdgerunnerMessages,
  getEdgerunnerSessions,
  useEdgerunnerLogsQuery,
  useEdgerunnerConfigQuery,
  useEdgerunnerActionMutation,
  useEdgerunnerEventsQuery,
  useEdgerunnerHealthQuery,
  useEdgerunnerSessionQuery,
  useEdgerunnerEventStream,
  useEdgerunnerMessagesQuery,
  useEdgerunnerSessionsQuery,
  useEdgerunnerBranchesQuery,
  useEdgerunnerArtifactsQuery,
  useEdgerunnerRepositoriesQuery,
  useCreateEdgerunnerSessionMutation,
} from '~/data-provider';
import { useDebounce, useDocumentTitle, useLocalize } from '~/hooks';
import MessageContent from '~/components/Chat/Messages/Content/MessageContent';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import MessageRow from '~/components/Chat/Messages/ui/MessageRow';
import { messageFooterClasses } from '~/components/Chat/Messages/styles';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import SubRow from '~/components/Chat/Messages/SubRow';
import { MessageContext } from '~/Providers';
import { mainTextareaId, type OptionWithIcon, type TAskFunction } from '~/common';
import { cn, removeFocusRings } from '~/utils';
import type { FormEvent, ReactNode } from 'react';

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
const NEW_SESSION_VALUE = '__new_session__';

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

const messageTimestamp = (value: number | string | undefined): string | undefined => {
  if (value == null || value === '') {
    return undefined;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(String(value));
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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

const repoSegments = (repo?: Pick<EdgerunnerRepository, 'owner' | 'name' | 'full_name'> | null) => {
  const owner = repo?.owner?.trim();
  const name = repo?.name?.trim();
  if (owner && name) {
    return { owner, repo: name };
  }

  const [fullOwner, fullName] = String(repo?.full_name ?? '').split('/');
  return fullOwner && fullName ? { owner: fullOwner, repo: fullName } : undefined;
};

const repoLaunchValue = (repo: EdgerunnerRepository): string =>
  repo.ssh_url || repo.clone_url || repo.html_url || repo.full_name;

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

const isJsonObject = (value: EdgerunnerJson | undefined): value is EdgerunnerJsonObject =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const stringValue = (value: EdgerunnerJson | undefined): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const firstString = (...values: Array<EdgerunnerJson | undefined>): string | undefined => {
  for (const value of values) {
    const next = stringValue(value);
    if (next) {
      return next;
    }
  }
  return undefined;
};

const transcriptRole = (value: EdgerunnerJson | undefined): TranscriptItem['role'] | undefined => {
  const role = stringValue(value)?.toLowerCase();
  if (role === 'user' || role === 'system' || role === 'tool') {
    return role;
  }
  if (role === 'assistant' || role === 'agent') {
    return 'agent';
  }
  return undefined;
};

const eventPayload = (event: EdgerunnerEvent): EdgerunnerJsonObject | undefined => {
  const data = isJsonObject(event.data) ? event.data : undefined;
  const report = isJsonObject(data?.report) ? data.report : undefined;
  return report ?? data;
};

const nestedMessagePayload = (
  payload: EdgerunnerJsonObject | undefined,
): EdgerunnerJsonObject | undefined => {
  return isJsonObject(payload?.message) ? payload.message : undefined;
};

const roleTitle = (role: TranscriptItem['role']): string => {
  if (role === 'user') {
    return 'User';
  }
  if (role === 'tool') {
    return 'Tool';
  }
  if (role === 'system') {
    return 'System';
  }
  return 'Assistant';
};

const eventRole = (event: EdgerunnerEvent): TranscriptItem['role'] => {
  const kind = String(event.kind ?? '').toLowerCase();
  const payload = eventPayload(event);
  const message = nestedMessagePayload(payload);
  const role = transcriptRole(event.role ?? payload?.role ?? message?.role);
  if (role) {
    return role;
  }
  if (kind.includes('tool') || kind.includes('call') || kind.includes('bash')) {
    return 'tool';
  }
  if (kind.includes('user') || kind === 'message') {
    return 'user';
  }
  if (kind.includes('stdout') || kind.includes('stderr') || kind === 'log') {
    return 'tool';
  }
  if (kind.includes('system') || kind.includes('status')) {
    return 'system';
  }
  return 'agent';
};

const eventTitle = (event: EdgerunnerEvent): string => {
  const kind = String(event.kind || 'Agent update');
  const payload = eventPayload(event);
  const toolName = firstString(
    payload?.tool_name,
    payload?.tool,
    payload?.name,
    payload?.command,
    payload?.action,
  );
  if (toolName && eventRole(event) === 'tool') {
    return toolName;
  }
  if (kind === 'agent_progress' && firstString(payload?.content)) {
    return 'Assistant';
  }
  if (kind === 'message') {
    return eventRole(event) === 'user' ? 'User' : 'Assistant';
  }
  return kind
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
};

const eventBody = (event: EdgerunnerEvent): string | undefined => {
  const payload = eventPayload(event);
  const message = nestedMessagePayload(payload);
  const body = firstString(
    payload?.content,
    payload?.question,
    message?.content,
    event.output,
    event.delta,
    event.text,
  );
  if (body) {
    return body;
  }
  if (typeof event.message === 'string' && event.message.trim()) {
    return event.message.trim();
  }
  return undefined;
};

const transcriptFromMessages = (
  messages: EdgerunnerTranscriptMessage[],
  session: EdgerunnerSession,
) => {
  const transcript: TranscriptItem[] = [];
  const firstUserMessage = messages.find((message) => transcriptRole(message.role) === 'user');
  if (session.prompt) {
    const prompt = String(session.prompt);
    if (!firstUserMessage || firstUserMessage.content !== prompt) {
      transcript.push({
        key: `${session.id}-prompt`,
        role: 'user',
        title: 'Request',
        body: prompt,
        timestamp: messageTimestamp(session.created_at),
      });
    }
  }

  for (const [index, message] of messages.entries()) {
    const role = transcriptRole(message.role) ?? 'agent';
    transcript.push({
      key: `${message.id ?? 'message'}-${index}`,
      role,
      title: roleTitle(role),
      body: message.content,
      timestamp: messageTimestamp(message.created_at),
      raw: message.data,
    });
  }

  return transcript;
};

const transcriptFromEvents = (events: EdgerunnerEvent[], session: EdgerunnerSession) =>
  transcriptFromMessages([], session).concat(
    events
      .filter((event) => String(event.kind ?? '').toLowerCase() !== 'agent_heartbeat')
      .map((event, index) => ({
        key: `${event.id ?? 'event'}-${index}`,
        role: eventRole(event),
        title: eventTitle(event),
        body: eventBody(event),
        timestamp: messageTimestamp(event.created_at ?? event.ts),
        raw: event,
      })),
  );

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

function SessionSelect({
  sessions,
  selectedId,
  loading,
  unavailable,
  onSelect,
  onNew,
}: {
  sessions: EdgerunnerSession[];
  selectedId?: string;
  loading: boolean;
  unavailable: boolean;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
}) {
  const localize = useLocalize();

  if (loading) {
    return <Skeleton className="h-9 w-32 sm:w-44" aria-hidden="true" />;
  }

  if (unavailable || sessions.length === 0) {
    return null;
  }

  return (
    <Select
      value={selectedId || NEW_SESSION_VALUE}
      onValueChange={(next) => {
        if (next === NEW_SESSION_VALUE) {
          onNew();
          return;
        }
        onSelect(next);
      }}
    >
      <SelectTrigger
        className="h-9 w-32 min-w-0 border-border-light bg-surface-primary text-xs shadow-none sm:w-52 lg:w-64"
        aria-label={localize('com_edgerunner_sessions')}
      >
        <SelectValue placeholder={localize('com_edgerunner_sessions')} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NEW_SESSION_VALUE}>{localize('com_edgerunner_new_session')}</SelectItem>
        {sessions.map((session) => (
          <SelectItem key={session.id} value={session.id}>
            <span className="flex min-w-0 flex-col py-1">
              <span className="truncate text-sm">{shortSessionTitle(session)}</span>
              <span className="truncate text-xs text-text-tertiary">
                {formatTimestamp(session.updated_at ?? session.created_at) ||
                  repoDisplayName(session.repo_url) ||
                  session.id}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RepoSelect({
  repos,
  value,
  disabled,
  onChange,
  onSearchChange,
}: {
  repos: EdgerunnerRepository[];
  value: string;
  disabled?: boolean;
  onChange: (repoUrl: string) => void;
  onSearchChange?: (value: string) => void;
}) {
  const localize = useLocalize();
  const selectedRepo = repos.find((repo) =>
    [repoLaunchValue(repo), repo.ssh_url, repo.clone_url, repo.html_url, repo.full_name].includes(
      value,
    ),
  );
  const items = useMemo<OptionWithIcon[]>(
    () => [
      {
        label: localize('com_edgerunner_repo_manual'),
        value: DEFAULT_REPO_VALUE,
        icon: <TerminalSquare className="size-4 text-text-secondary" aria-hidden="true" />,
      },
      ...repos.map((repo) => ({
        label: repo.full_name,
        value: repoLaunchValue(repo),
        icon: repo.private ? (
          <Lock className="size-4 text-text-secondary" aria-hidden="true" />
        ) : (
          <GitBranch className="size-4 text-text-secondary" aria-hidden="true" />
        ),
      })),
    ],
    [localize, repos],
  );

  return (
    <ControlCombobox
      selectedValue={selectedRepo ? repoLaunchValue(selectedRepo) : DEFAULT_REPO_VALUE}
      displayValue={selectedRepo?.full_name ?? ''}
      items={items}
      setValue={(next) => onChange(next === DEFAULT_REPO_VALUE ? '' : next)}
      onSearchChange={onSearchChange}
      disabled={disabled}
      ariaLabel={localize('com_edgerunner_repo_label')}
      searchPlaceholder={localize('com_edgerunner_repo_search')}
      selectPlaceholder={localize('com_edgerunner_repo_select')}
      isCollapsed={false}
      showCarat={true}
      matchTriggerWidth={false}
      placement="top-start"
      gutter={10}
      containerClassName="min-w-0 flex-1 px-0 sm:max-w-[280px]"
      className="h-8 min-w-0 rounded-md border-border-light bg-surface-primary px-3 text-xs shadow-none hover:bg-surface-hover"
      popoverClassName="animate-popover-bottom min-w-72 rounded-xl shadow-xl"
    />
  );
}

function BranchSelect({
  branches,
  value,
  placeholder,
  disabled,
  onChange,
  onSearchChange,
}: {
  branches: EdgerunnerBranch[];
  value: string;
  placeholder: string;
  disabled?: boolean;
  onChange: (ref: string) => void;
  onSearchChange?: (value: string) => void;
}) {
  const localize = useLocalize();
  const normalizedValue = value || placeholder || branches[0]?.name || '';
  const options = branches.some((branch) => branch.name === normalizedValue)
    ? branches
    : [{ name: normalizedValue }, ...branches];

  if (branches.length === 0 || !normalizedValue) {
    return (
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder || 'main'}
        className="h-8 w-full rounded-md border border-border-light bg-transparent px-3 text-xs text-text-primary outline-none focus:ring-2 focus:ring-text-primary sm:w-28"
        aria-label={localize('com_edgerunner_ref_label')}
        disabled={disabled}
      />
    );
  }
  const items = options.map<OptionWithIcon>((branch) => ({
    label: branch.name,
    value: branch.name,
    icon: <GitBranch className="size-4 text-text-secondary" aria-hidden="true" />,
  }));

  return (
    <ControlCombobox
      selectedValue={normalizedValue}
      displayValue={normalizedValue}
      items={items}
      setValue={onChange}
      onSearchChange={onSearchChange}
      disabled={disabled}
      ariaLabel={localize('com_edgerunner_ref_label')}
      searchPlaceholder={localize('com_edgerunner_branch_search')}
      selectPlaceholder={localize('com_edgerunner_branch_select')}
      isCollapsed={false}
      showCarat={true}
      matchTriggerWidth={false}
      placement="top-start"
      gutter={10}
      containerClassName="min-w-0 px-0 sm:w-36"
      className="h-8 min-w-0 rounded-md border-border-light bg-surface-primary px-3 text-xs shadow-none hover:bg-surface-hover"
      popoverClassName="animate-popover-bottom min-w-56 rounded-xl shadow-xl"
    />
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

function ComposerSubmitButton({
  disabled,
  loading,
  label,
}: {
  disabled: boolean;
  loading: boolean;
  label: string;
}) {
  return (
    <TooltipAnchor
      description={label}
      render={
        <button
          type="submit"
          disabled={disabled}
          aria-label={label}
          className="size-theme-control rounded-theme-control-round bg-text-primary p-theme-compact text-surface-primary outline-offset-4 transition-all duration-theme-normal disabled:cursor-not-allowed disabled:text-text-secondary disabled:opacity-10"
        >
          {loading ? <Spinner className="size-5" /> : <SendIcon size={24} />}
        </button>
      }
    />
  );
}

function EdgerunnerComposerShell({
  value,
  rows,
  loading,
  disabled,
  children,
  ariaLabel,
  placeholder,
  onChange,
  onSubmit,
}: {
  value: string;
  rows: number;
  loading: boolean;
  disabled?: boolean;
  children?: ReactNode;
  ariaLabel: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const [isFocused, setIsFocused] = useState(false);
  const canSubmit = !disabled && !loading && value.trim().length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) {
      onSubmit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className="mx-auto flex w-full max-w-3xl flex-row gap-3 px-4 pb-4 transition-[max-width] duration-300 sm:px-2 md:max-w-3xl xl:max-w-4xl"
    >
      <div
        className={cn(
          'relative flex w-full flex-grow flex-col overflow-hidden rounded-t-3xl border pb-4 text-text-primary transition-all duration-200 sm:rounded-3xl sm:pb-0',
          isFocused ? 'shadow-lg' : 'shadow-md',
          'border-border-light bg-surface-chat',
        )}
        onClick={() => {
          if (window.matchMedia?.('(pointer: coarse)').matches) {
            return;
          }
          document.getElementById(mainTextareaId)?.focus();
        }}
      >
        <div className="flex">
          <div className="relative flex-1">
            <TextareaAutosize
              id={mainTextareaId}
              value={value}
              rows={rows}
              maxRows={10}
              disabled={disabled || loading}
              aria-label={ariaLabel}
              placeholder={placeholder}
              data-testid="text-input"
              style={{ minHeight: rows > 1 ? 112 : 44, overflowY: 'auto' }}
              className={cn(
                'm-0 w-full resize-none bg-transparent px-5 py-[13px] placeholder:text-text-tertiary md:py-3.5',
                'scrollbar-hover max-h-[45vh] transition-[max-height] duration-200 disabled:cursor-not-allowed md:max-h-[55vh]',
                removeFocusRings,
              )}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (canSubmit) {
                    onSubmit();
                  }
                }
              }}
            />
          </div>
        </div>
        <div className="@container items-between flex gap-2 pb-2">
          <div className="ml-2 flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
          <div className="mx-auto flex" />
          <div className="mr-2">
            <ComposerSubmitButton disabled={!canSubmit} loading={loading} label={ariaLabel} />
          </div>
        </div>
      </div>
    </form>
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
  const [repoSearch, setRepoSearch] = useState('');
  const [branchSearch, setBranchSearch] = useState('');
  const debouncedRepoSearch = useDebounce(repoSearch.trim(), 250);
  const debouncedBranchSearch = useDebounce(branchSearch.trim(), 250);
  const [draft, setDraft] = useState<DraftState>(() => ({
    ...emptyDraft,
    profileId: profiles[0]?.id || '',
  }));
  const searchedRepositoriesQuery = useEdgerunnerRepositoriesQuery(debouncedRepoSearch, {
    enabled: repositoriesConfigured && debouncedRepoSearch.length > 0,
  });
  const visibleRepositories = useMemo(() => {
    const merged = new Map<string, EdgerunnerRepository>();
    for (const repo of repositories) {
      merged.set(repo.full_name || repo.id, repo);
    }
    for (const repo of searchedRepositoriesQuery.data?.repositories ?? []) {
      merged.set(repo.full_name || repo.id, repo);
    }
    return Array.from(merged.values());
  }, [repositories, searchedRepositoriesQuery.data?.repositories]);
  const repositoriesBusy = repositoriesLoading || searchedRepositoriesQuery.isFetching;

  useEffect(() => {
    if (!draft.profileId && profiles[0]?.id) {
      setDraft((current) => ({ ...current, profileId: profiles[0].id }));
    }
  }, [draft.profileId, profiles]);

  const selectedRepo = visibleRepositories.find((repo) =>
    [repoLaunchValue(repo), repo.ssh_url, repo.clone_url, repo.html_url, repo.full_name].includes(
      draft.repo,
    ),
  );
  const selectedRepoSegments = repoSegments(selectedRepo);
  const branchesQuery = useEdgerunnerBranchesQuery(
    selectedRepoSegments?.owner,
    selectedRepoSegments?.repo,
    debouncedBranchSearch || undefined,
    { enabled: Boolean(selectedRepoSegments) },
  );
  const branches = branchesQuery.data?.branches ?? [];

  const updateDraft = (field: keyof DraftState, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const updateRepo = (repoUrl: string) => {
    const repo = visibleRepositories.find((candidate) => repoLaunchValue(candidate) === repoUrl);
    setBranchSearch('');
    setDraft((current) => ({
      ...current,
      repo: repoUrl,
      ref: repo?.default_branch || '',
    }));
  };

  const submit = () => {
    const prompt = draft.prompt.trim();
    if (!prompt) {
      return;
    }

    const ref = draft.ref.trim() || selectedRepo?.default_branch || branches[0]?.name || '';
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
    <div>
      <EdgerunnerComposerShell
        value={draft.prompt}
        rows={4}
        loading={createSession.isLoading}
        ariaLabel={localize('com_edgerunner_start_session')}
        placeholder={localize('com_edgerunner_prompt_placeholder')}
        onChange={(value) => updateDraft('prompt', value)}
        onSubmit={submit}
      >
        {repositoriesConfigured ? (
          <RepoSelect
            repos={visibleRepositories}
            value={draft.repo}
            disabled={createSession.isLoading}
            onChange={updateRepo}
            onSearchChange={setRepoSearch}
          />
        ) : (
          <input
            value={draft.repo}
            onChange={(event) => updateDraft('repo', event.target.value)}
            placeholder="git@github.com:FuturePresentLabs/repo.git"
            className="h-8 min-w-0 flex-1 rounded-md border border-border-light bg-transparent px-3 text-xs text-text-primary outline-none focus:ring-2 focus:ring-text-primary sm:max-w-[280px]"
          />
        )}
        <BranchSelect
          branches={selectedRepo ? branches : []}
          value={draft.ref}
          placeholder={selectedRepo?.default_branch || 'main'}
          disabled={createSession.isLoading || branchesQuery.isLoading || repositoriesBusy}
          onChange={(ref) => updateDraft('ref', ref)}
          onSearchChange={setBranchSearch}
        />
        <ProfileSelect
          profiles={profiles}
          value={draft.profileId}
          disabled={createSession.isLoading}
          onChange={(profileId) => updateDraft('profileId', profileId)}
        />
      </EdgerunnerComposerShell>
      {!repositoriesConfigured ? (
        <p className="mx-auto -mt-2 w-full max-w-3xl px-4 pb-3 text-xs text-text-tertiary">
          {localize('com_edgerunner_repo_credentials_missing')}
        </p>
      ) : null}
    </div>
  );
}

function MessageComposer({ sessionId }: { sessionId: string }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [message, setMessage] = useState('');
  const action = useEdgerunnerActionMutation();

  const submit = () => {
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
    <EdgerunnerComposerShell
      value={message}
      rows={1}
      loading={action.isLoading}
      ariaLabel={localize('com_edgerunner_send')}
      placeholder={localize('com_edgerunner_message_placeholder')}
      onChange={setMessage}
      onSubmit={submit}
    />
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
    <div className="hidden shrink-0 items-center gap-1 md:flex">
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

const noopAsk: TAskFunction = () => false;

function TranscriptRow({
  item,
  conversationId,
  isLatestMessage,
  isSubmitting,
}: {
  item: TranscriptItem;
  conversationId: string;
  isLatestMessage: boolean;
  isSubmitting: boolean;
}) {
  const isUser = item.role === 'user';
  const message = useMemo<TMessage>(
    () => ({
      messageId: item.key,
      conversationId,
      parentMessageId: null,
      responseMessageId: null,
      text: item.body || item.title,
      title: item.title,
      sender: isUser ? 'User' : item.title,
      endpoint: isUser ? undefined : 'agents',
      model: isUser ? undefined : 'edgerunner',
      isCreatedByUser: isUser,
      createdAt: item.timestamp,
      updatedAt: item.timestamp,
      depth: 0,
      children: [],
    }),
    [conversationId, isUser, item.body, item.key, item.timestamp, item.title],
  );
  const messageContextValue = useMemo(
    () => ({
      messageId: item.key,
      isLatestMessage,
      isExpanded: false as const,
      isSubmitting,
      conversationId,
    }),
    [conversationId, isLatestMessage, isSubmitting, item.key],
  );

  return (
    <div className="w-full border-0 bg-transparent text-text-primary">
      <div className="m-auto justify-center px-4 py-3 sm:px-0">
        <MessageRow
          id={item.key}
          label={isUser ? 'User' : item.title}
          hoverLabel={isUser ? null : item.title}
          timestamp={item.timestamp}
          isCreatedByUser={isUser}
          icon={
            <MessageIcon
              iconData={{
                endpoint: 'agents',
                model: 'edgerunner',
                modelLabel: item.title,
                isCreatedByUser: false,
              }}
            />
          }
          footer={<SubRow classes={messageFooterClasses} />}
        >
          <MessageContext.Provider value={messageContextValue}>
            <MessageContent
              ask={noopAsk}
              edit={false}
              error={false}
              unfinished={false}
              isSubmitting={isSubmitting}
              isLast={isLatestMessage}
              text={message.text || ''}
              message={message}
              enterEdit={() => undefined}
              isCreatedByUser={isUser}
              siblingIdx={0}
              setSiblingIdx={() => undefined}
            />
          </MessageContext.Provider>
        </MessageRow>
      </div>
    </div>
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
  conversationId,
}: {
  transcript: TranscriptItem[];
  loading: boolean;
  profiles: EdgerunnerProfile[];
  conversationId: string;
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
      {transcript.map((item, index) => (
        <TranscriptRow
          key={item.key}
          item={item}
          conversationId={conversationId}
          isLatestMessage={index === transcript.length - 1}
          isSubmitting={loading && index === transcript.length - 1}
        />
      ))}
    </div>
  );
}

function LogsViewport({ lines }: { lines: string[] }) {
  const localize = useLocalize();

  if (lines.length === 0) {
    return (
      <div className="p-4 text-sm text-text-secondary">{localize('com_edgerunner_no_logs')}</div>
    );
  }

  return (
    <div className="h-full min-h-0 max-w-full overflow-auto overscroll-contain bg-surface-primary">
      <pre className="min-w-max whitespace-pre p-3 font-mono text-xs leading-relaxed text-text-primary">
        {lines.join('\n')}
      </pre>
    </div>
  );
}

function MobileLogsPanel({ lines }: { lines: string[] }) {
  const localize = useLocalize();

  return (
    <div className="shrink-0 border-t border-border-light bg-surface-secondary px-3 py-2 lg:hidden">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded-md px-2 py-2 text-sm font-medium text-text-primary hover:bg-surface-hover [&::-webkit-details-marker]:hidden">
          <span>{localize('com_edgerunner_logs')}</span>
          <ChevronDown
            className="size-4 shrink-0 text-text-secondary transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="h-56 min-h-0 pt-2">
          <LogsViewport lines={lines} />
        </div>
      </details>
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
        <TabsContent value="logs" className="min-h-0 flex-1 overflow-hidden px-3 pb-3">
          <LogsViewport lines={lines} />
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
  sessions,
  selectedSessionId,
  sessionsLoading,
  unavailable,
  profile,
  onSelectSession,
  onNewSession,
  onRefresh,
}: {
  session?: EdgerunnerSession;
  sessions: EdgerunnerSession[];
  selectedSessionId?: string;
  sessionsLoading: boolean;
  unavailable: boolean;
  profile: string;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
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
        <SessionSelect
          sessions={sessions}
          selectedId={selectedSessionId}
          loading={sessionsLoading}
          unavailable={unavailable}
          onSelect={onSelectSession}
          onNew={onNewSession}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={localize('com_edgerunner_new_session')}
          onClick={onNewSession}
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
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
  sessions,
  sessionsLoading,
  unavailable,
  profiles,
  repositories,
  repositoriesLoading,
  repositoriesConfigured,
  onSelectSession,
  onNewSession,
  onCreated,
  onRefreshSessions,
}: {
  sessionId?: string;
  sessions: EdgerunnerSession[];
  sessionsLoading: boolean;
  unavailable: boolean;
  profiles: EdgerunnerProfile[];
  repositories: EdgerunnerRepository[];
  repositoriesLoading: boolean;
  repositoriesConfigured: boolean;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onCreated: (sessionId: string) => void;
  onRefreshSessions: () => void;
}) {
  const localize = useLocalize();
  const sessionQuery = useEdgerunnerSessionQuery(sessionId);
  const messagesQuery = useEdgerunnerMessagesQuery(sessionId);
  const eventsQuery = useEdgerunnerEventsQuery(sessionId);
  const logsQuery = useEdgerunnerLogsQuery(sessionId);
  const artifactsQuery = useEdgerunnerArtifactsQuery(sessionId);
  useEdgerunnerEventStream(sessionId, Boolean(sessionId));

  const messages = useMemo(() => getEdgerunnerMessages(messagesQuery.data), [messagesQuery.data]);
  const events = useMemo(() => getEdgerunnerEvents(eventsQuery.data), [eventsQuery.data]);
  const session = sessionQuery.data;
  const transcript = useMemo(() => {
    if (!session) {
      return [];
    }
    return messages.length > 0
      ? transcriptFromMessages(messages, session)
      : transcriptFromEvents(events, session);
  }, [events, messages, session]);
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
    void messagesQuery.refetch();
    void eventsQuery.refetch();
    void logsQuery.refetch();
    void artifactsQuery.refetch();
  };

  if (sessionId && !sessionQuery.isLoading && !session) {
    return (
      <main className="flex min-w-0 flex-1 flex-col bg-surface-primary">
        <ChatHeader
          sessions={sessions}
          selectedSessionId={sessionId}
          sessionsLoading={sessionsLoading}
          unavailable={unavailable}
          profile={profileLabel(profiles, '')}
          onSelectSession={onSelectSession}
          onNewSession={onNewSession}
          onRefresh={refetchAll}
        />
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
          sessions={sessions}
          selectedSessionId={sessionId}
          sessionsLoading={sessionsLoading}
          unavailable={unavailable}
          profile={profileLabel(
            profiles,
            String(session?.labels?.['fpl.edgerunner.profile'] ?? ''),
          )}
          onSelectSession={onSelectSession}
          onNewSession={onNewSession}
          onRefresh={refetchAll}
        />
        <div className="min-h-0 flex-1 overflow-auto bg-surface-primary">
          {session ? (
            <EventsTranscript
              transcript={transcript}
              loading={sessionQuery.isLoading || messagesQuery.isLoading || eventsQuery.isLoading}
              profiles={profiles}
              conversationId={`edgerunner:${session.id}`}
            />
          ) : (
            <EmptyChat profiles={profiles} />
          )}
        </div>
        {session ? <MobileLogsPanel lines={logLines} /> : null}
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
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const selectedSessionId = sessionId;
  const configQuery = useEdgerunnerConfigQuery();
  const enabled = configQuery.data?.enabled === true;
  const healthQuery = useEdgerunnerHealthQuery({ enabled });
  const sessionsQuery = useEdgerunnerSessionsQuery({ enabled });
  const repositoriesQuery = useEdgerunnerRepositoriesQuery(undefined, { enabled });
  const sessions = useMemo(() => getEdgerunnerSessions(sessionsQuery.data), [sessionsQuery.data]);
  const profiles = configQuery.data?.profiles ?? [];
  const repositories = repositoriesQuery.data?.repositories ?? [];
  const repositoriesConfigured = repositoriesQuery.data?.credentialPresent !== false;
  useDocumentTitle(localize('com_edgerunner_title'));

  const selectSession = useCallback(
    (nextSessionId: string) => {
      navigate(`/edgerunner/${encodeURIComponent(nextSessionId)}`);
    },
    [navigate],
  );

  const startNewSession = useCallback(() => {
    navigate('/edgerunner');
  }, [navigate]);

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-surface-primary text-text-primary">
      <SessionWorkspace
        sessionId={selectedSessionId}
        sessions={sessions}
        sessionsLoading={configQuery.isLoading || sessionsQuery.isLoading}
        unavailable={enabled === false || healthQuery.isError || sessionsQuery.isError}
        profiles={profiles}
        repositories={repositories}
        repositoriesLoading={repositoriesQuery.isLoading}
        repositoriesConfigured={repositoriesConfigured}
        onSelectSession={selectSession}
        onNewSession={startNewSession}
        onCreated={selectSession}
        onRefreshSessions={() => {
          void configQuery.refetch();
          void healthQuery.refetch();
          void sessionsQuery.refetch();
          void repositoriesQuery.refetch();
        }}
      />
    </div>
  );
}
