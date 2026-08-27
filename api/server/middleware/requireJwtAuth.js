const cookies = require('cookie');
const openIdClient = require('openid-client');
const passport = require('passport');
const { logger } = require('@librechat/data-schemas');
const {
  isEnabled,
  tenantContextMiddleware,
  getAuthFailureReasonCategory,
  buildSafeAuthLogContext,
  buildOpenIDRefreshParams,
  maybeRefreshCloudFrontAuthCookiesMiddleware,
  recordRumProxyRequest,
  getValidOpenIdReuseUserId,
  shouldUseSecureCookie,
} = require('@librechat/api');
const { getOpenIdConfig } = require('~/strategies');

const hasPassportStrategy = (strategy) =>
  typeof passport._strategy === 'function' && passport._strategy(strategy) != null;

const getAuthenticatedUserId = (user) => user?.id?.toString?.() ?? user?._id?.toString?.();
const refreshCloudFrontCookies =
  maybeRefreshCloudFrontAuthCookiesMiddleware ?? ((_req, _res, next) => next());
const ACCOUNT_DELETION_CODE = 'ACCOUNT_DELETION_IN_PROGRESS';

function decodeJwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

function setRecoveredOpenIDCookie(res, name, value) {
  if (!value || !isEnabled(process.env.OPENID_ACCESS_TOKEN_COOKIE_FALLBACK)) {
    return;
  }
  const expiryMs = Number(process.env.REFRESH_TOKEN_EXPIRY) || 7 * 24 * 60 * 60 * 1000;
  res.cookie(name, value, {
    expires: new Date(Date.now() + expiryMs),
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
  });
}

function applyOpenIDFederatedTokens(user, accessToken, idToken, refreshToken) {
  if (!accessToken) {
    return;
  }
  user.federatedTokens = {
    access_token: accessToken,
    id_token: idToken,
    refresh_token: refreshToken,
    expires_at: decodeJwtExpiry(accessToken),
  };
}

function hydrateOpenIDFederatedTokens({ req, res, user, parsedCookies, openIdReuseUserId }) {
  if (
    !isEnabled(process.env.OPENID_REUSE_TOKENS) ||
    !isEnabled(process.env.OPENID_ACCESS_TOKEN_COOKIE_FALLBACK) ||
    getAuthenticatedUserId(user) !== openIdReuseUserId
  ) {
    return;
  }

  const sessionTokens = req.session?.openidTokens;
  let accessToken = sessionTokens?.accessToken || parsedCookies.openid_access_token;
  let idToken = sessionTokens?.idToken || parsedCookies.openid_id_token;
  let refreshToken = sessionTokens?.refreshToken || parsedCookies.refreshToken;

  if (!accessToken && refreshToken) {
    return openIdClient
      .refreshTokenGrant(
        getOpenIdConfig(),
        refreshToken,
        buildOpenIDRefreshParams(),
      )
      .then((tokenset) => {
        accessToken = tokenset.access_token || accessToken;
        idToken = tokenset.id_token || idToken;
        refreshToken = tokenset.refresh_token || refreshToken;

        if (req.session) {
          req.session.openidTokens = {
            accessToken,
            idToken,
            refreshToken,
            expiresAt: sessionTokens?.expiresAt,
            lastRefreshedAt: Date.now(),
          };
        }
        setRecoveredOpenIDCookie(res, 'openid_access_token', accessToken);
        setRecoveredOpenIDCookie(res, 'openid_id_token', idToken);
        setRecoveredOpenIDCookie(res, 'refreshToken', refreshToken);
        applyOpenIDFederatedTokens(user, accessToken, idToken, refreshToken);
        logger.debug('[requireJwtAuth] recovered OpenID access token for request context', {
          has_access_token: Boolean(accessToken),
          has_id_token: Boolean(idToken),
          has_refresh_token: Boolean(refreshToken),
        });
      })
      .catch((error) => {
        logger.warn('[requireJwtAuth] OpenID access token recovery failed', {
          message: error?.message,
        });
      });
  }

  applyOpenIDFederatedTokens(user, accessToken, idToken, refreshToken);
}

