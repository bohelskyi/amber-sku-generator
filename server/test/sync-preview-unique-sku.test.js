const test = require('node:test');
const assert = require('node:assert/strict');
const { uniqueInternalSku } = require('../src/services/magento/sync-preview-db');

const selected = { id: 10, full_sku: 'SV1', status: 'active', corrected_to_product_id: null, public_product_identity_id: '5' };
const copy = (patch = {}) => ({ id: 11, status: 'archived', corrected_to_product_id: null, corrected_from_product_id: null,
  lineage: false, pending_request: false, pending_job: false, ...patch });
const client = (others, owner = 10) => ({ async query(sql, values) {
  if (sql.includes('FROM products p WHERE p.full_sku=$1')) { assert.deepEqual(values, ['SV1', 10, '5']); return { rows: others }; }
  if (sql.includes('FROM sku_registry')) return { rows: owner === null ? [] : [{ first_product_id: owner }] };
  throw new Error('Unexpected SQL ' + sql);
} });

test('a unique internal SKU needs no reservation read', async () => {
  assert.equal(await uniqueInternalSku({ async query(sql) {
    if (sql.includes('FROM sku_registry')) assert.fail('no registry read'); return { rows: [] };
  } }, selected), true);
});
test('retired archived copies of the reserved current product are not a conflict', async () => {
  assert.equal(await uniqueInternalSku(client([copy(), copy({ id: 12 })]), selected), true);
});
test('any other duplicate stays a conflict', async () => {
  for (const other of [copy({ status: 'active' }), copy({ status: 'corrected' }), copy({ status: 'voided' }),
    copy({ corrected_to_product_id: 3 }), copy({ corrected_from_product_id: 3 }), copy({ lineage: true }),
    copy({ pending_request: true }), copy({ pending_job: true })])
    assert.equal(await uniqueInternalSku(client([other]), selected), false, JSON.stringify(other));
  assert.equal(await uniqueInternalSku(client([copy()], 11), selected), false, 'the reservation must belong to the selected product');
  assert.equal(await uniqueInternalSku(client([copy()], null), selected), false);
  assert.equal(await uniqueInternalSku(client([copy()]), { ...selected, status: 'archived' }), false);
  assert.equal(await uniqueInternalSku(client([copy()]), { ...selected, corrected_to_product_id: 4 }), false);
});
