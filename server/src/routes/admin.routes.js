const express = require('express');
const {
  getAppConfig,
  createCategory,
  updateCategory,
  createQuestion,
  updateQuestion,
  createOption,
  updateOption,
  setOptionArchived,
  updateQuestionsOrder,
  deleteCatalogItem,
} = require('../services/catalog.service');
const {
  getSchemaStatus,
  publishSkuSchema,
} = require('../services/sku-schema.service');
const {
  getAdminPrices,
  upsertPriceCell,
  createScenario,
  updateScenario,
  duplicateScenario,
  createModifier,
  updateModifier,
} = require('../services/pricing.service');
const {
  applyGlobalRepricing,
  applyRepricing,
  buildGlobalRepricingPreview,
  buildRepricingPreview,
  createRepricingDraft,
  discardRepricingDraft,
  getRepricingBatchItems,
  getRepricingRollbackItems,
  getRepricingBatches,
  getRepricingDraft,
  getRepricingDrafts,
  getRepricingScenarios,
  rollbackRepricing,
  saveRepricingDraft,
  syncRepricingDraft,
} = require('../services/repricing.service');
const { buildCsv } = require('../utils/csv');
const {
  completeCorrectionRequest,
  createCorrectionRequest,
  getCorrectionRequests,
  refreshCorrectionRequest,
  updateCorrectionRequestStatus,
} = require('../services/correction-request.service');
const {
  getCorrectionChangesText,
  getCorrectionHistory,
} = require('../services/correction-history.service');

const router = express.Router();

