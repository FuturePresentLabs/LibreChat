const express = require('express');
const request = require('supertest');

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
      events: {
        transport: 'sse',
        nativeTransport: 'polling',
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
        title: 'Implement thing',
        repo_url: 'git@github.com:FuturePresentLabs/example.git',
        labels: { project: 'fpl-ai' },
      });

    expect(response.status).toBe(201);
    const [, options] = mockFetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      title: 'Implement thing',
      repo_url: 'git@github.com:FuturePresentLabs/example.git',
      labels: {
        project: 'fpl-ai',
        'fpl.librechat.user_id': 'user-1',
        'fpl.librechat.tenant_id': 'tenant-1',
        'fpl.librechat.email': 'avery@fpl.dev',
        'fpl.librechat.role': 'USER',
      },
    });
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
});
