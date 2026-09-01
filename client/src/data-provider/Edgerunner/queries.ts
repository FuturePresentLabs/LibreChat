import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, dataService, edgerunnerSessionEvents } from 'librechat-data-provider';
import type { UseQueryOptions, QueryObserverResult, QueryClient } from '@tanstack/react-query';
import type {
  EdgerunnerEvent,
  EdgerunnerSession,
  EdgerunnerLogsResponse,
  EdgerunnerMessagesResponse,
  EdgerunnerConfigResponse,
  EdgerunnerEventsResponse,
  EdgerunnerHealthResponse,
  EdgerunnerSessionsResponse,
  EdgerunnerBranchesResponse,
  EdgerunnerRepositoriesResponse,
  EdgerunnerArtifactsResponse,
} from 'librechat-data-provider';

const ACTIVE_SESSION_REFRESH_MS = 2_000;
const IDLE_SESSION_REFRESH_MS = 10_000;

const terminalStatuses = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'canceled']);
const streamEventNames = [
  'edgerunner.event',
  'session_created',
  'message',
  'message_delta',
  'message_completed',
  'assistant_message',
  'assistant_delta',
  'run_started',
  'agent_started',
  'agent_progress',
  'plan_ready',
  'files_changed',
  'validation_started',
  'validation_passed',
  'validation_failed',
  'needs_approval',
  'question',
  'pr_ready',
  'agent_heartbeat',
  'run_completed',
  'run_failed',
  'approval',
  'approval_requested',
  'approval_resolved',
  'tool_call',
  'tool_call_started',
  'tool_call_delta',
  'tool_call_completed',
  'tool_result',
  'tool_result_delta',
  'stdout',
  'stderr',
  'log',
];

export const getEdgerunnerSessions = (
  response: EdgerunnerSessionsResponse | undefined,
): EdgerunnerSession[] => {
  if (Array.isArray(response)) {
    return response;
  }
  return response?.sessions ?? response?.data ?? [];
};

export const getEdgerunnerEvents = (
  response: EdgerunnerEventsResponse | undefined,
): EdgerunnerEvent[] => {
  if (Array.isArray(response)) {
    return response;
  }
  return response?.events ?? response?.data ?? [];
};

export const getEdgerunnerMessages = (
  response: EdgerunnerMessagesResponse | undefined,
): NonNullable<EdgerunnerMessagesResponse['messages']> => {
  return response?.messages ?? response?.data ?? [];
};

export const getEdgerunnerEventId = (event: EdgerunnerEvent): number | undefined => {
  if (typeof event.id === 'number' && Number.isSafeInteger(event.id)) {
    return event.id;
  }
  if (typeof event.id === 'string' && /^\d+$/.test(event.id)) {
    return Number.parseInt(event.id, 10);
  }
  return undefined;
};

export const isEdgerunnerSessionTerminal = (session: EdgerunnerSession | undefined): boolean =>
  terminalStatuses.has(String(session?.status ?? '').toLowerCase());

const mergeEvents = (current: EdgerunnerEventsResponse | undefined, event: EdgerunnerEvent) => {
  const events = getEdgerunnerEvents(current);
  const eventId = getEdgerunnerEventId(event);
  if (eventId != null && events.some((candidate) => getEdgerunnerEventId(candidate) === eventId)) {
    return current;
  }
  return { events: [...events, event] };
};

export const useEdgerunnerConfigQuery = (
  config?: UseQueryOptions<EdgerunnerConfigResponse>,
): QueryObserverResult<EdgerunnerConfigResponse> => {
  return useQuery<EdgerunnerConfigResponse>(
    [QueryKeys.edgerunnerConfig],
    () => dataService.getEdgerunnerConfig(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: false,
      ...config,
    },
  );
};

export const useEdgerunnerHealthQuery = (
  config?: UseQueryOptions<EdgerunnerHealthResponse>,
): QueryObserverResult<EdgerunnerHealthResponse> => {
  return useQuery<EdgerunnerHealthResponse>(
    [QueryKeys.edgerunnerHealth],
    () => dataService.getEdgerunnerHealth(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: false,
      ...config,
    },
  );
};

export const useEdgerunnerRepositoriesQuery = (
  q?: string,
  config?: UseQueryOptions<EdgerunnerRepositoriesResponse>,
): QueryObserverResult<EdgerunnerRepositoriesResponse> => {
  const stableQuery = q?.trim() ?? '';
  return useQuery<EdgerunnerRepositoriesResponse>(
    [QueryKeys.edgerunnerRepositories, stableQuery],
    () => dataService.listEdgerunnerRepositories(stableQuery),
    {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: false,
      ...config,
    },
  );
};

export const useEdgerunnerBranchesQuery = (
  owner: string | null | undefined,
  repo: string | null | undefined,
  q?: string,
  config?: UseQueryOptions<EdgerunnerBranchesResponse>,
): QueryObserverResult<EdgerunnerBranchesResponse> => {
  const stableOwner = owner ?? '';
  const stableRepo = repo ?? '';
  return useQuery<EdgerunnerBranchesResponse>(
    [QueryKeys.edgerunnerBranches, stableOwner, stableRepo, q ?? ''],
    () => dataService.listEdgerunnerBranches(stableOwner, stableRepo, q),
    {
      enabled: Boolean(stableOwner && stableRepo),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: false,
      ...config,
    },
  );
};

