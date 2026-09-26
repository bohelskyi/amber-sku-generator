const test = require('node:test');
const assert = require('node:assert/strict');
const { product, correction, snapshot, emptyEvidence, reproducedCase } = require('./fixtures/export-exposure');
const { buildHistoricalIndex } = require('../src/services/export-exposure/historical-index');
const { buildRepairManifest, verifyManifest, baseline, digest } = require('../src/services/export-exposure/repair-manifest');
const { serializeManifest } = require('../src/services/export-exposure/manifest');
const { applyRepair } = require('../src/services/recount-repair.service');

function input(raw = reproducedCase(), actual = true) {
  return { ...raw, registry:raw.products.map((p) => ({full_sku:p.full_sku,first_product_id:p.id})),
    lifecycle:actual ? raw.products.map(baseline) : [], lifecyclePresent:actual, members:[],migrations:[] };
}
function historical() {
  const p = product(1); const s = snapshot('history',[p], 'generated',{resolved_to_sku:p.full_sku});
  return input(emptyEvidence({products:[p],snapshots:[s],artifacts:[{snapshot_id:'history',profile_version:'magento-products-v1',
    group_code:'SV',file_name:'stored.csv',product_count:1,row_count:2,
    csv_content:'sku,store_view_code,attribute_set_code,product_type\nP1,,Souvenir,simple\nP1,en,Souvenir,simple'}]}));
}
test('phase3 historical indexing records one verified compatibility member without acknowledging revision', () => {
  const data = historical(); const before = structuredClone(data); const result = buildHistoricalIndex(data);
  assert.deepEqual(result.diagnostics,[]); assert.equal(result.proposed.length,1);
  assert.deepEqual(result.proposed[0],{snapshot_id:'history',product_id:1,sku_at_capture:'P1',full_revision:null,
    delivery_version:null,capture_kind:'legacy_compatibility',evidence_origin:'verified_stored_csv',evidence_hash:result.proposed[0].evidence_hash});
  assert.match(result.proposed[0].evidence_hash,/^[a-f0-9]{64}$/); assert.equal('recorded_at' in result.proposed[0],false);
  assert.deepEqual(data,before);
  data.members = result.proposed;
  assert.deepEqual(buildHistoricalIndex(data).proposed,[]); assert.deepEqual(buildHistoricalIndex(data).diagnostics,[]);
});
for (const [name,damage,code] of [
  ['malformed CSV', (d) => {d.snapshots[0].csv_content='sku\n"unterminated';},'STORED_CSV_INVALID'],
  ['row count', (d) => {d.snapshots[0].row_count=2;},'CSV_ROW_COUNT_MISMATCH'],
  ['Main/EN disagreement', (d) => {d.artifacts[0].csv_content=d.artifacts[0].csv_content.replace('P1,en,Souvenir','P1,en,Other');},'MAIN_EN_DISAGREEMENT'],
  ['unknown SKU', (d) => {d.snapshots[0].csv_content='sku,price_uah\nUNKNOWN,21700';},'CSV_SKU_UNRESOLVED'],
  ['contradictory duplicate', (d) => {d.members=[...buildHistoricalIndex(d).proposed,...buildHistoricalIndex(d).proposed];},'DUPLICATE_CONTRADICTORY_MEMBERSHIP'],
  ['identity conflict', (d) => {d.registry[0].first_product_id=2;},'PRODUCT_SKU_IDENTITY_CONFLICT'],
  ['artifact hash mismatch', (d) => {d.members=buildHistoricalIndex(d).proposed;d.artifacts[0].csv_content+='\n';},'ARTIFACT_HASH_OR_MEMBERSHIP_MISMATCH'],
  ['missing artifact', (d) => {d.artifacts=[];d.snapshots[0].legacy_preview_fingerprint='a'.repeat(64);},'MISSING_ARTIFACT'],
  ['metadata mismatch', (d) => {d.snapshots[0].resolved_to_sku='OTHER';},'SNAPSHOT_METADATA_MISMATCH'],
]) test(`phase3 indexing fails closed on ${name}`, () => {
  const data = historical(); damage(data); const result = buildHistoricalIndex(data);
  assert.ok(result.diagnostics.some((i) => i.code === code)); assert.equal(result.proposed.length,0);
  const manifest = buildRepairManifest(data); assert.equal(manifest.repairEntries[0].exposure.classification,'historical_ambiguous');
});
test('phase3 v2 is recursively canonical and binds product, names, lineage, exclusion, versions and snapshot evidence', () => {
  const data = input(); const first = buildRepairManifest(data);
  const reversed = { ...data,products:[...data.products].reverse(),lifecycle:[...data.lifecycle].reverse(),registry:[...data.registry].reverse() };
  // SQL collections are sorted; canonical payload order must also survive caller order.
  assert.equal(first.contentSha256,buildRepairManifest(reversed).contentSha256);
  assert.equal(serializeManifest(first),serializeManifest(buildRepairManifest(data)));
  verifyManifest(first,first.contentSha256);
  assert.throws(() => verifyManifest({...first,version:1},first.contentSha256));
  const before = first.repairEntries.find((e) => e.productId === 4848).beforeFingerprint;
  for (const change of [
    (d)=>{d.products[1].weight='1259.000';}, (d)=>{d.products[1].magento_name_subject_en='Changed';},
    (d)=>{d.products[1].exclude_from_export=0;}, (d)=>{d.lifecycle[1].delivery_version='2';},
    (d)=>{d.products[1].corrected_from_product_id=null;}, (d)=>{d.snapshots.push(snapshot('new',[d.products[0]]));},
  ]) {const copy=structuredClone(data);change(copy);assert.notEqual(buildRepairManifest(copy).repairEntries.find((e)=>e.productId===4848).beforeFingerprint,before);}
});
test('phase3 ordinary active historical inventory is exhaustive and never acknowledges current payload', () => {
  const ps=[1,2,3,4].map((id)=>product(id));
  const data=input(emptyEvidence({products:ps,snapshots:[snapshot('confirmed',[ps[0]],'confirmed'),snapshot('generated',[ps[1]])],
    revisions:[{product_id:3,has_product_snapshot:true,revision:'1',confirmed_revision:'0'}]}));
  const m=buildRepairManifest(data);
  assert.equal(m.repairSummary.ordinaryActive.total,4);
  assert.deepEqual(m.repairSummary.ordinaryActive.classes.map((c)=>c.count),[1,1,1,1]);
  assert.equal(m.repairSummary.architectureDecisions.length,4);
  assert.ok(m.repairEntries.every((e)=>e.expectedAfter.confirmed_revision==='0' && e.expectedAfter.route==='hold' && !e.wouldMutate));
});
test('phase3 4502 to 4848 exact names are conditional and unknown exclusion stays held', () => {
  const data=input(); data.products[0].magento_name_subject_ua=' [UX-5 аудит] Джерело ';
  data.products[0].magento_name_subject_en=' [UX-5 audit] Source ';
  const m=buildRepairManifest(data); const e=m.repairEntries.find((r)=>r.productId===4848);
  assert.equal(e.exposure.classification,'reliably_unexposed');assert.equal(e.action,'hold');
  assert.equal(e.expectedAfter.exclude_from_export,1);assert.equal(e.conditionalFirstDelivery.exclude_from_export,0);
  assert.equal(e.conditionalFirstDelivery.names.ua,data.products[0].magento_name_subject_ua);
  assert.equal(e.conditionalFirstDelivery.names.reviewRequired,true);assert.equal(e.sourceNames.productId,4502);
  assert.equal(e.before.products.find((p)=>p.id===4848).total_price_uah,'21700.00');
});
test('phase3 verified recount-only exclusion releases behind cursor without rewinding it', () => {
  const data=input(); data.state[0].exported_to_product_id=9000;
  data.lifecycle[0].evidence={origin:'ordinary_save'};
  data.lifecycle[1].source_correction_id=1436;data.lifecycle[1].evidence={origin:'recount',independentExclusion:false};
  const m=buildRepairManifest(data); const e=m.repairEntries.find((r)=>r.productId===4848);
  assert.equal(e.phase0Exposure.classification,'historical_ambiguous');assert.equal(e.action,'first_delivery_pending');
  assert.equal(e.expectedAfter.revision,'1');assert.equal(e.expectedAfter.confirmed_revision,'0');assert.equal(m.cursor,9000);
  data.lifecycle[0].hold_reason='intentional_exclusion';
  assert.equal(buildRepairManifest(data).repairEntries.find((r)=>r.productId===4848).action,'hold');
});
test('phase3 confirmed and generated ancestor lineages require reconciliation', () => {
  for (const status of ['confirmed','generated']) {
    const data=input();data.snapshots.push(snapshot(status,[data.products[0]],status));
    const e=buildRepairManifest(data).repairEntries.find((r)=>r.productId===4848);
    assert.equal(e.action,'hold');assert.equal(e.expectedAfter.hold_reason,'prior_exposure');assert.equal(e.operatorReconciliationRequired,true);
  }
});
test('phase3 schema projection cannot be applied and multi-entry atomicity fails closed', async () => {
  const m=buildRepairManifest(input(undefined,false));
  await assert.rejects(applyRepair({manifest:m,manifestHash:m.contentSha256,productIds:[4848]},{}),{code:'REPAIR_MANIFEST_STALE'});
  const actual=buildRepairManifest(input());
  await assert.rejects(applyRepair({manifest:actual,manifestHash:actual.contentSha256,productIds:[4502,4848]},{}),{code:'CUTOVER_BATCH_COMMAND_REQUIRED'});
  const tampered=structuredClone(actual);tampered.repairEntries[1].action='first_delivery_pending';
  await assert.rejects(applyRepair({manifest:tampered,manifestHash:actual.contentSha256,productIds:[4848]},{}),{code:'REPAIR_MANIFEST_INVALID'});
  assert.notEqual(digest(tampered),actual.contentSha256);
});
