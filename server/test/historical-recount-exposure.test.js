const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/magento/historical-recount-exposure');
const { digest } = require('../src/services/export-exposure/repair-manifest');
function fixture() {
  const members = Array.from({length:5},(_,i) => ({ product: { id:i+1,full_sku:`INTERNAL-${i}`,public_sku:i<2?`OLD-${i}`:'CURRENT',
    public_product_identity_id:i<2?String(i+1):'3',status:i===4?'active':'corrected',exclude_from_export:i===4?0:1,
    corrected_from_product_id:i===0?null:i,corrected_to_product_id:i===4?null:i+2 },
    lifecycle: { route:i===4?'hold':'retired',hold_reason:i===4?'historical_ambiguity':null,
      source_correction_id:i<3?null:10+i,business_exclusion_state:i<3?'unknown':'none',recount_compatibility_excluded:false,
      evidence:i<3?{origin:'migration_039',coverage:'unresolved_historical'}:{origin:'recount'} },reservation:{first_product_id:i+1} }));
  const corrections = members.slice(1).map((m,i) => ({id:11+i,source_product_id:i+1,corrected_product_id:i+2,
    source_sku:members[i].product.full_sku,corrected_sku:m.product.full_sku}));
  return {members,corrections};
}
test('historical recipe proves the actual mixed chain while keeping baseline pointers and retired unknown policies immutable', () => {
  const {members,corrections} = fixture(), before = structuredClone(members);
  assert.deepEqual(service.lineageBlockers(members,corrections,5),[]);
  assert.deepEqual(members,before);
  for (const change of [
    m => {m[3].lifecycle.source_correction_id=null;}, m => {m[1].lifecycle.source_correction_id=999;},
    m => {m[1].lifecycle.evidence.origin='recount';}, m => {m[0].lifecycle.business_exclusion_state='excluded';},
    m => {m[0].lifecycle.evidence.independentExclusion=true;}, m => {m[0].lifecycle.recount_compatibility_excluded=true;},
    m => {m[4].lifecycle.business_exclusion_state='unknown';}, m => {m[1].product.status='active';},
    m => {m[2].product.corrected_from_product_id=null;}, m => {m[3].reservation.first_product_id=1;},
  ]) { const clone=structuredClone(members);change(clone);assert.ok(service.lineageBlockers(clone,corrections,5).length,change.toString()); }
});
test('only receipt-proven cutover ancestors can retain the old unknown policy and missing pointer', () => {
  const { members, corrections } = fixture(), m = members[2];
  m.lifecycle.evidence = { origin: 'cutover', decision: 'hold' };
  m.lifecycle.repair_manifest_hash = 'a'.repeat(64);
  assert.ok(service.lineageBlockers(members, corrections, 5).includes('CUTOVER_BASELINE_UNVERIFIED'));
  m.cutoverBaseline = { productId: m.product.id, manifestHash: m.lifecycle.repair_manifest_hash, evidenceHash: digest(m.lifecycle.evidence) };
  assert.deepEqual(service.lineageBlockers(members, corrections, 5), []);
  for (const change of [
    v => { v.cutoverBaseline.productId = 99; }, v => { v.lifecycle.repair_manifest_hash = 'b'.repeat(64); },
    v => { v.lifecycle.evidence.independentExclusion = true; }, v => { v.lifecycle.source_correction_id = 999; },
    v => { v.lifecycle.business_exclusion_state = 'excluded'; }, v => { v.lifecycle.recount_compatibility_excluded = true; },
  ]) {
    const clone = structuredClone(members); change(clone[2]);
    assert.ok(service.lineageBlockers(clone, corrections, 5).length, change.toString());
  }
});
test('historical proof requires an explicit current-only decision and every exact retained file', () => {
  const plan={historical:{requiredEvidence:{files:['file-1']}}};
  const evidence={files:[{snapshotId:'file-1',disposition:'quarantined_do_not_import',evidence:'Removed from pending imports'}],
    confirmation:{disposition:'current_update_only',evidence:'Current product approved; retired unknown flags are recount markers'}};
  assert.deepEqual(service.validateEvidence(plan,evidence),evidence);
  for (const bad of [{...evidence,files:[]},{...evidence,files:[...evidence.files,...evidence.files]},
    {...evidence,confirmation:{disposition:'release',evidence:'yes'}},{...evidence,confirmation:{disposition:'current_update_only',evidence:''}}]) {
    assert.throws(()=>service.validateEvidence(plan,bad),{code:'RECONCILIATION_UNRESOLVED'});
  }
});
test('a held current successor keeps its missing pointer only with its own verified cutover baseline', () => {
  const { members, corrections } = fixture(), current = members[4];
  current.lifecycle.source_correction_id = null;
  current.lifecycle.evidence = { origin: 'cutover', decision: 'hold' };
  current.lifecycle.repair_manifest_hash = 'a'.repeat(64);
  assert.ok(service.lineageBlockers(members, corrections, 5).includes('CORRECTION_LINEAGE_CONFLICT'));
  current.cutoverBaseline = { productId: 5, manifestHash: current.lifecycle.repair_manifest_hash, evidenceHash: digest(current.lifecycle.evidence) };
  assert.deepEqual(service.lineageBlockers(members, corrections, 5), []);
  for (const change of [
    m => { m[4].cutoverBaseline.productId = 4; }, m => { m[4].lifecycle.evidence.decision = 'other'; },
    m => { m[4].lifecycle.business_exclusion_state = 'unknown'; }, m => { m[4].lifecycle.source_correction_id = 999; },
  ]) { const clone = structuredClone(members); change(clone); assert.ok(service.lineageBlockers(clone, corrections, 5).length, change.toString()); }
  // Another member's proof never covers the current product's pointer.
  const other = structuredClone(members); delete other[4].cutoverBaseline;
  other[3].cutoverBaseline = { productId: 5, manifestHash: 'a'.repeat(64), evidenceHash: digest(other[4].lifecycle.evidence) };
  assert.ok(service.lineageBlockers(other, corrections, 5).includes('CORRECTION_LINEAGE_CONFLICT'));
});

