const express = require('express');
const { getPublicConfig } = require('../../services/sku-schema.service');
const { calculatePricing } = require('../../services/pricing.service');
const { decodeSku, getNextVariationSku, buildProductPreview, buildProductRecountPreview, applyProductRecount, saveProduct, deleteProductBySku } = require('../../services/product.service');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { requirePermission } = require('../../auth/authorization');

const router = express.Router();

router.get('/config', requirePermission('products.view'), async (req, res) => {
  try {
    const config = await getPublicConfig();
    res.json(config);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/preview', requirePermission('products.create'), async (req, res) => {
  try {
    const preview = await buildProductPreview(req.body || {});
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

router.post('/recount/preview', requirePermission('corrections.create'), async (req, res) => {
  try {
    const preview = await buildProductRecountPreview(req.body || {});
    res.json(preview);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/recount/apply', requirePermission('products.recount'), async (req, res) => {
  try {
    const result = await applyProductRecount(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
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
