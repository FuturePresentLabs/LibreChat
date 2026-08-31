const fetch = require('node-fetch');

const DEFAULT_TIMEOUT_MS = 30000;

class EdgerunnerError extends Error {
  constructor(message, status = 502, details) {
    super(message);
    this.name = 'EdgerunnerError';
    this.status = status;
    this.details = details;
  }
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getEdgerunnerConfig(env = process.env) {
  const baseURL = trimTrailingSlash(env.EDGERUNNER_BASE_URL);
  const timeoutMs = Number.parseInt(env.EDGERUNNER_TIMEOUT_MS || '', 10);

  return {
    enabled: Boolean(baseURL),
    baseURL,
    apiToken: env.EDGERUNNER_API_TOKEN || '',
    timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

function getUserLabels(user = {}) {
  return Object.fromEntries(
    Object.entries({
      'fpl.librechat.user_id': user.id || user._id?.toString(),
      'fpl.librechat.tenant_id': user.tenantId,
      'fpl.librechat.email': user.email,
      'fpl.librechat.role': user.role,
    }).filter(([, value]) => typeof value === 'string' && value.trim() !== ''),
  );
}

function withActorLabels(body, user) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  return {
    ...body,
    labels: {
      ...(body.labels || {}),
      ...getUserLabels(user),
    },
  };
}

function normalizePath(path) {
  const value = String(path || '');
  return value.startsWith('/') ? value : `/${value}`;
}

function buildQuery(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }
  const value = query.toString();
  return value ? `?${value}` : '';
}

function identityHeaders(user = {}) {
  const email = user.email || user.openidEmail || user.username;
  const subject = user.id || user._id?.toString() || email;
  return Object.fromEntries(
    Object.entries({
      'x-fpl-user-email': email,
      'x-fpl-user-subject': subject,
    }).filter(([, value]) => typeof value === 'string' && value.trim() !== ''),
  );
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (response.status === 204) {
    return null;
  }
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

class EdgerunnerClient {
  constructor(config = getEdgerunnerConfig()) {
    this.config = config;
  }

  isEnabled() {
    return Boolean(this.config.enabled && this.config.baseURL);
  }

  async request(path, options = {}) {
    if (!this.isEnabled()) {
      throw new EdgerunnerError('Edgerunner is not configured', 404);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const headers = {
      accept: 'application/json',
      ...(options.body !== undefined && { 'content-type': 'application/json' }),
      ...(this.config.apiToken && { authorization: `Bearer ${this.config.apiToken}` }),
      ...(options.headers || {}),
    };

    try {
      const response = await fetch(`${this.config.baseURL}${normalizePath(path)}`, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const data = await parseResponse(response);

      if (!response.ok) {
        const message =
          data && typeof data === 'object' && typeof data.error === 'string'
            ? data.error
            : `Edgerunner request failed with ${response.status}`;
        throw new EdgerunnerError(message, response.status, data);
      }

      return data;
    } catch (error) {
      if (error instanceof EdgerunnerError) {
        throw error;
      }
      if (error.name === 'AbortError') {
        throw new EdgerunnerError('Edgerunner request timed out', 504);
      }
      throw new EdgerunnerError('Edgerunner request failed', 502, { message: error.message });
    } finally {
      clearTimeout(timeout);
    }
  }

  async stream(path, options = {}) {
    if (!this.isEnabled()) {
      throw new EdgerunnerError('Edgerunner is not configured', 404);
    }

    const headers = {
      accept: 'text/event-stream',
      ...(this.config.apiToken && { authorization: `Bearer ${this.config.apiToken}` }),
      ...(options.headers || {}),
    };

    try {
      const response = await fetch(`${this.config.baseURL}${normalizePath(path)}`, {
        method: options.method || 'GET',
        headers,
        signal: options.signal,
      });

      if (!response.ok) {
        const data = await parseResponse(response);
        const message =
          data && typeof data === 'object' && typeof data.error === 'string'
            ? data.error
            : `Edgerunner request failed with ${response.status}`;
        throw new EdgerunnerError(message, response.status, data);
      }

      return response;
    } catch (error) {
      if (error instanceof EdgerunnerError) {
        throw error;
      }
      if (error.name === 'AbortError') {
        throw error;
      }
      throw new EdgerunnerError('Edgerunner request failed', 502, { message: error.message });
    }
  }

  health() {
    return this.request('/healthz');
  }

  listSessions() {
    return this.request('/v1/sessions');
  }

  createSession(body, user) {
    return this.request('/v1/sessions', {
      method: 'POST',
      body: withActorLabels(body, user),
    });
  }

  getSession(sessionId) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  sendMessage(sessionId, body, user) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: withActorLabels(body, user),
    });
  }

  listEvents(sessionId, after) {
    const query = after == null ? '' : `?after=${encodeURIComponent(after)}`;
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/events${query}`);
  }

  streamEvents(sessionId, { after, lastEventId, signal } = {}, user) {
    const cursor = after != null ? after : lastEventId;
    const query = cursor == null || cursor === '' ? '' : `?after=${encodeURIComponent(cursor)}`;
    return this.stream(`/v1/sessions/${encodeURIComponent(sessionId)}/stream${query}`, {
      signal,
      headers: identityHeaders(user),
    });
  }

  listLogs(sessionId) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/logs`);
  }

  listArtifacts(sessionId) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/artifacts`);
  }

  approve(sessionId, body) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/approve`, {
      method: 'POST',
      body,
    });
  }

  cancel(sessionId, body) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: 'POST',
      body,
    });
  }

  suspend(sessionId, body) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/suspend`, {
      method: 'POST',
      body,
    });
  }

  resume(sessionId, body) {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/resume`, {
      method: 'POST',
      body,
    });
  }

  completeRepositories(query = {}, user) {
    return this.request(
      `/v1/github/repos${buildQuery({
        q: query.q,
        limit: query.limit,
        billing_company_id: query.billing_company_id,
      })}`,
      {
        headers: identityHeaders(user),
      },
    );
  }

  completeBranches(owner, repo, query = {}, user) {
    return this.request(
      `/v1/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches${buildQuery(
        {
          q: query.q,
          limit: query.limit,
          billing_company_id: query.billing_company_id,
        },
      )}`,
      {
        headers: identityHeaders(user),
      },
    );
  }
}

module.exports = {
  EdgerunnerClient,
  EdgerunnerError,
  getEdgerunnerConfig,
  getUserLabels,
  identityHeaders,
  withActorLabels,
};
