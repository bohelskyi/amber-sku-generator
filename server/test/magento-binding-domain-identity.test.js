const test = require('node:test');
const assert = require('node:assert/strict');
const { requirements } = require('../src/services/magento/binding-validation');
const { hash } = require('../src/services/magento/binding-contract');
const { definition, schema } = require('./fixtures/magento-bindings');

test('binding requirements preserve every frozen legacy route, domain and option identity', () => {
  const legacy = require('./fixtures/legacy-sv-publication.json');
  const d = structuredClone(legacy.definition);
  const before = structuredClone(d);
  const attributes = legacy.tables.schema_attributes.map(a => ({ ...a.metadata,
    options: legacy.tables.schema_options.filter(o => o.attribute_code === a.code)
      .map(o => ({ value: o.option_id, label: o.label })) }));
  const plans = requirements(d, { attributes });
  assert.equal(plans.length, 7);
  assert.equal(plans.flatMap(p => p.attributes).length, 204);
  // Captured from the unchanged deployed canonical algorithm, including all
  // options and domain keys; compiled publication.hash is a different identity.
  assert.equal(hash(plans), '4a614215bf2e39fe4d81d443e5307fa2c28d232ffd555ade930266e52c1397d6');
  assert.deepEqual(d, before);
});

test('a changed definition invalidates all field domains on the next call with the same object', () => {
  const d = structuredClone(definition()), s = schema();
  const original = requirements(d, s).flatMap(p => p.attributes);
  const row = d.groups[0].rows[0];
  row.cells.name = { op: 'literal', value: 'Changed fixture name' };
  const fresh = requirements(d, s).flatMap(p => p.attributes);
  assert.equal(fresh.length, original.length);
  assert.deepEqual(fresh.map(a => a.bindingKey), original.map(a => a.bindingKey));
  for (let n = 0; n < fresh.length; n++) assert.notEqual(fresh[n].domainKey, original[n].domainKey);
  assert.deepEqual(requirements(d, s).flatMap(p => p.attributes), fresh);
});
