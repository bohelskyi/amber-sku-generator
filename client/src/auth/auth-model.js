export const AUTH_STATUS = Object.freeze({
  LOADING: 'loading',
  AUTHENTICATED: 'authenticated',
  PENDING: 'pending',
  DISABLED: 'disabled',
  UNAUTHENTICATED: 'unauthenticated',
  ERROR: 'error',
});

export const EMPTY_AUTH = Object.freeze({
  status: AUTH_STATUS.LOADING,
  identity: null,
  applicationUser: null,
  roles: [],
  permissions: [],
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
  const applicationUserSource = data?.applicationUser;
  const applicationUserId = Number(applicationUserSource?.id);
  const applicationUserStatus = optionalString(applicationUserSource?.status);
  if (
    !issuer
    || !sub
    || !csrfToken
    || !Number.isSafeInteger(applicationUserId)
    || applicationUserId <= 0
    || !['pending', 'active', 'disabled'].includes(applicationUserStatus)
  ) return null;

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
  const applicationUser = {
    id: applicationUserId,
    status: applicationUserStatus,
  };
  for (const key of [
    'preferredUsername',
    'displayName',
    'givenName',
    'familyName',
    'email',
  ]) {
    const value = optionalString(applicationUserSource[key]);
    if (value) applicationUser[key] = value;
  }

  const roles = Array.isArray(data.roles)
    ? data.roles.flatMap((role) => {
        const key = optionalString(role?.key);
        const displayName = optionalString(role?.displayName);
        return key && displayName ? [{ key, displayName }] : [];
      })
    : [];
  const permissions = Array.isArray(data.permissions)
    ? [...new Set(data.permissions.filter((permission) => optionalString(permission)))]
    : [];
  return { identity, applicationUser, roles, permissions, csrfToken };
}

export function getApplicationAuthStatus(applicationUser) {
  if (applicationUser?.status === 'active') return AUTH_STATUS.AUTHENTICATED;
  if (applicationUser?.status === 'pending') return AUTH_STATUS.PENDING;
  if (applicationUser?.status === 'disabled') return AUTH_STATUS.DISABLED;
  return AUTH_STATUS.ERROR;
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
