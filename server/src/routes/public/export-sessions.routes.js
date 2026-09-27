const express = require('express');
const { requirePermission } = require('../../auth/authorization');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const service = require('../../services/export-sessions.service');
const { getMagentoArtifacts } = require('../../services/export.service');
const { manifestProvenance } = require('../../services/export-templates/snapshot-binding');
const router = express.Router();
const options = (req) => ({ mutationContext: getRequestMutationContext(req) });
function route(method, path, permission, action, status = 200) {
  router[method](`/export/sessions${path}`, requirePermission(permission), async (req, res) => {
    try { res.status(status).json(await action(req)); }
    catch (error) { res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Не вдалося виконати операцію експорту.',
      ...(error.statusCode && (error.code || error.publicCode) ? { code: error.code || error.publicCode } : {}),
      ...(error.details ? { details: error.details } : {}) }); }
  });
}
route('get', '', 'exports.view', (r) => service.listSessions(r.query, options(r)));
route('post', '', 'exports.create', (r) => service.createSession(r.body, options(r)), 201);
route('get', '/:id', 'exports.view', (r) => service.detail(r.params.id, options(r)));
route('put', '/:id', 'exports.create', (r) => service.saveSession(r.params.id, r.body, options(r)));
route('post', '/:id/preview', 'exports.view', async (r) => {
  const preview = await service.previewSession(r.params.id, options(r));
  delete preview.previewToken;
  return preview;
});
route('post', '/:id/prepare', 'exports.create', (r) => service.prepare(r.params.id, r.body, options(r)));
route('post', '/:id/generate', 'exports.create', async (r) => {
  const snapshot = await service.generate(r.params.id, r.body, options(r));
  return { id: snapshot.id, status: snapshot.status, rowCount: Number(snapshot.row_count), generatedAt: snapshot.generated_at,
    artifacts: await getMagentoArtifacts(snapshot.id, options(r)), ...manifestProvenance(snapshot), sessionId: r.params.id, accessEpoch: r.body.expectedAccessEpoch };
}, 201);
route('get', '/:id/recipients', 'exports.create', (r) => service.recipients(r.params.id, r.query, options(r)));
route('post', '/:id/invitations', 'exports.create', (r) => service.invite(r.params.id, r.body, options(r)));
route('post', '/:id/membership', 'exports.view', (r) => service.membership(r.params.id, r.body, options(r)));
module.exports = router;
