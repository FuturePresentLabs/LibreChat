const express = require('express');
const { generateCheckAccess } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const { getRoleByName } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');
const {
  EdgerunnerClient,
  EdgerunnerError,
  getEdgerunnerConfig,
} = require('~/server/services/Edgerunner/client');

const DEFAULT_PROFILES = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'General coding agent',
    model: 'bifrost/GLM-5.3-Flash',
    agent: 'build',
    run: {
      mode: 'serve',
      retention: 'keep',
      bifrost: {
        model: 'GLM-5.3-Flash',
        client: 'edgerunner',
        project: 'edgerunner',
        workflow: 'librechat-agent',
        billing_account_id: 'edgerunner:librechat',
        scopes: ['chat.completions'],
        ttl_seconds: 3600,
      },
    },
  },
];

const router = express.Router();
const client = new EdgerunnerClient();

const checkRemoteAgentsUse = generateCheckAccess({
  permissionType: PermissionTypes.REMOTE_AGENTS,
  permissions: [Permissions.USE],
  getRoleByName,
});

function sendError(res, error) {
  if (error instanceof EdgerunnerError) {
    return res.status(error.status).json({
      message: error.message,
      ...(error.details !== undefined && { details: error.details }),
    });
  }

  return res.status(500).json({ message: 'Edgerunner route failed' });
}

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function timestampMs(value) {
  if (value == null || value === '') {
    return 0;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionTimestamp(session) {
  return timestampMs(
    session?.updated_at ?? session?.updatedAt ?? session?.created_at ?? session?.createdAt,
  );
}

function sortSessionsNewestFirst(response) {
  if (Array.isArray(response)) {
    return [...response].sort(
      (first, second) => sessionTimestamp(second) - sessionTimestamp(first),
    );
  }

  if (!response || typeof response !== 'object') {
    return response;
  }

  let sessionsKey = null;
  if (Array.isArray(response.sessions)) {
    sessionsKey = 'sessions';
  } else if (Array.isArray(response.data)) {
    sessionsKey = 'data';
  }

  if (!sessionsKey) {
    return response;
  }

  return {
    ...response,
    [sessionsKey]: [...response[sessionsKey]].sort(
      (first, second) => sessionTimestamp(second) - sessionTimestamp(first),
    ),
  };
}

function normalizeProfiles(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_PROFILES;
  }

  const profiles = value
    .map((profile) => {
      if (!profile || typeof profile !== 'object') {
        return null;
      }
      const id = safeString(profile.id);
      const label = safeString(profile.label);
      if (!id || !label) {
        return null;
      }
      return {
        ...profile,
        id,
        label,
        description: safeString(profile.description),
      };
    })
    .filter(Boolean);

  return profiles.length > 0 ? profiles : DEFAULT_PROFILES;
}

function getProfiles() {
  if (!process.env.EDGERUNNER_PROFILES) {
    return DEFAULT_PROFILES;
  }

  try {
    return normalizeProfiles(JSON.parse(process.env.EDGERUNNER_PROFILES));
  } catch (_error) {
    return DEFAULT_PROFILES;
  }
}

function publicProfile(profile) {
  return {
    id: profile.id,
    label: profile.label,
    ...(profile.description && { description: profile.description }),
  };
}

function findProfile(profileId) {
  const profiles = getProfiles();
  return profiles.find((profile) => profile.id === profileId) || profiles[0];
}

function repoName(repoUrl) {
  const value = safeString(repoUrl);
  if (!value) {
    return '';
  }
  const withoutGit = value.replace(/\.git$/, '');
  const parts = withoutGit.split(/[/:]/).filter(Boolean);
  return parts.slice(-2).join('/');
}

function normalizeRepoUrlForLaunch(value) {
  const repoUrl = safeString(value);
  const githubSshMatch = repoUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!githubSshMatch) {
    return repoUrl;
  }
  return `https://github.com/${githubSshMatch[1]}.git`;
}

function autoTitle(body) {
  const prompt = safeString(body.prompt).replace(/\s+/g, ' ');
  const repo = repoName(body.repo_url);
  const promptTitle = prompt ? prompt.slice(0, 72) : 'New agent session';
  return repo ? `${repo}: ${promptTitle}` : promptTitle;
}

