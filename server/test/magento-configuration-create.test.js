const { test } = require('node:test');
const assert = require('node:assert/strict');
const { categoryTarget, verifyCategory } = require('../src/services/magento/configuration-category');
const revision = { id: '00000000-0000-0000-0000-000000000001', state: 'draft', revision: '1',
  bindings: { attributes: [{ bindingKey: 'new-path', target: 'categories', evidence: { categories: [
    { requestedPath: 'Default/Сувеніри/Нова підкатегорія', normalizedPath: 'Default/Сувеніри/Нова підкатегорія' },
  ] } }] } };
const input = { bindingRevisionId: revision.id, expectedRevision: '1', bindingKey: 'new-path',
  path: 'Default/Сувеніри/Нова підкатегорія', parentId: 10 };
const nodes = [{ categoryId: '10', path: 'Default/Сувеніри', normalizedPath: 'Default/Сувеніри', comparable: true }];
test('reviewed category creation extends beyond the two historical CLI paths, with fixed menu defaults', () => {
  const result = categoryTarget(revision, input, nodes);
  assert.deepEqual(result.body, { category: { parent_id: 10, name: 'Нова підкатегорія', is_active: true, include_in_menu: false } });
  assert.equal(revision.bindings.attributes[0].evidence.categories[0].categoryId, undefined);
});
test('unrelated paths, wrong parents, duplicate paths and stale draft revisions cannot create categories', () => {
  for (const command of [{ ...input, path: 'Default/Other' }, { ...input, parentId: 20 }, { ...input, expectedRevision: '2' }]) {
    assert.throws(() => categoryTarget(revision, command, nodes));
  }
  assert.throws(() => categoryTarget(revision, input, [...nodes, { ...nodes[0], categoryId: '20' }]));
});
test('verification requires returned exact ID, hierarchy and both reviewed flags; equal labels are insufficient', () => {
  const target = categoryTarget(revision, input, nodes);
  const created = { id: 6001, parent_id: 10, name: 'Нова підкатегорія', is_active: true, include_in_menu: false };
  const after = [...nodes, { categoryId: '6001', path: input.path, normalizedPath: input.path, comparable: true }];
  assert.equal(verifyCategory(target, '6001', created, after), true);
  for (const changed of [{ ...created, id: 6002 }, { ...created, include_in_menu: true }, { ...created, parent_id: 11 }]) {
    assert.throws(() => verifyCategory(target, '6001', changed, after));
  }
  assert.throws(() => verifyCategory(target, null, created, after));
});
