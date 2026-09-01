const express = require('express');
const request = require('supertest');
const { PassThrough } = require('stream');

const mockFetch = jest.fn();
const mockCheckAccess = jest.fn((_req, _res, next) => next());
const mockRequireJwtAuth = jest.fn((req, _res, next) => {
  req.user = {
    id: 'user-1',
    email: 'avery@fpl.dev',
    role: 'USER',
    tenantId: 'tenant-1',
  };
  next();
});

jest.mock(
  'node-fetch',
  () =>
    (...args) =>
      mockFetch(...args),
);

jest.mock('@librechat/api', () => ({
  generateCheckAccess: jest.fn(() => mockCheckAccess),
}));

jest.mock('~/models', () => ({
  getRoleByName: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (...args) => mockRequireJwtAuth(...args),
}));

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: () => 'application/json',
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function sseResponse(body, status = 200) {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.end(body);
  });
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        if (name.toLowerCase() === 'content-type') {
          return 'text/event-stream';
        }
        if (name.toLowerCase() === 'cache-control') {
          return 'no-cache';
        }
        return null;
      },
    },
    body: stream,
    json: async () => ({}),
    text: async () => body,
  });
}

function buildApp() {
  jest.resetModules();
  const router = require('../edgerunner');
  const app = express();
  app.use(express.json());
  app.use('/api/edgerunner', router);
  return app;
}