test('a later recount of a confirmed or released held successor keeps its baseline pointer through its own proof', () => {
  // KL production shape: migration-039 ancestors -> the formerly held current (cutover
  // baseline, released, maybe confirmed) -> a new recount current with a recorded pointer.
  for (const confirmed of [false, true]) {
    const { members, corrections } = fixture(), former = members[3];
    former.lifecycle.source_correction_id = null; former.lifecycle.business_exclusion_state = 'none';
    former.lifecycle.repair_manifest_hash = 'a'.repeat(64);
    const cutover = { origin: 'cutover', decision: 'hold' };
    former.lifecycle.evidence = confirmed ? { origin: 'reconciliation', action: 'magento_historical_recount_prior_exposure',
      priorEvidence: cutover, magentoPriorExposure: { planHash: 'p'.repeat(64) } } : cutover;
    assert.ok(service.lineageBlockers(members, corrections, 5).length, 'unproven former current is never legacy');
    former.cutoverBaseline = { productId: 4, manifestHash: 'a'.repeat(64), evidenceHash: digest(cutover) };
    assert.deepEqual(service.lineageBlockers(members, corrections, 5), [], String(confirmed));
    const wrong = structuredClone(members); wrong[3].lifecycle.business_exclusion_state = 'excluded';
    assert.ok(service.lineageBlockers(wrong, corrections, 5).includes('EXCLUSION_OR_UNKNOWN_POLICY'));
  }
});

test('an archived predecessor counts as retired only when it was already recounted into the chain', () => {
  const { members, corrections } = fixture();
  members[0].product.status = 'archived';
  assert.deepEqual(service.lineageBlockers(members, corrections, 5), []);
  members[0].product.corrected_to_product_id = null;
  assert.ok(service.lineageBlockers(members, corrections, 5).includes('PREDECESSOR_NOT_RETIRED'));
  const live = fixture(); live.members[0].lifecycle.route = 'normal'; live.members[0].product.status = 'archived';
  assert.ok(service.lineageBlockers(live.members, live.corrections, 5).includes('PREDECESSOR_NOT_RETIRED'));
});

test('a native recount current needs no SKU reservation and only its own null-SKU artifacts are tolerated', () => {
  // KL production shape: an Amber recount after cutover makes a native current (no full_sku).
  const { members, corrections } = fixture(), current = members[4].product;
  Object.assign(current, { full_sku: null, characteristic_version_id: 5, public_sku: 'CURRENT' });
  members[4].reservation = null; corrections[3].corrected_sku = 'CURRENT';
  assert.deepEqual(service.lineageBlockers(members, corrections, 5), []);
  const ancestor = structuredClone(members); ancestor[3].reservation = null;
  assert.ok(service.lineageBlockers(ancestor, corrections, 5).includes('SKU_RESERVATION_CONFLICT'));
  const encoded = structuredClone(members); encoded[4].product.characteristic_version_id = null;
  assert.ok(service.lineageBlockers(encoded, corrections, 5).includes('SKU_RESERVATION_CONFLICT'));
  for (const issue of [{ code: 'PRODUCT_SKU_AMBIGUOUS', productId: 5 }, { code: 'PRODUCT_SKU_IDENTITY_CONFLICT', productId: 5 },
    { code: 'CORRECTION_SKU_MISMATCH', correctionId: 14, productId: 5, storedSku: 'CURRENT' }]) assert.equal(service.nativeArtifact(current, issue), true);
  for (const issue of [{ code: 'PRODUCT_SKU_AMBIGUOUS', productId: 4 }, { code: 'CORRECTION_SKU_MISMATCH', productId: 5, storedSku: 'OTHER' },
    { code: 'RETAINED_FILE_UNREADABLE', productId: 5 }]) assert.equal(service.nativeArtifact(current, issue), false);
  assert.equal(service.nativeArtifact({ ...current, characteristic_version_id: null }, { code: 'PRODUCT_SKU_AMBIGUOUS', productId: 5 }), false);
});
