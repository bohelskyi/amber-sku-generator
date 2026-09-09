const crypto = require('node:crypto');
const express = require('express');
const env = require('../config/env');
const {
  SESSION_COOKIE_NAME,
  buildCookieOptions,
} = require('../auth/session');
const { createOidcAdapter } = require('../auth/oidc-adapter');
const {
  normalizeIdentity,
  requireAuthenticatedSession,
  requireCsrfToken,
  tokensEqual,
} = require('../auth/authentication');
const logger = require('../utils/logger');

const OIDC_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const MAX_RETURN_TO_LENGTH = 2048;

function randomBase64Url(byteLength) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function isUnsafeDecodedReturnTo(value) {
  return !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(value);
}

function normalizeReturnTo(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_RETURN_TO_LENGTH) return '/';

  let decoded = value;
  for (let index = 0; index < 3; index += 1) {
    if (isUnsafeDecodedReturnTo(decoded)) return '/';
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return '/';
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (isUnsafeDecodedReturnTo(decoded)) return '/';

  try {
    const base = new URL('https://return.invalid/');
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin) return '/';
  } catch {
    return '/';
  }
  return value;
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

function getCallbackUrl(req, redirectUri) {
  const callbackUrl = new URL(redirectUri);
  const queryIndex = req.originalUrl.indexOf('?');
  callbackUrl.search = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex + 1);
  return callbackUrl;
}

function validateTransaction(transaction, receivedState, now, transactionTtlMs) {
  if (!transaction || typeof transaction !== 'object') return false;
  if (!tokensEqual(receivedState, transaction.state)) return false;
  if (!Number.isFinite(transaction.createdAt)) return false;
  const age = now - transaction.createdAt;
  if (age < 0 || age > transactionTtlMs) return false;
  return typeof transaction.nonce === 'string'
    && transaction.nonce.length > 0
    && typeof transaction.codeVerifier === 'string'
    && transaction.codeVerifier.length > 0
    && typeof transaction.returnTo === 'string';
}

function createAuthRouter({
  oidcAdapter = createOidcAdapter(),
  now = () => Date.now(),
  randomToken = randomBase64Url,
  transactionTtlMs = OIDC_TRANSACTION_TTL_MS,
  sessionCookieSecure = env.sessionCookieSecure,
  applicationBaseUrl = env.appBaseUrl,
} = {}) {
  const router = express.Router();

  router.get('/login', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const transaction = {
      state: randomToken(32),
      nonce: randomToken(32),
      codeVerifier: randomToken(64),
      returnTo: normalizeReturnTo(req.query.returnTo),
      createdAt: now(),
    };

    try {
      const authorizationUrl = await oidcAdapter.buildAuthorizationRedirect(transaction);
      req.session.oidcTransaction = transaction;
      await saveSession(req);
      return res.redirect(authorizationUrl.toString());
    } catch (error) {
      logger.warn('auth.login.unavailable', {
        requestId: req.requestId,
        errorType: error?.name || 'Error',
      });
      return res.status(503).json({ error: 'Authentication service unavailable' });
    }
  });

  router.get('/callback', async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    const transaction = req.session.oidcTransaction;
    if (!transaction || typeof transaction !== 'object') {
      return res.status(400).json({ error: 'Invalid or expired authentication transaction' });
    }
    delete req.session.oidcTransaction;

    try {
      await saveSession(req);
    } catch (error) {
      return next(error);
    }

    if (!validateTransaction(transaction, req.query.state, now(), transactionTtlMs)) {
      return res.status(400).json({ error: 'Invalid or expired authentication transaction' });
    }
    if (typeof req.query.error === 'string') {
      logger.warn('auth.callback.provider_error', { requestId: req.requestId });
      return res.status(400).json({ error: 'Authentication failed' });
    }

    try {
      const claims = await oidcAdapter.exchangeAuthorizationCode({
        callbackUrl: getCallbackUrl(req, oidcAdapter.redirectUri),
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
      });
      const identity = normalizeIdentity(claims, {
        expectedIssuer: oidcAdapter.issuer,
        authenticatedAt: new Date(now()),
      });
      await regenerateSession(req);
      req.session.identity = identity;
      req.session.csrfToken = randomToken(32);
      await saveSession(req);
      return res.redirect(303, new URL(transaction.returnTo, applicationBaseUrl).toString());
    } catch (error) {
      logger.warn('auth.callback.rejected', {
        requestId: req.requestId,
        errorType: error?.name || 'Error',
      });
      return res.status(400).json({ error: 'Authentication failed' });
    }
  });

  router.get('/me', requireAuthenticatedSession, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (typeof req.session.csrfToken !== 'string' || !req.session.csrfToken) {
        req.session.csrfToken = randomToken(32);
        await saveSession(req);
      }
      return res.json({ identity: req.user, csrfToken: req.session.csrfToken });
    } catch (error) {
      return next(error);
    }
  });

  router.post(
    '/logout',
    requireAuthenticatedSession,
    requireCsrfToken,
    async (req, res, next) => {
      res.set('Cache-Control', 'no-store');
      let logoutUrl = null;
      try {
        logoutUrl = (await oidcAdapter.buildLogoutRedirect())?.toString() || null;
      } catch (error) {
        logger.warn('auth.logout.provider_unavailable', {
          requestId: req.requestId,
          errorType: error?.name || 'Error',
        });
      }

      try {
        await destroySession(req);
        res.clearCookie(
          SESSION_COOKIE_NAME,
          buildCookieOptions({ secure: sessionCookieSecure })
        );
        return res.status(200).json({ logoutUrl });
      } catch (error) {
        return next(error);
      }
    }
  );

  return router;
}

module.exports = {
  OIDC_TRANSACTION_TTL_MS,
  MAX_RETURN_TO_LENGTH,
  normalizeReturnTo,
  validateTransaction,
  getCallbackUrl,
  createAuthRouter,
};
