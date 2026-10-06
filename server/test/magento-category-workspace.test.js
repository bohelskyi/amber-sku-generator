const { test } = require('node:test');
const assert = require('node:assert/strict');
const workspace = require('../src/services/magento/integration-category-workspace');
const fixture = require('./fixtures/magento-v4');

function context() {
  const definition = fixture.definition();
  const schema = fixture.observation();
  schema.attributes.push({ attribute_id: 1001, attribute_code: 'material', frontend_input: 'select', default_frontend_label: 'Матеріал', options: [] },
    { attribute_id: 1002, attribute_code: 'photo', frontend_input: 'media_image', options: [] });
  schema.attributeSets[0].attributeCodes.push('material', 'photo');
  const revision = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', revision: '4', state: 'published', templateId: 'template', templateVersionId: 'version', observedAt: '2026-10-04T00:00:00Z', schema, bindings: fixture.approvedBindings(definition, schema) };
  const catalog = { categories: { XG: { name: 'Тестова категорія' } }, questions: { XG: [
    { id: 'new_color', label: 'Колір', input_type: 'options', options: [{ id: 7, label: 'Червоний', archived: 0 }, { id: 0, label: 'Нуль', archived: 0 }, { id: 9, label: 'Архівний', archived: 1 }] },
    { id: 'new_note', label: 'Примітка', input_type: 'text', options: [] },
    { id: 'unused', label: 'Не використано', input_type: 'text', options: [] },
  ] } };
  return { definition, revision, catalog };
}

test('category shows the complete selected set, unsupported/unmapped fields and exact pinned rules', () => {
  const f = context(); const before = structuredClone(f);
  const result = workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG');
  assert.equal(result.category.name, 'Тестова категорія');
  assert.equal(result.attributes.find((a) => a.code === 'material').state, 'unmapped');
  assert.match(result.attributes.find((a) => a.code === 'photo').restriction, /лише для перегляду/);
  assert.equal(result.attributes.find((a) => a.code === 'sku').editable, false);
  assert.deepEqual(result.attributes.find((a) => a.code === 'kolir').sources.map((s) => s.label), ['Колір']);
  assert.equal(result.template.versionId, 'version'); assert.equal(result.observedAt, f.revision.observedAt);
  assert.equal(result.unboundCount, 1); assert.equal(result.attributes.some((a) => Object.hasOwn(a, 'options')), false);
  assert.deepEqual(f, before);
});

test('category includes unresolved decisions across the publication without option bodies or changing state', () => {
  const f = context();
  f.definition.groups.push({ route: 'OTHER' });
  f.revision.bindings.routes.push({ ...f.revision.bindings.routes[0], routeKey: 'OTHER:all', reviewState: 'proposed' });
  f.revision.bindings.attributes.find((a) => a.target === 'kolir').reviewState = 'review_required';
  const before = structuredClone(f);
  const result = workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG');
  assert.equal(result.reviewScope.categoryCount, 2);
  assert.equal(result.reviewScope.unresolved.some((entry) => entry.group === 'OTHER'), true);
  assert.equal(result.reviewScope.unresolved.some((entry) => entry.target === 'kolir'), true);
  assert.equal(result.reviewScope.unresolved.every((entry) => Object.keys(entry).every((key) => ['group', 'target', 'row', 'kind', 'reviewState'].includes(key))), true);
  assert.deepEqual(f, before);
});

test('guards, unused declarations and another category source do not count as transmitted characteristics', () => {
  const f = context(); f.definition.sources.guard = { kind: 'information', category: 'XG', key: 'unused' };
  f.definition.groups[0].rows[0].cells.new_note = { op: 'when', if: { op: 'present', input: { op: 'source', id: 'guard' } },
    then: { op: 'require', if: { op: 'source', id: 'guard' }, value: { op: 'source', id: 'note' } }, else: { op: 'literal', value: '' } };
  f.definition.sources.other = { kind: 'information', category: 'YG', key: 'unused' };
  f.definition.groups[0].rows[1].cells.new_note = { op: 'source', id: 'other' };
  const result = workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG');
  assert.deepEqual(result.questions.find((q) => q.id === 'unused').uses, []);
  assert.deepEqual(result.questions.find((q) => q.id === 'new_note').uses, [{ target: 'new_note', rowId: 'base' }]);
  assert.deepEqual(result.questions[0].options.map((o) => o.id), [7, 0]);
});

