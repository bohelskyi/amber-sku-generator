const express = require('express');
const { buildCsv } = require('../utils/csv');
const { roundUah } = require('../utils/money');
const { getAppConfig } = require('../services/catalog.service');
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
  getExportRows,
  getExportStatus,
  recordExportEvent,
} = require('../services/export.service');

const router = express.Router();

router.get('/config', async (req, res) => {
  try {
    const config = await getAppConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/preview', async (req, res) => {
  try {
    const preview = await buildProductPreview(req.body || {});
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/price-preview', async (req, res) => {
  try {
    const { categoryCode, answers = {}, weight, isCalibrated } = req.body;
    const pricing = await calculatePricing(categoryCode, answers, weight, isCalibrated);
    res.json({
      pricePerGram: pricing.pricePerGram.toFixed(2),
      totalPrice: pricing.totalPrice,
      weightVal: pricing.weightVal,
      logMessage: pricing.logMessage,
      ...pricing.currencyPayload,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/decode', async (req, res) => {
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

router.post('/variation', async (req, res) => {
  try {
    const variation = await getNextVariationSku(req.body?.sku);
    res.json(variation);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/recount/preview', async (req, res) => {
  try {
    const preview = await buildProductRecountPreview(req.body || {});
    res.json(preview);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/recount/apply', async (req, res) => {
  try {
    const result = await applyProductRecount(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/save', async (req, res) => {
  try {
    const result = await saveProduct(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/delete', async (req, res) => {
  try {
    const { skuToDelete } = req.body || {};
    if (!skuToDelete || skuToDelete.length < 4) {
      return res.status(400).json({ error: 'Некоректний формат' });
    }

    const result = await deleteProductBySku(skuToDelete);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/products', async (req, res) => {
  try {
    const products = await getRecentProducts();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export/status', async (req, res) => {
  try {
    const status = await getExportStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export/csv', async (req, res) => {
  try {
    const { fromSku, toSku } = req.query;
    const exportData = await getExportRows(fromSku, toSku);
    const textHeaders = exportData.textColumns.map((column) => column.key);

    const csv = buildCsv([
      ['sku', 'price_uah', 'size', ...textHeaders],
      ...exportData.rows.map((row) => [
        row.full_sku,
        row.total_price_uah !== null && row.total_price_uah !== undefined
          ? roundUah(row.total_price_uah)
          : '',
        row.export_size || '',
        ...exportData.textColumns.map((column) => row.export_text_values?.[column.key] || ''),
      ]),
    ]);

    const suffixPart = exportData.range.toSku ? `-${exportData.range.toSku}` : '-to-latest';
    const fileName = `amber-export-${exportData.range.fromSku}${suffixPart}.csv`;

    await recordExportEvent(exportData);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csv);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
