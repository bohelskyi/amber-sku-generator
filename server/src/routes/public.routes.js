const express = require('express');

const router = express.Router();

router.use(require('./public/products.routes'));
router.use(require('./public/history.routes'));
router.use(require('./public/exports.routes'));
router.use(require('./public/export-sessions.routes'));

module.exports = router;