export const useEdgerunnerSessionsQuery = (
  config?: UseQueryOptions<EdgerunnerSessionsResponse>,
): QueryObserverResult<EdgerunnerSessionsResponse> => {
  return useQuery<EdgerunnerSessionsResponse>(
    [QueryKeys.edgerunnerSessions],
    () => dataService.listEdgerunnerSessions(),
    {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      refetchInterval: IDLE_SESSION_REFRESH_MS,
      retry: false,
      ...config,
    },
  );
};

export const useEdgerunnerSessionQuery = (
  sessionId: string | null | undefined,
  config?: UseQueryOptions<EdgerunnerSession>,
): QueryObserverResult<EdgerunnerSession> => {
  return useQuery<EdgerunnerSession>(
    [QueryKeys.edgerunnerSession, sessionId],
    () => dataService.getEdgerunnerSession(sessionId ?? ''),
    {
      enabled: Boolean(sessionId),
      refetchOnWindowFocus: true,
      refetchInterval: (session) =>
        isEdgerunnerSessionTerminal(session) ? false : ACTIVE_SESSION_REFRESH_MS,
      retry: false,
      ...config,
    },
  );
};

export const useEdgerunnerEventsQuery = (
  sessionId: string | null | undefined,
  config?: UseQueryOptions<EdgerunnerEventsResponse>,
): QueryObserverResult<EdgerunnerEventsResponse> => {
  return useQuery<EdgerunnerEventsResponse>(
    [QueryKeys.edgerunnerEvents, sessionId],
    () => dataService.listEdgerunnerEvents(sessionId ?? ''),
    {
      enabled: Boolean(sessionId),
      refetchOnWindowFocus: true,
      refetchInterval: ACTIVE_SESSION_REFRESH_MS,
      retry: false,
      ...config,
    },
  );
};

export const useEdgerunnerMessagesQuery = (
  sessionId: string | null | undefined,
  config?: UseQueryOptions<EdgerunnerMessagesResponse>,
): QueryObserverResult<EdgerunnerMessagesResponse> => {
  return useQuery<EdgerunnerMessagesResponse>(
    [QueryKeys.edgerunnerMessages, sessionId],
    () => dataService.listEdgerunnerMessages(sessionId ?? ''),
    {
      enabled: Boolean(sessionId),
      refetchOnWindowFocus: true,
      refetchInterval: ACTIVE_SESSION_REFRESH_MS,
      retry: false,
      ...config,
    },
  );
};

export const useEdgerunnerLogsQuery = (
  sessionId: string | null | undefined,
  config?: UseQueryOptions<EdgerunnerLogsResponse>,
): QueryObserverResult<EdgerunnerLogsResponse> => {
  return useQuery<EdgerunnerLogsResponse>(
    [QueryKeys.edgerunnerLogs, sessionId],
    () => dataService.listEdgerunnerLogs(sessionId ?? ''),
    {
      enabled: Boolean(sessionId),
      refetchOnWindowFocus: false,
      refetchInterval: ACTIVE_SESSION_REFRESH_MS,
      retry: false,
      ...config,
    },
  );
};

export const useEdgerunnerArtifactsQuery = (
  sessionId: string | null | undefined,
  config?: UseQueryOptions<EdgerunnerArtifactsResponse>,
): QueryObserverResult<EdgerunnerArtifactsResponse> => {
  return useQuery<EdgerunnerArtifactsResponse>(
    [QueryKeys.edgerunnerArtifacts, sessionId],
    () => dataService.listEdgerunnerArtifacts(sessionId ?? ''),
    {
      enabled: Boolean(sessionId),
      refetchOnWindowFocus: false,
      refetchInterval: ACTIVE_SESSION_REFRESH_MS,
      retry: false,
      ...config,
    },
  );
};

const appendStreamEvent = (queryClient: QueryClient, sessionId: string, event: EdgerunnerEvent) => {
  queryClient.setQueryData<EdgerunnerEventsResponse | undefined>(
    [QueryKeys.edgerunnerEvents, sessionId],
    (current) => mergeEvents(current, event),
  );
  queryClient.invalidateQueries([QueryKeys.edgerunnerMessages, sessionId]);
};

export const useEdgerunnerEventStream = (sessionId: string | null | undefined, enabled = true) => {
  const queryClient = useQueryClient();
  const stableSessionId = sessionId ?? '';

  const url = useMemo(() => {
    if (!stableSessionId || !enabled) {
      return null;
    }
    return edgerunnerSessionEvents(stableSessionId, undefined, true);
  }, [enabled, stableSessionId]);

  useEffect(() => {
    if (!url || !stableSessionId) {
      return;
    }

    const source = new EventSource(url);
    const handleEvent = (message: MessageEvent<string>) => {
      try {
        appendStreamEvent(
          queryClient,
          stableSessionId,
          JSON.parse(message.data) as EdgerunnerEvent,
        );
      } catch {
        // Ignore malformed stream frames; polling remains active as the authoritative fallback.
      }
    };

    source.onmessage = handleEvent;
    streamEventNames.forEach((eventName) => source.addEventListener(eventName, handleEvent));
    return () => {
      source.onmessage = null;
      streamEventNames.forEach((eventName) => source.removeEventListener(eventName, handleEvent));
      source.close();
    };
  }, [queryClient, stableSessionId, url]);
};
