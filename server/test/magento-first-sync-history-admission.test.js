const { test } = require('node:test');
const assert = require('node:assert/strict');
const helper = require('../src/services/magento/first-sync-history-admission');
const histories = require('../src/services/magento/recovery-history');
const repair = require('../src/services/export-exposure/repair-loader');
const c = require('../src/services/magento/binding-contract');

function fixture() {
  const config = { baseUrl: 'https://shop.example.test' }, originHash = c.originHash(config.baseUrl);
  const identity = { productId: 7, publicIdentityId: '17', sku: 'AG-000017', originHash,
    installationKey: 'installation-a', bindingRevisionId: '11111111-1111-4111-8111-111111111111', remoteId: 77 };
  const observation = { amber: { product: { id: 7, public_product_identity_id: '17', public_sku: identity.sku, details: { answers: {} } },
    revision: { id: identity.bindingRevisionId, originHash, installationKey: identity.installationKey } }, raw: { id: 77, sku: identity.sku, name: 'Magento name' } };
  const history = { productId: 7, complete: true, hasRecount: true, identityChanged: true, stableRecount: false,
    historicalRecount: true, historicalRecountBlockers: [], issues: [{ code: 'SOURCE_CORRECTION_NOT_RECORDED', productId: 6 }],
    products: [
      { productId: 7, article: identity.sku, internalSku: 'CHNEW', status: 'active', nextProductId: null, previousProductId: 6,
        route: 'hold', holdReason: 'historical_ambiguity', lifecycleOrigin: 'recount', businessExclusion: 'none' },
      { productId: 6, article: 'AG-000016', internalSku: 'CHOLD', status: 'corrected', nextProductId: 7, previousProductId: null,
        route: 'retired', holdReason: null, lifecycleOrigin: 'migration_039', businessExclusion: 'unknown' },
    ], corrections: [{ correctionId: 9, sourceProductId: 6, successorProductId: 7 }] };
  const retained = { products: [{ id: 6, full_sku: 'CHOLD', public_sku: 'AG-000016', category: 'CH' },
    { id: 7, full_sku: 'CHNEW', public_sku: identity.sku, category: 'CH' }], snapshots: [], artifacts: [], members: [],
  registry: [{ full_sku: 'CHOLD', first_product_id: 6 }, { full_sku: 'CHNEW', first_product_id: 7 }],
  revisions: [], events: [], state: [{ exported_to_product_id: 7 }] };
  return { config, identity, observation, history, retained, rows: [] };
}
function receipt(f, envelope, { stable = false } = {}) {
  const planHash = 'b'.repeat(64), handoffId = '22222222-2222-4222-8222-222222222222';
  const source = stable ? 'stable_recount_exposure' : 'historical_recount_exposure';
  const action = stable ? 'magento_stable_recount_prior_exposure' : 'magento_historical_recount_prior_exposure';
  const result = { productId: 7, publicIdentityId: '17', sku: f.identity.sku, planHash, handoffId,
    route: 'hold', holdReason: 'prior_exposure', deliveryVersion: '2' };
  f.rows = [{ receipt: { id: '91', actor_user_id: 3, event_key: 'product.magento_' + source + '_reconciled',
    subject_type: 'magento_exposure_resolution', subject_id: planHash, details: { beforeFingerprint: 'c'.repeat(64),
      originHash: f.identity.originHash, bindingRevisionId: f.identity.bindingRevisionId, remote: { id: 77, sku: f.identity.sku },
      result, lineageProductIds: [6, 7], doesNotAcknowledgeExport: true, firstSyncAdmission: structuredClone(envelope) } },
  handoff: { id: handoffId, actor_user_id: 3, kind: 'broader_resync', preview_hash: planHash,
    binding_revision_id: f.identity.bindingRevisionId, evidence: { source, planHash, doesNotAcknowledgeExport: true, firstSyncAdmission: structuredClone(envelope) } },
  item: { handoff_id: handoffId, product_id: 7, public_product_identity_id: '17', reason: 'reviewed_resync', state: 'enrolled', generation: '4' },
  binding: { id: f.identity.bindingRevisionId, origin_hash: f.identity.originHash, installation_key: f.identity.installationKey, state: 'published' },
  lifecycle: { product_id: 7, route: 'hold', hold_reason: 'prior_exposure', evidence: { origin: 'reconciliation', action,
    magentoPriorExposure: { originHash: f.identity.originHash, productId: 77, sku: f.identity.sku, planHash, doesNotAcknowledgeExport: true } } },
  request: { product_id: 7, public_product_identity_id: '17', desired_generation: '5', state: 'pending' } }];
  f.history.products[0].holdReason = 'prior_exposure'; f.history.products[0].lifecycleOrigin = 'reconciliation';
}
async function withEvidence(f, operation) {
  const calls = { queries: [], history: 0, retained: 0 };
  const client = { async query(sql, params) {
    assert.match(sql, /^(SELECT |LOCK TABLE )/); calls.queries.push({ sql, params });
    if (f.lockError && /NOWAIT/.test(sql)) throw Object.assign(new Error('lock held'), { code: '55P03' });
    if (/FOR (UPDATE|SHARE) NOWAIT/.test(sql)) {
      if (sql.includes('FROM products ')) return { rows: params[0].map(id => ({ id })) };
      if (sql.includes('FROM product_full_export_state ')) return { rows: params[0].map(product_id => ({ product_id })) };
      if (sql.includes('FROM public_product_identities ')) return { rows: params[0].map((sku, index) => ({ id: index + 1 })) };
      return { rows: [] };
    }
    if (sql.startsWith('LOCK TABLE ')) return { rows: [] };
    return { rows: f.rows };
  } };
  const patches = [
    [histories, 'read', async (db, id) => { assert.equal(db, client); assert.equal(id, 7); calls.history++; return f.history; }],
    [repair, 'readRepairInput', async db => { assert.equal(db, client); calls.retained++; return f.retained; }],
    [globalThis, 'fetch', async () => assert.fail('Admission has no HTTP authority')],
  ];
  const restore = patches.map(([object, key, value]) => { const original = object[key]; object[key] = value; return () => { object[key] = original; }; });
  try { await operation(client, calls); } finally { restore.reverse().forEach(fn => fn()); }
}

