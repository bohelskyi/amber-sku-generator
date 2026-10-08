const express = require('express');
const { requirePermission } = require('../../auth/authorization');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { sendHttpError } = require('../../http/errors');
const service = require('../../services/historical-standard-reactivation.service');
const worker = require('../../services/magento/historical-standard-worker');
const state = require('../../services/historical-reactivation-state');
const operations = require('../../services/historical-review-operations');
const router = express.Router();
const prefix = '/products/historical-reactivation';
const gates = state.PERMISSIONS.map(requirePermission);
const options = req => ({ databasePool: require('../../db/pool'), mutationContext: getRequestMutationContext(req) });
for (const action of ['preview', 'confirm']) router.post(`${prefix}/${action}`, ...gates, async (req, res) => {
  try { res.status(202).json(await operations.start(action, req.body || {}, options(req))); }
  catch (cause) { sendHttpError(res, cause, { includeCode: true }); }
});
router.get(`${prefix}/operations/:operationId`, ...gates, async (req, res) => {
  try { res.json(await operations.read(req.params.operationId, options(req))); }
  catch (cause) { sendHttpError(res, cause, { includeCode: true }); }
});
router.post(`${prefix}/cancel`, ...gates, async (req, res) => {
  try { res.json(await service.cancel(req.body || {}, options(req))); }
  catch (cause) { sendHttpError(res, cause, { includeCode: true }); }
});
router.get(`${prefix}/batches/:batchId`, ...gates, async (req, res) => {
  try { res.json(await service.readBatch(req.params.batchId, options(req))); }
  catch (cause) { sendHttpError(res, cause, { includeCode: true }); }
});
router.get(`${prefix}/intents/:intentId/inspection`, ...gates, async (req, res) => {
  try { res.json(await worker.inspect(require('../../config/env').magento, req.params.intentId, options(req))); }
  catch (cause) { sendHttpError(res, cause, { includeCode: true }); }
});
router.post(`${prefix}/reconcile`, ...gates, async (req, res) => {
  try { res.json(await worker.reconcile(require('../../config/env').magento, req.body || {}, options(req))); }
  catch (cause) { sendHttpError(res, cause, { includeCode: true }); }
});
for (const action of ['preview', 'apply']) router.post(`${prefix}/weight-normalization/${action}`,
  ...gates, requirePermission('products.recount'), requirePermission('exports.create'), async (req, res) => {
    try { res.json(await require('../../services/magento/historical-sv-weight-normalization.service')[action](req.body || {}, options(req))); }
    catch (cause) { sendHttpError(res, cause, { includeCode: true }); }
  });
module.exports = router;
