export const AUTH_STATUS = Object.freeze({
  LOADING: 'loading',
  AUTHENTICATED: 'authenticated',
  UNAUTHENTICATED: 'unauthenticated',
  ERROR: 'error',
});

export const EMPTY_AUTH = Object.freeze({
  status: AUTH_STATUS.LOADING,
  identity: null,
  csrfToken: null,
  errorMessage: null,
});

function optionalString(value) {
  return typeof value === 'string' && value ? value : undefined;
}

export function normalizeCurrentSession(data) {
  const source = data?.identity;
  if (!source || typeof source !== 'object') return null;
  const issuer = optionalString(source.issuer);
  const sub = optionalString(source.sub);
  const csrfToken = optionalString(data.csrfToken);
  if (!issuer || !sub || !csrfToken) return null;

  const identity = { issuer, sub };
  for (const key of [
    'preferred_username',
    'name',
    'given_name',
    'family_name',
    'email',
    'authenticatedAt',
  ]) {
    const value = optionalString(source[key]);
    if (value) identity[key] = value;
  }
  return { identity, csrfToken };
}

export function getIdentityDisplayName(identity) {
  return identity?.name || identity?.preferred_username || 'Користувач';
}

export function getCurrentReturnTo(locationObject = globalThis.location) {
  const pathname = locationObject?.pathname;
  if (
    typeof pathname !== 'string'
    || !pathname.startsWith('/')
    || pathname.startsWith('//')
    || pathname.includes('\\')
  ) return '/';
  return `${pathname}${locationObject?.search || ''}${locationObject?.hash || ''}`;
}