test('audited mixed-history release admits only first-sync review and preserves the original observation object', async () => {
  const f = fixture();
  await withEvidence(f, async (client, calls) => {
    const original = f.observation.amber.product, frozen = JSON.stringify(f);
    const envelope = await helper.captureOnClient(client, f.identity);
    assert.equal(envelope.scope, 'first_sync_review_only'); assert.equal(envelope.doesNotAcknowledgeExport, true);
    assert.equal(JSON.stringify(f), frozen, 'capture never rewrites the pre-release history');
    receipt(f, envelope);
    const before = JSON.stringify(f), result = await helper.readOnClient(client, f.config, f.observation, { history: f.history });
    assert.ok(result.admission); assert.equal(result.reason, null); assert.match(result.evidenceHash, /^[a-f0-9]{64}$/);
    assert.equal(helper.allows(f.observation, result.admission), true);
    assert.equal(helper.allows(f.observation, {}), false);
    assert.equal(helper.allows({ ...f.observation, amber: { ...f.observation.amber, product: { ...original } } }, result.admission), false);
    assert.equal(f.observation.amber.product, original); assert.equal(JSON.stringify(f), before);
    assert.equal(calls.queries.length, 1); assert.equal(calls.history, 1);
    assert.deepEqual(Object.keys(result.admission), []);
  });
});

test('the same audited admission envelope works for the reviewed stable recipe', async () => {
  const f = fixture(); f.history.identityChanged = false; f.history.issues = []; f.history.stableRecount = true;
  f.history.products[1].article = f.identity.sku;
  await withEvidence(f, async client => {
    receipt(f, await helper.captureOnClient(client, f.identity), { stable: true });
    assert.ok((await helper.readOnClient(client, f.config, f.observation)).admission);
  });
});

