import axios from 'axios';

const UNSAFE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

export function createApiClient({
  baseURL = import.meta.env.VITE_API_BASE_URL || '/api',
} = {}) {
  const client = axios.create({
    baseURL,
    withCredentials: true,
  });
  let getCsrfToken = null;
  let onUnauthorized = null;

  client.interceptors.request.use((config) => {
    const method = String(config.method || 'get').toLowerCase();
    const csrfToken = UNSAFE_METHODS.has(method) ? getCsrfToken?.() : null;
    if (csrfToken) {
      config.headers.set('X-CSRF-Token', csrfToken);
    }
    return config;
  });

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error?.response?.status === 401 && !error.config?.skipAuthHandling) {
        onUnauthorized?.();
      }
      return Promise.reject(error);
    }
  );

  function configureAuth(handlers = {}) {
    const registeredGetCsrfToken = typeof handlers.getCsrfToken === 'function'
      ? handlers.getCsrfToken
      : null;
    const registeredOnUnauthorized = typeof handlers.onUnauthorized === 'function'
      ? handlers.onUnauthorized
      : null;
    getCsrfToken = registeredGetCsrfToken;
    onUnauthorized = registeredOnUnauthorized;

    return () => {
      if (getCsrfToken === registeredGetCsrfToken) getCsrfToken = null;
      if (onUnauthorized === registeredOnUnauthorized) onUnauthorized = null;
    };
  }

  return { client, configureAuth };
}

const defaultApi = createApiClient();

export const api = defaultApi.client;
export const configureApiAuth = defaultApi.configureAuth;
