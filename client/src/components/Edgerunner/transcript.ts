import type {
  EdgerunnerEvent,
  EdgerunnerJson,
  EdgerunnerJsonObject,
  EdgerunnerSession,
  EdgerunnerTranscriptMessage,
} from 'librechat-data-provider';

export type TranscriptItem = {
  key: string;
  role: 'user' | 'agent' | 'tool' | 'system';
  title: string;
  body?: string;
  timestamp?: string;
  raw?: EdgerunnerJson;
  kind?: 'message' | 'activity';
  tone?: 'neutral' | 'running' | 'success' | 'warning' | 'error';
  collapsed?: boolean;
  active?: boolean;
};

const ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESCAPE_CHARACTER}\\[[0-?]*[ -/]*[@-~]`, 'g');
const LITERAL_ANSI_ESCAPE_PATTERN = /\\u001b|\\x1b|\\e/gi;
const ORPHANED_ANSI_SGR_PATTERN = /\[(?:\d{1,3}(?:;\d{1,3})*)?m/g;
const BACKSPACE_CHARACTER = String.fromCharCode(8);
const CHECK_MARK_CODEPOINT = 10003;
const CROSS_MARK_CODEPOINT = 10007;
const FOUR_SPOKED_ASTERISK_CODEPOINT = 10033;

const noisyEventKinds = new Set(['agent_heartbeat', 'session_created']);
const toolEventFragments = ['tool', 'call', 'bash', 'stdout', 'stderr', 'log'];
const visibleActivityKinds = new Set([
  'files_changed',
  'run_started',
  'agent_started',
  'plan_ready',
  'pr_ready',
  'run_completed',
  'run_failed',
  'validation_started',
  'validation_passed',
  'validation_failed',
]);

export const normalizeTranscriptText = (value: string): string => {
  let normalized = value
    .replace(LITERAL_ANSI_ESCAPE_PATTERN, ESCAPE_CHARACTER)
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(ORPHANED_ANSI_SGR_PATTERN, '')
    .replace(/\r\n?/g, '\n');
  while (normalized.includes(BACKSPACE_CHARACTER)) {
    const next = normalized.replace(BACKSPACE_CHARACTER, '');
    if (next === normalized) {
      break;
    }
    normalized = next;
  }
  return normalized.replace(/[^\S\n]+$/gm, '').trim();
};

export const messageTimestamp = (value: number | string | undefined): string | undefined => {
  if (value == null || value === '') {
    return undefined;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(String(value));
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const isJsonObject = (value: EdgerunnerJson | undefined): value is EdgerunnerJsonObject =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const stringValue = (value: EdgerunnerJson | undefined): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = normalizeTranscriptText(value);
  return normalized || undefined;
};

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

const eventPhase = (event: EdgerunnerEvent): string =>
  stringValue(eventPayload(event)?.phase)?.toLowerCase() ?? '';

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

const repoDisplayName = (repoUrl?: string): string => {
  if (!repoUrl) {
    return '';
  }
  const cleaned = repoUrl.replace(/\.git$/, '');
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  return parts.slice(-2).join('/') || repoUrl;
};

const promptFromSessionTitle = (session: EdgerunnerSession): string | undefined => {
  const title = stringValue(session.title);
  if (!title || title.toLowerCase() === 'new agent session') {
    return undefined;
  }

  const repo = repoDisplayName(session.repo_url);
  const repoPrefix = repo ? `${repo}: ` : '';
  if (repoPrefix && title.startsWith(repoPrefix)) {
    return title.slice(repoPrefix.length).trim() || undefined;
  }

  return title.replace(/^[^:\s]+\/[^:]+:\s+/, '').trim() || undefined;
};

const sessionPrompt = (session: EdgerunnerSession): string | undefined =>
  firstString(
    session.prompt,
    session.initial_prompt,
    session.initialPrompt,
    session.input,
    session.request,
  ) ?? promptFromSessionTitle(session);

const messageBody = (message: EdgerunnerTranscriptMessage): string | undefined => {
  const data = isJsonObject(message.data) ? message.data : undefined;
  return firstString(message.content, data?.content, data?.text, data?.message, message.text);
};

const eventRole = (event: EdgerunnerEvent): TranscriptItem['role'] => {
  const kind = String(event.kind ?? '').toLowerCase();
  const payload = eventPayload(event);
  const message = nestedMessagePayload(payload);
  const role = transcriptRole(event.role ?? payload?.role ?? message?.role);
  if (role) {
    return role;
  }
  if (toolEventFragments.some((fragment) => kind.includes(fragment))) {
    return 'tool';
  }
  if (kind.includes('user') || kind === 'message') {
    return 'user';
  }
  if (kind.includes('system') || kind.includes('status')) {
    return 'system';
  }
  return 'agent';
};

const humanizeKind = (kind: string): string =>
  kind
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();

const activityTitleForKind = (kind: string): string | undefined => {
  if (kind === 'run_started') {
    return 'Runtime started';
  }
  if (kind === 'agent_started') {
    return 'Agent started';
  }
  if (kind === 'validation_started') {
    return 'Checking changes';
  }
  if (kind === 'validation_passed') {
    return 'Checks passed';
  }
  if (kind === 'validation_failed') {
    return 'Check failed';
  }
  if (kind === 'run_completed') {
    return 'Run completed';
  }
  if (kind === 'run_failed') {
    return 'Run failed';
  }
  return undefined;
};

const eventTitle = (event: EdgerunnerEvent): string => {
  const kind = String(event.kind || 'agent_update').toLowerCase();
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
  const explicitTitle = firstString(payload?.title);
  if (explicitTitle) {
    return explicitTitle;
  }
  if ((kind === 'agent_progress' || kind.endsWith('_delta')) && firstString(payload?.content)) {
    return 'Assistant';
  }
  if (kind === 'message') {
    return eventRole(event) === 'user' ? 'User' : 'Assistant';
  }
  return activityTitleForKind(kind) ?? humanizeKind(kind);
};

const eventBody = (event: EdgerunnerEvent): string | undefined => {
  const payload = eventPayload(event);
  const message = nestedMessagePayload(payload);
  const body = firstString(
    payload?.content,
    payload?.question,
    payload?.summary,
    payload?.output,
    message?.content,
    event.output,
    event.delta,
    event.text,
  );
  if (body) {
    return body;
  }
  if (typeof event.message === 'string' && event.message.trim()) {
    return normalizeTranscriptText(event.message);
  }
  return undefined;
};

const eventTone = (event: EdgerunnerEvent): TranscriptItem['tone'] => {
  const kind = String(event.kind ?? '').toLowerCase();
  const payload = eventPayload(event);
  const exitCode = typeof payload?.exit_code === 'number' ? payload.exit_code : undefined;
  const phase = eventPhase(event);
  const agentStatus = stringValue(payload?.agent_status)?.toLowerCase();
  if (
    kind.includes('failed') ||
    kind.includes('error') ||
    kind === 'stderr' ||
    (exitCode != null && exitCode !== 0)
  ) {
    return 'error';
  }
  if (
    kind.includes('completed') ||
    kind.includes('passed') ||
    kind === 'run_completed' ||
    phase === 'agent_idle' ||
    agentStatus === 'completed'
  ) {
    return 'success';
  }
  if (kind.includes('approval') || kind.includes('question')) {
    return 'warning';
  }
  if (kind.includes('started') || kind.includes('delta') || kind.includes('progress')) {
    return 'running';
  }
  return 'neutral';
};

const isRunningActivityEvent = (event: EdgerunnerEvent): boolean => {
  if (eventTone(event) !== 'running') {
    return false;
  }
  const kind = String(event.kind ?? '').toLowerCase();
  return (
    kind === 'agent_progress' ||
    kind === 'run_started' ||
    kind === 'agent_started' ||
    kind === 'validation_started'
  );
};

const isActiveSession = (session: EdgerunnerSession): boolean => {
  const status = stringValue(session.status)?.toLowerCase();
  const agentStatus = stringValue(session.agent_status)?.toLowerCase();
  return (
    agentStatus === 'running' ||
    agentStatus === 'started' ||
    status === 'starting' ||
    status === 'running'
  );
};

const shouldHideEvent = (event: EdgerunnerEvent): boolean => {
  const kind = String(event.kind ?? '').toLowerCase();
  if (noisyEventKinds.has(kind)) {
    return true;
  }
  if ((kind === 'validation_started' || kind === 'validation_passed') && !eventBody(event)) {
    return true;
  }
  return false;
};

const isActivityEvent = (event: EdgerunnerEvent): boolean => {
  const kind = String(event.kind ?? '').toLowerCase();
  const payload = eventPayload(event);
  const lifecycleProgress = kind === 'agent_progress' && !firstString(payload?.content);
  return (
    eventRole(event) === 'tool' ||
    visibleActivityKinds.has(kind) ||
    lifecycleProgress ||
    kind.includes('approval') ||
    kind.includes('question')
  );
};

type ParsedLine =
  | { type: 'message'; body: string }
  | {
      type: 'activity';
      title: string;
      body?: string;
      tone: NonNullable<TranscriptItem['tone']>;
      collapsed?: boolean;
    }
  | { type: 'detail'; body: string }
  | { type: 'hidden' };

const stripStatusPrefix = (line: string): string => {
  const firstCode = line.codePointAt(0);
  if (
    firstCode === CHECK_MARK_CODEPOINT ||
    firstCode === CROSS_MARK_CODEPOINT ||
    firstCode === FOUR_SPOKED_ASTERISK_CODEPOINT
  ) {
    return line.slice(String.fromCodePoint(firstCode).length).trim();
  }
  return line.replace(/^[!>*]\s*/, '').trim();
};

const parseAgentOutputLine = (line: string): ParsedLine => {
  const trimmed = normalizeTranscriptText(line);
  if (!trimmed) {
    return { type: 'hidden' };
  }

  if (/^!\s+agent\s+"[^"]+"\s+not found\.\s+falling back to default agent/i.test(trimmed)) {
    return {
      type: 'activity',
      title: 'Using default agent',
      tone: 'warning',
      collapsed: true,
    };
  }

  if (/^(error|exception|traceback|statuscode):/i.test(trimmed)) {
    return { type: 'detail', body: trimmed };
  }

  if (trimmed.startsWith('> ')) {
    return {
      type: 'activity',
      title: stripStatusPrefix(trimmed),
      tone: 'running',
      collapsed: true,
    };
  }

  const firstCode = trimmed.codePointAt(0);
  if (firstCode === CROSS_MARK_CODEPOINT) {
    return {
      type: 'activity',
      title: stripStatusPrefix(trimmed),
      tone: 'error',
    };
  }
  if (firstCode === CHECK_MARK_CODEPOINT) {
    return {
      type: 'activity',
      title: stripStatusPrefix(trimmed),
      tone: 'success',
      collapsed: true,
    };
  }
  if (firstCode === FOUR_SPOKED_ASTERISK_CODEPOINT) {
    return {
      type: 'activity',
      title: stripStatusPrefix(trimmed),
      tone: 'running',
      collapsed: true,
    };
  }

  return { type: 'message', body: trimmed };
};

const appendBody = (current: string | undefined, next: string): string =>
  current ? `${current}\n${next}` : next;

const splitAgentMessage = (
  baseKey: string,
  body: string,
  timestamp: string | undefined,
): TranscriptItem[] => {
  const items: TranscriptItem[] = [];
  let messageLines: string[] = [];

  const flushMessage = () => {
    const messageBody = normalizeTranscriptText(messageLines.join('\n'));
    messageLines = [];
    if (!messageBody) {
      return;
    }
    items.push({
      key: `${baseKey}-message-${items.length}`,
      role: 'agent',
      title: 'Assistant',
      body: messageBody,
      timestamp,
      kind: 'message',
    });
  };

  for (const line of body.split('\n')) {
    const parsed = parseAgentOutputLine(line);
    if (parsed.type === 'hidden') {
      continue;
    }
    if (parsed.type === 'message') {
      messageLines.push(parsed.body);
      continue;
    }
    if (parsed.type === 'detail') {
      const previous = items[items.length - 1];
      if (previous?.kind === 'activity') {
        previous.body = appendBody(previous.body, parsed.body);
        previous.collapsed = false;
      } else {
        messageLines.push(parsed.body);
      }
      continue;
    }

    flushMessage();
    items.push({
      key: `${baseKey}-activity-${items.length}`,
      role: 'tool',
      title: parsed.title,
      body: parsed.body,
      timestamp,
      kind: 'activity',
      tone: parsed.tone,
      collapsed: parsed.collapsed,
    });
  }

  flushMessage();
  return items;
};

export const transcriptFromMessages = (
  messages: EdgerunnerTranscriptMessage[],
  session: EdgerunnerSession,
) => {
  const transcript: TranscriptItem[] = [];
  const firstUserMessage = messages.find((message) => transcriptRole(message.role) === 'user');
  const prompt = sessionPrompt(session);
  if (prompt) {
    if (!firstUserMessage || messageBody(firstUserMessage) !== prompt) {
      transcript.push({
        key: `${session.id}-prompt`,
        role: 'user',
        title: 'Request',
        body: prompt,
        timestamp: messageTimestamp(session.created_at),
        kind: 'message',
      });
    }
  }

  for (const [index, message] of messages.entries()) {
    const role = transcriptRole(message.role) ?? 'agent';
    const body = messageBody(message);
    const timestamp = messageTimestamp(message.created_at);
    const key = `${message.id ?? 'message'}-${index}`;
    if (role === 'agent' && body) {
      transcript.push(...splitAgentMessage(key, body, timestamp));
      continue;
    }
    if (role === 'system' && body && parseAgentOutputLine(body).type === 'hidden') {
      continue;
    }
    transcript.push({
      key,
      role,
      title: roleTitle(role),
      body,
      timestamp,
      raw: message.data,
      kind: role === 'tool' ? 'activity' : 'message',
      tone: role === 'tool' ? 'neutral' : undefined,
    });
  }

  return transcript;
};

const isAssistantDelta = (item: TranscriptItem): boolean =>
  item.kind === 'message' &&
  item.role === 'agent' &&
  String(item.raw?.kind ?? '').toLowerCase() === 'assistant_delta';

const isCompletedAssistantMessage = (item: TranscriptItem): boolean =>
  item.kind === 'message' &&
  item.role === 'agent' &&
  String(item.raw?.kind ?? '').toLowerCase() === 'message_completed';

const isAccumulatedAssistantDelta = (item: TranscriptItem): boolean =>
  Boolean(isJsonObject(item.raw?.data) && item.raw.data.accumulated);

const mergeAssistantStreamItems = (items: TranscriptItem[]): TranscriptItem[] => {
  const merged: TranscriptItem[] = [];
  for (const item of items) {
    const previous = merged[merged.length - 1];
    if (isAssistantDelta(item) && previous && isAssistantDelta(previous)) {
      previous.body = isAccumulatedAssistantDelta(item)
        ? item.body
        : `${previous.body ?? ''}${item.body ?? ''}`;
      previous.timestamp = item.timestamp ?? previous.timestamp;
      previous.raw = item.raw;
      continue;
    }
    if (isCompletedAssistantMessage(item) && previous && isAssistantDelta(previous) && item.body) {
      previous.key = item.key;
      previous.body = item.body;
      previous.timestamp = item.timestamp ?? previous.timestamp;
      previous.raw = item.raw;
      continue;
    }
    merged.push(item);
  }
  return merged;
};

export const transcriptFromEvents = (events: EdgerunnerEvent[], session: EdgerunnerSession) => {
  let activeProgressKey: string | undefined;
  if (isActiveSession(session)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!shouldHideEvent(event) && isRunningActivityEvent(event)) {
        activeProgressKey = `${event.id ?? 'event'}-${index}`;
        break;
      }
    }
  }

  return mergeAssistantStreamItems(
    transcriptFromMessages([], session).concat(
      events.flatMap((event, index): TranscriptItem[] => {
        if (shouldHideEvent(event)) {
          return [];
        }

        const role = eventRole(event);
        const kind = isActivityEvent(event) ? 'activity' : 'message';
        const body = eventBody(event);
        const key = `${event.id ?? 'event'}-${index}`;
        const tone = kind === 'activity' ? eventTone(event) : undefined;
        const active = kind === 'activity' && key === activeProgressKey;
        const runningLifecycle = kind === 'activity' && isRunningActivityEvent(event);
        if (!body && kind === 'message' && role === 'agent') {
          return [];
        }

        return [
          {
            key,
            role: kind === 'activity' ? 'tool' : role,
            title: eventTitle(event),
            body,
            timestamp: messageTimestamp(event.created_at ?? event.ts),
            raw: event,
            kind,
            tone: active || tone !== 'running' || !runningLifecycle ? tone : 'success',
            collapsed: kind === 'activity' && tone !== 'error' && Boolean(body),
            active,
          },
        ];
      }),
    ),
  );
};

const transcriptFingerprint = (item: TranscriptItem): string =>
  [item.role, item.kind ?? '', item.title, item.body ?? ''].join('\u0000');

export const transcriptFromMessagesAndEvents = (
  messages: EdgerunnerTranscriptMessage[],
  events: EdgerunnerEvent[],
  session: EdgerunnerSession,
): TranscriptItem[] => {
  const messageTranscript = transcriptFromMessages(messages, session);
  if (events.length === 0) {
    return messageTranscript;
  }
  if (messages.length === 0) {
    return transcriptFromEvents(events, session);
  }

  const promptKey = `${session.id}-prompt`;
  const seen = new Set(messageTranscript.map(transcriptFingerprint));
  const liveTranscript = transcriptFromEvents(events, session).filter((item) => {
    if (item.key === promptKey) {
      return false;
    }
    const fingerprint = transcriptFingerprint(item);
    if (seen.has(fingerprint)) {
      return false;
    }
    seen.add(fingerprint);
    return true;
  });

  return messageTranscript.concat(liveTranscript);
};
