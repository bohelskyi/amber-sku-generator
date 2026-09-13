const express = require('express');

const router = express.Router();

router.use(require('./admin/audit.routes'));
router.use(require('./admin/users.routes'));
router.use(require('./admin/roles.routes'));
router.use(require('./admin/catalog.routes'));
router.use(require('./admin/pricing.routes'));
router.use(require('./admin/corrections.routes'));
router.use(require('./admin/repricing.routes'));

module.exports = router;
