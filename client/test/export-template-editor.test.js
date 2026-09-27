import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import { copyDefinition, consumers, moveItem, parseProductIds, replaceAt, renameSlot, removeSlot, slotNameError } from '../src/lib/export-template-editor.js';
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { compileDefinition, hashJsonData } = require('../../server/src/services/export-templates/definition');
const { evaluateBatch } = require('../../server/src/services/export-templates/evaluate');
const { catalog, product } = require('../../server/test/fixtures/magento-v1/contract');
const { cases } = require('../../server/test/fixtures/magento-v1/expected-rows');
const goldens = require('../../server/test/fixtures/magento-v1/goldens.json');

test('PR4 structural round-trip preserves all ten original pure goldens and canonical server hashes', () => {
  for (const fixture of cases) {
    const rules = catalog();
    for (const [key, changes] of Object.entries(fixture.questions || {})) Object.assign(rules.get(fixture.group).get(key), changes);
    const original = materializeMagentoV1(rules);
    const roundTrip = copyDefinition(original);
    assert.equal(hashJsonData(roundTrip), hashJsonData(original));
    const output = evaluateBatch(compileDefinition(roundTrip), [product(fixture.group, fixture.answers, fixture.product)]);
    assert.deepEqual(Buffer.from(output.artifacts[0].csvContent), Buffer.from(goldens[fixture.id]));
  }
});
test('PR4 path edits retain missing/null/zero/string/whitespace, order, aliases and future nodes', () => {
  const original = { untouched: { null: null, number: 0, string: '0', blank: '', text: ' \n x \t', aliases: [{ schemaId: '9007199254740993', key: '2' }] },
    future: { op: 'future', content: [0, '0', null] }, array: ['b', 'a'], tables: { example: { 0: ' zero ' } } };
  const edited = replaceAt(copyDefinition(original), ['tables', 'example', '0'], ' нове ');
  assert.deepEqual(edited.untouched, original.untouched);
  assert.deepEqual(edited.future, original.future);
  assert.equal(Object.hasOwn(edited, 'missing'), false);
  assert.deepEqual(edited.array, original.array);
  assert.equal(original.tables.example[0], ' zero ');
});
test('PR4 transitive shared consumers and local copy target only the selected reference', () => {
  const original = materializeMagentoV1(catalog());
  assert.ok(consumers(original, 'table', 'materialUa').some((s) => s.startsWith('BR')));
  assert.ok(consumers(original, 'table', 'materialUa').some((s) => s.startsWith('NM')));
  const binding = original.bindings.find((b) => b.id === 'BR.nameUa');
  const edited = replaceAt(original, ['groups', 0, 'rows', 0, 'cells', 'name'], copyDefinition(binding.value));
  assert.deepEqual(edited.bindings, original.bindings);
  assert.equal(edited.groups[0].rows[1].cells.name.op, 'ref');
  assert.equal(Object.hasOwn(edited.groups[0].rows[1].cells, 'price'), false);
  assert.equal(original.sources['SV.2'].key, '2');
});
test('PR4 column moves never delete or add contract columns', () => {
  const columns = materializeMagentoV1(catalog()).groups[0].columns;
  const moved = moveItem(columns, 2, -1);
  assert.deepEqual([...moved].sort(), [...columns].sort());
  assert.equal(moved[1], columns[2]);
  assert.deepEqual(moveItem(columns, 0, -1), columns);
});
test('PR4 explicit product ID parser rejects missing, duplicates, overflow and excess without dropping IDs', () => {
  assert.deepEqual(parseProductIds('1, 2;3\n4'), [1, 2, 3, 4]);
  for (const input of ['', '1,1', '1,x', '0', '-1', '1.1', '2147483648', Array.from({ length: 101 }, (_, i) => i + 1).join(',')]) {
    assert.throws(() => parseProductIds(input));
  }
});

test('PR4 slot names, duplicates, explicit reference handling and server type/bounds reject unsafe composition', () => {
  const node = { op: 'interpolate', template: '{material} {sku}', slots: { material: { op: 'literal', value: '  0 ' }, sku: { op: 'literal', value: 'A' } } };
  for (const name of ['__proto__','constructor','prototype','bad.name','a-b','','x'.repeat(65),'material']) assert.ok(slotNameError(name,node.slots));
  assert.throws(() => removeSlot(node,'material'));
  const renamed = renameSlot(node,'material','color'); assert.equal(renamed.template,'{color} {sku}'); assert.equal(renamed.slots.color.value,'  0 ');
  assert.deepEqual(removeSlot({ ...renamed, template: '{sku}' },'color').slots,node.slots.sku ? { sku: node.slots.sku } : {});
  const definition = materializeMagentoV1(catalog());
  const path = ['groups',2,'rows',0,'cells','name'];
  assert.throws(() => compileDefinition(replaceAt(definition,path,{...node,slots:{...node.slots,material:{op:'literal',value:0}}})),/Text node required/);
  assert.throws(() => compileDefinition(replaceAt(definition,path,{...node,template:'{unknown}'})),/Interpolation slots/);
  const slots=Object.fromEntries(Array.from({length:17},(_,i)=>[`slot${i}`,{op:'literal',value:''}]));
  assert.throws(() => compileDefinition(replaceAt(definition,path,{op:'interpolate',slots,template:Object.keys(slots).map((s)=>`{${s}}`).join('')})),/Interpolation slots/);
});
