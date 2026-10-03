const express = require('express');
const { getRecentProducts } = require('../../services/product.service');
const { getProductRegisterPage } = require('../../services/product/product-queries');
const pool = require('../../db/pool');
const { getProductTimeline } = require('../../services/product-timeline.service');
const { requirePermission } = require('../../auth/authorization');

const router = express.Router();

router.get('/products', requirePermission('history.view'), async (req, res) => {
  try {
    const products = await getRecentProducts();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/products/register', requirePermission('history.view'), async (req, res) => {
  try {
    res.json(await getProductRegisterPage(pool, req.query || {}));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.publicCode ? { code: err.publicCode } : {}),
    });
  }
});

router.get('/product-timeline', requirePermission('history.view'), async (req, res) => {
  try {
    res.json(await getProductTimeline(req.query?.sku));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
  }
});

module.exports = router;
