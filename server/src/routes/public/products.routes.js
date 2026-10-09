const express = require('express');
const { getPublicConfig } = require('../../services/sku-schema.service');
const { calculatePricing } = require('../../services/pricing.service');
const { decodeSku, getNextVariationSku, buildNewProductPreview, buildProductRecountPreview, applyProductRecount, saveProduct, deleteProductBySku } = require('../../services/product.service');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { requirePermission, requireAnyPermission } = require('../../auth/authorization');
const {
  applyProductPriceChange,
  previewProductPriceChange,
} = require('../../services/product-price-change.service');
const {
  applyProductInformation,
  previewProductInformation,
} = require('../../services/product-information.service');
const {
  applyProductMagentoName,
  previewProductMagentoName,
  suggestEnglishSubject,
} = require('../../services/product-magento-name.service');

const router = express.Router();
function publicFieldErrors(error) {
  if (error.statusCode !== 422 || !error.fieldErrors || typeof error.fieldErrors !== 'object') return {};
  const fieldErrors = Object.fromEntries(Object.entries(error.fieldErrors)
    .filter(([key, value]) => key.length <= 100 && typeof value === 'string' && value.length <= 1000));
  return { fieldErrors, ...(error.code === 'WEIGHT_CONFLICT' ? { code: 'WEIGHT_CONFLICT',
    details: { weight: error.details?.weight, answerWeight: error.details?.answerWeight } } : {}) };
}

for (const action of ['preview', 'apply']) {
  router.post(`/products/test-delete/${action}`, requirePermission('products.delete_test'), async (req, res) => {
    try {
      res.json(await require('../../services/magento/test-deletion.service')[action](
        require('../../config/env').magento, req.body || {}, { mutationContext: getRequestMutationContext(req) }));
    } catch (error) { require('../../http/errors').sendHttpError(res, error, { includeCode: true }); }
  });
}

router.get('/magento/summary', requirePermission('products.view'), async (req, res, next) => {
  try { res.json(await require('../../services/magento/sync-problems').summary()); } catch (error) { next(error); }
});
router.get('/magento/problems', requirePermission('products.view'), async (req, res, next) => {
  try { res.json(await require('../../services/magento/sync-problems').problems(require('../../config/env').magento)); }
  catch (error) { next(error); }
});
router.get('/magento/problems/page', requirePermission('products.view'), async (req, res, next) => {
  try { res.json(await require('../../services/magento/sync-problems').problemPage(require('../../config/env').magento, req.query || {})); }
  catch (error) { next(error); }
});
router.get('/magento/problems/:productId', requirePermission('products.view'), async (req, res, next) => {
  try { res.json(await require('../../services/magento/sync-problems').problemDetail(require('../../config/env').magento, req.params.productId)); }
  catch (error) { next(error); }
});
router.get('/magento/product-status/:productId', requirePermission('products.view'), async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    if (!Number.isSafeInteger(productId) || productId <= 0) return res.status(422).json({ error: 'Некоректний товар.' });
    const db = require('../../db/pool');
    const statuses = await require('../../services/magento/automatic-sync-status').readStatuses(db, [productId]);
    const names = (await db.query(`SELECT n.state FROM magento_name_sync_states n JOIN products p
      ON p.public_product_identity_id=n.public_product_identity_id WHERE p.id=$1 AND n.origin_hash=$2`,
    [productId, require('../../config/env').magento.configured ? require('../../services/magento/binding-contract')
      .originHash(require('../../config/env').magento.baseUrl) : 'unconfigured'])).rows[0];
    res.json({ ...statuses.get(productId), nameConflict: ['conflict', 'baseline_required'].includes(names?.state) });
  } catch (error) { next(error); }
});
router.post('/magento/name-resolution/preview', requirePermission('exports.create'), async (req, res) => {
  try { res.json(await require('../../services/magento/name-resolution.service').preview(req.body || {}, { mutationContext: getRequestMutationContext(req) })); }
  catch (error) { sendMagentoNameError(res, error); }
});
router.post('/magento/name-resolution/apply', requirePermission('exports.create'), async (req, res) => {
  try { res.json(await require('../../services/magento/name-resolution.service').apply(req.body || {},
    { mutationContext: getRequestMutationContext(req) })); } catch (error) { sendMagentoNameError(res, error); }
});

