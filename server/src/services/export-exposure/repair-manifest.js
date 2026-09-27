const { buildCorrectionExposureManifest, buildLineageGraph } = require('./manifest');
const { buildHistoricalIndex } = require('./historical-index');
const { classifyExposure, canonical, hash, stableJson, compare } = require('./evidence');

const FORMAT = 'amber-correction-exposure-manifest-v2';
const digest = (value) => hash(stableJson(value));
function baseline(p) {
  const retired = ['corrected','archived'].includes(p.status) || p.corrected_to_product_id != null;
  return { product_id: p.id, revision:'1', confirmed_revision:'0', delivery_version:'1',
    route:retired ? 'retired' : 'hold', hold_reason:retired ? null : 'historical_ambiguity',
    source_correction_id:null, evidence:{origin:'migration_039',coverage:'unresolved_historical'},
    repair_manifest_hash:null, last_resolution_key:null, resolved_by_user_id:null, resolved_at:null };
}
const stateView = (s) => ({ revision:String(s.revision), confirmed_revision:String(s.confirmed_revision),
  delivery_version:String(s.delivery_version), route:s.route, hold_reason:s.hold_reason });
const names = (p) => ({ ua:p.magento_name_subject_ua ?? null, en:p.magento_name_subject_en ?? null,
  reviewRequired:p.magento_name_review_required ?? false });
const list = (entries, predicate) => entries.filter(predicate).map((e) => e.productId);

