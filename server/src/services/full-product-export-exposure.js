const { buildExposureIndex, classifyExposure, hash, stableJson } = require('./export-exposure/evidence');
const { buildLineageGraph } = require('./export-exposure/manifest');

// One statement gives the Phase-0 classifier coherent retained evidence in the
// recount transaction. No snapshot locks: generated and confirmed both hold a successor.
async function readLineageExposure(client, sourceId, sourceBeforeRecount) {
  const { rows: [input] } = await client.query(`SELECT
    (SELECT COALESCE(jsonb_agg(p ORDER BY id), '[]') FROM
      (SELECT id, full_sku, status, corrected_from_product_id, corrected_to_product_id FROM products) p) AS products,
    (SELECT COALESCE(jsonb_agg(c ORDER BY id), '[]') FROM
      (SELECT id, source_product_id, corrected_product_id, source_sku, corrected_sku FROM product_corrections) c) AS corrections,
    (SELECT COALESCE(jsonb_agg(s ORDER BY id), '[]') FROM
      (SELECT id, status, from_sku, to_sku, exported_to_product_id, row_count, file_name, csv_content, reexport_revisions
       FROM export_snapshots WHERE full_product_lifecycle_version IS NULL) s) AS snapshots,
    (SELECT COALESCE(jsonb_agg(a), '[]') FROM magento_export_artifacts a
      JOIN export_snapshots s ON s.id=a.snapshot_id WHERE s.full_product_lifecycle_version IS NULL) AS artifacts,
    (SELECT COALESCE(jsonb_agg(r), '[]') FROM product_export_revisions r) AS revisions,
    (SELECT COALESCE(jsonb_agg(e), '[]') FROM export_events e) AS events,
    (SELECT COALESCE(jsonb_agg(s), '[]') FROM export_state s) AS state,
    (SELECT COALESCE(jsonb_agg(f), '[]') FROM product_full_export_state f) AS lifecycle,
    (SELECT COALESCE(jsonb_agg(m), '[]') FROM
      (SELECT p.product_id, p.sku_at_capture, p.snapshot_id, p.capture_kind, p.evidence_hash, s.status
       FROM export_snapshot_products p JOIN export_snapshots s ON s.id=p.snapshot_id) m) AS members`);
  return classifyLineage(input, sourceId, sourceBeforeRecount);
}

function classifyLineage(input, sourceId, sourceBeforeRecount) {
  const graph = buildLineageGraph(input.products, input.corrections);
  const ids = [...graph.ancestors(sourceId), sourceId].sort((a, b) => a - b);
  const index = buildExposureIndex(input);
  const states = new Map(input.lifecycle.map((s) => [Number(s.product_id), s]));
  const exact = []; const indicators = []; const issues = [...(graph.components.get(sourceId)?.issues || [])];
  for (const id of ids) {
    const state = states.get(id);
    const retained = index.productEvidence.get(id);
    const members = input.members.filter((m) => Number(m.product_id) === id);
    exact.push(...(retained?.exact || []), ...members.map((m) => ({ productId: id,
      sku: m.sku_at_capture, snapshotId: m.snapshot_id, status: m.status,
      kind: m.capture_kind, evidenceHash: m.evidence_hash })));
    issues.push(...(retained?.issues || []));
    const covered = ['ordinary_save', 'recount'].includes(state?.evidence?.origin);
    if (!covered) indicators.push({ code: 'LIFECYCLE_HISTORY_UNRESOLVED', productId: id });
    // Current exact membership replaces cursor/range inference for lifecycle-born
    // products. An unmatched old exposure flag still fails closed.
    indicators.push(...(retained?.indicators || []).filter((item) =>
      !(covered && item.code === 'AT_OR_BELOW_CURSOR')
      && !(members.length && item.code === 'HAS_PRODUCT_SNAPSHOT_FLAG')));
    if (state?.hold_reason === 'invalid_lineage') issues.push({ code: 'PRIOR_INVALID_LINEAGE', productId: id });
  }
  const exposure = classifyExposure({ exact, indicators, issues });
  const independentExclusion = (Number(sourceBeforeRecount.exclude_from_export) === 1
      && !states.get(sourceId)?.source_correction_id)
    || ids.some((id) => states.get(id)?.hold_reason === 'intentional_exclusion');
  const invalidLineage = issues.some((i) => /LINEAGE|CORRECTION|PRODUCT_MISSING/.test(i.code));
  const holdReason = invalidLineage ? 'invalid_lineage'
    : independentExclusion ? 'intentional_exclusion'
      : exposure.classification === 'historical_ambiguous' ? 'historical_ambiguity'
        : exposure.classification === 'reliably_unexposed' ? null : 'prior_exposure';
  // Reference-only evidence. CSV bytes and large raw inventory payloads stay out.
  return { route: holdReason ? 'hold' : 'normal', holdReason, productIds: ids,
    lineage: { products: input.products.filter((p) => ids.includes(Number(p.id))),
      corrections: input.corrections.filter((c) => ids.includes(Number(c.corrected_product_id))) },
    evidence: { origin: 'recount', classification: exposure.classification,
      primaryReason: exposure.primaryReason, ancestorProductIds: ids,
      snapshotIds: [...new Set(exposure.exact.map((e) => e.snapshotId))].sort(),
      evidenceHash: hash(stableJson(exposure)), independentExclusion,
      issueCodes: [...new Set(exposure.issues.map((e) => e.code))].sort() } };
}

module.exports = { readLineageExposure, classifyLineage };
