import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import type {
  EdgerunnerJson,
  EdgerunnerSession,
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
      onSuccess: (session) => {
        queryClient.setQueryData([QueryKeys.edgerunnerSession, session.id], session);
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
