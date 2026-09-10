const crypto = require('node:crypto');

const IDENTITY_OPTIONAL_FIELDS = [
  'preferred_username',
  'name',
  'given_name',
  'family_name',
  'email',
];

function copyOptionalStringFields(source, target) {
  for (const field of IDENTITY_OPTIONAL_FIELDS) {
    if (typeof source[field] === 'string' && source[field].trim()) {
      target[field] = source[field];
    }
  }
}

function normalizeIdentity(claims, { expectedIssuer, authenticatedAt = new Date() }) {
  if (!claims || typeof claims !== 'object') throw new Error('OIDC identity claims are missing');
  if (typeof claims.iss !== 'string' || claims.iss !== expectedIssuer) {
    throw new Error('OIDC issuer is invalid');
  }
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) {
    throw new Error('OIDC subject is missing');
  }

  const identity = {
    issuer: claims.iss,
    sub: claims.sub,
  };
  copyOptionalStringFields(claims, identity);
  identity.authenticatedAt = authenticatedAt.toISOString();
  return identity;
}

function readSessionIdentity(session) {
  const stored = session?.identity;
  if (!stored || typeof stored !== 'object') return null;
  if (typeof stored.issuer !== 'string' || !stored.issuer) return null;
  if (typeof stored.sub !== 'string' || !stored.sub.trim()) return null;
  if (typeof stored.authenticatedAt !== 'string' || !stored.authenticatedAt) return null;

  const identity = {
    issuer: stored.issuer,
    sub: stored.sub,
  };
  copyOptionalStringFields(stored, identity);
  identity.authenticatedAt = stored.authenticatedAt;
  return identity;
}

function requireAuthenticatedSession(req, res, next) {
  const identity = readSessionIdentity(req.session);
  if (!identity) {
    res.set('Cache-Control', 'no-store');
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.user = identity;
  return next();
}

function tokensEqual(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const receivedBuffer = Buffer.from(received, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return receivedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function requireCsrfToken(req, res, next) {
  if (!tokensEqual(req.get('X-CSRF-Token'), req.session?.csrfToken)) {
    res.set('Cache-Control', 'no-store');
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  return next();
}

function requireCsrfForUnsafeMethods(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return requireCsrfToken(req, res, next);
}

module.exports = {
  IDENTITY_OPTIONAL_FIELDS,
  normalizeIdentity,
  readSessionIdentity,
  requireAuthenticatedSession,
  requireCsrfForUnsafeMethods,
  requireCsrfToken,
  tokensEqual,
};