test('first-sync field adoption and later delivery generations do not rewrite or invalidate reviewed structural history', async () => {
  const f = fixture();
  await withEvidence(f, async client => {
    receipt(f, await helper.captureOnClient(client, f.identity));
    f.observation.amber.product.details.answers = { bead_length: '20' };
    f.observation.amber.product.total_price_uah = '300';
    f.observation.amber.product.magento_name_override = { generated: { all: 'UA', en: 'EN' }, values: { all: 'Magento UA', en: 'Magento EN' } };
    f.retained.products[1].total_price_uah = '300'; f.retained.products[1].product_state_hash = 'd'.repeat(64);
    f.retained.revisions.push({ product_id: 7, revision: '9', confirmed_revision: '0', changed_at: 'new price import', has_product_snapshot: false });
    f.rows[0].request.desired_generation = '8';
    assert.ok((await helper.readOnClient(client, f.config, f.observation)).admission);
  });
});

for (const [label, change] of [
  ['old receipt without envelope', f => { delete f.rows[0].receipt.details.firstSyncAdmission; delete f.rows[0].handoff.evidence.firstSyncAdmission; }],
  ['audit/handoff envelope mismatch', f => { f.rows[0].handoff.evidence.firstSyncAdmission.historyHash = 'd'.repeat(64); }],
  ['wrong handoff', f => { f.rows[0].handoff.id = 'other'; }],
  ['wrong historical recipe', f => { f.rows[0].handoff.evidence.source = 'unreviewed'; }],
  ['wrong audit subject', f => { f.rows[0].receipt.subject_type = 'product'; }],
  ['wrong actor pairing', f => { f.rows[0].handoff.actor_user_id = 4; }],
  ['wrong product', f => { f.rows[0].item.product_id = 8; }],
  ['wrong public identity', f => { f.rows[0].item.public_product_identity_id = '18'; }],
  ['wrong origin', f => { f.rows[0].binding.origin_hash = 'e'.repeat(64); }],
  ['wrong installation', f => { f.rows[0].binding.installation_key = 'installation-b'; }],
  ['wrong binding', f => { f.rows[0].handoff.binding_revision_id = 'other'; }],
  ['wrong remote ID', f => { f.rows[0].receipt.details.remote.id = 78; }],
  ['wrong remote SKU', f => { f.rows[0].receipt.details.remote.sku = 'AG-000018'; }],
  ['pending enrollment', f => { f.rows[0].item.state = 'pending'; f.rows[0].item.generation = null; }],
  ['protected enrollment', f => { f.rows[0].item.state = 'protected'; }],
  ['retired enrollment', f => { f.rows[0].item.state = 'retired'; }],
  ['request predates enrollment', f => { f.rows[0].request.desired_generation = '3'; }],
  ['request belongs to another product', f => { f.rows[0].request.product_id = 8; }],
  ['current lifecycle disposition changed', f => { f.rows[0].lifecycle.hold_reason = 'intentional_exclusion'; }],
  ['current lifecycle receipt pointer changed', f => { f.rows[0].lifecycle.evidence.magentoPriorExposure.planHash = 'e'.repeat(64); }],
  ['false delivery acknowledgement', f => { f.rows[0].receipt.details.doesNotAcknowledgeExport = false; }],
  ['broadened authority scope', f => { f.rows[0].receipt.details.firstSyncAdmission.scope = 'ordinary'; }],
  ['changed reviewed lineage membership', f => { f.rows[0].receipt.details.lineageProductIds = [5, 7]; }],
  ['duplicate audit evidence', f => { f.rows.push(structuredClone(f.rows[0])); }],
]) test('history admission refuses ' + label, async () => {
  const f = fixture();
  await withEvidence(f, async client => {
    receipt(f, await helper.captureOnClient(client, f.identity)); change(f);
    const result = await helper.readOnClient(client, f.config, f.observation);
    assert.equal(result.admission, null); assert.ok(result.reason); assert.equal(result.evidenceHash, null);
  });
});