function createSessionPayload(body = {}) {
  const requestedProfile = safeString(body.profile_id) || safeString(body.profileId);
  const profile = findProfile(requestedProfile);
  const profileRun =
    profile && typeof profile.run === 'object' && !Array.isArray(profile.run) ? profile.run : {};
  const repoUrl = normalizeRepoUrlForLaunch(body.repo_url);

  const run = {
    ...profileRun,
    ...(safeString(profile.model) && { model: safeString(profile.model) }),
    ...(safeString(profile.agent) && { agent: safeString(profile.agent) }),
    mode: safeString(profileRun.mode) || 'serve',
    retention: safeString(profileRun.retention) || 'keep',
  };

  const payload = {
    ...(repoUrl && { repo_url: repoUrl }),
    ...(safeString(body.ref) && { ref: safeString(body.ref) }),
    ...(safeString(body.prompt) && { prompt: safeString(body.prompt) }),
    title: autoTitle(body),
    auto_start: body.auto_start !== false,
    labels: {
      ...(body.labels || {}),
      ...(profile?.id && { 'fpl.edgerunner.profile': profile.id }),
    },
  };

  if (Object.keys(run).length > 0) {
    payload.run = run;
  }

  return payload;
}

function shouldStartAsync(body = {}, payload = {}) {
  return body.start_async === true && safeString(payload.prompt);
}

