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
  });
}

export const exportsApi = createExportsApi();
