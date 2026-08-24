const express = require('express');
const {
  createCategory,
  updateCategory,
  createQuestion,
  updateQuestion,
  createOption,
  updateOption,
  updateQuestionsOrder,
  deleteCatalogItem,
} = require('../services/catalog.service');
const {
  getAdminPrices,
  upsertPriceCell,
  createScenario,
  updateScenario,
  duplicateScenario,
  createModifier,
  updateModifier,
} = require('../services/pricing.service');

const router = express.Router();

router.get('/admin/prices/:catCode', async (req, res) => {
  try {
    const data = await getAdminPrices(req.params.catCode);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
