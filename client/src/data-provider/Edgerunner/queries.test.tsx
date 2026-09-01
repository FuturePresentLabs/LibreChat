import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import type { EdgerunnerEventsResponse } from 'librechat-data-provider';
import { useEdgerunnerEventStream } from './queries';

type Listener = (event: MessageEvent) => void;
type MockStream = {
  url: string;
  options: { method?: string; headers?: Record<string, string> };
  listeners: Record<string, Listener>;
  close: jest.Mock;
  emit: (type: string, data: unknown) => void;
};

const streams: MockStream[] = [];

jest.mock('sse.js', () => ({
  SSE: jest.fn().mockImplementation((url: string, options: MockStream['options']) => {
    const listeners: Record<string, Listener> = {};
    const stream: MockStream = {
      url,
      options,
      listeners,
      close: jest.fn(),
      emit: (type, data) => listeners[type]?.({ data: JSON.stringify(data) } as MessageEvent),
    };
    streams.push(stream);
    return {
      addEventListener: (type: string, listener: Listener) => {
        listeners[type] = listener;
      },
      close: stream.close,
    };
  }),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'token-1', isAuthenticated: true }),
}));

const createWrapper = (queryClient: QueryClient) => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return Wrapper;
};

describe('useEdgerunnerEventStream', () => {
  beforeEach(() => {
    streams.length = 0;
  });

  it('opens an authorized stream and appends live events to the cache', () => {
    const queryClient = new QueryClient();
    const { unmount } = renderHook(() => useEdgerunnerEventStream('session 1'), {
      wrapper: createWrapper(queryClient),
    });

    expect(streams).toHaveLength(1);
    expect(streams[0]?.url).toContain('/api/edgerunner/sessions/session%201/events?stream=true');
    expect(streams[0]?.options.headers).toEqual({ Authorization: 'Bearer token-1' });

    act(() => {
      streams[0]?.emit('message', {
        id: 7,
        kind: 'assistant_delta',
        data: { content: 'Live output' },
      });
    });

    expect(
      queryClient.getQueryData<EdgerunnerEventsResponse>([QueryKeys.edgerunnerEvents, 'session 1']),
    ).toEqual({
      events: [{ id: 7, kind: 'assistant_delta', data: { content: 'Live output' } }],
    });

    unmount();
    expect(streams[0]?.close).toHaveBeenCalledTimes(1);
  });
});
