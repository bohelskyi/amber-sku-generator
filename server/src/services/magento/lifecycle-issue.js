// Local read projection only. Never return arbitrary lifecycle evidence to HTTP.
const historicalAmbiguitySql = `f.route='hold' AND f.hold_reason='historical_ambiguity'
  AND (f.evidence->>'classification'='historical_ambiguous'
    OR f.evidence->>'primaryReason'='INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP')`;
const lifecycleProjectionSql = `jsonb_build_object('route',f.route,'hold_reason',f.hold_reason,
  'delivery_version',f.delivery_version::text,'source_correction_id',f.source_correction_id,
  'evidence',jsonb_build_object('classification',f.evidence->>'classification',
    'primaryReason',f.evidence->>'primaryReason','ancestorProductIds',f.evidence->'ancestorProductIds')) AS lifecycle`;
function eligibilityIssue(state) {
  if (state?.route !== 'hold' || state.hold_reason !== 'historical_ambiguity'
    || (state.evidence?.classification !== 'historical_ambiguous'
      && state.evidence?.primaryReason !== 'INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP')) return null;
  const evidence = state.evidence;
  return { type: 'historical_ambiguity', lifecycleRoute: 'hold', holdReason: 'historical_ambiguity',
    classification: evidence.classification === 'historical_ambiguous' ? evidence.classification : null,
    primaryReason: ['INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP', 'EVIDENCE_INTEGRITY_UNRESOLVED'].includes(evidence.primaryReason)
      ? evidence.primaryReason : null,
    sourceCorrectionId: Number.isSafeInteger(state.source_correction_id) && state.source_correction_id > 0 ? state.source_correction_id : null,
    ancestorProductIds: Array.isArray(evidence.ancestorProductIds)
      ? [...new Set(evidence.ancestorProductIds.filter((id) => Number.isSafeInteger(id) && id > 0))] : [],
    deliveryVersion: /^[1-9]\d*$/.test(String(state.delivery_version)) ? String(state.delivery_version) : null };
}
module.exports = { eligibilityIssue, lifecycleProjectionSql, historicalAmbiguitySql };
