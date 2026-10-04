const test = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../src/services/magento/sync-job-recovery');
const lifecycle = require('../src/services/magento/lifecycle-recovery');
const { hash } = require('../src/services/magento/binding-contract');
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

test('reviewed continuation is exact to the original job, its immutable plan and every durable step', () => {
  const job = { id, plan_hash: 'original', state: 'uncertain' };
  const steps = [{ ordinal: 0, state: 'verified' }];
  const review = { jobId: id, planHash: 'original', jobFingerprint: jobs.fingerprint(job, steps) };
  assert.doesNotThrow(() => jobs.assertReviewedJob(job, steps, review));
  for (const changed of [{ ...job, state: 'running' }, { ...job, plan_hash: 'new' }, { ...job, id: 'other' }]) {
    assert.throws(() => jobs.assertReviewedJob(changed, steps, review), { code: 'MAGENTO_RECOVERY_REVIEW_STALE' });
  }
  const dispatched = [{ ordinal: 0, state: 'dispatched' }];
  assert.throws(() => jobs.assertReviewedJob(job, dispatched, { ...review, jobFingerprint: jobs.fingerprint(job, dispatched) }),
    { code: 'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED' });
});
test('remote review binds exact identity, field state, category and scoped evidence', () => {
  const observation = { raw: { id: 5, sku: 'AG-1', price: 10 }, domainEvidence: { english: null }, schema: {}, categoryNodes: [] };
  const review = { remoteFingerprint: jobs.remoteFingerprint(observation) };
  assert.doesNotThrow(() => jobs.assertReviewedRemote(observation, review));
  assert.throws(() => jobs.assertReviewedRemote({ ...observation, raw: { ...observation.raw, id: 6 } }, review), { code: 'MAGENTO_RECOVERY_REVIEW_STALE' });
  assert.throws(() => jobs.assertReviewedRemote({ ...observation, categoryNodes: [{ id: 3 }] }, review), { code: 'MAGENTO_RECOVERY_REVIEW_STALE' });
});
test('recovery inputs reject fabricated evidence before any local or remote operation', async () => {
  const options = { databasePool: { query() { assert.fail('no database operation for invalid review'); } } };
  await assert.rejects(jobs.reconcile({}, id, { review: {}, reviewHash: 'a', reason: 'Reviewed' }, options));
  await assert.rejects(jobs.continueJob({}, id, { review: {}, reviewHash: 'a', reason: 'Reviewed' }, options));
  const review = { format: lifecycle.FORMAT, kind: 'prior_exposure', productId: 1, payload: { productId: 2 }, blockers: [] };
  await assert.rejects(lifecycle.apply({}, 1, { review, reviewHash: hash(review), reason: 'Reviewed' }, options));
});
test('lifecycle evidence form requires exact ancestor and file dispositions and preserves distinctions', () => {
  const entry = { productId: 3, status: 'active', correctionId: 1, terminalDescendants: [3],
    lifecycle: { route: 'hold', business_exclusion_state: 'none' },
    ancestorChain: [{ sku: 'OLD-A' }, { sku: 'OLD-B' }], generatedMemberships: [{ sku: 'OLD-A', snapshotId: 'file-a' }],
    confirmedMemberships: [{ sku: 'CURRENT', snapshotId: 'file-b' }],
    exposure: { classification: 'historical_ambiguous', issues: [] }, independentExclusion: { provenance: 'unknown' } };
  assert.deepEqual(lifecycle.requirements(entry, 'replacement'), { oldSkus: ['CURRENT', 'OLD-A', 'OLD-B'], files: ['file-a', 'file-b'],
    externalHistory: true, exclusionResolution: true, exclusionDisposition: 'release', redeliveryEvidence: false });
  assert.deepEqual(lifecycle.actionBlockers(entry, 'replacement'), []);
  assert.ok(lifecycle.actionBlockers(entry, 'unexposed_first_delivery').includes('LIFECYCLE_UNEXPOSED_EVIDENCE_REQUIRED'));
  assert.ok(lifecycle.actionBlockers(entry, 'generated_first_delivery').includes('LIFECYCLE_RETAINED_FILE_EVIDENCE_REQUIRED'));
});
test('continuation review shows only original unsent changes with labels and exact before/after values', () => {
  const { unsentChanges } = require('../src/services/magento/sync-recovery-changes');
  const job = { intent: { operations: [
    { domain: 'coreProduct', payload: { product: { sku: 'AG-1', name: 'Збережено' } } },
    { domain: 'storeViews', payload: { product: { sku: 'AG-1', name: 'New English', custom_attributes: [] } } },
    { domain: 'categoryLinkSave', payload: { productLink: { sku: 'AG-1', category_id: '10', position: 0 } } },
  ] } };
  const steps = [{ ordinal: 0, state: 'verified', matches: true }, { ordinal: 1, state: 'not_sent', matches: false },
    { ordinal: 2, state: 'not_sent', matches: false }];
  const observation = { raw: { extension_attributes: { category_links: [] }, private_field: 'must not leak' },
    schema: { attributes: [] }, categoryNodes: [{ categoryId: '10', path: 'Каталог/Намисто' }],
    domainEvidence: { english: { fields: { name: 'Old English', private_field: 'must not leak' } } } };
  assert.deepEqual(unsentChanges(job, steps, observation), [
    { ordinal: 1, label: 'Назва (англійська)', before: 'Old English', after: 'New English' },
    { ordinal: 2, label: 'Категорія: Каталог/Намисто', before: null, after: 'Каталог/Намисто · позиція 0' },
  ]);
});
