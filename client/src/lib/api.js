import axios from 'axios';
import { notifyExportReviewChanged } from './export-review-events';

const UNSAFE_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const ACCESS_STATUS_BY_ERROR_CODE = Object.freeze({
  APP_ACCESS_DISABLED: 'disabled',
  APP_ACCESS_PENDING: 'pending',
});

export function createApiClient({
  baseURL = import.meta.env.VITE_API_BASE_URL || '/api',
} = {}) {
  const client = axios.create({
    baseURL,
    withCredentials: true,
  });
  let getCsrfToken = null;
  let onUnauthorized = null;
  let onAccessStatusChange = null;
  let getPrincipalLifetime = null;

  client.interceptors.request.use((config) => {
    config.applicationPrincipal = getPrincipalLifetime?.();
    const method = String(config.method || 'get').toLowerCase();
    const csrfToken = UNSAFE_METHODS.has(method) ? getCsrfToken?.() : null;
    if (csrfToken) {
      config.headers.set('X-CSRF-Token', csrfToken);
    }
    return config;
  }, undefined, { synchronous: true });

  client.interceptors.response.use(
    (response) => {
      const config = response.config;
      const current = !config?.applicationPrincipal || (config.applicationPrincipal.valid && config.applicationPrincipal === getPrincipalLifetime?.());
      // Preview and metadata commands do not invalidate a review. Successful domain
      // writes require an explicit recheck; no row is patched in the browser.
      if (current && UNSAFE_METHODS.has(String(config?.method).toLowerCase())
        && /(?:\/(?:save|delete|archive|apply|complete|rollback|publish)|\/activation|\/product-magento-name\/apply)$/.test(config?.url || '')) notifyExportReviewChanged({ kind: /export-templates/.test(config?.url || '') ? 'configuration' : 'product' });
      return response;
    },
    (error) => {
      const dispatchedPrincipal = error.config?.applicationPrincipal;
      const currentPrincipal = !dispatchedPrincipal || (dispatchedPrincipal.valid && dispatchedPrincipal === getPrincipalLifetime?.());
      if (currentPrincipal && error?.response?.status === 401 && !error.config?.skipAuthHandling) {
        onUnauthorized?.();
      }
      const accessStatus = error?.response?.status === 403
        ? ACCESS_STATUS_BY_ERROR_CODE[error.response?.data?.code]
        : null;
      if (currentPrincipal && accessStatus && !error.config?.skipAuthHandling) {
        onAccessStatusChange?.(accessStatus);
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
    const registeredOnAccessStatusChange = typeof handlers.onAccessStatusChange === 'function'
      ? handlers.onAccessStatusChange
      : null;
    const registeredGetPrincipalLifetime = typeof handlers.getPrincipalLifetime === 'function' ? handlers.getPrincipalLifetime : null;
    getCsrfToken = registeredGetCsrfToken;
    onUnauthorized = registeredOnUnauthorized;
    onAccessStatusChange = registeredOnAccessStatusChange;
    getPrincipalLifetime = registeredGetPrincipalLifetime;

    return () => {
      if (getCsrfToken === registeredGetCsrfToken) getCsrfToken = null;
      if (onUnauthorized === registeredOnUnauthorized) onUnauthorized = null;
      if (onAccessStatusChange === registeredOnAccessStatusChange) onAccessStatusChange = null;
      if (getPrincipalLifetime === registeredGetPrincipalLifetime) getPrincipalLifetime = null;
    };
  }

  return { client, configureAuth };
}

const defaultApi = createApiClient();

export const api = defaultApi.client;
export const configureApiAuth = defaultApi.configureAuth;
