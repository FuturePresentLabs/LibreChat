import type { EdgerunnerEvent, EdgerunnerSession } from 'librechat-data-provider';
import {
  transcriptFromEvents,
  transcriptFromMessages,
  transcriptFromMessagesAndEvents,
} from './transcript';

const session = (overrides: Partial<EdgerunnerSession> = {}): EdgerunnerSession => ({
  id: 'session-1',
  title: 'FuturePresentLabs/client-files: Inspect the repo',
  repo_url: 'git@github.com:FuturePresentLabs/client-files.git',
  created_at: 1788237893076,
  ...overrides,
});

describe('Edgerunner transcript mapping', () => {
  it('splits terminal activity out of assistant prose and hides internal fallback labels', () => {
    const esc = String.fromCharCode(27);
    const middleDot = String.fromCharCode(183);
    const body = [
      `${esc}[93m${esc}[1m! ${esc}[0m agent "spec_author" not found. Falling back to default agent`,
      `${esc}[0m`,
      `> build ${middleDot} fpl/llm`,
      `${esc}[0m`,
      'ADAPTER_AGENT_SMOKE_OK',
    ].join('\n');

    const transcript = transcriptFromMessages(
      [
        {
          id: 18,
          session_id: 'session-1',
          role: 'assistant',
          content: body,
          data: { content: body, role: 'assistant' },
          created_at: 1788237893076,
        },
      ],
      session(),
    );

    expect(transcript.map((item) => [item.kind, item.title, item.body])).toEqual([
      ['message', 'Request', 'Inspect the repo'],
      ['activity', 'Using default agent', undefined],
      ['activity', `build ${middleDot} fpl/llm`, undefined],
      ['message', 'Assistant', 'ADAPTER_AGENT_SMOKE_OK'],
    ]);
    expect(JSON.stringify(transcript)).not.toContain('spec_author');
  });

  it('keeps command failures as structured activity with error detail', () => {
    const crossMark = String.fromCodePoint(10007);
    const body = [
      `${crossMark} Read .alfalfa/spec failed [limit=2000]`,
      'Error: File not found: /workspace/.alfalfa/spec',
      'Here is the next step.',
    ].join('\n');

    const transcript = transcriptFromMessages(
      [
        {
          id: 19,
          session_id: 'session-1',
          role: 'assistant',
          content: body,
          created_at: 1788237893076,
        },
      ],
      session({ prompt: 'Please plan it' }),
    );

    expect(transcript[1]).toMatchObject({
      kind: 'activity',
      role: 'tool',
      tone: 'error',
      title: 'Read .alfalfa/spec failed [limit=2000]',
      body: 'Error: File not found: /workspace/.alfalfa/spec',
    });
    expect(transcript[2]).toMatchObject({
      kind: 'message',
      role: 'agent',
      body: 'Here is the next step.',
    });
  });

  it('hides routine startup events but keeps failed runs visible', () => {
    const events: EdgerunnerEvent[] = [
      { id: 1, kind: 'session_created', message: 'session created' },
      { id: 2, kind: 'run_started', message: 'run started', data: { runtime: 'shroud' } },
      { id: 3, kind: 'agent_started', message: 'runner started' },
      {
        id: 4,
        kind: 'run_failed',
        message: 'run failed',
        data: { agent_status: 'failed', exit_code: 128 },
      },
    ];

    const transcript = transcriptFromEvents(events, session({ prompt: 'Clone this repo' }));

    expect(transcript.map((item) => item.title)).toEqual(['Request', 'Run failed']);
    expect(transcript[1]).toMatchObject({ kind: 'activity', tone: 'error' });
  });

  it('maps native tool events to compact activity items', () => {
    const transcript = transcriptFromEvents(
      [
        {
          id: 9,
          kind: 'tool_call_started',
          data: { tool_name: 'Read', path: 'package.json' },
        },
        {
          id: 10,
          kind: 'stderr',
          data: { content: 'permission denied' },
        },
      ],
      session({ prompt: 'Inspect package metadata' }),
    );

    expect(
      transcript.slice(1).map((item) => [item.kind, item.title, item.tone, item.body]),
    ).toEqual([
      ['activity', 'Read', 'running', undefined],
      ['activity', 'Stderr', 'error', 'permission denied'],
    ]);
  });

  it('keeps streamed assistant output visible when persisted messages only contain the prompt', () => {
    const transcript = transcriptFromMessagesAndEvents(
      [
        {
          id: 21,
          session_id: 'session-1',
          role: 'user',
          content: 'Inspect package metadata',
          created_at: 1788237893076,
        },
      ],
      [
        {
          id: 22,
          kind: 'assistant_delta',
          data: { role: 'assistant', content: 'I am checking the repository now.' },
          created_at: 1788237894076,
        },
        {
          id: 23,
          kind: 'tool_call_started',
          data: { tool_name: 'Read', path: 'package.json' },
          created_at: 1788237895076,
        },
      ],
      session({ prompt: 'Inspect package metadata' }),
    );

    expect(transcript.map((item) => [item.role, item.kind, item.title, item.body])).toEqual([
      ['user', 'message', 'User', 'Inspect package metadata'],
      ['agent', 'message', 'Assistant', 'I am checking the repository now.'],
      ['tool', 'activity', 'Read', undefined],
    ]);
  });
});
