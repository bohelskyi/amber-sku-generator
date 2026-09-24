const express = require('express');
const {
  getExportStatus, confirmExportSnapshot, createExportSnapshot, getExportSnapshot,
  getMagentoArtifact, getMagentoArtifacts, previewExport,
} = require('../../services/export.service');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { requirePermission } = require('../../auth/authorization');
const config = require('../../config/env');
const { manifestProvenance } = require('../../services/export-templates/snapshot-binding');
const {
  confirmPriceExportSnapshot,
  createPriceExportSnapshot,
  getPriceExportSnapshot,
  getPriceExportStatus,
} = require('../../services/price-export.service');

const router = express.Router();

router.get('/export/template-options', requirePermission('exports.view'), async (req, res) => {
  try {
    const { getExportTemplateOptions } = require('../../services/export-templates/template.service');
    res.json(await getExportTemplateOptions({ includeNonActive: req.permissions.includes('export_templates.activate') }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/export/status', requirePermission('exports.view'), async (req, res) => {
  try {
    const status = await getExportStatus({ mutationContext: getRequestMutationContext(req) });
    res.json({ ...status,
      translationSuggestionAvailable: Boolean(config.googleTranslationApiKey) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export/csv', requirePermission('exports.view'), async (req, res) => {
  res.status(410).json({
    error: 'Прямий CSV-експорт вимкнено. Створіть і підтвердьте immutable export snapshot.',
  });
});

router.post('/export/preview', requirePermission('exports.view'), async (req, res) => {
  try {
    res.json(await previewExport({
      fromSku: req.body?.fromSku,
      toSku: req.body?.toSku,
      mode: req.body?.mode,
      profile: req.body?.profile,
      requestContract: req.body?.requestContract,
      selection: req.body?.selection,
    }, { mutationContext: getRequestMutationContext(req) }));
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message,
      ...(err.statusCode && err.code ? { code: err.code } : {}),
      ...(err.details ? { errors: err.details } : {}) });
  }
});

router.post('/export/snapshots', requirePermission('exports.create'), async (req, res) => {
  try {
    const snapshot = await createExportSnapshot({
      fromSku: req.body?.fromSku,
      toSku: req.body?.toSku,
      idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
      profile: req.body?.profile,
      mode: req.body?.mode,
      requestContract: req.body?.requestContract,
      selection: req.body?.selection,
      previewToken: req.body?.previewToken,
      previewExpectation: req.body?.previewExpectation,
    }, { mutationContext: getRequestMutationContext(req) });
    res.status(201).json({
      id: snapshot.id,
      status: snapshot.status,
      fileName: snapshot.file_name,
      rowCount: Number(snapshot.row_count),
      generatedAt: snapshot.generated_at,
      artifacts: await getMagentoArtifacts(snapshot.id, { mutationContext: getRequestMutationContext(req) }),
      ...manifestProvenance(snapshot),
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({
      error: err.message,
      ...(err.publicCode ? { code: err.publicCode } : {}),
      ...(err.statusCode && err.code ? { code: err.code } : {}),
      ...(err.details ? { errors: err.details } : {}),
    });
  }
});

router.get('/export/snapshots/:id', requirePermission('exports.view'), async (req, res) => {
  try {
    const snapshot = await getExportSnapshot(req.params.id, { mutationContext: getRequestMutationContext(req) });
    res.json({
      id: snapshot.id,
      status: snapshot.status,
      rowCount: Number(snapshot.row_count),
      generatedAt: snapshot.generated_at,
      artifacts: await getMagentoArtifacts(snapshot.id, { includeRows: true, mutationContext: getRequestMutationContext(req) }),
      ...(snapshot.export_session_id ? { sessionId: snapshot.export_session_id, accessEpoch: snapshot.session_access_epoch } : {}),
      ...(snapshot.template_label ? { templateLabel: snapshot.template_label } : {}),
      ...manifestProvenance(snapshot),
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.get('/export/snapshots/:id/magento/:group/csv', requirePermission('exports.view'), async (req, res) => {
  try {
    const artifact = await getMagentoArtifact(req.params.id, req.params.group, { mutationContext: getRequestMutationContext(req) });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.file_name}"`);
    res.send(artifact.csv_content);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.get('/export/snapshots/:id/csv', requirePermission('exports.view'), async (req, res) => {
  try {
    const snapshot = await getExportSnapshot(req.params.id, { mutationContext: getRequestMutationContext(req) });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${snapshot.file_name}"`);
    res.send(snapshot.csv_content);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/export/snapshots/:id/confirm', requirePermission('exports.create'), async (req, res) => {
  try {
    res.json(await confirmExportSnapshot(req.params.id, {
      mutationContext: getRequestMutationContext(req),
      expectedAccessEpoch: req.body?.expectedAccessEpoch,
    }));
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.get('/price-export/status', requirePermission('exports.view'), async (_req, res) => {
  try {
    res.json(await getPriceExportStatus());
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/price-export/snapshots', requirePermission('exports.create'), async (req, res) => {
  try {
    const snapshot = await createPriceExportSnapshot({
      idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey,
    }, { mutationContext: getRequestMutationContext(req) });
    res.status(201).json({
      id: snapshot.id,
      status: snapshot.status,
      fileName: snapshot.file_name,
      rowCount: Number(snapshot.row_count),
      generatedAt: snapshot.generated_at,
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({
      error: err.message,
      ...(err.publicCode ? { code: err.publicCode } : {}),
    });
  }
});

router.get('/price-export/snapshots/:id/csv', requirePermission('exports.view'), async (req, res) => {
  try {
    const snapshot = await getPriceExportSnapshot(req.params.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${snapshot.file_name}"`);
    res.send(snapshot.csv_content);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/price-export/snapshots/:id/confirm', requirePermission('exports.create'), async (req, res) => {
  try {
    res.json(await confirmPriceExportSnapshot(req.params.id, {
      mutationContext: getRequestMutationContext(req),
    }));
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

module.exports = router;
