import { api } from '../lib/api';

export function createCorrectionsApi(client = api) {
  return Object.freeze({
    getPublicConfig: () => client.get('/config'),
    listRequests: (status) => client.get('/admin/correction-requests', { params: { status } }),
    claimRequest: (requestId) => client.post(`/admin/correction-requests/${requestId}/claim`),
    releaseRequest: (requestId, claimVersion, headers = {}) => client.post(
      `/admin/correction-requests/${requestId}/release`,
      { claimVersion },
      { headers }
    ),
    forceReleaseRequest: (requestId, claimVersion) => client.post(
      `/admin/correction-requests/${requestId}/force-release`,
      { confirm: true, claimVersion }
    ),
    updateRequestStatus: (requestId, status, claimVersion, headers = {}) => client.patch(
      `/admin/correction-requests/${requestId}/status`,
      { status, claimVersion },
      { headers }
    ),
    refreshRequest: (requestId, claimVersion, headers = {}) => client.post(
      `/admin/correction-requests/${requestId}/refresh`,
      { claimVersion },
      { headers }
    ),
    completeRequest: (requestId, claimVersion, headers = {}) => client.post(
      `/admin/correction-requests/${requestId}/complete`,
      { claimVersion },
      { headers }
    ),
    listHistory: (params) => client.get('/admin/product-corrections', { params }),
    exportHistory: (params) => client.get('/admin/product-corrections/csv', {
      params,
      responseType: 'blob',
    }),
  });
}

export const correctionsApi = createCorrectionsApi();
