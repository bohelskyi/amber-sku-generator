import { api } from '../lib/api';

export function createRepricingApi(client = api) {
  return Object.freeze({
    getPublicConfig: () => client.get('/config'),
    listScenarios: () => client.get('/admin/repricing/scenarios'),
    listBatches: () => client.get('/admin/repricing/batches'),
    listDrafts: () => client.get('/admin/repricing/drafts'),
    getDraft: (draftId) => client.get(`/admin/repricing/drafts/${draftId}`),
    createDraft: (payload) => client.post('/admin/repricing/drafts', payload),
    saveDraft: (draftId, payload) => client.put(`/admin/repricing/drafts/${draftId}`, payload),
    syncDraft: (draftId) => client.post(`/admin/repricing/drafts/${draftId}/sync`),
    discardDraft: (draftId) => client.delete(`/admin/repricing/drafts/${draftId}`),
    previewScenario: (scenarioId) => client.post('/admin/repricing/preview', { scenarioId }),
    previewGlobal: () => client.post('/admin/repricing/global/preview'),
    applyScenario: (payload) => client.post('/admin/repricing/apply', payload),
    applyGlobal: (payload) => client.post('/admin/repricing/global/apply', payload),
    rollback: (batchId) => client.post(`/admin/repricing/${batchId}/rollback`),
    downloadBatch: (batchId) => client.get(`/admin/repricing/${batchId}/csv`, {
      responseType: 'blob',
    }),
    downloadRollback: (batchId) => client.get(`/admin/repricing/${batchId}/rollback-csv`, {
      responseType: 'blob',
    }),
  });
}

export const repricingApi = createRepricingApi();
