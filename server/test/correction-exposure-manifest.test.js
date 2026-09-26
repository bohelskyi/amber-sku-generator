const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCorrectionExposureManifest, serializeManifest, storedDiff } = require('../src/services/export-exposure/manifest');
const { loadCorrectionExposureManifest } = require('../src/services/export-exposure.service');
const { product, correction, snapshot, emptyEvidence, reproducedCase } = require('./fixtures/export-exposure');

test('manifest real 4502 / SV23150003 -> 4848 / SV23150004 is unexposed under retained evidence', () => {
  const manifest = buildCorrectionExposureManifest(reproducedCase());
  const pair = manifest.correctionPairs[0];
  assert.equal(pair.correctionId, 1436);
  assert.equal(pair.lineageExposure.classification, 'reliably_unexposed');
  assert.equal(pair.lineageExposure.evidenceScope, 'retained_database_evidence');
  assert.equal(pair.successor.exclude_from_export, 1, 'diagnostic must not repair exclusion');
  assert.equal(pair.terminalDescendant.id, 4848);
  assert.deepEqual(pair.storedPayloadDiff, [{ path: '/answers/weight', beforePresent: true, afterPresent: true, before: '1260,0', after: 1260 }]);
});

test('manifest complete ancestor chain finds confirmed 3883 -> 4570 -> 4780', () => {
  const a = product(3883, 'KL2/11141350005'); const b = product(4570, 'KL2/11141251005'); const c = product(4780, 'KL3/11141351005');
  const data = emptyEvidence({ products: [a, b, c], corrections: [correction(1207, a, b), correction(1408, b, c)],
    snapshots: [snapshot('confirmed-ancestor', [a], 'confirmed')] });
  const manifest = buildCorrectionExposureManifest(data); const pair = manifest.correctionPairs[1];
  assert.equal(pair.source.exposure.classification, 'reliably_unexposed');
  assert.equal(pair.successor.exposure.classification, 'reliably_unexposed');
  assert.equal(pair.lineageExposure.classification, 'confirmed_exact');
  assert.deepEqual(pair.ancestorChain.map((p) => p.productId), [3883, 4570]);
  assert.equal(manifest.terminalActiveSuccessors.length, 1);
  assert.deepEqual(manifest.terminalActiveSuccessors[0].correctionIds, [1207, 1408]);
});

test('manifest generated-only ancestor remains potential exposure without confirmation', () => {
  const data = reproducedCase(); data.snapshots.push(snapshot('unconfirmed', [data.products[0]]));
  const pair = buildCorrectionExposureManifest(data).correctionPairs[0];
  assert.equal(pair.lineageExposure.classification, 'generated_exact');
  assert.equal(pair.ancestorExposure.exact[0].status, 'generated');
});

test('manifest behind-cursor successor and inferred source are ambiguous without exact rows', () => {
  const a = product(1208, 'BR11384452017'); const b = product(2847, 'BR11184452017');
  const manifest = buildCorrectionExposureManifest(emptyEvidence({ products: [a, b], corrections: [correction(1, a, b)],
    state: [{ exported_to_product_id: 4063 }] }));
  assert.equal(manifest.correctionPairs[0].lineageExposure.classification, 'historical_ambiguous');
  assert.equal(manifest.summary.activeExcludedSuccessors.successorAtOrBelowCursor, 1);
  assert.equal(manifest.summary.allPairs.neitherImmediateRowConfirmed, 1);
});

test('manifest byte/hash determinism is independent of input row and object key order', () => {
  const data = reproducedCase(); const first = serializeManifest(buildCorrectionExposureManifest(data));
  const reverse = (value) => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value;
  const shuffled = reverse(data); for (const value of Object.values(shuffled)) if (Array.isArray(value)) value.reverse();
  assert.equal(serializeManifest(buildCorrectionExposureManifest(shuffled)), first);
  assert.match(JSON.parse(first).contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.includes('generatedAt": "20'), false);
});

test('manifest does not mutate input and preserves missing/null/zero/raw array differences', () => {
  const data = reproducedCase(); const before = structuredClone(data);
  buildCorrectionExposureManifest(data); assert.deepEqual(data, before);
  assert.deepEqual(storedDiff({ a: null, b: 0, 'a/b': [1, 2] }, { b: '0', 'a/b': [2, 1] }).map((x) => x.path), ['/a', '/a~1b', '/b']);
});

