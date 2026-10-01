const test = require('node:test');
const assert = require('node:assert/strict');
const { stableReviewedSource } = require('../src/services/magento/integration-successor');

test('successor carry requires unchanged expression and transitive source/table proof', () => {
  const definition = { sources: { color: { kind: 'semantic', category: 'XX', key: 'color' } },
    questionContracts: {}, sourceSupport: [], tables: { labels: { 8: 'Скриньки' } },
    bindings: [{ id: 'mapped', group: 'XX', value: { op: 'lookup', input: { op: 'source', id: 'color' }, table: 'labels' } }],
    groups: [{ route: 'XX', rows: [{ id: 'base', cells: { suveniry: { op: 'ref', id: 'mapped' }, name: { op: 'literal', value: 'Old' } } }] }] };
  const revision = { bindings: { routes: [], attributes: [{ routeKey: 'XX:default', rowId: 'base', target: 'suveniry', bindingKey: 'k', reviewState: 'approved', evidence: {} }],
    options: [{ bindingKey: 'k', reviewState: 'approved' }], policies: [{ bindingKey: 'k', reviewState: 'approved' }] } };
  const original = structuredClone(revision);
  const unrelated = structuredClone(definition); unrelated.groups[0].rows[0].cells.name.value = 'New';
  assert.equal(stableReviewedSource(revision, definition, unrelated).bindings.attributes[0].reviewState, 'approved');
  const changed = structuredClone(definition); changed.tables.labels[8] = 'Лампа';
  const result = stableReviewedSource(revision, definition, changed);
  for (const kind of ['attributes', 'options', 'policies']) assert.equal(result.bindings[kind][0].reviewState, 'review_required');
  assert.deepEqual(revision, original);
  changed.sources.color.key = 'other';
  assert.equal(stableReviewedSource(revision, definition, changed).bindings.attributes[0].reviewState, 'review_required');
});
