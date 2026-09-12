const READ_SAMPLES = { warmups: 10, samples: 100 };
const WRITE_SAMPLES = { warmups: 5, samples: 30 };

const gates = Object.freeze({
  requestP95Ms: 500,
  readQueryCount: 20,
  writeQueryCount: 75,
  maxSingleQueryMs: 100,
  responseBytes: 5 * 1024 * 1024,
  heapGrowthBytes: 64 * 1024 * 1024,
  planEstimateRatio: 10,
  sharedReadBlocks: 10000,
  tempBlocks: 1,
});

const matrix = [
  ['product_config', 'read', 'GET /api/config'],
  ['product_preview', 'read', 'POST /api/preview'],
  ['product_save', 'write', 'POST /api/save'],
  ['product_decode', 'read', 'POST /api/decode'],
  ['recount_preview', 'read', 'POST /api/recount/preview'],
  ['recount_direct_apply', 'write', 'POST /api/recount/apply'],
  ['correction_completion', 'write', 'POST /api/admin/correction-requests/:id/complete'],
  ['catalog_read', 'read', 'GET /api/admin/config'],
  ['schema_read', 'read', 'GET /api/admin/sku-schema/:category'],
  ['pricing_read', 'read', 'GET /api/admin/prices/:category'],
  ['correction_queue', 'read', 'GET /api/admin/correction-requests'],
  ['correction_history_page', 'read', 'GET /api/admin/product-corrections'],
  ['correction_history_csv', 'write', 'GET /api/admin/product-corrections/csv'],
  ['product_timeline', 'read', 'GET /api/product-timeline'],
  ['repricing_scenario_preview', 'read', 'POST /api/admin/repricing/preview'],
  ['repricing_global_preview', 'read', 'POST /api/admin/repricing/global/preview'],
  ['repricing_draft_list', 'read', 'GET /api/admin/repricing/drafts'],
  ['repricing_draft_read', 'read', 'GET /api/admin/repricing/drafts/:id'],
  ['repricing_draft_create', 'write', 'POST /api/admin/repricing/drafts'],
  ['repricing_draft_sync', 'write', 'POST /api/admin/repricing/drafts/:id/sync'],
  ['repricing_apply', 'write', 'POST /api/admin/repricing/apply'],
  ['repricing_rollback', 'write', 'POST /api/admin/repricing/:id/rollback'],
  ['repricing_csv', 'write', 'GET /api/admin/repricing/:id/csv'],
  ['export_status', 'read', 'GET /api/export/status'],
  ['export_snapshot_create', 'write', 'POST /api/export/snapshots'],
  ['export_snapshot_reuse', 'write', 'POST /api/export/snapshots (idempotent reuse)'],
  ['export_snapshot_download', 'write', 'GET /api/export/snapshots/:id/csv'],
  ['export_snapshot_confirmation', 'write', 'POST /api/export/snapshots/:id/confirm'],
].map(([id, kind, workflow]) => ({
  id,
  kind,
  workflow,
  ...(kind === 'read' ? READ_SAMPLES : WRITE_SAMPLES),
  concurrency: kind === 'read' ? [1, 4] : [1],
}));

module.exports = { gates, matrix, READ_SAMPLES, WRITE_SAMPLES };
