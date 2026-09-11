const express = require('express');
const { getAdminPrices } = require('../../services/pricing/pricing-read-model');
const { upsertPriceCell, createScenario, updateScenario, duplicateScenario, createModifier, updateModifier } = require('../../services/pricing.service');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { requirePermission } = require('../../auth/authorization');

const router = express.Router();

router.get('/admin/prices/:catCode', requirePermission('pricing.view'), async (req, res) => {
  try {
    const data = await getAdminPrices(req.params.catCode);
    res.json(data);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/price-cell', requirePermission('pricing.manage'), async (req, res) => {
  try {
    await upsertPriceCell(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/scenario', requirePermission('pricing.manage'), async (req, res) => {
  try {
    const result = await createScenario(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/admin/scenario', requirePermission('pricing.manage'), async (req, res) => {
  try {
    const { id, name, axis_x_key } = req.body || {};
    if (!id || !name || !axis_x_key) {
      return res.status(400).json({ error: 'Потрібні id, назва та вісь X' });
    }

    await updateScenario(req.body, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/scenario/duplicate', requirePermission('pricing.manage'), async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Потрібен id сценарію' });

    const result = await duplicateScenario(id, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/modifier', requirePermission('pricing.manage'), async (req, res) => {
  try {
    const result = await createModifier(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/modifier', requirePermission('pricing.manage'), async (req, res) => {
  try {
    await updateModifier(req.body || {}, {
      mutationContext: getRequestMutationContext(req),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
