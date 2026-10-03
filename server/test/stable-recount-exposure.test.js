const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/magento/stable-recount-exposure');
const { parseArguments } = require('../scripts/magento-reconcile-exposure');
const fixture = () => ({
  product: { id: 5033, full_sku: 'SV11501001', public_sku: 'SV5111010', public_product_identity_id: '4901', status: 'active', corrected_from_product_id: 1368, corrected_to_product_id: null, exclude_from_export: 0 },
  lifecycle: { route: 'hold', hold_reason: 'historical_ambiguity', source_correction_id: 1509, business_exclusion_state: 'none', recount_compatibility_excluded: false, evidence: {} },
  reservation: { first_product_id: 5033 }, gate: { phase: 'active' },
  stable: { activation: { enabled: true }, automatic: { installation_key: 'fixture',legacy_product_csv_enabled:false,cutover_at:'2026-01-01' }, binding: { id: 'binding', installationKey: 'fixture', state: 'published' }, currentBindingId: 'binding', publicEvaluator: true,
    members: [{ product: { id: 1368, full_sku: 'SV5111010', public_sku: 'SV5111010', public_product_identity_id: '4901', status: 'corrected', corrected_from_product_id: null, corrected_to_product_id: 5033, exclude_from_export: 1 }, lifecycle: { route: 'retired', business_exclusion_state: 'none', recount_compatibility_excluded: false, evidence: {} }, reservation: { first_product_id: 1368 } }],
    corrections: [{ id: 1509, source_product_id: 1368, corrected_product_id: 5033,source_sku:'SV5111010',corrected_sku:'SV11501001' }], activeRequests: [], jobs: [], deletions: [], request: { product_id: 5033, state: 'needs_attention', reason_code: 'data_or_binding', active_job_id: null, active_generation: null }, remoteId: 3672 },
});
test('stable recount proof accepts exact immutable identity and rejects every unsafe lineage/work variant', () => {
  const valid = fixture(); valid.stable.members.push({ product: valid.product, lifecycle: valid.lifecycle, reservation: valid.reservation });
  assert.deepEqual(service.blockers(valid), []);
  for (const change of [
    s => { s.stable.members[0].product.public_product_identity_id = '999'; },
    s => { s.stable.members[0].product.public_sku = 'OTHER'; },
    s => { s.stable.members[0].lifecycle.route = 'normal'; },
    s => { s.product.corrected_to_product_id = 6000; },
    s => { s.lifecycle.evidence.independentExclusion = true; },
    s => { s.lifecycle.recount_compatibility_excluded = true; },
    s => { s.stable.members.push(structuredClone(s.stable.members[0])); },
    s => { s.stable.members[0].reservation.first_product_id = 999; },
    s => { s.stable.corrections[0].source_product_id = 999; },
    s => { s.stable.request.reason_code = 'reconciliation_required'; },
    s => { s.stable.request.active_job_id = 'unfinished'; },
    s => { s.stable.jobs.push({ state: 'uncertain' }); },
    s => { s.stable.activeRequests.push({}); },
    s => { s.stable.activation.enabled = false; },
    s => { s.stable.currentBindingId = 'changed'; },
    s => { s.stable.publicEvaluator = false; },
    s => { s.stable.remoteId = null; },
    s => { s.stable.conflictingReservations = true; },
    s => { s.stable.automatic.legacy_product_csv_enabled = true; },
  ]) { const s = structuredClone(valid); change(s); assert.ok(service.blockers(s).length, change.toString()); }
});
test('stable recount CLI is explicit, single-product and requires a binding for preview', () => {
  const base = ['--stable-recount', '--expected-database', 'amber', '--output', 'new.json'];
  assert.throws(() => parseArguments([...base, '--sku', 'SV5111010']));
  assert.throws(() => parseArguments([...base, '--bulk', '--candidates', 'candidates.json']));
  assert.equal(parseArguments([...base, '--sku', 'SV5111010', '--binding-revision', '00000000-0000-4000-8000-000000000001']).stableRecount, true);
  assert.equal(parseArguments([...base,'--apply','--plan','review.json','--expected-hash','a'.repeat(64),'--actor-user-id','1']).stableRecount,true);
});
test('prior exposure enables same-public-SKU UPDATE and still forbids CREATE or a mismatched SKU', () => {
  const s=fixture(), p={...s.product,exportState:{...s.lifecycle,hold_reason:'prior_exposure'}};
  const {syncEligibility}=require('../src/services/magento/sync-eligibility');
  const update=syncEligibility(p,{id:3672,sku:'SV5111010'});
  assert.equal(update.eligible,true);assert.equal(update.mode,'update');
  assert.equal(syncEligibility(p,null).eligible,false);
  assert.equal(syncEligibility(p,{id:3672,sku:'SV11501001'}).eligible,false);
});
test('ordinary exposure rejects the exact stable recount fixture unless the dedicated mode is selected', () => {
  assert.ok(require('../src/services/magento/exposure-reconciliation').blockers(fixture()).includes('CORRECTION_LINEAGE'));
});
