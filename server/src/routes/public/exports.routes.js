const express = require('express');
const { getExportStatus, confirmExportSnapshot, createExportSnapshot, getExportSnapshot } = require('../../services/export.service');
const { getRequestMutationContext } = require('../../audit/mutation-context');
const { requirePermission } = require('../../auth/authorization');

const router = express.Router();

router.get('/export/status', requirePermission('exports.view'), async (req, res) => {
  try {
    const status = await getExportStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/export/csv', requirePermission('exports.view'), async (req, res) => {
  res.status(410).json({
    error: 'Прямий CSV-експорт вимкнено. Створіть і підтвердьте immutable export snapshot.',
  });
});

router.post('/export/snapshots', requirePermission('exports.create'), async (req, res) => {
  try {
    const snapshot = await createExportSnapshot({
      fromSku: req.body?.fromSku,
      toSku: req.body?.toSku,
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
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.get('/export/snapshots/:id/csv', requirePermission('exports.view'), async (req, res) => {
  try {
    const snapshot = await getExportSnapshot(req.params.id);
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
    }));
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

module.exports = router;