for (const defect of ['missing', 'branch', 'cycle', 'pointer', 'sku', 'duplicate']) {
  test(`manifest ${defect} lineage fails closed and retains confirmed evidence`, () => {
    const data = reproducedCase(); const [a, b] = data.products;
    data.snapshots.push(snapshot('s', [a], 'confirmed'));
    if (defect === 'missing') data.products.pop();
    if (defect === 'branch') { const c = product(4900); data.products.push(c); data.corrections.push(correction(1500, a, c)); }
    if (defect === 'cycle') data.corrections.push(correction(1500, b, a));
    if (defect === 'pointer') a.corrected_to_product_id = null;
    if (defect === 'sku') data.corrections[0].source_sku = 'WRONG';
    if (defect === 'duplicate') data.corrections.push({ ...data.corrections[0], id: 1500 });
    const pair = buildCorrectionExposureManifest(data).correctionPairs[0];
    assert.equal(pair.lineageExposure.classification, 'historical_ambiguous');
    assert.ok(pair.lineageExposure.issues.length);
    assert.ok(pair.lineageExposure.exact.some((item) => item.status === 'confirmed'));
  });
}

test('manifest loader rejects the wrong database, rolls back and releases its connection', async () => {
  const commands = [];
  const client = { query: async (sql) => { commands.push(sql); return { rows: [{ name: 'unexpected' }] }; },
    release: () => commands.push('RELEASE') };
  await assert.rejects(loadCorrectionExposureManifest({ connect: async () => client }, { expectedDatabase: 'amber' }), /does not match/);
  assert.equal(commands[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(commands.slice(-2), ['ROLLBACK', 'RELEASE']);
});

test('manifest inventories terminal successors even when correction rows are missing or branching', () => {
  const data = reproducedCase(); data.corrections = [];
  let manifest = buildCorrectionExposureManifest(data);
  assert.equal(manifest.correctionPairs.length, 0);
  assert.equal(manifest.terminalActiveSuccessors[0].product.id, 4848);
  assert.equal(manifest.terminalActiveSuccessors[0].lineageExposure.classification, 'historical_ambiguous');
  const branched = reproducedCase(); const other = product(4900); branched.products.push(other);
  branched.corrections.push(correction(1500, branched.products[0], other));
  manifest = buildCorrectionExposureManifest(branched);
  assert.deepEqual(manifest.terminalActiveSuccessors.map((p) => p.product.id), [4848, 4900]);
  assert.ok(manifest.terminalActiveSuccessors.every((p) => p.lineageExposure.classification === 'historical_ambiguous'));
  branched.products.reverse(); branched.corrections.reverse();
  assert.equal(serializeManifest(buildCorrectionExposureManifest(branched)), serializeManifest(manifest));
});

test('manifest pointer-only cycles without correction rows remain visible and fail closed', () => {
  const data = reproducedCase(); const [a, b] = data.products; data.corrections = [];
  a.corrected_from_product_id = b.id; b.corrected_to_product_id = a.id;
  const manifest = buildCorrectionExposureManifest(data);
  assert.equal(manifest.correctionPairs.length, 0);
  assert.equal(manifest.terminalActiveSuccessors.length, 0);
  assert.ok(manifest.lineageDiagnostics.some((issue) => issue.code === 'LINEAGE_CYCLE'));
  assert.ok(manifest.products.every((p) => p.exposure.classification === 'historical_ambiguous'));
});

test('manifest null historical source stays unknown and cannot hide an active terminal successor', () => {
  const data = reproducedCase(); data.products.shift();
  data.products[0].corrected_from_product_id = null;
  data.corrections[0].source_product_id = null;
  const manifest = buildCorrectionExposureManifest(data);
  assert.equal(manifest.correctionPairs[0].source.id, null);
  assert.equal(manifest.correctionPairs[0].lineageExposure.classification, 'historical_ambiguous');
  assert.equal(manifest.terminalActiveSuccessors.length, 1);
  assert.equal(manifest.terminalActiveSuccessors[0].lineageExposure.classification, 'historical_ambiguous');
});
