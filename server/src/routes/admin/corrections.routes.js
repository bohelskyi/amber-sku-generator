const express = require('express');
const { CLAIM_TOKEN_HEADER, claimCorrectionRequest, completeCorrectionRequest, createCorrectionRequest, forceReleaseCorrectionRequest, getCorrectionRequests, refreshCorrectionRequest, releaseCorrectionRequest, updateCorrectionRequestStatus } = require('../../services/correction-request.service');
const { getCorrectionHistory } = require('../../services/correction-history.service');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { presentCorrectionHistoryCsv } = require('../../presenters/correction-history-csv');
const { sendCsvDownload } = require('../../presenters/csv-download');
const { requirePermission } = require('../../auth/authorization');

const router = express.Router();

router.get('/admin/correction-requests', requirePermission('corrections.view'), async (req, res) => {
  try {
    res.json(await getCorrectionRequests(req.query || {}));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/product-corrections', requirePermission('history.view'), async (req, res) => {
  try {
    res.json(await getCorrectionHistory(req.query || {}));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/product-corrections/csv', requirePermission('history.view'), async (req, res) => {
  try {
    const data = await getCorrectionHistory(req.query || {}, { forExport: true });
    sendCsvDownload(res, presentCorrectionHistoryCsv(data.items));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/correction-requests', requirePermission('corrections.create'), async (req, res) => {
  try {
    res.json(await createCorrectionRequest(
      req.body || {},
      { mutationContext: getRequestMutationContext(req) }
    ));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/correction-requests/:requestId/claim', requirePermission('corrections.claim'), async (req, res) => {
  try {
    res.json(await claimCorrectionRequest(
      req.params.requestId,
      { mutationContext: getRequestMutationContext(req) }
    ));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/correction-requests/:requestId/release', requirePermission('corrections.claim'), async (req, res) => {
  try {
    res.json(await releaseCorrectionRequest(
      req.params.requestId,
      req.body?.claimVersion,
      req.get(CLAIM_TOKEN_HEADER),
      { mutationContext: getRequestMutationContext(req) }
    ));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/correction-requests/:requestId/force-release', requirePermission('corrections.force_release'), async (req, res) => {
  try {
    res.json(await forceReleaseCorrectionRequest(
      req.params.requestId,
      req.body?.claimVersion,
      req.body?.confirm === true,
      { mutationContext: getRequestMutationContext(req) }
    ));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/correction-requests/:requestId/refresh', requirePermission('corrections.complete'), async (req, res) => {
  try {
    res.json(await refreshCorrectionRequest(
      req.params.requestId,
      req.body?.claimVersion,
      req.get(CLAIM_TOKEN_HEADER),
      { mutationContext: getRequestMutationContext(req) }
    ));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.patch('/admin/correction-requests/:requestId/status', requirePermission('corrections.reject'), async (req, res) => {
  try {
    res.json(await updateCorrectionRequestStatus(
      req.params.requestId,
      req.body?.status,
      req.body?.claimVersion,
      req.get(CLAIM_TOKEN_HEADER),
      { mutationContext: getRequestMutationContext(req) }
    ));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

router.post('/admin/correction-requests/:requestId/complete', requirePermission('corrections.complete'), async (req, res) => {
  try {
    res.json(await completeCorrectionRequest(
      req.params.requestId,
      req.body?.claimVersion,
      req.get(CLAIM_TOKEN_HEADER),
      { mutationContext: getRequestMutationContext(req) }
    ));
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
});

module.exports = router;
