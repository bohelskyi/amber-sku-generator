import { api } from '../lib/api';
const root = '/export/sessions';
export const exportSessionsApi = Object.freeze({
  list: (scope, after = '') => api.get(root, { params: { scope, after, limit: 20 } }),
  create: (body) => api.post(root, body),
  get: (id) => api.get(`${root}/${id}`),
  save: (id, body) => api.put(`${root}/${id}`, body),
  preview: (id) => api.post(`${root}/${id}/preview`),
  prepare: (id, body) => api.post(`${root}/${id}/prepare`, body),
  generate: (id, body) => api.post(`${root}/${id}/generate`, body),
  recipients: (id, q) => api.get(`${root}/${id}/recipients`, { params: { q } }),
  invite: (id, body) => api.post(`${root}/${id}/invitations`, body),
  membership: (id, body) => api.post(`${root}/${id}/membership`, body),
});
