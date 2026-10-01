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

router.get('/magento/summary', requirePermission('products.view'), async (req, res, next) => {
  try { res.json(await require('../../services/magento/sync-problems').summary()); } catch (error) { next(error); }
});
router.get('/magento/problems', requirePermission('products.view'), async (req, res, next) => {
  try { res.json(await require('../../services/magento/sync-problems').problems(require('../../config/env').magento)); }
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
  try { res.json(await require('../../services/magento/name-resolution.service').preview(req.body || {})); }
  catch (error) { sendMagentoNameError(res, error); }
});
router.post('/magento/name-resolution/apply', requirePermission('exports.create'), async (req, res) => {
  try { res.json(await require('../../services/magento/name-resolution.service').apply(req.body || {},
    { mutationContext: getRequestMutationContext(req) })); } catch (error) { sendMagentoNameError(res, error); }
});

router.get('/product-names/:productId', requirePermission('products.decode'), async (req, res) => {
  try { res.json(await require('../../services/magento/product-names.service').read(Number(req.params.productId))); }
  catch (error) { require('../../http/errors').sendHttpError(res, error, { includeCode: true }); }
});
router.post('/product-names/save', requirePermission('exports.create'), async (req, res) => {
  try { res.json(await require('../../services/magento/product-names.service').save(req.body || {},
    { mutationContext: getRequestMutationContext(req) })); }
  catch (error) { require('../../http/errors').sendHttpError(res, error, { includeCode: true }); }
});

router.get('/config', requirePermission('products.view'), async (req, res) => {
  try {
    const config = await getPublicConfig();
    res.json({ ...config, productCreateRequirements: require('../../services/product/new-product-readiness').requirements });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/preview', requirePermission('products.create'), async (req, res) => {
  try {
    const preview = await buildNewProductPreview(req.body || {});
    res.json(preview);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/price-preview', requirePermission('products.create'), async (req, res) => {
  try {
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
    res.status(500).json({ error: err.message });
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
    if (req.body?.nameChange !== undefined && (!req.permissions.includes('products.recount') || !req.permissions.includes('exports.create'))) {
      return res.status(403).json({ error: 'Немає дозволу змінювати назву.', code: 'INSUFFICIENT_PERMISSION' });
    }
    if (req.body?.pricingDecision && !req.permissions.includes('products.recount')
        && !req.permissions.includes('corrections.price_override')) {
      return res.status(403).json({ error: 'Немає дозволу обирати спосіб ціноутворення.', code: 'INSUFFICIENT_PERMISSION' });
    }
    const preview = await buildProductRecountPreview(req.body || {});
    res.json(preview);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/recount/apply', requirePermission('products.recount'), async (req, res) => {
  try {
    if (req.body?.nameChange !== undefined && !req.permissions.includes('exports.create')) {
      return res.status(403).json({ error: 'Немає дозволу змінювати назву.', code: 'INSUFFICIENT_PERMISSION' });
    }
    const result = await applyProductRecount(req.body || {}, {
      authorizedDirectDecision: true,
      authorizedNameChange: true,
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message,
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
    res.json(await previewProductMagentoName(req.body || {}));
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
    res.status(err.statusCode || 500).json({ error: err.message });
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
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
