import { api } from '../lib/api';

export function createExportsApi(client = api) {
  return Object.freeze({
    getStatus: () => client.get('/export/status'),
    preview: (payload) => client.post('/export/preview', payload),
    createSnapshot: (payload, idempotencyKey) => client.post('/export/snapshots', payload, {
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
    getSnapshot: (snapshotId) => client.get(`/export/snapshots/${snapshotId}`),
    downloadMagentoArtifact: (snapshotId, groupCode) => client.get(
      `/export/snapshots/${snapshotId}/magento/${groupCode}/csv`,
      { responseType: 'blob' }
    ),
    downloadSnapshot: (snapshotId) => client.get(`/export/snapshots/${snapshotId}/csv`, {
      responseType: 'blob',
    }),
    confirmSnapshot: (snapshotId) => client.post(`/export/snapshots/${snapshotId}/confirm`),
    suggestMagentoName: (payload) => client.post('/product-magento-name/suggest', payload),
    previewMagentoName: (payload) => client.post('/product-magento-name/preview', payload),
    applyMagentoName: (payload) => client.post('/product-magento-name/apply', payload),
    getPriceStatus: () => client.get('/price-export/status'),
    createPriceSnapshot: (idempotencyKey) => client.post('/price-export/snapshots', {}, {
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
    downloadPriceSnapshot: (snapshotId) => client.get(`/price-export/snapshots/${snapshotId}/csv`, {
      responseType: 'blob',
    }),
    confirmPriceSnapshot: (snapshotId) => client.post(`/price-export/snapshots/${snapshotId}/confirm`),
  });
}

export const exportsApi = createExportsApi();
