const test = require('node:test');
const assert = require('node:assert/strict');
const baseline = require('../src/services/magento/historical-cutover-baseline');
const { digest } = require('../src/services/export-exposure/repair-manifest');

function fixture() {
  const before = { revision: '1', confirmed_revision: '0', source_correction_id: null,
    business_exclusion_state: 'unknown', recount_compatibility_excluded: false,
    evidence: { origin: 'migration_039', coverage: 'unresolved_historical' } };
  const after = { ...before, route: 'hold', evidence: { origin: 'cutover', decision: 'hold', classification: 'historical_ambiguous' } };
  const entry = { productId: 3, sku: 'OLD-3', action: 'hold', before, after };
  const body = { format: 'amber-full-product-cutover-v1', kind: 'cutover', database: 'amber_test', policy: { batchSize: 100 },
    entries: [{ productId: 1, action: 'preserve' }, entry] };
  const hash = digest(body), manifest = { ...body, contentSha256: hash };
  const member = { product: { id: 3, full_sku: 'OLD-3', status: 'corrected' }, lifecycle: { ...after, route: 'retired', repair_manifest_hash: hash } };
  const approval = { id: '10', subject_id: hash, details: { manifest } };
  const receipt = { id: '11', subject_id: `${hash}:0`, details: { result: { manifestHash: hash, batchNumber: 0, productIds: [3] }, beforeAfterHash: digest([entry]) } };
  const state = { database: 'amber_test', phase: 'active', approvals: [approval], receipts: [receipt] };
  const queries = [];
  const client = { query: async (sql, params) => {
    queries.push({ sql, params }); assert.match(sql, /^SELECT /);
    if (sql.includes('current_database()')) return { rows: [{ database: state.database, phase: state.phase }] };
    assert.deepEqual(params, [sql.includes("event_key='full_product_cutover.approved'") ? [hash] : [`${hash}:0`]]);
    return { rows: sql.includes("event_key='full_product_cutover.approved'") ? state.approvals : state.receipts };
  } };
  return { member, state, client, queries };
}

test('retired cutover baseline requires the exact immutable approval and applied batch receipt, without writes', async () => {
  const f = fixture(), before = structuredClone(f.member);
  const proofs = await baseline.read(f.client, [f.member]);
  assert.deepEqual(f.member, before);
  assert.equal(proofs.size, 1);
  const proof = proofs.get(3);
  assert.equal(proof.approvalEventId, '10'); assert.equal(proof.batchEventId, '11');
  assert.equal(baseline.verified({ ...f.member, cutoverBaseline: proof }), true);
  assert.equal(baseline.verified({ ...f.member, product: { ...f.member.product, id: 4 }, cutoverBaseline: proof }), false);
  assert.equal(f.queries.length, 3);
});

test('unverified, unrelated, unapplied or changed cutover evidence never grants historical baseline status', async () => {
  const changes = [
    f => { f.state.approvals = []; }, f => { f.state.receipts = []; },
    f => { f.state.approvals.push(f.state.approvals[0]); }, f => { f.state.receipts.push(f.state.receipts[0]); },
    f => { f.state.phase = 'preparing'; }, f => { f.state.database = 'other_test'; },
    f => { f.state.approvals[0].details.manifest.entries[1].sku = 'OTHER'; },
    f => { f.state.receipts[0].details.beforeAfterHash = 'invalid'; },
    f => { f.state.receipts[0].details.result.productIds = [4]; },
    f => { f.state.receipts[0].details.result.batchNumber = 1; },
    f => { f.state.receipts[0].id = '9'; }, f => { f.state.receipts[0].details = {}; },
    f => { f.member.lifecycle.evidence.independentExclusion = true; },
    f => { f.member.lifecycle.source_correction_id = 9; },
    f => { f.member.lifecycle.business_exclusion_state = 'excluded'; },
    f => { f.member.lifecycle.recount_compatibility_excluded = true; },
    f => { f.member.product.full_sku = 'OTHER'; }, f => { f.member.product.status = 'active'; },
    f => { f.member.lifecycle.repair_manifest_hash = null; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    assert.equal((await baseline.read(f.client, [f.member])).size, 0, change.toString());
  }
});

test('a validly sealed modern origin or non-baseline policy is not treated as migration history', async () => {
  for (const patch of [{ evidence: { origin: 'recount' } }, { source_correction_id: 5 }, { business_exclusion_state: 'none' }]) {
    const f = fixture(), manifest = f.state.approvals[0].details.manifest;
    Object.assign(manifest.entries[1].before, patch);
    const { contentSha256: ignored, ...body } = manifest;
    const hash = digest(body); manifest.contentSha256 = hash; f.member.lifecycle.repair_manifest_hash = hash;
    f.state.approvals[0].subject_id = hash;
    const client = { query: async sql => ({ rows: sql.includes('current_database()') ? [{ database: 'amber_test', phase: 'active' }] : f.state.approvals }) };
    assert.equal((await baseline.read(client, [f.member])).size, 0);
  }
});