router.get('/product-names/:productId/readiness', requirePermission('products.decode'), async (req, res) => {
  try { res.json(await require('../../services/magento/product-names.service').read(Number(req.params.productId), { readiness: true, allowUnavailable: true })); }
  catch (error) { require('../../http/errors').sendHttpError(res, error, { includeCode: true, includeDetails: true }); }
});
router.get('/product-names/:productId', requirePermission('products.decode'), async (req, res) => {
  try { res.json(await require('../../services/magento/product-names.service').read(Number(req.params.productId))); }
  catch (error) { require('../../http/errors').sendHttpError(res, error, { includeCode: true, includeDetails: true }); }
});
router.post('/product-names/save', requirePermission('exports.create'), async (req, res) => {
  try { res.json(await require('../../services/magento/product-names.service').save(req.body || {},
    { mutationContext: getRequestMutationContext(req) })); }
  catch (error) { require('../../http/errors').sendHttpError(res, error, { includeCode: true }); }
});

router.get('/config', requirePermission('products.view'), async (req, res) => {
  try {
    const config = await getPublicConfig();
    const activation = (await require('../../db/pool').query('SELECT enabled FROM public_sku_activation WHERE singleton')).rows[0];
    const productNameReadiness = await require('../../services/product/effective-name-readiness').availability(require('../../db/pool'));
    res.json({ ...config, productNameReadiness, productCreateRequirements: require('../../services/product/new-product-readiness').requirements,
      productPhotoRequirements: { available: Boolean(activation?.enabled), maxPhotoBytes: require('../../services/product-photos.service').MAX_PHOTO_BYTES, maxPhotos: require('../../services/product-photos.service').MAX_PHOTOS, maxNewGalleryBytes: require('../../services/product-photos.service').MAX_PHOTO_BYTES * require('../../services/product-photos.service').MAX_PHOTOS, uploadEncoding: 'json-base64' },
      productLifecycle: { available: Boolean(activation?.enabled) },
      historicalReactivation: { available: Boolean(activation?.enabled), format: 'historical-reactivation-standard-v1', protocol: 'standard-rest-v1', administratorOnly: true, maxItems: 100, createTargetStatus: 2 },
      productIntegrationRequests: { available: Boolean(activation?.enabled), version: 1 },
      productCreation: { identityMode: activation?.enabled ? 'public_identity' : 'encoded_sku',
        skuReservation: { available: Boolean(activation?.enabled), version: 1 },
        testProducts: { available: Boolean(activation?.enabled), administratorOnly: true, prefix: 'TEST-', targetStatus: 2 },
        pricingDecision: { available: Boolean(activation?.enabled), modes: ['system_auto', 'manual_uah', 'usd_per_gram'] } } });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...publicFieldErrors(err),
      ...(typeof err.code === 'string' && err.code.startsWith('TEST_PRODUCT_') ? { code: err.code } : {}) });
  }
});

router.post('/preview', requirePermission('products.create'), async (req, res) => {
  try {
    const preview = await buildNewProductPreview(req.body || {}, { mutationContext: getRequestMutationContext(req) });
    res.json(preview);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...publicFieldErrors(err),
      ...(typeof err.code === 'string' && err.code.startsWith('TEST_PRODUCT_') ? { code: err.code } : {}) });
  }
});

router.post('/products/creation/cancel', requirePermission('products.create'), async (req, res) => {
  try { res.json(await require('../../services/product/creation-sku-reservation').cancel(req.body || {},
    { mutationContext: getRequestMutationContext(req) })); }
  catch (error) { require('../../http/errors').sendHttpError(res, error, { includeCode: true }); }
});

router.post('/price-preview', requirePermission('products.create'), async (req, res) => {
  try {
    const tests = require('../../services/product/test-products');
    if (tests.normalizeFlag(req.body || {})) await tests.assertAdministrator(require('../../db/pool'), Number(req.applicationUser?.id), { readOnly: true });
    const { categoryCode, answers = {}, weight, isCalibrated } = req.body;
    const pricing = await calculatePricing(categoryCode, answers, weight, isCalibrated);
    res.json({
      pricePerGram: pricing.pricePerGram.toFixed(2),
      fixedPriceUah: pricing.fixedPriceUah,
      priceMode: pricing.priceMode,
      usesWeight: pricing.usesWeight,
      totalPrice: pricing.totalPrice,
      weightVal: pricing.weightVal,
      logMessage: pricing.logMessage,
      ...pricing.currencyPayload,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...publicFieldErrors(err),
      ...(typeof err.code === 'string' && err.code.startsWith('TEST_PRODUCT_') ? { code: err.code } : {}) });
  }
});

