// Synthetic immutable approval chain, no database or HTTP.
const { digest } = require('../../src/services/export-exposure/repair-manifest');
const c = require('../../src/services/magento/binding-contract');
function fixture({ malformed = true } = {}) {
  const config = { baseUrl: 'https://review.invalid' }, originHash = c.originHash(config.baseUrl);
  const evidence = { origin: 'cutover', decision: 'legacy_baseline' };
  const entry = {
    productId: 7, sku: 'SV7', action: 'legacy_baseline', lineageProductIds: [7],
    payloadHash: 'a'.repeat(64), classification: 'historical_ambiguous',
    before: { evidence: { origin: 'migration_039' }, revision: '1', confirmed_revision: '0',
      cutover_baseline_revision: '0', source_correction_id: null, recount_compatibility_excluded: false },
    after: { route: 'normal', hold_reason: null, business_exclusion_state: 'none',
      recount_compatibility_excluded: false, source_correction_id: null, revision: '1',
      confirmed_revision: '0', cutover_baseline_revision: '1', delivery_version: '2', evidence },
  };
  const body = { format: 'amber-full-product-cutover-v1', kind: 'cutover', database: 'review_test',
    policy: { batchSize: 100 }, entries: typeof malformed === 'function' ? malformed(entry) : malformed ? [entry, null] : [entry] };
  const manifestHash = digest(body);
  const row = { revision: '1', origin: 'legacy', status: 'active', exclude_from_export: 0,
    corrected_from_product_id: null, corrected_to_product_id: null, route: 'normal', hold_reason: null,
    source_correction_id: null, business_exclusion_state: 'none', recount_compatibility_excluded: false,
    confirmed_revision: '0', cutover_baseline_revision: '1', cutover_baseline_event_id: '2',
    csv_retired_revision: '0', externally_delivered_revision: '0', externally_delivered_event_id: null,
    repair_manifest_hash: manifestHash, evidence, event_key: 'product.full_export_baselined',
    subject_type: 'product', subject_id: '7', database: 'review_test', delivery_version: '2',
    details: { manifestHash, baselineRevision: '1', deliveryNotProven: true,
      assertion: 'current_inventory_accepted_as_legacy_external_baseline', factualEvidence: 'historical_ambiguous' },
  };
  const history = { complete: true, productId: 7, hasRecount: false, identityChanged: false,
    issues: [], corrections: [], products: [{ productId: 7, article: 'SV7', internalSku: 'SV7',
      status: 'active', previousProductId: null, nextProductId: null, route: 'normal', holdReason: null,
      businessExclusion: 'none', compatibilityExcluded: false, independentExclusion: false,
      legacyExportExcluded: false, sourceCorrectionId: null }] };
  const observation = { amber: { product: { id: 7, public_product_identity_id: '17', public_sku: 'SV7' },
    revision: { id: '11111111-1111-4111-8111-111111111111', originHash, installationKey: 'review' } },
    raw: { id: 77, sku: 'SV7' } };
  const queries = [];
  const client = { async query(sql) {
    queries.push(sql);
    if (sql.startsWith('SELECT phase')) return { rows: [{ phase: 'active' }] };
    if (sql.includes('f.*,a.event_key')) return { rows: [row] };
    if (sql.includes("event_key='full_product_cutover.approved'"))
      return { rows: [{ id: '1', details: { manifest: { ...body, contentSha256: manifestHash } } }] };
    if (sql.includes("event_key='full_product_cutover.batch_applied'"))
      return { rows: [{ id: '3', details: { result: { manifestHash, batchNumber: 0, productIds: [7] },
        beforeAfterHash: digest([entry]) } }] };
    throw new Error('Unexpected SQL: ' + sql);
  } };
  const options = { history, progress: null, facts: { protected_work: false, other_origin: false,
    previous_delivery: false, acknowledged_remote_id: null, external_delivery_receipts: [] },
    evidence: { ownershipIssue: null, lifecycleBlockers: [] } };
  return { config, client, observation, options, queries, body, row };
}

module.exports = { fixture };
