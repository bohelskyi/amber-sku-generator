import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, configureApiAuth } from '../lib/api.js';
import { AuthContext } from './auth-context.js';
import {
  AUTH_STATUS,
  EMPTY_AUTH,
  getApplicationAuthStatus,
  getCurrentReturnTo,
  normalizeCurrentSession,
} from './auth-model.js';

export function AuthProvider({
  children,
  apiClient = api,
  bindApiAuth = configureApiAuth,
  locationObject = globalThis.location,
}) {
  const [auth, setAuth] = useState(EMPTY_AUTH);
  const csrfTokenRef = useRef(null);
  const latestRequestRef = useRef(0);
  const principalRef = useRef({ id: null, valid: false });

  const invalidatePrincipal = useCallback(() => {
    principalRef.current.valid = false;
    principalRef.current = { id: null, valid: false };
  }, []);

  const markUnauthenticated = useCallback(() => {
    invalidatePrincipal();
    latestRequestRef.current += 1;
    csrfTokenRef.current = null;
    setAuth({
      status: AUTH_STATUS.UNAUTHENTICATED,
      identity: null,
      applicationUser: null,
      roles: [],
      permissions: [],
      csrfToken: null,
      errorMessage: null,
    });
  }, [invalidatePrincipal]);

  const markAccessStatus = useCallback((applicationUserStatus) => {
    if (!['pending', 'disabled'].includes(applicationUserStatus)) return;
    invalidatePrincipal();
    latestRequestRef.current += 1;
    setAuth((currentAuth) => {
      if (!currentAuth.identity || !currentAuth.applicationUser) return currentAuth;
      return {
        ...currentAuth,
        status: applicationUserStatus === 'pending'
          ? AUTH_STATUS.PENDING
          : AUTH_STATUS.DISABLED,
        applicationUser: {
          ...currentAuth.applicationUser,
          status: applicationUserStatus,
        },
        roles: [],
        permissions: [],
        errorMessage: null,
      };
    });
  }, [invalidatePrincipal]);

  const loadCurrentSession = useCallback(async () => {
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    try {
      const response = await apiClient.get('/auth/me', { skipAuthHandling: true });
      if (latestRequestRef.current !== requestId) return;
      const currentSession = normalizeCurrentSession(response.data);
      if (!currentSession) throw new Error('Invalid current-session response');
      const id = currentSession.applicationUser?.status === 'active' ? String(currentSession.applicationUser.id) : null;
      if (principalRef.current.id !== id || !principalRef.current.valid) {
        invalidatePrincipal();
        principalRef.current = { id, valid: id !== null };
      }
      csrfTokenRef.current = currentSession.csrfToken;
      setAuth({
        status: getApplicationAuthStatus(currentSession.applicationUser),
        ...currentSession,
        principalLifetime: principalRef.current,
        errorMessage: null,
      });
    } catch (error) {
      if (latestRequestRef.current !== requestId) return;
      if (error?.response?.status === 401) {
        markUnauthenticated();
        return;
      }
      csrfTokenRef.current = null;
      invalidatePrincipal();
      setAuth({
        status: AUTH_STATUS.ERROR,
        identity: null,
        applicationUser: null,
        roles: [],
        permissions: [],
        csrfToken: null,
        errorMessage: 'Не вдалося перевірити сеанс. Спробуйте ще раз.',
      });
    }
  }, [apiClient, markUnauthenticated, invalidatePrincipal]);

  useEffect(() => {
    const removeApiAuth = bindApiAuth({
      getCsrfToken: () => csrfTokenRef.current,
      getPrincipalLifetime: () => principalRef.current,
      onAccessStatusChange: markAccessStatus,
      onUnauthorized: markUnauthenticated,
    });
    const bootstrapTimer = globalThis.setTimeout(() => {
      void loadCurrentSession();
    }, 0);
    return () => {
      globalThis.clearTimeout(bootstrapTimer);
      latestRequestRef.current += 1;
      removeApiAuth();
    };
  }, [bindApiAuth, loadCurrentSession, markAccessStatus, markUnauthenticated]);

  const retry = useCallback(() => {
    setAuth(EMPTY_AUTH);
    void loadCurrentSession();
  }, [loadCurrentSession]);

  const startLogin = useCallback((endpoint) => {
    const returnTo = getCurrentReturnTo(locationObject);
    locationObject.assign(`${endpoint}?returnTo=${encodeURIComponent(returnTo)}`);
  }, [locationObject]);

  const login = useCallback(() => {
    startLogin('/api/auth/login');
  }, [startLogin]);

  const loginWithWindows = useCallback(() => {
    startLogin('/api/auth/login/windows');
  }, [startLogin]);

  const logout = useCallback(async () => {
    const response = await apiClient.post('/auth/logout');
    const logoutUrl = typeof response.data?.logoutUrl === 'string' && response.data.logoutUrl
      ? response.data.logoutUrl
      : null;
    markUnauthenticated();
    locationObject.assign(logoutUrl || '/');
  }, [apiClient, locationObject, markUnauthenticated]);

  const value = useMemo(() => ({
    ...auth,
    authenticated: [
      AUTH_STATUS.AUTHENTICATED,
      AUTH_STATUS.PENDING,
      AUTH_STATUS.DISABLED,
    ].includes(auth.status),
    login,
    loginWithWindows,
    logout,
    refresh: loadCurrentSession,
    retry,
    markUnauthenticated,
  }), [
    auth,
    loadCurrentSession,
    login,
    loginWithWindows,
    logout,
    markUnauthenticated,
    retry,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
