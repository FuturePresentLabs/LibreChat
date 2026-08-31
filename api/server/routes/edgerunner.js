const express = require('express');
const fetch = require('node-fetch');
const { generateCheckAccess } = require('@librechat/api');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const { getRoleByName } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');
const {
  EdgerunnerClient,
  EdgerunnerError,
  getEdgerunnerConfig,
} = require('~/server/services/Edgerunner/client');

const EVENT_POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 15000;
const GITHUB_API_BASE = 'https://api.github.com';

const DEFAULT_PROFILES = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'General coding agent',
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

  const run = {
    ...profileRun,
    ...(safeString(profile.model) && { model: safeString(profile.model) }),
    ...(safeString(profile.agent) && { agent: safeString(profile.agent) }),
    retention: safeString(profileRun.retention) || 'snapshot',
  };

  const payload = {
    ...(safeString(body.repo_url) && { repo_url: safeString(body.repo_url) }),
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

function githubToken(req) {
  return (
    safeString(process.env.EDGERUNNER_GITHUB_TOKEN) ||
    safeString(process.env.GITHUB_TOKEN) ||
    safeString(process.env.GH_TOKEN) ||
    safeString(process.env.GITHUB_SKILLS_TOKEN) ||
    safeString(req.user?.federatedTokens?.access_token) ||
    safeString(req.user?.openidTokens?.access_token)
  );
}

async function githubJson(path, token) {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new EdgerunnerError('GitHub repository lookup failed', response.status, data);
  }
  return data;
}

function normalizeGitHubRepo(repo) {
  return {
    id: String(repo.id),
    name: repo.name,
    full_name: repo.full_name,
    private: Boolean(repo.private),
    default_branch: repo.default_branch || 'main',
    html_url: repo.html_url,
    clone_url: repo.clone_url,
    ssh_url: repo.ssh_url,
    pushed_at: repo.pushed_at,
    owner: repo.owner?.login,
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

function eventId(event) {
  if (event && Number.isSafeInteger(event.id)) {
    return event.id;
  }
  if (event && typeof event.id === 'string' && /^\d+$/.test(event.id)) {
    return Number.parseInt(event.id, 10);
  }
  return undefined;
}

function writeSse(res, event, data, id) {
  if (id != null) {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamEvents(req, res, sessionId, initialAfter) {
  let after = initialAfter;
  let closed = false;

  res.status(200);
  res.set({
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  writeSse(res, 'ready', { sessionId, after });

  req.on('close', () => {
    closed = true;
  });

  const poll = async () => {
    if (closed) {
      return;
    }

    try {
      const events = await client.listEvents(sessionId, after);
      const items = Array.isArray(events) ? events : events?.events || [];
      for (const item of items) {
        const id = eventId(item);
        writeSse(res, 'edgerunner.event', item, id);
        if (id != null && (after == null || id > after)) {
          after = id;
        }
      }
    } catch (error) {
      writeSse(res, 'error', {
        message:
          error instanceof EdgerunnerError ? error.message : 'Edgerunner event stream failed',
      });
      closed = true;
      res.end();
    }
  };

  await poll();

  const pollTimer = setInterval(poll, EVENT_POLL_INTERVAL_MS);
  const heartbeatTimer = setInterval(() => {
    if (!closed) {
      writeSse(res, 'heartbeat', { ts: Date.now(), after });
    }
  }, HEARTBEAT_INTERVAL_MS);

  req.on('close', () => {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
  });
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
      nativeTransport: 'polling',
    },
  });
});

router.get('/repositories', async (req, res) => {
  const token = githubToken(req);
  if (!token) {
    return res.json({ repositories: [], credentialPresent: false });
  }

  try {
    const repos = await githubJson(
      '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
      token,
    );
    res.json({
      credentialPresent: true,
      repositories: Array.isArray(repos) ? repos.map(normalizeGitHubRepo) : [],
    });
  } catch (error) {
    sendError(res, error);
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
    res.json(await client.listSessions());
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/sessions', async (req, res) => {
  try {
    const payload = createSessionPayload(req.body || {});
    const session = await client.createSession(payload, req.user);
    res.status(201).json(session);
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
