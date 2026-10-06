import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { nativeDeferredReview, promoteNativeDeferredValue } from '../src/lib/native-source-value-review.js';
import { availableSources } from '../src/lib/export-template-columns.js';
import { addIntegrationCategory } from '../src/lib/integration-template.js';
const require = createRequire(import.meta.url);
const { compileDefinition } = require('../../server/src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { upgradeColumns } = require('../../server/src/services/export-templates/column-contract');
const { upgradeSourceSupport } = require('../../server/src/services/export-templates/source-support');
const { officeCatalog, officeEvidence } = require('../../server/test/fixtures/magento-v1/office');
const definition = () => ({ ...upgradeSourceSupport(upgradeColumns(materializeMagentoV1(officeCatalog(), { publicSku: true })), officeEvidence()), evaluatorVersion: 'magento-declarative-5', sourceContractVersion: 'public-product-characteristics-v1' });
const evidence = () => ({ current: [{ archived: false, input_type: 'options', options: [29, 30, 31].map((id) => ({ value_id: id, archived: false, label: `${id} · точний розмір` })) }], historical: [], truncated: false });
const acknowledgements = { exactSemanticValue: true, allUsesReviewed: true };

test('explicit native deferred review changes only selected semantic ID and all outputs, leaving the original frozen', () => {
  const d = definition(); const before = JSON.stringify(d); const review = nativeDeferredReview(d, 'AR.size', evidence());
  const outputs = Object.fromEntries(review.tableIds.map((id) => [id, 'Окремо перевірений текст']));
  const next = promoteNativeDeferredValue(d, 'AR.size', '29', evidence(), outputs, acknowledgements);
  compileDefinition(next);
  assert.equal(JSON.stringify(d), before);
  assert.deepEqual(next.sourceSupport.sources['AR.size'].deferredValues, ['30', '31']);
  assert.ok(next.sourceSupport.sources['AR.size'].semanticValues.includes('29'));
  assert.deepEqual(next.groups, d.groups); assert.deepEqual(next.questionContracts, d.questionContracts);
  for (const id of review.tableIds) assert.equal(next.tables[id]['29'], outputs[id]);
});
test('native promotion fails closed for missing/ambiguous/archived evidence, stale membership, incomplete outputs and acknowledgements', () => {
  const d = definition(); const review = nativeDeferredReview(d, 'AR.size', evidence());
  const outputs = Object.fromEntries(review.tableIds.map((id) => [id, 'Reviewed']));
  for (const e of [null, { ...evidence(), truncated: true }, { current: [] }, { current: [evidence().current[0], evidence().current[0]] },
    { current: [{ ...evidence().current[0], archived: true }] }, { current: [{ ...evidence().current[0], options: [evidence().current[0].options[0], evidence().current[0].options[0]] }] }]) {
    assert.throws(() => promoteNativeDeferredValue(d, 'AR.size', '29', e, outputs, acknowledgements));
  }
  for (const bad of [{}, { ...outputs, unreviewed: 'x' }, Object.fromEntries(review.tableIds.map((id) => [id, ' x '])), Object.fromEntries(review.tableIds.map((id) => [id, 'x\ny']))]) {
    assert.throws(() => promoteNativeDeferredValue(d, 'AR.size', '29', evidence(), bad, acknowledgements));
  }
  assert.throws(() => promoteNativeDeferredValue(d, 'AR.size', '29', evidence(), outputs, { exactSemanticValue: true }));
  const stale = structuredClone(d); stale.questionContracts['AR.size'].allowed = ['28'];
  assert.throws(() => promoteNativeDeferredValue(stale, 'AR.size', '29', evidence(), outputs, acknowledgements));
  assert.equal(nativeDeferredReview({ ...d, evaluatorVersion: 'magento-declarative-4' }, 'AR.size', evidence()), null);
});
test('duplicate descriptors share global source support and require every mapping table to be reviewed', () => {
  const d = definition(); d.sources.secondSize = structuredClone(d.sources['AR.size']);
  d.questionContracts.secondSize = { ...d.questionContracts['AR.size'], source: 'secondSize' };
  d.tables.secondSize = { 29: 'Different EN' };
  d.groups.find((g) => g.route === 'AR').rows[1].cells.rozmir_kartyny = { op: 'lookup', input: { op: 'semanticKey', input: { op: 'source', id: 'secondSize' } }, table: 'secondSize', otherwise: { op: 'literal', value: '' } };
  const review = nativeDeferredReview(d, 'AR.size', evidence()); assert.ok(review.tableIds.includes('secondSize'));
  const incomplete = Object.fromEntries(review.tableIds.filter((id) => id !== 'secondSize').map((id) => [id, 'Reviewed']));
  assert.throws(() => promoteNativeDeferredValue(d, 'AR.size', '29', evidence(), incomplete, acknowledgements));
});
test('only explicit v5 authoring exposes active current SKU-labelled characteristics before product creation', () => {
  const registry = { nativeCharacteristicsAuthoring: true, references: { questions: [{ category_code: 'XX', key: 'fresh', input_type: 'options', include_in_sku: 1, archived: false }], schemas: [] } };
  assert.ok(availableSources(registry, 'XX', definition()).some((s) => s.id === 'XX.fresh' && s.descriptor.kind === 'semantic'));
  assert.ok(!availableSources(registry, 'XX', { ...definition(), evaluatorVersion: 'magento-declarative-4' }).some((s) => s.id === 'XX.fresh'));
});
test('new guided category preserves reviewed evaluator5 and the original frozen groups', () => {
  const d = definition();
  const next = addIntegrationCategory(d, { code: 'XX', label: 'Нова категорія', nameUa: 'Тест', nameEn: 'Test', attributeSet: 'Explicit set', categoryPath: 'Default/Test' });
  compileDefinition(next);
  assert.equal(next.evaluatorVersion, 'magento-declarative-5');
  assert.equal(next.sourceContractVersion, d.sourceContractVersion);
  assert.deepEqual(next.groups.slice(0, d.groups.length), d.groups);
  assert.equal(next.groups.at(-1).rows[0].cells.product_online.value, '2');
  assert.ok(!d.groups.some((g) => g.route === 'XX'));
});