router.get('/admin/config', async (req, res) => {
  try {
    res.json(await getAppConfig());
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/sku-schema/:catCode', async (req, res) => {
  try {
    res.json(await getSchemaStatus(String(req.params.catCode || '').toUpperCase()));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/sku-schema/:catCode/publish', async (req, res) => {
  try {
    res.json(await publishSkuSchema(String(req.params.catCode || '').toUpperCase()));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/prices/:catCode', async (req, res) => {
  try {
    const data = await getAdminPrices(req.params.catCode);
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/repricing/scenarios', async (req, res) => {
  try {
    const scenarios = await getRepricingScenarios();
    res.json(scenarios);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/correction-requests', async (req, res) => {
  try {
    res.json(await getCorrectionRequests(req.query || {}));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/product-corrections', async (req, res) => {
  try {
    res.json(await getCorrectionHistory(req.query || {}));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/product-corrections/csv', async (req, res) => {
  try {
    const data = await getCorrectionHistory(req.query || {}, { forExport: true });
    const csv = buildCsv([
      [
        'date',
        'category',
        'old_sku',
        'new_sku',
        'weight_g',
        'old_price_uah',
        'new_price_uah',
        'difference_uah',
        'old_price_per_gram_usd',
        'new_price_per_gram_usd',
        'old_matrix',
        'new_matrix',
        'changed_characteristics',
        'reason',
      ],
      ...data.items.map((item) => [
        item.createdAt ? new Date(item.createdAt).toISOString() : '',
        item.categoryCode,
        item.sourceSku,
        item.correctedSku,
        item.weight ?? '',
        item.oldPriceUah ?? '',
        item.newPriceUah ?? '',
        item.priceDeltaUah ?? '',
        item.oldPricePerGram ?? '',
        item.newPricePerGram ?? '',
        item.oldMatrixName ?? '',
        item.newMatrixName ?? '',
        getCorrectionChangesText(item),
        item.reason,
      ]),
    ]);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="amber-correction-history.csv"'
    );
    res.send(`\uFEFF${csv}`);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/correction-requests', async (req, res) => {
  try {
    res.json(await createCorrectionRequest(req.body || {}));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/correction-requests/:requestId/refresh', async (req, res) => {
  try {
    res.json(await refreshCorrectionRequest(req.params.requestId));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.patch('/admin/correction-requests/:requestId/status', async (req, res) => {
  try {
    res.json(await updateCorrectionRequestStatus(
      req.params.requestId,
      req.body?.status
    ));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/correction-requests/:requestId/complete', async (req, res) => {
  try {
    res.json(await completeCorrectionRequest(req.params.requestId));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.get('/admin/repricing/batches', async (req, res) => {
  try {
    const batches = await getRepricingBatches(req.query.limit);
    res.json(batches);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/repricing/drafts', async (req, res) => {
  try {
    res.json(await getRepricingDrafts());
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/repricing/drafts', async (req, res) => {
  try {
    res.json(await createRepricingDraft(req.body || {}));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/repricing/drafts/:draftId', async (req, res) => {
  try {
    res.json(await getRepricingDraft(req.params.draftId));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/admin/repricing/drafts/:draftId', async (req, res) => {
  try {
    res.json(await saveRepricingDraft(req.params.draftId, req.body || {}));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/repricing/drafts/:draftId/sync', async (req, res) => {
  try {
    res.json(await syncRepricingDraft(req.params.draftId));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.delete('/admin/repricing/drafts/:draftId', async (req, res) => {
  try {
    res.json(await discardRepricingDraft(req.params.draftId));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/repricing/preview', async (req, res) => {
  try {
    const { scenarioId } = req.body || {};
    if (!scenarioId) return res.status(400).json({ error: 'Оберіть цінову матрицю.' });

    const preview = await buildRepricingPreview(scenarioId);
    res.json(preview);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/repricing/global/preview', async (_req, res) => {
  try {
    res.json(await buildGlobalRepricingPreview());
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/repricing/apply', async (req, res) => {
  try {
    const result = await applyRepricing(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/repricing/global/apply', async (req, res) => {
  try {
    res.json(await applyGlobalRepricing(req.body || {}));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/repricing/:batchId/rollback', async (req, res) => {
  try {
    res.json(await rollbackRepricing(req.params.batchId));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/repricing/:batchId/rollback-csv', async (req, res) => {
  try {
    const data = await getRepricingRollbackItems(req.params.batchId);
    const csv = buildCsv([
      ['sku', 'current_price_uah', 'restored_price_uah', 'difference_uah'],
      ...data.items.map((item) => [
        item.sku,
        item.current_price_uah ?? '',
        item.restored_price_uah ?? '',
        item.difference_uah ?? '',
      ]),
    ]);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="amber-repricing-rollback-${Number(req.params.batchId)}.csv"`
    );
    res.send(`\uFEFF${csv}`);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/repricing/:batchId/csv', async (req, res) => {
  try {
    const data = await getRepricingBatchItems(req.params.batchId);
    const csv = buildCsv([
      [
        'sku',
        'old_matrix',
        'new_matrix',
        'old_price_mode',
        'new_price_mode',
        'old_price_per_gram_usd',
        'new_price_per_gram_usd',
        'old_uah_rate',
        'new_uah_rate',
        'old_price_uah',
        'new_price_uah',
        'difference_uah',
        'change_reason',
        'price_source',
      ],
      ...data.items.map((item) => [
        item.sku,
        item.old_matrix_name ?? '',
        item.new_matrix_name ?? '',
        item.old_price_mode ?? '',
        item.new_price_mode ?? '',
        item.old_price_per_gram_usd ?? '',
        item.new_price_per_gram_usd ?? '',
        item.old_uah_rate ?? '',
        item.new_uah_rate ?? '',
        item.old_price_uah ?? '',
        item.new_price_uah,
        item.price_delta_uah,
        item.change_reason,
        item.manual_override ? 'manual' : 'matrix',
      ]),
    ]);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="amber-repricing-${Number(req.params.batchId)}.csv"`
    );
    res.send(`\uFEFF${csv}`);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/price-cell', async (req, res) => {
  try {
    await upsertPriceCell(req.body || {});
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/scenario', async (req, res) => {
  try {
    const result = await createScenario(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/admin/scenario', async (req, res) => {
  try {
    const { id, name, axis_x_key } = req.body || {};
    if (!id || !name || !axis_x_key) {
      return res.status(400).json({ error: 'Потрібні id, назва та вісь X' });
    }

    await updateScenario(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/scenario/duplicate', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Потрібен id сценарію' });

    const result = await duplicateScenario(id);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/modifier', async (req, res) => {
  try {
    const result = await createModifier(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/modifier', async (req, res) => {
  try {
    await updateModifier(req.body || {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/delete-item', async (req, res) => {
  try {
    const { type, id } = req.body || {};
    await deleteCatalogItem(type, id);
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/category', async (req, res) => {
  try {
    const { code, name } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'Потрібні код і назва' });

    const result = await createCategory(req.body);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/admin/category', async (req, res) => {
  try {
    const { code, name } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'Потрібні код і назва' });

    const result = await updateCategory(req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/question', async (req, res) => {
  try {
    const { key, label } = req.body || {};
    if (!key || label === undefined) {
      return res.status(400).json({ error: 'Потрібні key та назва' });
    }

    const result = await createQuestion(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/admin/question', async (req, res) => {
  try {
    const { id, key, label } = req.body || {};
    if (!id || !key || label === undefined) {
      return res.status(400).json({ error: 'Потрібні id, key та назва' });
    }

    const result = await updateQuestion(req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/question/update', async (req, res) => {
  try {
    const { id, key, label } = req.body || {};
    if (!id || !key || label === undefined) {
      return res.status(400).json({ error: 'Потрібні id, key та назва' });
    }

    const result = await updateQuestion(req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/admin/questions/order', async (req, res) => {
  try {
    const result = await updateQuestionsOrder(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/option', async (req, res) => {
  try {
    const result = await createOption(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/option', async (req, res) => {
  try {
    const { id, value_id, label } = req.body || {};
    if (!id || !label || value_id === undefined || value_id === null || value_id === '') {
      return res.status(400).json({ error: 'Потрібні id, label і value_id' });
    }

    await updateOption(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.patch('/admin/option/:id/archive', async (req, res) => {
  try {
    await setOptionArchived({
      id: req.params.id,
      archived: req.body?.archived,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
