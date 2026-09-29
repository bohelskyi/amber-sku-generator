const test = require('node:test');
const assert = require('node:assert/strict');
const { readStoredCsv } = require('../src/services/export-exposure/csv-reader');
const { buildExposureIndex, classifyExposure } = require('../src/services/export-exposure/evidence');
const { product, snapshot, emptyEvidence } = require('./fixtures/export-exposure');

const exposure = (data, id) => classifyExposure(buildExposureIndex(data).productEvidence.get(id));

test('exposure CSV reader handles BOM, CRLF, quotes, multiline cells and trailing records', () => {
  assert.deepEqual(readStoredCsv('\uFEFFsku,name\r\nP1,"a, ""b""\r\nc"\r\n'), [['sku', 'name'], ['P1', 'a, "b"\r\nc']]);
  assert.deepEqual(readStoredCsv('a,b\n,\n'), [['a', 'b'], ['', '']]);
  assert.deepEqual(readStoredCsv('a,b\nx,'), [['a', 'b'], ['x', '']]);
  assert.deepEqual(readStoredCsv(''), []);
});
for (const csv of ['a\n"unterminated', 'a\nx"y', 'a\n"x"garbage']) {
  test(`exposure CSV reader fails closed for ${JSON.stringify(csv)}`, () => assert.throws(() => readStoredCsv(csv), /CSV_/));
}

for (const status of ['generated', 'confirmed']) {
  test(`exposure exact ${status} membership survives empty reexport_revisions`, () => {
    const p = product(10); const data = emptyEvidence({ products: [p], snapshots: [snapshot('s', [p], status)] });
    const result = exposure(data, p.id);
    assert.equal(result.classification, `${status}_exact`);
    assert.equal(result.exact[0].csvRecord, 2);
    assert.equal(result.exact[0].snapshotId, 's');
  });
}

test('exposure cursor, flag and snapshot range do not establish exact membership', () => {
  const a = product(1); const omitted = product(2); const z = product(3);
  const data = emptyEvidence({ products: [a, omitted, z], snapshots: [snapshot('s', [a, z], 'confirmed')],
    state: [{ exported_to_product_id: 3 }], revisions: [{ product_id: 2, has_product_snapshot: true, revision: '0', confirmed_revision: '0' }] });
  const result = exposure(data, 2);
  assert.equal(result.classification, 'historical_ambiguous');
  assert.equal(result.exact.length, 0);
  assert.deepEqual(new Set(result.indicators.map((i) => i.code)), new Set([
    'AT_OR_BELOW_CURSOR', 'HAS_PRODUCT_SNAPSHOT_FLAG', 'SNAPSHOT_RANGE_INFERENCE',
  ]));
});

test('historical internal-SKU snapshot range anchors still resolve exactly', () => {
  const p = product(12, 'SV-INTERNAL-12');
  const data = emptyEvidence({ products: [p], snapshots: [snapshot('internal-range', [p], 'generated')] });
  const range = buildExposureIndex(data).productEvidence.get(p.id).indicators
    .find((indicator) => indicator.code === 'SNAPSHOT_RANGE_INFERENCE');
  assert.equal(range.rangeResolved, true);
  assert.equal(range.startId, 12);
  assert.equal(range.endId, 12);
});

test('future public-SKU snapshot range anchors resolve to their product', () => {
  const p = product(13, 'SV-INTERNAL-13', { public_sku: 'AG-000001' });
  const data = emptyEvidence({ products: [p], snapshots: [snapshot('public-range', [p], 'generated', {
    from_sku: 'AG-000001', to_sku: 'AG-000001',
  })] });
  const range = buildExposureIndex(data).productEvidence.get(p.id).indicators
    .find((indicator) => indicator.code === 'SNAPSHOT_RANGE_INFERENCE');
  assert.equal(range.rangeResolved, true);
  assert.equal(range.startId, 13);
  assert.equal(range.endId, 13);
});

test('conflicting internal and public range-anchor identities remain unresolved', () => {
  const internal = product(14, 'AG-000001', { public_sku: 'LEGACY-14' });
  const publicProduct = product(15, 'SV-INTERNAL-15', { public_sku: 'AG-000001' });
  const data = emptyEvidence({ products: [internal, publicProduct], snapshots: [snapshot('conflict', [internal], 'generated', {
    from_sku: 'AG-000001', to_sku: 'AG-000001', exported_to_product_id: 15,
  })] });
  const range = buildExposureIndex(data).productEvidence.get(internal.id).indicators
    .find((indicator) => indicator.code === 'SNAPSHOT_RANGE_INFERENCE');
  assert.equal(range.rangeResolved, false);
  assert.equal(range.startId, null);
});

