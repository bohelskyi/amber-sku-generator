const test = require('node:test');
const assert = require('node:assert/strict');
const { hashJsonData, compileDefinition } = require('../src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { prepareDraft, counter } = require('../src/services/export-templates/template.service');
const { validateSourceReferences } = require('../src/services/export-templates/source-references');
const { normalizeDetails } = require('../src/services/audit-viewer.service');
const { catalog } = require('./fixtures/magento-v1/contract');

test('PR2 incomplete draft hash reuses PR1B canonical identity without certifying publishability', () => {
  const d = materializeMagentoV1(catalog());
  assert.equal(prepareDraft(d).hash, compileDefinition(d).hash);
  assert.equal(hashJsonData({ b: [1, '1'], a: '×\r\n' }), hashJsonData({ a: '×\r\n', b: [1, '1'] }));
  assert.notEqual(hashJsonData({ a: [1, 2] }), hashJsonData({ a: [2, 1] }));
  assert.deepEqual(prepareDraft({ groups: [] }).definition, { groups: [] });
  assert.throws(() => compileDefinition({ groups: [] }), { code: 'TEMPLATE_INVALID' });
  const copy = prepareDraft(d); d.groups[0].name = 'changed';
  assert.notEqual(copy.definition.groups[0].name, d.groups[0].name);
});

test('PR2 draft safety rejects executable, unbounded and non-JSONB data', () => {
  for (const value of [[], null, { x: 'a'.repeat(4097) }, { x: '\u0000' }, { x: '\ud800' }, { x: '\udfff' },
    { x: Infinity }, JSON.parse('{"__proto__":{}}'), { x: undefined }]) {
    assert.throws(() => prepareDraft(value), { code: 'TEMPLATE_INVALID', statusCode: 422 });
  }
  const accessor = {}; Object.defineProperty(accessor, 'x', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.throws(() => prepareDraft(accessor), { code: 'TEMPLATE_INVALID' });
  assert.equal(prepareDraft({ emoji: '😀' }).definition.emoji, '😀');
});

test('PR2 revision preconditions retain bigint precision and reject unsafe counters', () => {
  assert.equal(counter('9007199254740993'), '9007199254740993');
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '01', '9223372036854775807', {}, null]) {
    assert.throws(() => counter(value), { code: 'TEMPLATE_COMMAND_INVALID' });
  }
});

function refs(kind = 'semantic') {
  return { sources: { field: { kind, category: 'BR', key: 'old_key', aliases: [] } },
    questionContracts: { q: { source: 'field', exists: true, allowed: ['0', '7'] } } };
}
function evidence() {
  return { categories: ['BR', 'NM'], questions: [], schemas: [
    { id: 12, category_code: 'BR', questions: [{ key: 'old_key', value_ids: ['0', '7'] }] },
  ] };
}
test('PR2 source validation uses archived historical semantic IDs without requiring live options', () => {
  assert.deepEqual(validateSourceReferences(refs(), evidence()), []);
  const e = evidence(); e.questions.push({ category_code: 'BR', key: 'new_key', value_ids: ['7'], include_in_sku: 1 });
  assert.deepEqual(validateSourceReferences(refs(), e), []);
  const d = refs(); d.sources.field.key = 'new_key';
  assert.ok(validateSourceReferences(d, e).some((x) => x.code === 'SOURCE_REFERENCE_UNRESOLVED'));
});
test('PR2 information references require current non-SKU metadata, not schema or label guesses', () => {
  const d = refs('information'); const e = evidence();
  assert.ok(validateSourceReferences(d, e).length);
  e.questions.push({ category_code: 'BR', key: 'old_key', value_ids: ['0', '7'], include_in_sku: 0 });
  assert.deepEqual(validateSourceReferences(d, e), []);
  e.questions.push({ ...e.questions[0] });
  assert.ok(validateSourceReferences(d, e).some((x) => x.code === 'SOURCE_REFERENCE_AMBIGUOUS'));
});
test('PR2 source references reject wrong family, missing questions and unverified value IDs', () => {
  const e = evidence(); const d = refs();
  d.sources.field.category = 'NM';
  assert.ok(validateSourceReferences(d, e).length);
  d.sources.field.category = 'BR'; d.questionContracts.q.exists = false;
  assert.ok(validateSourceReferences(d, e).length);
  d.questionContracts.q.exists = true; d.questionContracts.q.allowed = ['700'];
  assert.ok(validateSourceReferences(d, e).length);
});
test('PR2 aliases check schema ownership and never trust caller-authored evidence as lineage', () => {
  const d = refs(); const e = evidence();
  d.sources.field.aliases = [{ key: 'old_key', schemaId: '12', evidence: 'operator says same question' }];
  assert.ok(validateSourceReferences(d, e).some((x) => x.code === 'SOURCE_REFERENCE_UNSUPPORTED'));
  d.sources.field.aliases[0].schemaId = '999';
  assert.ok(validateSourceReferences(d, e).some((x) => x.code === 'SOURCE_REFERENCE_UNRESOLVED'));
});
test('PR2 audit reader exposes only the exact template definition hash exception', () => {
  const definitionHash = 'a'.repeat(64);
  assert.deepEqual(normalizeDetails('export_template.published', { definitionHash, templateId: 'id', tokenHash: definitionHash }),
    { definitionHash, templateId: 'id' });
  assert.deepEqual(normalizeDetails('product.created', { definitionHash }), {});
  assert.deepEqual(normalizeDetails('export_template.published', { definitionHash: 'not a hash' }), {});
});
