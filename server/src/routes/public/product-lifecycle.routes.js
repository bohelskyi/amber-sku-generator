const express = require('express');
const { requirePermission } = require('../../auth/authorization');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { sendHttpError } = require('../../http/errors');
const lifecycle = require('../../services/product-lifecycle.service');
const visibility = require('../../services/magento/product-visibility-worker');
const router = express.Router();

router.use('/products/restore', requirePermission('products.view'), requirePermission('products.archive'));
for (const action of ['preview', 'apply']) router.post(`/products/restore/${action}`, async (req, res) => {
  try { res.json(await lifecycle[action](req.body || {}, { mutationContext: getRequestMutationContext(req) })); }
  catch (cause) { sendHttpError(res, cause, { includeCode: true }); }
});
router.get('/products/restore/batches/:batchId', async (req, res) => {
  try {
    if (!/^[a-f0-9]{64}$/.test(req.params.batchId)) return res.status(422).json({ error: 'Некоректний список.', code: 'PRODUCT_RESTORE_BATCH_INVALID' });
    res.json(await lifecycle.readBatch(req.params.batchId));
  } catch (cause) { sendHttpError(res, cause, { includeCode: true }); }
});
router.get('/products/:productId/lifecycle', requirePermission('products.view'), async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isSafeInteger(productId) || productId <= 0) return res.status(422).json({ error: 'Некоректний товар.', code: 'PRODUCT_RESTORE_NOT_FOUND' });
    res.json(await lifecycle.status(productId));
  } catch (cause) { sendHttpError(res, cause, { includeCode: true }); }
});
for (const action of ['inspect', 'reconcile']) router.post(`/products/visibility/${action}`,
  requirePermission('products.view'), requirePermission('products.archive'), async (req, res) => {
    try {
      const id = req.body?.intentId;
      require('../../services/magento/binding-contract').identity(id);
      const options = { databasePool: require('../../db/pool'), mutationContext: getRequestMutationContext(req) };
      const config = require('../../config/env').magento;
      res.json(await (action === 'inspect' ? visibility.inspect(config, id, options) : visibility.reconcile(config, req.body, options)));
    } catch (cause) { sendHttpError(res, cause, { includeCode: true }); }
  });
module.exports = router;
