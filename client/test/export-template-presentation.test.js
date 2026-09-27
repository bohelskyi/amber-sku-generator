import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { affectedFields, at, editField, editMapping, insertCharacteristic, mappingsForSource, outputNode, resolveNode, summary } from '../src/lib/export-template-presentation.js';
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { compileDefinition, hashJsonData } = require('../../server/src/services/export-templates/definition');
const { evaluateProduct, evaluateBatch } = require('../../server/src/services/export-templates/evaluate');
const { catalog, product } = require('../../server/test/fixtures/magento-v1/contract');
const { cases } = require('../../server/test/fixtures/magento-v1/expected-rows');
const goldens = require('../../server/test/fixtures/magento-v1/goldens.json');
const path = ['groups', 2, 'rows', 0, 'cells', 'name'];

test('presentation reads every field and preserves canonical hashes and all original goldens', () => {
  for (const fixture of cases) {
    const rules = catalog();
    for (const [key, changes] of Object.entries(fixture.questions || {})) Object.assign(rules.get(fixture.group).get(key), changes);
    const definition = materializeMagentoV1(rules); const hash = hashJsonData(definition);
    definition.groups.forEach((group) => group.rows.forEach((row) => group.columns.forEach((column) => {
      summary(definition, row.cells[column]); outputNode(definition, row.cells[column]);
    })));
    assert.equal(hashJsonData(definition), hash);
    assert.equal(evaluateBatch(compileDefinition(definition), [product(fixture.group, fixture.answers, fixture.product)]).artifacts[0].csvContent, goldens[fixture.id]);
  }
});
test('one local mapping action copies exactly its dependency path and only changes KL name across all six groups', () => {
  const original = materializeMagentoV1(catalog());
  const name = outputNode(original, at(original, path));
  assert.ok(mappingsForSource(original, 'KL.color').includes('klColor'));
  let edited = editField(original, path, name.trail, 'local', (node) => insertCharacteristic(node, 'KL.color', 'klColor'));
  const local = outputNode(edited, at(edited, path));
  edited = editField(edited, path, local.trail, 'local', (node) => ({ ...node, template: 'Кулон з {material} бурштину, {color}. Арт: {sku}' }));
  edited = editMapping(edited, path, [...local.trail, 'slots', 'color'], 'local', (table) => ({ ...table, 1: '  особливий колір  ' }));
  const table = at(edited, path).then.slots.color.table;
  assert.notEqual(table, 'klColor'); assert.equal(edited.tables[table][1], '  особливий колір  ');
  assert.deepEqual(edited.tables.klColor, original.tables.klColor);
  const tableCount = Object.keys(edited.tables).length;
  edited = editMapping(edited, path, [...local.trail, 'slots', 'color'], 'local', (entries) => ({ ...entries, 2: 'Інший' }));
  assert.equal(Object.keys(edited.tables).length, tableCount);
  assert.deepEqual(edited.bindings, original.bindings);
  assert.deepEqual(at(edited, path).if, original.bindings.find((b) => b.id === 'KL.nameUa').value.if);
  assert.deepEqual(at(edited, path).else, original.bindings.find((b) => b.id === 'KL.nameUa').value.else);
  assert.deepEqual(at(edited, path).then.slots.material, name.node.slots.material);
  assert.deepEqual(at(edited, path).then.slots.sku, name.node.slots.sku);
  for (const group of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) {
    const before = evaluateProduct(compileDefinition(original), product(group)); const after = evaluateProduct(compileDefinition(edited), product(group));
    assert.deepEqual(after.errors, []);
    if (group === 'KL') { assert.notEqual(after.base.name, before.base.name); assert.deepEqual(after, { ...before, base: { ...before.base, name: after.base.name } }); }
    else assert.deepEqual(after, before);
  }
  assert.deepEqual(edited.sources, original.sources); assert.deepEqual(edited.questionContracts, original.questionContracts);
});
test('local nested material edits preserve shared tables, unknown metadata and fallback branches', () => {
  const definition = materializeMagentoV1(catalog());
  const binding = definition.bindings.find((b) => b.id === 'KL.nameUa');
  binding.value.note = { zero: 0, null: null, text: '  ' };
  const name = outputNode(definition, at(definition, path));
  const result = editMapping(definition, path, [...name.trail, 'slots', 'material'], 'local', (table) => ({ ...table, 1: 'Локальне' }));
  assert.deepEqual(at(result, path).note, binding.value.note);
  assert.deepEqual(at(result, path).then.slots.material.otherwise, name.node.slots.material.otherwise);
  assert.deepEqual(result.bindings, definition.bindings);
  assert.deepEqual(result.tables.materialUa, definition.tables.materialUa);
  assert.equal(Object.hasOwn(result.groups[2].rows[1].cells, 'price'), false);
});
test('shared warning is the actual transitive consumer set; shared mutation uses original table', () => {
  const definition = materializeMagentoV1(catalog()); const name = outputNode(definition, at(definition, path));
  const trail = [...name.trail, 'slots', 'material'];
  const affected = affectedFields(definition, path, trail, 'materialUa');
  assert.deepEqual(affected, ['BR / база / name', 'NM / база / name', 'KL / база / name', 'CH / база / name']);
  const next = editMapping(definition, path, trail, 'shared', (table) => ({ ...table, 1: 'Спільне' }));
  assert.deepEqual(next.groups, definition.groups); assert.deepEqual(next.bindings, definition.bindings);
  assert.equal(Object.keys(next.tables).length, Object.keys(definition.tables).length);
});
test('custom names resolve structurally, protected/metadata references fail closed and unknown nodes remain intact', () => {
  const definition = materializeMagentoV1(catalog());
  const original = definition.bindings.find((b) => b.id === 'KL.nameUa'); original.id = 'custom.name';
  definition.groups[2].rows[0].cells.name = { op: 'ref', id: 'custom.name', futureMetadata: 0 };
  const resolved = outputNode(definition, at(definition, path));
  assert.equal(resolved.node.op, 'interpolate');
  assert.throws(() => editField(definition, path, resolved.trail, 'local', (node) => ({ ...node, template: 'x' })), /додаткові властивості/);
  assert.throws(() => editField(definition, [...path.slice(0, -1), 'sku'], [], 'local', () => ({ op: 'literal', value: 'x' })), /захищено/);
  const future = { op: 'future', value: [0, '0', null], metadata: '  ' };
  definition.groups[2].rows[0].cells.meta_title = future;
  assert.equal(summary(definition, future), 'Власне правило');
  assert.deepEqual(resolveNode(definition, future).node, future);
  const next = editField(definition, ['groups', 2, 'rows', 1, 'cells', 'meta_title'], [], 'local', () => ({ op: 'literal', value: 0 }));
  assert.equal(next.groups[2].rows[1].cells.meta_title.value, 0);
  assert.deepEqual(next.groups[2].rows[0].cells.meta_title, future);
});
