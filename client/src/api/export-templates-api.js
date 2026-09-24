import { api } from '../lib/api';

export function createExportTemplatesApi(client = api) {
  const root = '/admin/export-templates';
  return Object.freeze({
    list: () => client.get(root),
    sources: () => client.get(`${root}/sources`),
    sourceDetails: (params, signal) => client.get(`${root}/source-details`, { params, signal }),
    searchSamples: (params, signal) => client.get(`${root}/sample-products`, { params, signal }),
    candidate: (supportPolicy) => supportPolicy ? client.get(`${root}/candidate`, { params: { supportPolicy } }) : client.get(`${root}/candidate`),
    system: () => client.get(`${root}/system`),
    upgrade: (id, body) => client.post(`${root}/${id}/draft/upgrade-columns`, body),
    prepareSupport: (id, body) => client.post(`${root}/${id}/draft/source-support/prepare`, body),
    applySupport: (id, body) => client.post(`${root}/${id}/draft/source-support/apply`, body),
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
