const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/magento/historical-recount-exposure');
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
