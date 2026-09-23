import { api } from '../lib/api';

export function createExportTemplatesApi(client = api) {
  const root = '/admin/export-templates';
  return Object.freeze({
    list: () => client.get(root),
    sources: () => client.get(`${root}/sources`),
    candidate: () => client.get(`${root}/candidate`),
    get: (id) => client.get(`${root}/${id}`),
    create: (body) => client.post(root, body),
    save: (id, body) => client.put(`${root}/${id}/draft`, body),
    clone: (id, body) => client.post(`${root}/${id}/draft/from-version`, body),
    validate: (id, body) => client.post(`${root}/${id}/validate`, body),
    preview: (id, body) => client.post(`${root}/${id}/test-preview`, body),
    publish: (id, body) => client.post(`${root}/${id}/publish`, body),
    activation: () => client.get(`${root}/activation`),
    select: (body) => client.put(`${root}/activation`, body),
  });
}
export const exportTemplatesApi = createExportTemplatesApi();
