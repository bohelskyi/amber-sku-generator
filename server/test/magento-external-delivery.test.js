const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../scripts/magento-external-delivery');
const service = require('../src/services/magento/external-delivery-acknowledgement');

test('external delivery CLI separates read-only preview from hash-bound apply', () => {
  assert.deepEqual(parse(['preview', '--expected-database', 'amber', '--candidates', 'candidates.json',
    '--output', 'plan.json']), {
    action: 'preview', expectedDatabase: 'amber', candidatesPath: 'candidates.json', output: 'plan.json',
  });
  assert.deepEqual(parse(['apply', '--expected-database', 'amber', '--actor-user-id', '17',
    '--plan', 'plan.json', '--expected-hash', 'a'.repeat(64), '--output', 'receipts']), {
    action: 'apply', expectedDatabase: 'amber', actorUserId: 17, planPath: 'plan.json',
    expectedHash: 'a'.repeat(64), output: 'receipts',
  });
  assert.throws(() => parse(['preview', '--expected-database', 'amber', '--candidates', 'c.json',
    '--actor-user-id', '17', '--output', 'plan.json']), /INVALID_ARGUMENTS/);
  assert.throws(() => parse(['apply', '--expected-database', 'amber', '--actor-user-id', '17',
    '--plan', 'plan.json', '--expected-hash', 'bad', '--output', 'receipts']), /INVALID_ARGUMENTS/);
});

test('external delivery candidate scope is exact, bounded and operator-evidenced', () => {
  const entry = { productId: 1, internalSku: 'BR-1', publicSku: 'AG-000001', magentoProductId: 2,
    resolutionKey: 'change-1/product-1', reason: 'Reviewed historical import', evidence: 'Magento inventory ticket 1' };
  assert.deepEqual(service.validateCandidates({ format: service.CANDIDATE_FORMAT, database: 'amber', entries: [entry] }, 'amber'), [entry]);
  assert.throws(() => service.validateCandidates({ format: service.CANDIDATE_FORMAT, database: 'amber',
    entries: [entry, { ...entry }] }, 'amber'), { code: 'EXTERNAL_DELIVERY_CANDIDATES_INVALID' });
  const distinct = { ...entry, productId: 2, internalSku: 'BR-2', publicSku: 'AG-000002',
    magentoProductId: 3, resolutionKey: 'change-1/product-2' };
  assert.throws(() => service.validateCandidates({ format: service.CANDIDATE_FORMAT, database: 'amber',
    entries: [entry, { ...distinct, internalSku: entry.internalSku }] }, 'amber'),
  { code: 'EXTERNAL_DELIVERY_CANDIDATES_INVALID' });
  assert.throws(() => service.validateCandidates({ format: service.CANDIDATE_FORMAT, database: 'amber',
    entries: [entry, { ...distinct, publicSku: entry.publicSku }] }, 'amber'),
  { code: 'EXTERNAL_DELIVERY_CANDIDATES_INVALID' });
  assert.throws(() => service.validateCandidates({ format: service.CANDIDATE_FORMAT, database: 'other', entries: [entry] }, 'amber'),
    { code: 'EXTERNAL_DELIVERY_CANDIDATES_INVALID' });
});
