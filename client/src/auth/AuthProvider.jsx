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

  const markUnauthenticated = useCallback(() => {
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
  }, []);

  const loadCurrentSession = useCallback(async () => {
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    try {
      const response = await apiClient.get('/auth/me', { skipAuthHandling: true });
      if (latestRequestRef.current !== requestId) return;
      const currentSession = normalizeCurrentSession(response.data);
      if (!currentSession) throw new Error('Invalid current-session response');
      csrfTokenRef.current = currentSession.csrfToken;
      setAuth({
        status: getApplicationAuthStatus(currentSession.applicationUser),
        ...currentSession,
        errorMessage: null,
      });
    } catch (error) {
      if (latestRequestRef.current !== requestId) return;
      if (error?.response?.status === 401) {
        markUnauthenticated();
        return;
      }
      csrfTokenRef.current = null;
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
  }, [apiClient, markUnauthenticated]);

  useEffect(() => {
    const removeApiAuth = bindApiAuth({
      getCsrfToken: () => csrfTokenRef.current,
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
  }, [bindApiAuth, loadCurrentSession, markUnauthenticated]);

  const retry = useCallback(() => {
    setAuth(EMPTY_AUTH);
    void loadCurrentSession();
  }, [loadCurrentSession]);

  const login = useCallback(() => {
    const returnTo = getCurrentReturnTo(locationObject);
    locationObject.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [locationObject]);

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
    logout,
    retry,
    markUnauthenticated,
  }), [auth, login, logout, markUnauthenticated, retry]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
