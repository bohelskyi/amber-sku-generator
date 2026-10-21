const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateExample } = require('../src/services/export-templates/template.service');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { officeCatalog, officeEvidence } = require('./fixtures/magento-v1/office');
const { product } = require('./fixtures/magento-v1/contract');

function fixture(products = [{ ...product('BR'), id: 12 }], evidence = officeEvidence()) {
  const queries = []; let released = false;
  const client = { release() { released = true; }, async query(sql, values) {
    queries.push({ sql, values });
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE)\b/i);
    if (sql.includes('to_regclass')) return { rows: [{ present: false }] };
    if (sql.includes('FROM products p')) return { rows: products };
    if (sql.includes('AS categories')) return { rows: [evidence] };
    if (/^(SELECT pg_advisory_|BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  return { queries, databasePool: { async connect() { return client; } }, released: () => released };
}

test('unsaved examples evaluate UA/EN from stored facts in one read-only transaction without template writes', async () => {
  const definition = materializeMagentoV1(officeCatalog());
  definition.groups[0].rows[0].cells.name = { op: 'literal', value: 'Приклад UA' };
  definition.groups[0].rows[1].cells.name = { op: 'literal', value: 'Example EN' };
  const before = structuredClone(definition); const db = fixture();
  const result = await evaluateExample({ definition, productIds: [12] }, db);
  assert.equal(result.draftOnly, true); assert.equal(result.publicationReady, false);
  assert.equal(result.sampleProducts[0].productId, 12);
  assert.match(JSON.stringify(result.result), /Приклад UA/); assert.match(JSON.stringify(result.result), /Example EN/);
  assert.deepEqual(definition, before);
  assert.ok(db.queries.some(({ sql }) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(db.queries.some(({ sql }) => sql === 'COMMIT')); assert.ok(db.released());
  assert.ok(db.queries.every(({ sql }) => !sql.includes('export_template')));
  assert.deepEqual(db.queries.find(({ sql }) => sql.includes('FROM products p')).values, [[12]]);
});

test('examples reject caller products, invalid IDs and unknown command fields before connecting', async () => {
  const db = { databasePool: { connect() { throw new Error('must not connect'); } } };
  const definition = materializeMagentoV1(officeCatalog());
  for (const input of [{ definition, productIds: [] }, { definition, productIds: [12, 12] }, { definition, productIds: [0] },
    { definition, productIds: [12], products: [] }, { definition, productIds: Array.from({ length: 101 }, (_, i) => i + 1) }]) {
    await assert.rejects(evaluateExample(input, db), { code: 'TEMPLATE_COMMAND_INVALID' });
  }
});

test('missing products and unresolved sampled sources fail closed and release the read transaction', async () => {
  const definition = materializeMagentoV1(officeCatalog()); const db = fixture([]);
  await assert.rejects(evaluateExample({ definition, productIds: [12] }, db), { code: 'TEMPLATE_PRODUCTS_MISSING' });
  assert.ok(db.queries.some(({ sql }) => sql === 'ROLLBACK')); assert.ok(db.released());
  const missing = fixture(undefined, { categories: [], questions: [], schemas: [] });
  await assert.rejects(evaluateExample({ definition, productIds: [12] }, missing), { code: 'TEMPLATE_SOURCE_INVALID' });
  assert.ok(missing.released());
});