test('English and multiple routes keep their own membership, option and policy states', () => {
  const f = context(); const route = { ...f.revision.bindings.routes[0], routeKey: 'XG.kind=value_id:0', setId: 9002 };
  f.revision.schema.attributeSets.push({ attribute_set_id: 9002, attribute_set_name: 'Інший набір', attributeCodes: ['material'] });
  f.revision.bindings.routes.push(route);
  const result = workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG', { routeKey: route.routeKey, rowId: 'english' });
  assert.equal(result.routes.length, 2); assert.equal(result.routeKey, route.routeKey); assert.equal(result.rowIndex, 1);
  assert.equal(result.attributes.find((a) => a.code === 'kolir').inSet, false);
  assert.equal(result.attributes.find((a) => a.code === 'material').inSet, true);
  assert.equal(result.attributes.find((a) => a.code === 'kolir').state, 'unmapped');
  assert.equal(result.attributes.find((a) => a.code === 'name').state, 'review');
  assert.throws(() => workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG', { routeKey: 'YG:all' }));
});

test('new category without a publication is unavailable rather than a fabricated connection', () => {
  const f = context(); const result = workspace.projectCategory(f.catalog, null, null, 'XG');
  assert.equal(result.revision, null); assert.equal(result.observedAt, null); assert.equal(result.unboundCount, 3);
  assert.deepEqual(result.attributes, []);
  assert.throws(() => workspace.projectCategory(f.catalog, null, null, 'UNKNOWN'), { code: 'MAGENTO_CATEGORY_NOT_FOUND' });
});

test('optional empty texts are omitted, required empty texts explain a repair, and service fields stay separate', () => {
  const f = context();
  f.definition.groups[0].columns.push('description', 'short_description', 'image_label', 'custom_layout_update');
  Object.assign(f.definition.groups[0].rows[0].cells, { description: { op: 'ref', id: 'emptyDescription' }, short_description: { op: 'literal', value: '' } });
  f.definition.bindings.push({ id: 'emptyDescription', value: { op: 'literal', value: '' } });
  for (const [code, required] of [['description', false], ['short_description', true], ['image_label', false], ['custom_layout_update', false]]) {
    f.revision.schema.attributes.push({ attribute_code: code, frontend_input: 'text', is_required: required, is_user_defined: false, default_frontend_label: code });
    f.revision.schema.attributeSets[0].attributeCodes.push(code);
  }
  const result = workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG');
  const field = (code) => result.attributes.find((a) => a.code === code);
  assert.equal(field('description').state, 'empty'); assert.deepEqual(field('description').reviewReasons, []);
  assert.equal(field('description').label, 'Опис'); assert.equal(field('description').service, false);
  assert.equal(field('short_description').state, 'review'); assert.match(field('short_description').reviewReasons[0].message, /Обов’язкове поле порожнє/);
  assert.equal(field('image_label').service, true); assert.equal(field('custom_layout_update').service, true);
  assert.equal(field('new_note').service, false);
});

test('field review explains exact unresolved decisions and placement exposes frozen identities without approval', () => {
  const f = context(); const binding = f.revision.bindings.attributes.find((a) => a.target === 'kolir');
  binding.reviewState = 'proposed';
  f.revision.bindings.options.find((o) => o.bindingKey === binding.bindingKey).reviewState = 'review_required';
  f.revision.bindings.policies.find((p) => p.bindingKey === binding.bindingKey).reviewState = 'proposed';
  binding.evidence.categories = [{ requestedPath: 'Default/Кулони', normalizedPath: 'Default/Кулони', categoryId: 42, candidates: [{ categoryId: 42, path: 'Default/Кулони' }], reviewState: 'proposed' }];
  const result = workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG');
  assert.deepEqual(result.attributes.find((a) => a.code === 'kolir').reviewReasons.map((r) => r.kind), ['attribute', 'option', 'policy', 'category']);
  assert.equal(result.placements[0].identity, 42); assert.equal(result.placements[0].reviewState, 'proposed');
});

test('explicit observation projects new fields and option drift without changing frozen bindings; failures and conflicts fail closed', async () => {
  const editor = require('../src/services/magento/integration-editor.service');
  const c = require('../src/services/magento/binding-contract');
  const f = context();
  f.revision.schema = c.normalizeSchema(f.revision.schema);
  f.revision.schemaFingerprint = c.hash(f.revision.schema);
  f.revision.topologyFingerprint = c.hash(f.revision.schema.storeTopology);
  const original = structuredClone(f.revision);
  const snapshot = { ...workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG'), currentPublishedId: f.revision.id, selectedRevision: f.revision };
  const observation = { schema: structuredClone(f.revision.schema), categories: [], observedAt: '2026-10-04T12:00:00Z' };
  observation.schema.attributes.find(a => a.attribute_code === 'kolir').options = [];
  observation.schema.attributes.push({ ...observation.schema.attributes.find(a => a.attribute_code === 'new_note'), attribute_code: 'new_text', attribute_id: 1003, default_frontend_label: 'Новий текст' });
  observation.schema.attributeSets[0].attributeCodes.push('new_text');
  const read = editor.read, discovery = editor.discovery;
  let reads = 0;
  try {
    editor.read = async () => { ++reads; return snapshot; };
    editor.discovery = async () => { assert.equal(reads, 1); return observation; };
    const result = await workspace.observeCategory({}, 'XG');
    assert.equal(result.observedAt, observation.observedAt);
    assert.equal(result.attributes.find(a => a.code === 'new_text').state, 'unmapped');
    assert.equal(result.attributes.find(a => a.code === 'kolir').state, 'review');
    assert.deepEqual(f.revision, original);
    editor.discovery = async () => { throw new Error('Magento unavailable'); };
    await assert.rejects(workspace.observeCategory({}, 'XG'), /Magento unavailable/);
    assert.deepEqual(f.revision, original);
    reads = 0; editor.discovery = async () => observation;
    editor.read = async () => ++reads === 1 ? snapshot : { ...snapshot, currentPublishedId: 'another' };
    await assert.rejects(workspace.observeCategory({}, 'XG'), { code: 'MAGENTO_BINDING_CONFLICT' });
  } finally { editor.read = read; editor.discovery = discovery; }
});

test('category/field queries reject malformed or extra input before database access', async () => {
  for (const input of [{ rowId: 'uk' }, { bindingRevisionId: 'latest' }, { routeKey: ['XG:all'] }, { extra: true }]) {
    await assert.rejects(workspace.readCategory({}, 'XG', input));
  }
  await assert.rejects(workspace.readField({}, 'XG', '../secret'));
  await assert.rejects(workspace.readCategory({}, "XG';DROP TABLE products"));
});

test('category and field HTTP reads retain view authorization and normalize the Express query', async () => {
  const router = require('../src/routes/admin/magento-integration.routes');
  for (const [path, method, params] of [
    ['/admin/magento-integration/categories/:categoryCode', 'readCategory', { categoryCode: 'XG' }],
    ['/admin/magento-integration/categories/:categoryCode/fields/:field', 'readField', { categoryCode: 'XG', field: 'kolir' }],
  ]) {
    const route = router.stack.find((layer) => layer.route.path === path).route;
    assert.deepEqual(route.stack.map((layer) => layer.handle.permissionKey).filter(Boolean), ['export_templates.view']);
    const original = workspace[method]; let command;
    workspace[method] = async (...args) => { command = args.at(-1); return {}; };
    try {
      await route.stack.at(-1).handle({ params, query: Object.assign(Object.create(null), { rowId: 'english' }) }, { json: () => {} });
      assert.deepEqual(command, { rowId: 'english' }); assert.equal(Object.getPrototypeOf(command), Object.prototype);
    } finally { workspace[method] = original; }
  }
});

test('controlled picker binds exact category and literal search as SQL parameters', async () => {
  const editor = require('../src/services/magento/integration-editor.service');
  const repository = require('../src/services/magento/binding-repository');
  const original = { read: editor.read, selected: editor.selected, current: repository.current }; const calls = [];
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  editor.read = async (_options, operation) => operation({ query: async (...args) => { calls.push(args); return { rows: [] }; } });
  editor.selected = async () => ({ id, state: 'published', installationKey: 'fixture' }); repository.current = async () => ({ id });
  try {
    const controlled = require('../src/services/magento/binding-controlled-actions');
    assert.deepEqual(await controlled.candidates({}, id, {}, { after: '0', search: "'%_", categoryCode: 'XG' }), { products: [], nextCursor: null });
    assert.deepEqual(calls[0][1], [0, "'%_", 'XG', null]); assert.match(calls[0][0], /p.category=\$3/);
    await controlled.candidates({}, id, {}, { categoryCode: 'XG', productId: '42' });
    assert.deepEqual(calls[1][1], [0, '', 'XG', 42]); assert.match(calls[1][0], /p.id=\$4/);
    for (const productId of ['42 OR 1=1', 0, -1, '1e3', [42], '2147483648']) await assert.rejects(controlled.candidates({}, id, {}, { productId }));
    await assert.rejects(controlled.candidates({}, id, {}, { categoryCode: ['XG'] }));
  } finally { Object.assign(editor, { read: original.read, selected: original.selected }); repository.current = original.current; }
});

test('retired exact resources remain inspectable but contribute an explicit field review reason', () => {
  const f = context(); f.revision.state = 'draft';
  const binding = f.revision.bindings.attributes.find(a => a.target === 'kolir');
  const retired = require('../src/services/magento/retired-catalog-targets');
  f.revision.catalogAvailability = retired.availability([{ route_key: 'XG:all', row_id: 'base', binding_key: binding.bindingKey,
    target: 'kolir', attribute_code: 'kolir', attribute_id: '1535', kind: 'attribute_delete_remote', cleanup_id: 'cleanup', verified_at: '2026-10-06T01:00:00Z' }]);
  const before = structuredClone(f);
  const result = workspace.projectCategory(f.catalog, f.revision, f.definition, 'XG');
  assert.equal(result.revision.catalogAvailability.publicationBlocked, true);
  assert.equal(result.attributes.find(a => a.code === 'kolir').state, 'review');
  assert.equal(result.attributes.find(a => a.code === 'kolir').reviewReasons.some(r => r.kind === 'retired_resource'), true);
  assert.throws(() => retired.assertAvailable(f.revision), { code: 'MAGENTO_BINDING_RETIRED_RESOURCE' });
  assert.doesNotThrow(() => retired.assertAvailable({ catalogAvailability: retired.availability([]) }));
  assert.deepEqual(f, before);
});
