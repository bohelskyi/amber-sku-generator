const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSourceReferences, loadSourceEvidence, getSourceRegistry } = require('../src/services/export-templates/source-references');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { definition: fixture } = require('./fixtures/magento-v4');
const native = () => ({ ...fixture(), evaluatorVersion: 'magento-declarative-5', sourceContractVersion: 'public-product-characteristics-v1' });
const current = () => ({ categories: ['XG'], schemas: [], characteristicVersions: [], questions: [
  { id: 1, category_code: 'XG', key: 'new_color', include_in_sku: 1, input_type: 'options', archived: false, value_ids: ['7', '8'], active_value_ids: ['7'] },
  { id: 2, category_code: 'XG', key: 'new_note', include_in_sku: 1, input_type: 'text', archived: false, value_ids: [], active_value_ids: [] },
] });

test('v5 authoring freezes active current characteristics before any product or SKU publication; v4 still requires original proof', () => {
  const d = native(); compileDefinition(d);
  assert.deepEqual(validateSourceReferences(d, current()), []);
  assert.ok(validateSourceReferences(fixture(), current()).some((x) => x.sourceId === 'color' && x.code === 'SOURCE_REFERENCE_UNRESOLVED'));
});
test('v5 authoring rejects archived, wrong type, duplicate, unknown and inactive source membership', () => {
  for (const mutate of [
    (e) => { e.questions[0].archived = true; },
    (e) => { e.questions[0].input_type = 'text'; },
    (e) => { e.questions.push({ ...e.questions[0], id: 3 }); },
    (e) => { e.questions[0].active_value_ids = ['8']; },
    (e) => { e.categories = []; },
    (e) => { e.questions[1].archived = true; e.questions[1].include_in_sku = 0; },
  ]) { const e = current(); mutate(e); assert.ok(validateSourceReferences(native(), e).length > 0); }
});
test('historical membership remains available after current characteristic archival', () => {
  const e = current(); e.questions[0].archived = true;
  e.schemas.push({ id: 1, category_code: 'XG', questions: [{ key: 'new_color', value_ids: ['7'] }] });
  assert.deepEqual(validateSourceReferences(native(), e), []);
});
test('registry discovers explicitly bounded native categories; old evidence SQL shape stays unchanged', async () => {
  const sqls = [];
  const db = { async query(sql, args) {
    sqls.push([sql, args]);
    if (sql.includes('to_regclass')) return { rows: [{ available: true }] };
    if (sql.startsWith('SELECT code')) return { rows: [{ code: 'XG' }] };
    if (sql.startsWith('SELECT id,category_code')) return { rows: [] };
    return { rows: [current()] };
  } };
  const registry = await getSourceRegistry(db);
  assert.equal(registry.nativeCharacteristicsAuthoring, true);
  assert.deepEqual(sqls.find(([sql]) => sql.includes('jsonb_agg(code'))[1], [['XG']]);
  assert.ok(sqls.some(([sql]) => sql.includes('active_value_ids')));
  sqls.length = 0; await loadSourceEvidence(db, fixture());
  assert.ok(!sqls[0][0].includes('active_value_ids'));
  await assert.rejects(getSourceRegistry({ async query(sql) { return { rows: sql.includes('to_regclass') ? [{ available: true }] : Array.from({ length: 65 }, (_, i) => ({ code: `X${i}` })) }; } }), { code: 'TEMPLATE_SOURCE_SCOPE_LIMIT' });
});
