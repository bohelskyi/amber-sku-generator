'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { patchDefinition, compare, argumentsFor } = require('../scripts/sv-optional-characteristics');
const publication = require('./fixtures/legacy-sv-publication.json');
const schema6 = require('./fixtures/legacy-sv-schema6.json');

const products = schema6.products.map((product) => ({ ...product, public_sku: product.full_sku,
  // Names are completed separately; keep them valid so only characteristic errors remain.
  magento_name_override: { generated: { all: '', en: '' }, values: { all: 'UA ' + product.full_sku, en: 'EN ' + product.full_sku } } }));

test('the patch compiles and only wraps the three characteristic rules', () => {
  const published = compileDefinition(publication.definition);
  const patched = compileDefinition(patchDefinition(published.definition));
  assert.notEqual(patched.hash, published.hash);
  const before = new Map(published.definition.bindings.map((b) => [b.id, b.value]));
  const changed = patched.definition.bindings.filter((b) => JSON.stringify(b.value) !== JSON.stringify(before.get(b.id))).map((b) => b.id);
  assert.deepEqual(changed.sort(), ['SV.kolir', 'SV.rozmir_suveniriv', 'SV.typy_obrobky_burshtynu']);
  assert.equal(patched.definition.bindings.find((b) => b.id === 'SV.kolir').value.then.op, 'questionValue', 'original rule retained when answered');
});

test('real SV product copies keep every output; only missing-answer errors disappear', () => {
  const published = compileDefinition(publication.definition);
  const patched = compileDefinition(patchDefinition(published.definition));
  const result = compare({ evaluateProduct }, published, patched, products);
  assert.deepEqual(result.changedOutputs, []);
  assert.equal(result.unchangedOutputs, products.length);
  assert.ok(result.removedErrors.kolir > 0 && result.removedErrors.typy_obrobky_burshtynu > 0);
  assert.equal(result.removedErrors.decor_weight, undefined, 'weight requirement is unchanged');
  const statuette = products.find((p) => p.full_sku === 'SV1121001');
  const after = evaluateProduct(patched, statuette);
  assert.equal(after.base.kolir, ''); assert.equal(after.base.typy_obrobky_burshtynu, '');
  const answered = products.find((p) => p.details.answers.color !== undefined && p.details.answers.material !== undefined);
  assert.deepEqual(evaluateProduct(patched, answered).base, evaluateProduct(published, answered).base);
});

test('unexpected rule shapes and invalid arguments refuse', () => {
  const definition = structuredClone(publication.definition);
  definition.bindings.find((b) => b.id === 'SV.kolir').value = { op: 'literal', value: 'x' };
  assert.throws(() => patchDefinition(definition), /SV_OPTIONAL_UNEXPECTED_SHAPE/);
  assert.throws(() => argumentsFor(['--mode', 'apply', '--expected-database', 'amber', '--actor-id', '1']), /SV_OPTIONAL_ARGUMENTS/);
});
