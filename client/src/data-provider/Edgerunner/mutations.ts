import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import type {
  EdgerunnerJson,
  EdgerunnerSession,
  EdgerunnerMessagesResponse,
  EdgerunnerActionVariables,
  EdgerunnerCreateSessionRequest,
} from 'librechat-data-provider';

export const useCreateEdgerunnerSessionMutation = (): UseMutationResult<
  EdgerunnerSession,
  unknown,
  EdgerunnerCreateSessionRequest,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.edgerunnerCreateSession],
    (payload: EdgerunnerCreateSessionRequest) => dataService.createEdgerunnerSession(payload),
    {
      onSuccess: (session, payload) => {
        queryClient.setQueryData([QueryKeys.edgerunnerSession, session.id], session);
        const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
        if (prompt) {
          queryClient.setQueryData<EdgerunnerMessagesResponse | undefined>(
            [QueryKeys.edgerunnerMessages, session.id],
            (current) => {
              const messages = current?.messages ?? current?.data ?? [];
              if (
                messages.some((message) => message.role === 'user' && message.content === prompt)
              ) {
                return current ?? { session_id: session.id, messages };
              }
              return {
                ...(current ?? {}),
                session_id: session.id,
                messages: [
                  {
                    id: `${session.id}-initial-prompt`,
                    session_id: session.id,
                    role: 'user',
                    content: prompt,
                    created_at: session.created_at ?? new Date().toISOString(),
                    data: {
                      optimistic: true,
                      source: 'librechat-create-session',
                    },
                  },
                  ...messages,
                ],
              };
            },
          );
        }
        queryClient.invalidateQueries([QueryKeys.edgerunnerSessions]);
      },
    },
  );
};

export const useEdgerunnerActionMutation = (): UseMutationResult<
  EdgerunnerJson,
  unknown,
  EdgerunnerActionVariables,
  unknown
> => {
  const queryClient = useQueryClient();
  return useMutation(
    [MutationKeys.edgerunnerAction],
    (variables: EdgerunnerActionVariables) => dataService.sendEdgerunnerAction(variables),
    {
      onSuccess: (_response, variables) => {
        queryClient.invalidateQueries([QueryKeys.edgerunnerSessions]);
        queryClient.invalidateQueries([QueryKeys.edgerunnerSession, variables.sessionId]);
        queryClient.invalidateQueries([QueryKeys.edgerunnerMessages, variables.sessionId]);
        queryClient.invalidateQueries([QueryKeys.edgerunnerEvents, variables.sessionId]);
        queryClient.invalidateQueries([QueryKeys.edgerunnerLogs, variables.sessionId]);
        queryClient.invalidateQueries([QueryKeys.edgerunnerArtifacts, variables.sessionId]);
      },
    },
  );
};
