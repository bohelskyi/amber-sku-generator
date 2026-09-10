const express = require('express');
const { getPublicConfig } = require('../services/sku-schema.service');
const { calculatePricing } = require('../services/pricing.service');
const {
  decodeSku,
  getNextVariationSku,
  buildProductPreview,
  buildProductRecountPreview,
  applyProductRecount,
  saveProduct,
  deleteProductBySku,
  getRecentProducts,
} = require('../services/product.service');
const {
  getExportStatus,
  confirmExportSnapshot,
  createExportSnapshot,
  getExportSnapshot,
} = require('../services/export.service');
const { requirePermission } = require('../auth/authorization');
const { getRequestMutationContext } = require('../audit/mutation-context');

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

router.get('/products', requirePermission('history.view'), async (req, res) => {
  try {
    const products = await getRecentProducts();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export/status', requirePermission('exports.view'), async (req, res) => {
  try {
    const status = await getExportStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export/csv', requirePermission('exports.view'), async (req, res) => {
  res.status(410).json({
    error: 'Прямий CSV-експорт вимкнено. Створіть і підтвердьте immutable export snapshot.',
  });
});

router.post('/export/snapshots', requirePermission('exports.create'), async (req, res) => {
  try {
    const snapshot = await createExportSnapshot({
      fromSku: req.body?.fromSku,
      toSku: req.body?.toSku,
      idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
    });
    res.status(201).json({
      id: snapshot.id,
      status: snapshot.status,
      fileName: snapshot.file_name,
      rowCount: Number(snapshot.row_count),
      generatedAt: snapshot.generated_at,
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.get('/export/snapshots/:id/csv', requirePermission('exports.view'), async (req, res) => {
  try {
    const snapshot = await getExportSnapshot(req.params.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${snapshot.file_name}"`);
    res.send(snapshot.csv_content);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/export/snapshots/:id/confirm', requirePermission('exports.create'), async (req, res) => {
  try {
    res.json(await confirmExportSnapshot(req.params.id));
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

module.exports = router;
