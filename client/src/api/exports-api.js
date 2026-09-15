import { api } from '../lib/api';

export function createExportsApi(client = api) {
  return Object.freeze({
    getStatus: () => client.get('/export/status'),
    createSnapshot: (payload, idempotencyKey) => client.post('/export/snapshots', payload, {
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
    downloadSnapshot: (snapshotId) => client.get(`/export/snapshots/${snapshotId}/csv`, {
      responseType: 'blob',
    }),
    confirmSnapshot: (snapshotId) => client.post(`/export/snapshots/${snapshotId}/confirm`),
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
