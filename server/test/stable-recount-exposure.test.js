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

// Replica of the operator's read-only SV11510016 rows, not a production fixture.
function nativeChainFixture() {
  const state = fixture();
  state.product = { id: 5082, full_sku: null, characteristic_version_id: 1,
    public_sku: 'SV11510016', public_product_identity_id: '4315', category: 'SV',
    status: 'active', corrected_from_product_id: 5081, corrected_to_product_id: null, exclude_from_export: 0 };
  state.lifecycle = { ...state.lifecycle, source_correction_id: 1558 };
  state.reservation = null;
  state.stable.request = { ...state.stable.request, product_id: 5082 };
  const ancestor = (id, fullSku, previous, next, correctionId) => ({
    product: { ...state.product, id, full_sku: fullSku, characteristic_version_id: null,
      status: 'corrected', corrected_from_product_id: previous, corrected_to_product_id: next, exclude_from_export: 1 },
    lifecycle: { ...state.lifecycle, route: 'retired', hold_reason: null, source_correction_id: correctionId },
    reservation: { first_product_id: id },
  });
  state.stable.members = [ancestor(1835, 'SV11510016', null, 5081, null),
    ancestor(5081, 'SV11510024', 1835, 5082, 1557),
    { product: state.product, lifecycle: state.lifecycle, reservation: null }];
  state.stable.corrections = [
    { id: 1557, source_product_id: 1835, corrected_product_id: 5081, source_sku: 'SV11510016', corrected_sku: 'SV11510024' },
    { id: 1558, source_product_id: 5081, corrected_product_id: 5082, source_sku: 'SV11510024', corrected_sku: 'SV11510016' },
  ];
  return state;
}

test('SV11510016 native terminal uses public identity and exact ancestor ownership without a synthetic registry entry', () => {
  const state = nativeChainFixture(), before = structuredClone(state);
  assert.deepEqual(service.blockers(state), []);
  assert.deepEqual(state, before, 'eligibility cannot repair reservations or lineage');
  const ordinary = require('../src/services/magento/exposure-reconciliation').blockers(state);
  assert.ok(ordinary.includes('CORRECTION_LINEAGE'));
  assert.ok(ordinary.includes('SKU_RESERVATION_CONFLICT'), 'generic legacy exposure remains unchanged');
});

test('native terminal still rejects foreign identity/owners, missing history and unsafe delivery evidence', () => {
  const variants = [
    ['missing characteristics', s => { s.product.characteristic_version_id = null; }, 'SKU_RESERVATION_CONFLICT'],
    ['zero characteristics', s => { s.product.characteristic_version_id = 0; }, 'SKU_RESERVATION_CONFLICT'],
    ['legacy terminal without owner', s => { s.product.full_sku = 'SV11510025'; s.product.characteristic_version_id = null; }, 'SKU_RESERVATION_CONFLICT'],
    ['root reservation absent', s => { s.stable.members[0].reservation = null; }, 'SKU_RESERVATION_CONFLICT'],
    ['root reserved for successor', s => { s.stable.members[0].reservation.first_product_id = 5082; }, 'SKU_RESERVATION_CONFLICT'],
    ['middle reserved for foreign owner', s => { s.stable.members[1].reservation.first_product_id = 9000; }, 'SKU_RESERVATION_CONFLICT'],
    ['outside SKU conflict', s => { s.stable.conflictingReservations = true; }, 'SKU_RESERVATION_CONFLICT'],
    ['foreign ancestor identity with copied public article', s => { s.stable.members[0].product.public_product_identity_id = '9999'; }, 'PUBLIC_IDENTITY_CHANGED'],
    ['foreign middle public article', s => { s.stable.members[1].product.public_sku = 'FOREIGN'; }, 'PUBLIC_IDENTITY_CHANGED'],
    ['foreign current identity', s => { s.product.public_product_identity_id = '9999'; }, 'PUBLIC_IDENTITY_CHANGED'],
    ['missing ancestor', s => { s.stable.members.shift(); }, 'CORRECTION_LINEAGE_CONFLICT'],
    ['missing correction', s => { s.stable.corrections.shift(); }, 'CORRECTION_LINEAGE_CONFLICT'],
    ['missing source pointer', s => { s.lifecycle.source_correction_id = null; }, 'CORRECTION_LINEAGE_CONFLICT'],
    ['broken reciprocal link', s => { s.stable.members[1].product.corrected_to_product_id = null; }, 'CORRECTION_LINEAGE_CONFLICT'],
    ['duplicate ancestor', s => { s.stable.members.push(structuredClone(s.stable.members[0])); }, 'CORRECTION_LINEAGE_CONFLICT'],
    ['disconnected identity user', s => { const extra = structuredClone(s.stable.members[0]); extra.product.id = 9000; extra.product.corrected_to_product_id = null; s.stable.members.push(extra); }, 'CORRECTION_LINEAGE_CONFLICT'],
    ['retired ancestor not retired', s => { s.stable.members[1].lifecycle.route = 'normal'; }, 'PREDECESSOR_NOT_RETIRED'],
    ['unknown ancestor exclusion', s => { s.stable.members[0].lifecycle.business_exclusion_state = 'unknown'; }, 'EXCLUSION_OR_UNKNOWN_POLICY'],
    ['current independently excluded', s => { s.lifecycle.evidence.independentExclusion = true; }, 'EXCLUSION_OR_UNKNOWN_POLICY'],
    ['nonterminal current', s => { s.product.corrected_to_product_id = 9000; }, 'STABLE_RECOUNT_NOT_TERMINAL'],
    ['missing remote identity', s => { s.stable.remoteId = null; }, 'DURABLE_REMOTE_ID_REQUIRED'],
    ['binding changed', s => { s.stable.currentBindingId = 'foreign'; }, 'CURRENT_PUBLIC_BINDING_REQUIRED'],
    ['uncertain delivery', s => { s.stable.jobs.push({ state: 'uncertain' }); }, 'UNFINISHED_SYNC_WORK'],
    ['active correction', s => { s.stable.activeRequests.push({}); }, 'ACTIVE_CORRECTION_OR_DELETION'],
  ];
  for (const [label, change, expected] of variants) {
    const state = nativeChainFixture(); change(state);
    assert.ok(service.blockers(state).includes(expected), label);
  }
});