const getAuthTokenSource = (req) => {
  const authorization = req.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  return typeof value === 'string' && /^Bearer\s+/i.test(value) ? 'bearer' : 'none';
};

const getAuthStrategies = (req) => {
  const cookieHeader = req.headers.cookie;
  const parsedCookies = cookieHeader ? cookies.parse(cookieHeader) : {};
  const tokenProvider = parsedCookies.token_provider;
  const openidReuseEnabled = isEnabled(process.env.OPENID_REUSE_TOKENS);
  const openidJwtAvailable = openidReuseEnabled && hasPassportStrategy('openidJwt');
  const openIdReuseUserId = getValidOpenIdReuseUserId(parsedCookies.openid_user_id);
  const useOpenIdJwt =
    tokenProvider === 'openid' && openidJwtAvailable && openIdReuseUserId != null;

  return {
    tokenProvider,
    tokenSource: getAuthTokenSource(req),
    openidReuseEnabled,
    openidJwtAvailable,
    openIdReuseUserId,
    parsedCookies,
    strategies: useOpenIdJwt ? ['openidJwt', 'jwt'] : ['jwt'],
  };
};

const dropRumTelemetry = (res) => {
  if (!res.headersSent) {
    res.status(204).end();
  }
};

// Keep in sync with packages/api/src/rum/proxy.ts; auth drops are recorded before proxy code runs.
const getRumProxyEndpoint = (req) => {
  if (req.path === '/v1/traces') {
    return 'traces';
  }
  if (req.path === '/v1/logs') {
    return 'logs';
  }
  return 'unknown';
};

const isOpenIdReuseUser = (strategy, user, openIdReuseUserId) =>
  strategy !== 'openidJwt' || getAuthenticatedUserId(user) === openIdReuseUserId;

/**
 * Custom Middleware to handle JWT authentication, with support for OpenID token reuse.
 * Switches between JWT and OpenID authentication based on cookies and environment settings.
 *
 * After successful authentication (req.user populated), automatically chains into
 * `tenantContextMiddleware` to propagate request context into AsyncLocalStorage
 * for downstream Mongoose tenant isolation and structured logging.
 */