router.post('/decode', requirePermission('products.decode'), async (req, res) => {
  try {
    const decoded = await decodeSku(req.body?.sku);
    res.json(decoded);
  } catch (err) {
    res.status(err.statusCode || 400).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/variation', requirePermission('products.create'), async (req, res) => {
  try {
    const variation = await getNextVariationSku(req.body?.sku);
    res.json(variation);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/recount/preview', requireAnyPermission(['products.recount', 'corrections.create']), async (req, res) => {
  try {
    if (req.body?.nameChange !== undefined && !req.permissions.includes('products.recount')) {
      return res.status(403).json({ error: 'Немає дозволу змінювати назву.', code: 'INSUFFICIENT_PERMISSION' });
    }
    if (req.body?.pricingDecision && !req.permissions.includes('products.recount')
        && !req.permissions.includes('corrections.price_override')) {
      return res.status(403).json({ error: 'Немає дозволу обирати спосіб ціноутворення.', code: 'INSUFFICIENT_PERMISSION' });
    }
    const preview = await buildProductRecountPreview(req.body || {});
    res.json(preview);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message, ...publicFieldErrors(err) });
  }
});

router.post('/recount/apply', requirePermission('products.recount'), async (req, res) => {
  try {
    const result = await applyProductRecount(req.body || {}, {
      authorizedDirectDecision: true,
      authorizedNameChange: true,
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message, ...publicFieldErrors(err),
      ...(err.publicCode ? { code: err.publicCode } : {}) });
  }
});

router.post('/product-information/preview', requirePermission('products.recount'), async (req, res) => {
  try {
    res.json(await previewProductInformation(req.body || {}));
  } catch (err) {
    res.status(err.statusCode || 400).json({
      error: err.message,
      ...(err.publicCode ? { code: err.publicCode } : {}),
    });
  }
});

router.post('/product-information/apply', requirePermission('products.recount'), async (req, res) => {
  try {
    res.json(await applyProductInformation(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    }));
  } catch (err) {
    res.status(err.statusCode || 400).json({
      error: err.message,
      ...(err.publicCode ? { code: err.publicCode } : {}),
    });
  }
});

function sendMagentoNameError(res, error) {
  res.status(error.statusCode || 500).json({
    error: error.message,
    ...(error.publicCode ? { code: error.publicCode } : {}),
  });
}

router.post('/product-magento-name/suggest', requirePermission('exports.create'), async (req, res) => {
  try {
    res.json(await suggestEnglishSubject(req.body || {}));
  } catch (error) {
    sendMagentoNameError(res, error);
  }
});

router.post('/product-magento-name/preview', requirePermission('exports.create'), async (req, res) => {
  try {
    res.json(await previewProductMagentoName(req.body || {}, { mutationContext: getRequestMutationContext(req) }));
  } catch (error) {
    sendMagentoNameError(res, error);
  }
});

router.post('/product-magento-name/apply', requirePermission('exports.create'), async (req, res) => {
  try {
    res.json(await applyProductMagentoName(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    }));
  } catch (error) {
    sendMagentoNameError(res, error);
  }
});

router.post('/product-price-change/preview', requirePermission('products.price_change'), async (req, res) => {
  try {
    const result = await previewProductPriceChange(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.publicCode ? { code: err.publicCode } : {}),
    });
  }
});

router.post('/product-price-change/apply', requirePermission('products.price_change'), async (req, res) => {
  try {
    const result = await applyProductPriceChange(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.publicCode ? { code: err.publicCode } : {}),
    });
  }
});

router.post('/save', requirePermission('products.create'), async (req, res) => {
  try {
    const result = await saveProduct(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...publicFieldErrors(err),
      ...(typeof err.code === 'string' && err.code.startsWith('TEST_PRODUCT_') ? { code: err.code } : {}) });
  }
});

router.post('/delete', requirePermission('products.archive'), async (req, res) => {
  try {
    const { skuToDelete } = req.body || {};
    if (!skuToDelete || skuToDelete.length < 4) {
      return res.status(400).json({ error: 'Некоректний формат' });
    }

    const result = await deleteProductBySku(skuToDelete, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, ...publicFieldErrors(err),
      ...(typeof err.code === 'string' && err.code.startsWith('TEST_PRODUCT_') ? { code: err.code } : {}) });
  }
});

module.exports = router;