test('conflicting explicit snapshot upper anchor does not fall back to exported product ID', () => {
  const from = product(16, 'SV-FROM-16', { public_sku: 'AG-000016' });
  const internal = product(17, 'AG-000099', { public_sku: 'LEGACY-17' });
  const publicProduct = product(18, 'SV-INTERNAL-18', { public_sku: 'AG-000099' });
  const data = emptyEvidence({ products: [from, internal, publicProduct],
    snapshots: [snapshot('upper-conflict', [from], 'generated', {
      from_sku: 'SV-FROM-16', to_sku: 'AG-000099', exported_to_product_id: 18,
    })] });
  const range = buildExposureIndex(data).productEvidence.get(from.id).indicators
    .find((indicator) => indicator.code === 'SNAPSHOT_RANGE_INFERENCE');
  assert.equal(range.rangeResolved, false);
  assert.equal(range.startId, 16);
  assert.equal(range.endId, null);
});

test('exposure has_product_snapshot alone is not confirmed exposure', () => {
  const data = emptyEvidence({ products: [product(5)], revisions: [{ product_id: 5, has_product_snapshot: true, revision: '2', confirmed_revision: '2' }] });
  assert.equal(exposure(data, 5).classification, 'historical_ambiguous');
});

test('exposure exact artifact rows deduplicate Main/EN and corroborate parent CSV', () => {
  const p = product(7);
  const data = emptyEvidence({ products: [p], snapshots: [snapshot('s', [p], 'confirmed')], artifacts: [{
    snapshot_id: 's', group_code: 'SV', profile_version: 'magento-products-v1', product_count: 1, row_count: 2,
    csv_content: 'sku,store_view_code,name\nP7,,"a, b"\nP7,en,English',
  }] });
  const result = exposure(data, 7);
  assert.equal(result.classification, 'confirmed_exact');
  assert.equal(result.exact.length, 3);
  assert.equal(buildExposureIndex(data).snapshotEvidence[0].files[1].members.length, 2);
});

test('exposure serializer-neutralized SKU is matched exactly without lossy apostrophe stripping', () => {
  const p = product(8, '=SKU');
  const data = emptyEvidence({ products: [p], snapshots: [snapshot('s', [p], 'confirmed', { csv_content: "sku,price_uah\n'=SKU,10" })] });
  assert.equal(exposure(data, 8).classification, 'confirmed_exact');
});

test('exposure inconsistent artifacts retain positive evidence but fail closed', () => {
  const a = product(1); const b = product(2);
  const data = emptyEvidence({ products: [a, b], snapshots: [snapshot('s', [a], 'confirmed')], artifacts: [{
    snapshot_id: 's', group_code: 'SV', profile_version: 'magento-products-v1', product_count: 1, row_count: 2,
    csv_content: 'sku,store_view_code\nP2,\nP2,en',
  }] });
  assert.equal(exposure(data, 1).classification, 'historical_ambiguous');
  assert.equal(exposure(data, 2).classification, 'historical_ambiguous');
  assert.ok(exposure(data, 2).exact.length);
});

test('exposure malformed/count-mismatched/unknown-SKU snapshots never prove absence', () => {
  for (const overrides of [{ csv_content: 'sku\n"bad' }, { row_count: 3 }, { csv_content: 'sku,price_uah\nMISSING,10' }]) {
    const p = product(10); const data = emptyEvidence({ products: [p], snapshots: [snapshot('s', [p], 'generated', overrides)] });
    assert.equal(exposure(data, 10).classification, 'historical_ambiguous');
  }
});

test('exposure positive revision reference corroborates membership but does not replace missing CSV', () => {
  const p = product(5); const data = emptyEvidence({ products: [p], snapshots: [snapshot('s', [p], 'confirmed', {
    reexport_revisions: [{ productId: 5, revision: 2 }],
  })] });
  assert.equal(exposure(data, 5).classification, 'confirmed_exact');
  data.snapshots[0].csv_content = 'sku,price_uah'; data.snapshots[0].row_count = 0;
  assert.equal(exposure(data, 5).classification, 'historical_ambiguous');
  assert.ok(exposure(data, 5).issues.some((i) => i.code === 'REVISION_MEMBERSHIP_CONFLICT'));
});

test('exposure missing state fails closed instead of inventing a zero cursor', () => {
  assert.equal(exposure(emptyEvidence({ products: [product(9)], state: [] }), 9).classification, 'historical_ambiguous');
});

test('exposure a contradicted upper bound cannot hide other potential members above it', () => {
  const p = product(5); const later = product(7);
  const data = emptyEvidence({ products: [p, later], snapshots: [snapshot('s', [p], 'generated', { exported_to_product_id: 1 })] });
  assert.equal(exposure(data, 7).classification, 'historical_ambiguous');
  assert.ok(exposure(data, 7).issues.some((issue) => issue.code === 'SNAPSHOT_UPPER_BOUND_INVALID'));
});