const requireJwtAuth = (req, res, next) => {
  const {
    tokenProvider,
    tokenSource,
    openidReuseEnabled,
    openidJwtAvailable,
    openIdReuseUserId,
    parsedCookies,
    strategies,
  } = getAuthStrategies(req);
  const authLogState = {
    tokenProvider,
    tokenSource,
    openidReuseEnabled,
    openidJwtAvailable,
    hasOpenIdReuseUserId: openIdReuseUserId != null,
  };
  let primaryFailureReasonCategory;
  let fallbackAttempted = false;

  const logOpenIdFallbackAttempt = ({ fallbackStrategy, reasonCategory, status }) => {
    primaryFailureReasonCategory = reasonCategory;
    fallbackAttempted = true;
    const message = '[requireJwtAuth] OpenID JWT auth failed; trying fallback';
    const context = buildSafeAuthLogContext(req, authLogState, {
      event_name: 'jwt_auth_fallback_attempt',
      primary_strategy: 'openidJwt',
      fallback_strategy: fallbackStrategy,
      fallback_attempted: true,
      reason_category: reasonCategory,
      recovery_classification: 'fallback_attempted',
      strategy_status: status,
    });
    logger.debug({ message, ...context });
  };

  const logAuthenticationFailure = ({ strategy, info, status, err }) => {
    const message = '[requireJwtAuth] Authentication failed after all strategies';
    const reasonCategory = getAuthFailureReasonCategory(err, info);
    const context = buildSafeAuthLogContext(req, authLogState, {
      event_name: 'jwt_auth_rejected',
      primary_strategy: strategies[0],
      fallback_strategy: strategies[1],
      fallback_attempted: fallbackAttempted,
      fallback_succeeded: false,
      attempted_strategies: strategies,
      final_strategy: strategy,
      ...(fallbackAttempted && {
        primary_failure_reason_category: primaryFailureReasonCategory,
      }),
      reason_category: reasonCategory,
      recovery_classification: 'terminal_rejection',
      response_status: status || 401,
    });
    const log =
      fallbackAttempted || reasonCategory === 'malformed_jwt' ? logger.warn : logger.debug;
    log.call(logger, { message, ...context });
  };

  const logFallbackSuccess = (strategy) => {
    if (!fallbackAttempted || strategy !== 'jwt') {
      return;
    }
    const message = '[requireJwtAuth] JWT fallback succeeded after OpenID JWT failure';
    const context = buildSafeAuthLogContext(req, authLogState, {
      event_name: 'jwt_auth_recovered',
      auth_strategy: 'jwt',
      primary_strategy: 'openidJwt',
      fallback_strategy: 'jwt',
      fallback_attempted: true,
      fallback_succeeded: true,
      primary_failure_reason_category: primaryFailureReasonCategory,
      recovery_classification: 'fallback_succeeded',
    });
    logger.debug({ message, ...context });
  };

  const authenticateWithStrategy = (index) => {
    const strategy = strategies[index];
    passport.authenticate(strategy, { session: false }, (err, user, info, status) => {
      if (err) {
        return next(err);
      }
      if (!user) {
        if (index + 1 < strategies.length) {
          logOpenIdFallbackAttempt({
            fallbackStrategy: strategies[index + 1],
            reasonCategory: getAuthFailureReasonCategory(err, info),
            status: status || 401,
          });
          return authenticateWithStrategy(index + 1);
        }
        logAuthenticationFailure({ strategy, info, status, err });
        return res.status(status || 401).json({
          message: info?.message || 'Unauthorized',
          ...(info?.code === ACCOUNT_DELETION_CODE && { code: ACCOUNT_DELETION_CODE }),
        });
      }
      if (strategy === 'openidJwt' && getAuthenticatedUserId(user) !== openIdReuseUserId) {
        if (index + 1 < strategies.length) {
          logOpenIdFallbackAttempt({
            fallbackStrategy: strategies[index + 1],
            reasonCategory: 'principal_mismatch',
            status: 401,
          });
          return authenticateWithStrategy(index + 1);
        }
        logAuthenticationFailure({ strategy, info, status: 401, err });
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const completeAuthentication = () => {
        req.user = user;
        req.authStrategy = strategy;
        logFallbackSuccess(strategy);
        tenantContextMiddleware(req, res, (tenantErr) => {
          if (tenantErr) {
            return next(tenantErr);
          }
          refreshCloudFrontCookies(req, res, next);
        });
      };

      if (tokenProvider === 'openid') {
        const hydration = hydrateOpenIDFederatedTokens({
          req,
          res,
          user,
          parsedCookies,
          openIdReuseUserId,
        });
        if (hydration?.then) {
          hydration.then(completeAuthentication).catch(next);
          return;
        }
      }

      completeAuthentication();
    })(req, res, next);
  };

  authenticateWithStrategy(0);
};

const requireRumProxyAuth = (req, res, next) => {
  const { openIdReuseUserId, strategies } = getAuthStrategies(req);
  const endpoint = getRumProxyEndpoint(req);
  let authErrorSeen = false;

  const dropTelemetry = () => {
    recordRumProxyRequest(endpoint, authErrorSeen ? 'auth_error' : 'auth_drop');
    dropRumTelemetry(res);
  };

  const finishAuthentication = (strategy, user) => {
    req.user = user;
    req.authStrategy = strategy;
    next();
  };

  let nextStrategyIndex = 0;
  const tryNextStrategy = () => {
    const strategy = strategies[nextStrategyIndex];
    nextStrategyIndex += 1;

    if (!strategy) {
      dropTelemetry();
      return;
    }

    passport.authenticate(strategy, { session: false }, (err, user) => {
      authErrorSeen = authErrorSeen || err != null;
      if (err || !user || !isOpenIdReuseUser(strategy, user, openIdReuseUserId)) {
        tryNextStrategy();
        return;
      }

      finishAuthentication(strategy, user);
    })(req, res, next);
  };

  tryNextStrategy();
};

module.exports = requireJwtAuth;
module.exports.requireRumProxyAuth = requireRumProxyAuth;
