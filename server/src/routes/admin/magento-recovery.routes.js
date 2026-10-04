const express = require('express');
const { requirePermission, requireAnyPermission } = require('../../auth/authorization');
const { sendHttpError } = require('../../http/errors');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const jobs = require('../../services/magento/sync-job-recovery');
const lifecycle = require('../../services/magento/lifecycle-recovery');
const config = require('../../config/env').magento;
const c = require('../../services/magento/binding-contract');
const router = express.Router();
const root = '/admin/magento-recovery';
const handle = (operation) => async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(await operation(req)); }
  catch (cause) { sendHttpError(res, cause, { includeCode: true, includeDetails: true }); }
};
const productId = (req) => {
  const id = Number(req.params.id);
  if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) c.invalid();
  return id;
};
const options = (req) => ({ mutationContext: getRequestMutationContext(req) });
router.get(`${root}/products/:id`, requireAnyPermission(['export_templates.publish', 'exports.reconcile']), handle((req) =>
  lifecycle.productRecovery(config, productId(req), { ...options(req),
    canRecoverJobs: req.permissions.includes('export_templates.publish'), canReconcileLifecycle: req.permissions.includes('exports.reconcile') })));
router.get(`${root}/jobs/:id`, requirePermission('export_templates.publish'), handle((req) => jobs.get(config, req.params.id, options(req))));
for (const [path, operation] of [['inspect', jobs.inspect], ['reconcile', jobs.reconcile], ['continue', jobs.continueJob]]) {
  router.post(`${root}/jobs/:id/${path}`, requirePermission('export_templates.publish'), handle((req) => {
    if (path === 'inspect') { c.command(req.body, []); return operation(config, req.params.id, options(req)); }
    return operation(config, req.params.id, req.body, options(req));
  }));
}
router.post(`${root}/products/:id/lifecycle-preview`, requirePermission('exports.reconcile'), handle((req) =>
  lifecycle.preview(config, productId(req), req.body, options(req))));
router.post(`${root}/products/:id/history-inspect`, requirePermission('exports.reconcile'), handle((req) => {
  c.command(req.body, []);
  return require('../../services/magento/recovery-history').inspect(config, productId(req), options(req));
}));
router.post(`${root}/products/:id/lifecycle-apply`, requirePermission('exports.reconcile'), handle((req) =>
  lifecycle.apply(config, productId(req), req.body, options(req))));
module.exports = router;