for (const [label, change] of [
  ['ancestor policy', f => { f.history.products[1].businessExclusion = 'excluded'; }],
  ['ancestor identity', f => { f.history.products[1].article = 'AG-000019'; }],
  ['correction link', f => { f.history.corrections[0].correctionId = 10; }],
  ['new history issue', f => { f.history.issues.push({ code: 'SOURCE_CORRECTION_MISMATCH' }); }],
  ['retained export event', f => { f.retained.events.push({ id: 1, from_sku: 'CHOLD', exported_to_product_id: 7 }); }],
  ['retained export cursor', f => { f.retained.state[0].exported_to_product_id = 8; }],
  ['legacy revision evidence', f => { f.retained.revisions.push({ product_id: 6, revision: '2', confirmed_revision: '1' }); }],
  ['new retained snapshot', f => { f.retained.snapshots.push({ id: '33333333-3333-4333-8333-333333333333', status: 'generated',
    from_sku: 'CHOLD', resolved_to_sku: 'CHOLD', exported_to_product_id: 6, row_count: 1, file_name: 'old.csv', csv_content: 'sku,price_uah\r\nCHOLD,42\r\n' }); }],
]) test('unchanged reviewed evidence rejects changed ' + label, async () => {
  const f = fixture();
  await withEvidence(f, async client => {
    receipt(f, await helper.captureOnClient(client, f.identity)); change(f);
    const result = await helper.readOnClient(client, f.config, f.observation);
    assert.equal(result.admission, null); assert.equal(result.reason, 'FIRST_SYNC_HISTORY_ADMISSION_CHANGED');
  });
});

test('incomplete history cannot mint admission and a changed live remote identity invalidates its opaque proof', async () => {
  const f = fixture();
  await withEvidence(f, async client => {
    f.history.complete = false;
    await assert.rejects(helper.captureOnClient(client, f.identity), { code: 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_INVALID' });
    f.history.complete = true; receipt(f, await helper.captureOnClient(client, f.identity));
    const { admission } = await helper.readOnClient(client, f.config, f.observation); assert.ok(admission);
    f.observation.raw.id = 78; assert.equal(helper.allows(f.observation, admission), false);
  });
});

test('transaction assertion locks the complete reviewed component and retained phantoms before rereading proof', async () => {
  const f = fixture();
  await withEvidence(f, async (client, calls) => {
    receipt(f, await helper.captureOnClient(client, f.identity));
    const initial = await helper.readOnClient(client, f.config, f.observation); calls.queries = [];
    const fresh = await helper.assertOnClient(client, f.config, f.observation, initial.admission);
    assert.equal(fresh.evidenceHash, initial.evidenceHash); assert.ok(fresh.admission);
    assert.deepEqual(calls.queries[0].params, [[6, 7]]); assert.match(calls.queries[0].sql, /products .*FOR UPDATE NOWAIT/);
    assert.match(calls.queries[1].sql, /product_full_export_state .*FOR UPDATE NOWAIT/);
    assert.match(calls.queries[2].sql, /public_product_identities .*FOR UPDATE NOWAIT/);
    const tableLock = calls.queries.findIndex(call => call.sql.startsWith('LOCK TABLE '));
    assert.ok(tableLock > 2); assert.match(calls.queries[tableLock].sql, /product_corrections,export_snapshots/);
    assert.doesNotMatch(calls.queries[tableLock].sql, /audit_events|product_export_revisions|prices|catalog/);
    assert.match(calls.queries[tableLock + 1].sql, /to_jsonb\(a\) receipt/);
  });
});

test('transaction assertion rejects history drift and lock contention without writes or remote calls', async () => {
  for (const contention of [false, true]) {
    const f = fixture();
    await withEvidence(f, async (client, calls) => {
      receipt(f, await helper.captureOnClient(client, f.identity));
      const initial = await helper.readOnClient(client, f.config, f.observation), before = JSON.stringify(f);
      if (contention) f.lockError = true;
      else f.history.products[1].businessExclusion = 'excluded';
      const changedState = JSON.stringify(f);
      await assert.rejects(helper.assertOnClient(client, f.config, f.observation, initial.admission), { code: 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED' });
      assert.equal(JSON.stringify(f), changedState); assert.notEqual(changedState, before);
      assert.ok(calls.queries.every(call => /^(SELECT |LOCK TABLE )/.test(call.sql)));
    });
  }
});

test('a real current-product delivery confirmation still invalidates admission despite mutable price revisions', async () => {
  const f = fixture();
  await withEvidence(f, async client => {
    receipt(f, await helper.captureOnClient(client, f.identity));
    f.retained.revisions.push({ product_id: 7, revision: '9', confirmed_revision: '9', has_product_snapshot: true });
    assert.equal((await helper.readOnClient(client, f.config, f.observation)).admission, null);
  });
});
