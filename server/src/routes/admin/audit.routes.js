const express = require('express');
const { AuditViewerError, getAuditEvents } = require('../../services/audit-viewer.service');
const { requirePermission } = require('../../auth/authorization');
const { sendHttpError } = require('../../http/errors');

const router = express.Router();

router.get('/admin/audit-events', requirePermission('audit.view'), async (req, res) => {
  try {
    res.json(await getAuditEvents(req.query || {}));
  } catch (error) {
    if (!(error instanceof AuditViewerError)) console.error('Audit event listing failed:', error);
    return sendHttpError(res, error, {
      defaultMessage: 'Audit event listing failed',
      includeCode: true,
      isExpected: (candidate) => candidate instanceof AuditViewerError,
    });
  }
});

module.exports = router;
