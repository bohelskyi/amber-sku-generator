const express = require('express');
const { applyGlobalRepricing, applyRepricing, buildGlobalRepricingPreview, buildRepricingPreview, createRepricingDraft, discardRepricingDraft, getRepricingBatchItems, getRepricingRollbackItems, getRepricingBatches, getRepricingDraft, getRepricingDrafts, getRepricingScenarios, rollbackRepricing, saveRepricingDraft, syncRepricingDraft } = require('../../services/repricing.service');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { presentRepricingBatchCsv, presentRepricingRollbackCsv } = require('../../presenters/repricing-csv');
const { sendCsvDownload } = require('../../presenters/csv-download');
const { requirePermission } = require('../../auth/authorization');

const router = express.Router();

router.get('/admin/repricing/scenarios', requirePermission('repricing.view'), async (req, res) => {
  try {
    const scenarios = await getRepricingScenarios();
    res.json(scenarios);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/repricing/batches', requirePermission('repricing.view'), async (req, res) => {
  try {
    const batches = await getRepricingBatches(req.query.limit);
    res.json(batches);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/repricing/drafts', requirePermission('repricing.view'), async (req, res) => {
  try {
    res.json(await getRepricingDrafts());
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/repricing/drafts', requirePermission('repricing.prepare'), async (req, res) => {
  try {
    res.json(await createRepricingDraft(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    }));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/repricing/drafts/:draftId', requirePermission('repricing.view'), async (req, res) => {
  try {
    res.json(await getRepricingDraft(req.params.draftId));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/admin/repricing/drafts/:draftId', requirePermission('repricing.prepare'), async (req, res) => {
  try {
    res.json(await saveRepricingDraft(req.params.draftId, req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    }));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/repricing/drafts/:draftId/sync', requirePermission('repricing.prepare'), async (req, res) => {
  try {
    res.json(await syncRepricingDraft(req.params.draftId, {
      mutationContext: getRequestMutationContext(req),
    }));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.delete('/admin/repricing/drafts/:draftId', requirePermission('repricing.prepare'), async (req, res) => {
  try {
    res.json(await discardRepricingDraft(req.params.draftId, {
      mutationContext: getRequestMutationContext(req),
    }));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/repricing/preview', requirePermission('repricing.prepare'), async (req, res) => {
  try {
    const { scenarioId } = req.body || {};
    if (!scenarioId) return res.status(400).json({ error: 'Оберіть цінову матрицю.' });

    const preview = await buildRepricingPreview(scenarioId);
    res.json(preview);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/repricing/global/preview', requirePermission('repricing.prepare'), async (_req, res) => {
  try {
    res.json(await buildGlobalRepricingPreview());
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/repricing/apply', requirePermission('repricing.apply'), async (req, res) => {
  try {
    const result = await applyRepricing(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/repricing/global/apply', requirePermission('repricing.apply'), async (req, res) => {
  try {
    res.json(await applyGlobalRepricing(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    }));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/repricing/:batchId/rollback', requirePermission('repricing.rollback'), async (req, res) => {
  try {
    res.json(await rollbackRepricing(req.params.batchId, {
      mutationContext: getRequestMutationContext(req),
    }));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/repricing/:batchId/rollback-csv', requirePermission('repricing.view'), async (req, res) => {
  try {
    const data = await getRepricingRollbackItems(req.params.batchId);
    sendCsvDownload(res, presentRepricingRollbackCsv(req.params.batchId, data.items));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/repricing/:batchId/csv', requirePermission('repricing.view'), async (req, res) => {
  try {
    const data = await getRepricingBatchItems(req.params.batchId);
    sendCsvDownload(res, presentRepricingBatchCsv(req.params.batchId, data.items));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
