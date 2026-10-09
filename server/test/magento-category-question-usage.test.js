const { test } = require('node:test');
const assert = require('node:assert/strict');
const workspace = require('../src/services/magento/integration-category-workspace');
const fixture = require('./fixtures/magento-v4');

const source = (id) => ({ op: 'source', id });
const ref = (id) => ({ op: 'ref', id });
function context() {
  const definition = fixture.definition();
  const schema = fixture.observation();
  const revision = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', revision: '1', state: 'published',
    templateId: 'template', templateVersionId: 'version', schema, bindings: fixture.approvedBindings(definition, schema) };
  const catalog = { categories: { XG: { name: 'Category' } }, questions: { XG: [
    { id: 'new_color', label: 'Color', options: [{ id: 0, archived: 0 }, { id: 1, archived: 1 }] },
    { id: 'new_note', label: 'Note' }, { id: 'guard', label: 'Guard only' }, { id: 'unused', label: 'Unused' },
  ] } };
  definition.sources.guard = { kind: 'information', category: 'XG', key: 'guard' };
  definition.sources.sameQuestion = { kind: 'information', category: 'XG', key: 'new_color' };
  definition.sources.foreign = { kind: 'semantic', category: 'YG', key: 'unused' };
  definition.sources.product = { kind: 'product', category: 'XG', key: 'unused', field: 'weight' };
  definition.bindings.push({ id: 'leaf', value: { op: 'concat', values: [source('color'), source('sameQuestion'), source('color'),
    source('foreign'), source('product'), source('unknown')] } },
  { id: 'nested', value: { op: 'when', if: source('guard'), then: ref('leaf'), else: {
    op: 'require', if: source('guard'), value: { op: 'questionValue', question: source('guard'), value: source('note') } } } },
  { id: 'self', value: { op: 'concat', values: [source('color'), ref('self'), source('note')] } },
  { id: 'cycleA', value: { op: 'concat', values: [ref('cycleB'), source('color')] } },
  { id: 'cycleB', value: { op: 'concat', values: [source('note'), ref('cycleA')] } },
  { id: 'duplicate', value: source('color') }, { id: 'duplicate', value: source('note') });
  definition.groups[0].rows[0].cells.kolir = ref('nested');
  definition.groups[0].rows[0].cells.new_note = ref('self');
  definition.groups[0].rows[1].cells.new_note = ref('cycleA');
  return { catalog, revision, definition };
}

test('output provenance retains nested reference order, cycle guards and first binding identity', () => {
  const { definition } = context();
  assert.deepEqual([...workspace.outputSources(definition, ref('nested'))],
    ['color', 'sameQuestion', 'foreign', 'product', 'unknown', 'note']);
  assert.deepEqual([...workspace.outputSources(definition, ref('self'))], ['color', 'note']);
  assert.deepEqual([...workspace.outputSources(definition, ref('cycleA'))], ['note', 'color']);
  assert.deepEqual([...workspace.outputSources(definition, ref('duplicate'))], ['color']);
  assert.deepEqual([...workspace.outputSources(definition, ref('missing'))], []);
});

test('question uses preserve cell order and deduplicate repeated sources while excluding guards and foreign kinds', () => {
  const { catalog, definition } = context();
  const usage = workspace.questionUsage(catalog, definition, 'XG');
  const expected = [{ target: 'kolir', rowId: 'base' }, { target: 'new_note', rowId: 'base' }, { target: 'new_note', rowId: 'english' }];
  assert.deepEqual(usage[0].uses, expected);
  assert.deepEqual(usage[1].uses, expected);
  assert.deepEqual(usage[2].uses, []); assert.deepEqual(usage[3].uses, []);
  assert.deepEqual(usage[0].options, [{ id: 0, archived: 0 }]);
  catalog.questions.XG.push({ ...catalog.questions.XG[0] });
  assert.deepEqual(workspace.questionUsage(catalog, definition, 'XG').at(-1).uses, expected);
});

test('category and English provenance reuse keeps source labels, input data and later requests fresh', () => {
  const f = context(); const before = structuredClone(f);
  const base = workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG');
  const english = workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG', { rowId: 'english' });
  assert.deepEqual(base.attributes.find(a => a.code === 'kolir').sources.map(s => [s.id, s.label]),
    [['color', 'Color'], ['sameQuestion', 'Color'], ['foreign', 'unused'], ['product', 'Unused'], ['unknown', 'unknown'], ['note', 'Note']]);
  assert.deepEqual(english.attributes.find(a => a.code === 'new_note').sources.map(s => s.id), ['note', 'color']);
  assert.deepEqual(english.questions, base.questions); assert.deepEqual(f, before);
  f.definition.bindings.find(b => b.id === 'leaf').value = source('note');
  const changed = workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG');
  assert.deepEqual(changed.attributes.find(a => a.code === 'kolir').sources.map(s => s.id), ['note']);
  assert.deepEqual(changed.questions[0].uses, [{ target: 'new_note', rowId: 'base' }, { target: 'new_note', rowId: 'english' }]);
});

test('one projection traverses each used cell once independent of question count and attribute aliases', () => {
  const f = context(); let traversals = 0;
  const node = source('color');
  f.definition.bindings = [{ id: 'counted', get value() { traversals++; return node; } }];
  f.definition.groups[0].columns = ['first', 'second'];
  // The wrapper isolates provenance visits from the separate empty-literal check.
  const cell = () => ({ op: 'concat', values: [ref('counted')] });
  f.definition.groups[0].rows[0].cells = { first: cell(), second: cell() };
  f.definition.groups[0].rows[1].cells = { first: cell() };
  f.catalog.questions.XG.push(...Array.from({ length: 16 }, (_, i) => ({ id: `unused${i}` })));
  f.revision.schema.attributeSets[0].attributeCodes = ['first', 'second', 'alias'];
  f.revision.bindings.attributes = [{ routeKey: 'XG:all', rowId: 'base', target: 'first', attributeCode: 'alias',
    bindingKey: 'alias', reviewState: 'approved', evidence: {} }];
  f.revision.bindings.options = []; f.revision.bindings.policies = [];
  const result = workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG');
  assert.equal(traversals, 3);
  assert.deepEqual(result.attributes.find(a => a.code === 'alias').sources, result.attributes.find(a => a.code === 'first').sources);
  traversals = 0; workspace.questionUsage(f.catalog, f.definition, 'XG'); assert.equal(traversals, 3);
});

test('empty contexts, first matching category and strict question key identities stay unchanged', () => {
  const f = context();
  assert.deepEqual(workspace.questionUsage({ questions: {} }, f.definition, 'XG'), []);
  assert.deepEqual(workspace.projectCategory(f.catalog, null, null, 'XG').attributes, []);
  f.catalog.questions.XG.push({ id: 0 }, { id: '0' });
  f.definition.sources.numeric = { kind: 'semantic', category: 'XG', key: 0 };
  f.definition.groups[0].rows[0].cells.kolir = source('numeric');
  const extra = structuredClone(f.definition.groups[0]); extra.rows[0].cells.new_note = source('guard');
  f.definition.groups.push(extra);
  const usage = workspace.questionUsage(f.catalog, f.definition, 'XG');
  assert.deepEqual(usage.find(q => q.id === 0).uses, [{ target: 'kolir', rowId: 'base' }]);
  assert.deepEqual(usage.find(q => q.id === '0').uses, []);
  assert.deepEqual(usage.find(q => q.id === 'guard').uses, []);
});