function buildRepairManifest(input) {
  input = { ...input, products:[...input.products].sort((a,b)=>a.id-b.id),
    corrections:[...input.corrections].sort((a,b)=>a.id-b.id),
    registry:[...input.registry].sort((a,b)=>compare(a.full_sku,b.full_sku)),
    events:[...input.events].sort((a,b)=>a.id-b.id),
    revisions:[...input.revisions].sort((a,b)=>a.product_id-b.product_id),
    members:[...input.members].sort((a,b)=>compare(a.snapshot_id,b.snapshot_id) || a.product_id-b.product_id) };
  const phase0 = buildCorrectionExposureManifest(input);
  const indexing = buildHistoricalIndex(input);
  const graph = buildLineageGraph(input.products, input.corrections);
  const states = new Map((input.lifecyclePresent ? input.lifecycle : input.products.map(baseline)).map((s) => [Number(s.product_id),s]));
  const products = new Map(input.products.map((p) => [Number(p.id),p]));
  const reservations = new Map(input.registry.map((r) => [r.full_sku,Number(r.first_product_id)]));
  const described = new Map(phase0.products.map((p) => [p.id,p]));
  const terminal = new Map(phase0.terminalActiveSuccessors.map((p) => [p.product.id,p]));
  const entries = [...input.products].sort((a,b) => a.id-b.id).map((p) => {
    const id = Number(p.id); const s = states.get(id); const lineageIds = graph.components.get(id)?.productIds || [id];
    const ancestors = graph.ancestors(id); const t = terminal.get(id);
    const rawExposure = t?.lineageExposure || described.get(id).exposure;
    const exposure = classifyExposure({ ...rawExposure,
      indicators:rawExposure.indicators.filter((i) => !(i.code === 'AT_OR_BELOW_CURSOR'
        && (['ordinary_save','recount'].includes(states.get(i.productId ?? id)?.evidence?.origin)
          || states.get(i.productId ?? id)?.evidence?.historicalCoverage === 'retained_evidence_unexposed'))),
      // An indexing failure can conceal exposure; never turn it into absence.
      issues:[...rawExposure.issues, ...indexing.diagnostics,...lineageIds.filter((n) => products.has(n)
        && reservations.get(products.get(n).full_sku) !== n).map((n) => ({code:'PRODUCT_SKU_IDENTITY_CONFLICT',productId:n}))] });
    const correction = input.corrections.find((c) => Number(c.corrected_product_id) === id);
    const source = correction && products.get(Number(correction.source_product_id));
    const independent = lineageIds.filter((n) => states.get(n)?.business_exclusion_state === 'excluded' || states.get(n)?.hold_reason === 'intentional_exclusion'
      || states.get(n)?.evidence?.independentExclusion === true);
    const provenance = Number(p.exclude_from_export) === 0 ? 'not_excluded'
      : independent.length ? 'independent_exclusion'
        : s?.source_correction_id === correction?.id && s?.evidence?.origin === 'recount'
          && s.business_exclusion_state !== 'unknown'
          && s.evidence.independentExclusion === false ? 'recount_only_verified' : 'unknown';
    const current = s ? { ...stateView(s), exclude_from_export:p.exclude_from_export, names:names(p) } : null;
    let expected = current; let action = 'preserve'; const reasons = [];
    let reconciliation = false; let decision = false;
    const conditionalNames = source && names(p).ua === null && names(p).en === null
      && names(source).ua !== null && names(source).en !== null
      ? { ...names(source), reviewRequired:true } : names(p);
    const candidate = t && exposure.classification === 'reliably_unexposed';
    if (!s) { action = 'blocked'; reasons.push('LIFECYCLE_STATE_MISSING'); decision = true; }
    else if (['phase3_repair','reconciliation','cutover'].includes(s.evidence?.origin)) {
      reasons.push('PRESERVE_REVIEWED_LIFECYCLE_DISPOSITION');
    } else if (t) {
      let holdReason;
      if (exposure.issues.some((i) => /LINEAGE|CORRECTION|PRODUCT_MISSING/.test(i.code))) holdReason = 'invalid_lineage';
      else if (exposure.classification === 'historical_ambiguous') holdReason = 'historical_ambiguity';
      else if (!candidate) { holdReason = 'prior_exposure'; reconciliation = true; }
      else if (provenance === 'independent_exclusion') holdReason = 'intentional_exclusion';
      else if (provenance === 'unknown') holdReason = 'historical_ambiguity';
      reasons.push(exposure.primaryReason);
      if (provenance === 'unknown') reasons.push('EXCLUSION_PROVENANCE_UNPROVEN');
      if (independent.length) reasons.push('INDEPENDENT_EXCLUSION');
      if (candidate && (s.revision !== '1' || s.confirmed_revision !== '0')) {
        holdReason = 'historical_ambiguity'; reasons.push('FIRST_REVISION_BASELINE_CHANGED');
      }
      action = holdReason ? 'hold' : 'first_delivery_pending';
      expected = { ...current, route:holdReason ? 'hold' : 'normal', hold_reason:holdReason ?? null,
        delivery_version:String(BigInt(s.delivery_version)+1n),
        exclude_from_export:holdReason ? current.exclude_from_export : 0,
        names:holdReason ? current.names : conditionalNames };
    } else if (p.status === 'active' && !p.corrected_from_product_id && !p.corrected_to_product_id
      && s.evidence?.origin === 'migration_039') {
      action = 'ordinary_baseline_decision_required'; decision = true;
      reasons.push('HISTORICAL_MEMBERSHIP_DOES_NOT_ACKNOWLEDGE_CURRENT_PAYLOAD');
    } else reasons.push(['archived','corrected'].includes(p.status) ? 'PRESERVE_RETIRED_IDENTITY' : 'PRESERVE_EXISTING_LIFECYCLE');
    const before = { productIds:lineageIds, products:lineageIds.map((n) => products.get(n) ?? { id:n,missing:true }),
      lifecycle:lineageIds.map((n) => states.get(n) ?? { product_id:n,missing:true }),
      corrections:input.corrections.filter((c) => lineageIds.includes(Number(c.source_product_id)) || lineageIds.includes(Number(c.corrected_product_id))),
      registry:input.registry.filter((r) => lineageIds.includes(Number(r.first_product_id))),
      snapshotFingerprints:indexing.snapshots.map((x) => [x.snapshotId,x.beforeFingerprint]),
      cursor:phase0.exportState, events:input.events,
      revisions:input.revisions.filter((r) => lineageIds.includes(Number(r.product_id))),
      exclusionProvenance:provenance, classification:exposure, schemaPresent:input.lifecyclePresent };
    return { productId:id, sku:p.full_sku, category:p.category, status:p.status, exclude_from_export:p.exclude_from_export,
      lifecycle:s ?? null, names:names(p), correctionId:correction?.id ?? null,
      sourceNames:source ? { productId:source.id,...names(source) } : null,
      ancestorChain:ancestors.map((n) => ({ productId:n,sku:products.get(n)?.full_sku ?? null })),
      terminalDescendants:graph.terminals(id), lineageProductIds:lineageIds,
      generatedMemberships:exposure.exact.filter((e) => e.status === 'generated'),
      confirmedMemberships:exposure.exact.filter((e) => e.status === 'confirmed'),
      historicalMemberships:{proposed:indexing.proposed.filter((m) => lineageIds.includes(m.product_id)),
        existing:indexing.existing.filter((m) => lineageIds.includes(Number(m.product_id)))},
      indicators:exposure.indicators, independentExclusion:{provenance,productIds:independent},
      phase0Exposure:rawExposure, exposure, action, reasonCodes:reasons.sort(compare),
      beforeFingerprint:digest(before), before, expectedAfter:expected,
      wouldMutate:['hold','first_delivery_pending'].includes(action), operatorReconciliationRequired:reconciliation,
      architectureDecisionRequired:decision,
      payloadEquality:{ status:'not_proven', reason:'No historical full-payload identity bound to the current product revision.' },
      conditionalFirstDelivery:candidate && s?.route === 'hold' ? { ...current, route:'normal',hold_reason:null,exclude_from_export:0,
        delivery_version:String(BigInt(s?.delivery_version || '1')+1n), names:conditionalNames,
        requires:[...(provenance === 'unknown' ? ['EXCLUSION_PROVENANCE_PROOF'] : independent.length ? ['INDEPENDENT_EXCLUSION_RESOLUTION'] : []),
          ...(s?.revision !== '1' || s?.confirmed_revision !== '0' ? ['FIRST_REVISION_BASELINE_REVIEW'] : [])] } : null };
  });
  const ordinary = entries.filter((e) => e.status === 'active' && e.ancestorChain.length === 0 && e.terminalDescendants.length === 1
    && e.terminalDescendants[0] === e.productId && !e.correctionId);
  const ordinaryClasses = ['confirmed_exact','generated_exact','historical_ambiguous','reliably_unexposed'].map((classification) => {
    const rows = ordinary.filter((e) => e.phase0Exposure.classification === classification);
    return { classification, count:rows.length, productIds:rows.map((e) => e.productId),
      routes:[...new Set(rows.map((e) => e.lifecycle?.route ?? 'missing'))].sort(compare),
      proposedActions:[...new Set(rows.map((e) => e.action))].sort(compare), payloadEquality:'not_proven' };
  });
  const payload = canonical({ ...phase0, format:FORMAT, version:2, contentSha256:undefined,
    schema:{ lifecyclePresent:input.lifecyclePresent, baseline:input.lifecyclePresent ? 'actual' : 'projected_migration_039',
      migrations:input.migrations, applyEligible:input.lifecyclePresent },
    indexing, repairEntries:entries,
    repairSummary:{ total:entries.length, ordinaryActive:{total:ordinary.length,classes:ordinaryClasses},
      mutations:list(entries,(e) => e.wouldMutate), holds:list(entries,(e) => e.expectedAfter?.route === 'hold'),
      automaticFirstDelivery:list(entries,(e) => e.action === 'first_delivery_pending'),
      conditionalFirstDelivery:list(entries,(e) => e.conditionalFirstDelivery !== null),
      reconciliation:list(entries,(e) => e.operatorReconciliationRequired),
      ambiguousSuccessors:list(entries,(e) => terminal.has(e.productId) && e.exposure.classification === 'historical_ambiguous'),
      architectureDecisions:list(entries,(e) => e.architectureDecisionRequired),
      exclusionProofRequired:list(entries,(e) => e.conditionalFirstDelivery?.requires.length > 0) } });
  delete payload.contentSha256;
  return { ...payload,contentSha256:digest(payload) };
}
function verifyManifest(manifest, expectedHash) {
  const { contentSha256, ...payload } = manifest || {};
  if (manifest?.format !== FORMAT || manifest?.version !== 2 || !/^[a-f0-9]{64}$/.test(expectedHash)
    || contentSha256 !== expectedHash || digest(payload) !== expectedHash) throw new Error('Exact manifest version/hash required');
}
module.exports = { FORMAT, buildRepairManifest, verifyManifest, baseline, names, stateView, digest };