describe('Edgerunner routes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      EDGERUNNER_BASE_URL: 'http://127.0.0.1:8087',
      EDGERUNNER_API_TOKEN: 'test-token',
      EDGERUNNER_PROFILES: '',
    };
    mockFetch.mockReset();
    mockCheckAccess.mockClear();
    mockRequireJwtAuth.mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('reports client-safe feature configuration', async () => {
    const app = buildApp();

    const response = await request(app).get('/api/edgerunner/config');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      enabled: true,
      protocol: 'edgerunner-v1',
      profiles: [
        {
          id: 'standard',
          label: 'Standard',
          description: 'General coding agent',
        },
      ],
      events: {
        transport: 'sse',
        nativeTransport: 'sse',
      },
    });
    expect(response.text).not.toContain('127.0.0.1');
  });

  it('returns 404 when Edgerunner is not configured', async () => {
    delete process.env.EDGERUNNER_BASE_URL;
    const app = buildApp();

    const response = await request(app).get('/api/edgerunner/sessions');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Edgerunner is not configured' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lists sessions through the native Edgerunner API', async () => {
    mockFetch.mockResolvedValueOnce(await jsonResponse([{ id: 'session-1', status: 'running' }]));
    const app = buildApp();

    const response = await request(app).get('/api/edgerunner/sessions');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 'session-1', status: 'running' }]);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8087/v1/sessions',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          authorization: 'Bearer test-token',
        }),
      }),
    );
  });

  it('creates sessions with LibreChat actor labels', async () => {
    mockFetch.mockResolvedValueOnce(await jsonResponse({ id: 'session-1' }, 201));
    const app = buildApp();

    const response = await request(app)
      .post('/api/edgerunner/sessions')
      .send({
        repo_url: 'git@github.com:FuturePresentLabs/example.git',
        prompt: 'Implement thing',
        labels: { project: 'fpl-ai' },
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: 'session-1',
      prompt: 'Implement thing',
    });
    const [, options] = mockFetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      title: 'FuturePresentLabs/example: Implement thing',
      repo_url: 'git@github.com:FuturePresentLabs/example.git',
      prompt: 'Implement thing',
      auto_start: true,
      run: {
        retention: 'snapshot',
      },
      labels: {
        project: 'fpl-ai',
        'fpl.edgerunner.profile': 'standard',
        'fpl.librechat.user_id': 'user-1',
        'fpl.librechat.tenant_id': 'tenant-1',
        'fpl.librechat.email': 'avery@fpl.dev',
        'fpl.librechat.role': 'USER',
      },
    });
  });

  it('lists GitHub repositories through Edgerunner discovery', async () => {
    mockFetch.mockResolvedValueOnce(
      await jsonResponse({
        repositories: [
          {
            name: 'LibreChat',
            full_name: 'FuturePresentLabs/LibreChat',
            private: true,
            default_branch: 'fpl/prod-librechat',
            html_url: 'https://github.com/FuturePresentLabs/LibreChat',
            clone_url: 'https://github.com/FuturePresentLabs/LibreChat.git',
            ssh_url: 'git@github.com:FuturePresentLabs/LibreChat.git',
            owner: 'FuturePresentLabs',
          },
        ],
      }),
    );
    const app = buildApp();

    const response = await request(app).get('/api/edgerunner/repositories');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      credentialPresent: true,
      repositories: [
        {
          id: 'FuturePresentLabs/LibreChat',
          name: 'LibreChat',
          full_name: 'FuturePresentLabs/LibreChat',
          private: true,
          default_branch: 'fpl/prod-librechat',
          html_url: 'https://github.com/FuturePresentLabs/LibreChat',
          clone_url: 'https://github.com/FuturePresentLabs/LibreChat.git',
          ssh_url: 'git@github.com:FuturePresentLabs/LibreChat.git',
          owner: 'FuturePresentLabs',
        },
      ],
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8087/v1/github/repos?limit=100',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer test-token',
          'x-fpl-user-email': 'avery@fpl.dev',
          'x-fpl-user-subject': 'user-1',
        }),
      }),
    );
    expect(response.text).not.toContain('test-token');
  });

  it('lists GitHub branches through Edgerunner discovery', async () => {
    mockFetch.mockResolvedValueOnce(
      await jsonResponse({
        branches: [
          {
            name: 'fpl/prod-librechat',
            sha: 'abc123',
            protected: true,
          },
        ],
      }),
    );
    const app = buildApp();

    const response = await request(app).get(
      '/api/edgerunner/repositories/FuturePresentLabs/LibreChat/branches?q=fpl',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      credentialPresent: true,
      branches: [
        {
          name: 'fpl/prod-librechat',
          sha: 'abc123',
          protected: true,
        },
      ],
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8087/v1/github/repos/FuturePresentLabs/LibreChat/branches?q=fpl&limit=100',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer test-token',
          'x-fpl-user-email': 'avery@fpl.dev',
        }),
      }),
    );
  });

  it('reports missing GitHub credentials as an empty discovery result', async () => {
    mockFetch.mockResolvedValueOnce(await jsonResponse({ error: 'github is not connected' }, 404));
    const app = buildApp();

    const response = await request(app).get('/api/edgerunner/repositories');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      credentialPresent: false,
      repositories: [],
      message: 'github is not connected',
    });
  });

  it('applies hidden profile launch options server-side', async () => {
    process.env.EDGERUNNER_PROFILES = JSON.stringify([
      {
        id: 'careful',
        label: 'Careful',
        description: 'Runs project checks',
        agent: 'codex',
        model: 'fpl/agent',
        run: {
          validate: 'npm test',
          timeout_seconds: 1200,
        },
      },
    ]);
    mockFetch.mockResolvedValueOnce(await jsonResponse({ id: 'session-1' }, 201));
    const app = buildApp();

    const response = await request(app)
      .post('/api/edgerunner/sessions')
      .send({
        profile_id: 'careful',
        repo_url: 'git@github.com:FuturePresentLabs/example.git',
        prompt: 'Fix the failing tests',
        run: {
          validate: 'rm -rf .',
        },
      });

    expect(response.status).toBe(201);
    const [, options] = mockFetch.mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({
      title: 'FuturePresentLabs/example: Fix the failing tests',
      run: {
        validate: 'npm test',
        timeout_seconds: 1200,
        model: 'fpl/agent',
        agent: 'codex',
        retention: 'snapshot',
      },
      labels: {
        'fpl.edgerunner.profile': 'careful',
      },
    });
    expect(options.body).not.toContain('rm -rf');
  });

  it('forwards message actions to the session messages endpoint', async () => {
    mockFetch.mockResolvedValueOnce(await jsonResponse({ id: 'session-1', status: 'waiting' }));
    const app = buildApp();

    const response = await request(app)
      .post('/api/edgerunner/sessions/session-1/actions')
      .send({
        type: 'message',
        message: {
          content: 'Inspect the branch',
          start_run: false,
        },
      });

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8087/v1/sessions/session-1/messages');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      content: 'Inspect the branch',
      start_run: false,
      labels: {
        'fpl.librechat.user_id': 'user-1',
      },
    });
  });

  it('lists readable session messages from Edgerunner', async () => {
    mockFetch.mockResolvedValueOnce(
      await jsonResponse({
        session_id: 'session-1',
        messages: [{ id: 1, role: 'assistant', content: 'Done.' }],
      }),
    );
    const app = buildApp();

    const response = await request(app).get('/api/edgerunner/sessions/session-1/messages');

    expect(response.status).toBe(200);
    expect(response.body.messages[0]).toMatchObject({ role: 'assistant', content: 'Done.' });
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8087/v1/sessions/session-1/messages');
  });

  it('forwards cancel actions to the native cancel endpoint', async () => {
    mockFetch.mockResolvedValueOnce(await jsonResponse({ id: 'session-1', status: 'canceled' }));
    const app = buildApp();

    const response = await request(app)
      .post('/api/edgerunner/sessions/session-1/actions')
      .send({ type: 'cancel', reason: 'user_request' });

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8087/v1/sessions/session-1/cancel');
  });

  it('validates the event cursor before forwarding', async () => {
    const app = buildApp();

    const response = await request(app).get('/api/edgerunner/sessions/session-1/events?after=nope');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Invalid after cursor' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns event lists as JSON when SSE is not requested', async () => {
    mockFetch.mockResolvedValueOnce(await jsonResponse([{ id: 3, kind: 'message' }]));
    const app = buildApp();

    const response = await request(app).get('/api/edgerunner/sessions/session-1/events?after=2');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ id: 3, kind: 'message' }]);
    expect(mockFetch.mock.calls[0][0]).toBe(
      'http://127.0.0.1:8087/v1/sessions/session-1/events?after=2',
    );
  });

  it('relays native session event streams from Edgerunner', async () => {
    mockFetch.mockResolvedValueOnce(
      await sseResponse(
        'id: 3\nevent: agent_progress\ndata: {"id":3,"kind":"agent_progress","message":"working"}\n\n',
      ),
    );
    const app = buildApp();

    const response = await request(app)
      .get('/api/edgerunner/sessions/session-1/events?stream=true&after=2')
      .set('Accept', 'text/event-stream');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('event: agent_progress');
    expect(response.text).toContain('"message":"working"');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8087/v1/sessions/session-1/stream?after=2',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          accept: 'text/event-stream',
          authorization: 'Bearer test-token',
          'x-fpl-user-email': 'avery@fpl.dev',
          'x-fpl-user-subject': 'user-1',
        }),
      }),
    );
  });
});