async function startSessionAsync(sessionId, payload, user) {
  const prompt = safeString(payload.prompt);
  if (!sessionId || !prompt) {
    return;
  }

  try {
    await client.sendMessage(
      sessionId,
      {
        content: prompt,
        start_run: true,
        ...(payload.run && { run: payload.run }),
      },
      user,
    );
  } catch (error) {
    logger.error('[edgerunner] async session start failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeGitHubRepo(repo) {
  const fullName = safeString(repo.full_name);
  return {
    id: fullName || safeString(repo.id) || safeString(repo.name),
    name: repo.name,
    full_name: fullName,
    private: Boolean(repo.private),
    default_branch: repo.default_branch || 'main',
    html_url: repo.html_url,
    clone_url: repo.clone_url,
    ssh_url: repo.ssh_url,
    pushed_at: repo.pushed_at,
    owner: safeString(repo.owner) || repo.owner?.login,
  };
}

function parseAfter(value) {
  if (value == null || value === '') {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function writeSse(res, event, data, id) {
  if (id != null) {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamEvents(req, res, sessionId, initialAfter) {
  const controller = new AbortController();
  const parsedLastEventId = parseAfter(req.headers['last-event-id']);
  const lastEventId = parsedLastEventId === null ? undefined : parsedLastEventId;
  let clientClosed = false;

  req.on('close', () => {
    clientClosed = true;
    controller.abort();
  });

  try {
    const upstream = await client.streamEvents(
      sessionId,
      {
        after: initialAfter,
        lastEventId,
        signal: controller.signal,
      },
      req.user,
    );

    if (clientClosed) {
      res.end();
      return;
    }

    res.status(200);
    res.set({
      'Cache-Control': upstream.headers.get('cache-control') || 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    upstream.body.on('error', (error) => {
      if (!clientClosed && !res.destroyed) {
        writeSse(res, 'error', {
          message:
            error instanceof EdgerunnerError ? error.message : 'Edgerunner event stream failed',
        });
        res.end();
      }
    });
    upstream.body.on('end', () => {
      if (!res.destroyed) {
        res.end();
      }
    });
    upstream.body.pipe(res, { end: false });
  } catch (error) {
    if (clientClosed || error.name === 'AbortError') {
      if (!res.destroyed) {
        res.end();
      }
      return;
    }
    if (res.headersSent) {
      writeSse(res, 'error', {
        message:
          error instanceof EdgerunnerError ? error.message : 'Edgerunner event stream failed',
      });
      res.end();
      return;
    }
    sendError(res, error);
  }
}

function actionToClientCall(sessionId, action, user) {
  switch (action.type) {
    case 'message':
      return client.sendMessage(sessionId, action.message || action, user);
    case 'approve':
      return client.approve(sessionId, action.decision || action);
    case 'cancel':
      return client.cancel(sessionId, action);
    case 'suspend':
      return client.suspend(sessionId, action);
    case 'resume':
      return client.resume(sessionId, action);
    default:
      throw new EdgerunnerError('Unsupported Edgerunner action type', 400);
  }
}

router.use(requireJwtAuth, checkRemoteAgentsUse);

router.get('/config', (_req, res) => {
  const config = getEdgerunnerConfig();
  res.json({
    enabled: config.enabled,
    protocol: 'edgerunner-v1',
    profiles: getProfiles().map(publicProfile),
    events: {
      transport: 'sse',
      nativeTransport: 'sse',
    },
  });
});

router.get('/repositories', async (req, res) => {
  try {
    const response = await client.completeRepositories(
      {
        q: safeString(req.query.q),
        limit: safeString(req.query.limit) || 100,
        billing_company_id: safeString(req.query.billing_company_id),
      },
      req.user,
    );
    const repos = response?.repositories;
    res.json({
      credentialPresent: true,
      repositories: Array.isArray(repos) ? repos.map(normalizeGitHubRepo) : [],
    });
  } catch (error) {
    if (error instanceof EdgerunnerError && [401, 403, 404, 501].includes(error.status)) {
      return res.json({
        credentialPresent: false,
        repositories: [],
        message: error.message,
      });
    }
    return sendError(res, error);
  }
});

router.get('/repositories/:owner/:repo/branches', async (req, res) => {
  try {
    const response = await client.completeBranches(
      req.params.owner,
      req.params.repo,
      {
        q: safeString(req.query.q),
        limit: safeString(req.query.limit) || 100,
        billing_company_id: safeString(req.query.billing_company_id),
      },
      req.user,
    );
    res.json({
      credentialPresent: true,
      branches: Array.isArray(response?.branches) ? response.branches : [],
    });
  } catch (error) {
    if (error instanceof EdgerunnerError && [401, 403, 404, 501].includes(error.status)) {
      return res.json({
        credentialPresent: false,
        branches: [],
        message: error.message,
      });
    }
    return sendError(res, error);
  }
});

router.get('/health', async (_req, res) => {
  try {
    const health = await client.health();
    res.json({ ok: true, edgerunner: health });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/sessions', async (_req, res) => {
  try {
    res.json(sortSessionsNewestFirst(await client.listSessions()));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/sessions', async (req, res) => {
  try {
    const requestedPayload = createSessionPayload(req.body || {});
    const asyncStart = shouldStartAsync(req.body || {}, requestedPayload);
    const payload = {
      ...requestedPayload,
      ...(asyncStart && { auto_start: false }),
    };
    const session = await client.createSession(payload, req.user);
    const response = {
      ...session,
      ...(payload.prompt && !safeString(session?.prompt) && { prompt: payload.prompt }),
      ...(asyncStart && { start_pending: true }),
    };
    res.status(asyncStart ? 202 : 201).json(response);
    if (asyncStart) {
      void startSessionAsync(session.id, payload, req.user);
    }
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/sessions/:sessionId', async (req, res) => {
  try {
    res.json(await client.getSession(req.params.sessionId));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/sessions/:sessionId/messages', async (req, res) => {
  try {
    res.json(await client.listMessages(req.params.sessionId));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/sessions/:sessionId/messages', async (req, res) => {
  try {
    res.json(await client.sendMessage(req.params.sessionId, req.body || {}, req.user));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/sessions/:sessionId/events', async (req, res) => {
  const after = parseAfter(req.query.after);
  if (after === null) {
    return res.status(400).json({ message: 'Invalid after cursor' });
  }

  const wantsStream =
    req.query.stream === 'true' || String(req.headers.accept || '').includes('text/event-stream');
  if (wantsStream) {
    return streamEvents(req, res, req.params.sessionId, after);
  }

  try {
    res.json(await client.listEvents(req.params.sessionId, after));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/sessions/:sessionId/logs', async (req, res) => {
  try {
    res.json(await client.listLogs(req.params.sessionId));
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/sessions/:sessionId/artifacts', async (req, res) => {
  try {
    res.json(await client.listArtifacts(req.params.sessionId));
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/sessions/:sessionId/actions', async (req, res) => {
  try {
    if (!req.body || typeof req.body.type !== 'string') {
      throw new EdgerunnerError('Edgerunner action type is required', 400);
    }
    res.json(await actionToClientCall(req.params.sessionId, req.body, req.user));
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
