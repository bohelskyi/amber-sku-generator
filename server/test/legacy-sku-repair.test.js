const assert = require('node:assert/strict');
const test = require('node:test');
const { parse } = require('../scripts/legacy-sku-repair');
const { normalizeDecisions } = require('../src/services/legacy-sku-repair.service');

test('legacy SKU repair CLI requires explicit preflight and exact stage artifacts', () => {
  assert.deepEqual(parse(['preflight', '--expected-database', 'amber_test', '--actor-user-id', '7',
    '--decisions', 'decisions.json', '--output', 'plan.json']), {
    action: 'preflight', expectedDatabase: 'amber_test', actorUserId: 7,
    decisionsPath: 'decisions.json', output: 'plan.json',
  });
  assert.deepEqual(parse(['stage', '--expected-database', 'amber_test', '--actor-user-id', '7',
    '--plan', 'plan.json', '--expected-hash', 'a'.repeat(64)]), {
    action: 'stage', expectedDatabase: 'amber_test', actorUserId: 7,
    planPath: 'plan.json', planHash: 'a'.repeat(64),
  });
  assert.throws(() => parse(['stage', '--expected-database', 'amber_test', '--actor-user-id', '7',
    '--plan', 'plan.json']), /LEGACY_SKU_REPAIR_ARGUMENTS/);
});

test('legacy SKU repair decisions are explicit, canonical, bounded, and non-overlapping', () => {
  const normalized = normalizeDecisions({ version: 1, groups: [
    { sku: 'ZZ-SPLIT', action: 'split_public_identity', keeperProductId: 4,
      splitProductIds: [9, 7], reason: 'Separate products' },
    { sku: 'ZZ-DUP', action: 'deduplicate', keeperProductId: 1,
      retireProductIds: [3, 2], reason: 'Accidental copies' },
  ] });
  assert.deepEqual(normalized.groups.map((group) => group.sku), ['ZZ-DUP', 'ZZ-SPLIT']);
  assert.deepEqual(normalized.groups[0].targetProductIds, [2, 3]);
  assert.deepEqual(normalized.groups[1].targetProductIds, [7, 9]);
  assert.throws(() => normalizeDecisions({ version: 1, groups: [{ sku: 'zz-bad', action: 'deduplicate',
    keeperProductId: 1, retireProductIds: [2], reason: 'No inference' }] }), /Decision values/);
  assert.throws(() => normalizeDecisions({ version: 1, groups: [
    { sku: 'ZZ-A', action: 'deduplicate', keeperProductId: 1, retireProductIds: [2], reason: 'One' },
    { sku: 'ZZ-B', action: 'split_public_identity', keeperProductId: 3, splitProductIds: [2], reason: 'Two' },
  ] }), /only one decision/);
});
