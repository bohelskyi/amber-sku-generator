const express = require('express');
const { requirePermission } = require('../../auth/authorization');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { sendHttpError } = require('../../http/errors');
const service = require('../../services/historical-standard-reactivation.service');
const worker = require('../../services/magento/historical-standard-worker');
const state = require('../../services/historical-reactivation-state');
const router = express.Router();
const prefix = '/products/historical-reactivation';
const gates = state.PERMISSIONS.map(requirePermission);
const options = req => ({ databasePool: require('../../db/pool'), mutationContext: getRequestMutationContext(req) });
for (const action of ['preview', 'confirm', 'cancel']) router.post(`${prefix}/${action}`, ...gates, async (req, res) => {
  try { res.json(await service[action](req.body || {}, options(req))); }
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
module.exports = router;
