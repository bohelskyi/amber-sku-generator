const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateBatch } = require('../src/services/export-templates/evaluate');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { buildMagentoPayload } = require('../src/services/magento-products-v1');
const { catalog, product } = require('./fixtures/magento-v1/contract');
const { buildCsv, finalizeCsvValue } = require('../src/utils/csv');
const { historyQuery, snapshotMetadata } = require('../src/services/export-history.service');
const { homeDefinition, officeEvidence, schema, stored } = require('./fixtures/export-source-support');
const { upgradeSourceSupport } = require('../src/services/export-templates/source-support');

test('UX3 diagnostic review retains failed-only groups, emitted headers/order and valid blanks without partial artifacts', () => {
  const d = materializeMagentoV1(catalog()); const compiled = compileDefinition(d);
  const products = [product('BR', {}, { id: 10 }), product('SV', { souvenir: 999 }, { id: 11 })];
  const plain = evaluateBatch(compiled, products);
  const reviewed = evaluateBatch(compiled, products, undefined, { review: true });
  const { review, ...authority } = reviewed;
  assert.deepEqual(authority, plain, 'review never changes readiness/artifacts/metrics');
  assert.equal(reviewed.artifacts.length, 0);
  assert.equal(review.files.length, 2);
  const failed = review.files.find((file) => file.groupCode === 'SV');
  assert.deepEqual(failed.headers, d.groups.find((g) => g.route === 'SV').columns);
  assert.equal(failed.rows[0].productPosition, 2); assert.equal(failed.rows[0].ordinal, 3);
  assert.equal(failed.rows[1].language, 'en');
  assert.ok(failed.rows[0].cells.some((c) => c.state === 'not-evaluated' && c.value === null));
  assert.ok(failed.rows[0].cells.some((c) => c.state === 'provisional'));
  assert.ok(review.files[0].rows[1].cells.some((c) => c.state === 'blank' && c.value === ''));
  for (const file of review.files.filter((f) => f.groupCode === 'BR')) {
    assert.equal(buildCsv([file.headers, ...file.rows.map((r) => r.cells.map((c) => c.value))]), reviewed.provisionalArtifacts[0].csvContent);
  }
});

test('UX3 ready values use exactly the serializer finalization including formulas, quotes and sparse EN', () => {
  const d = materializeMagentoV1(catalog());
  d.groups[0].rows[0].cells.meta_title = { op: 'literal', value: '  =SUM(1,2)\n"quoted"' };
  const result = evaluateBatch(compileDefinition(d), [product('BR')], undefined, { review: true });
  const file = result.review.files[0]; const cell = file.rows[0].cells[file.headers.indexOf('meta_title')];
  assert.equal(cell.value, "'  =SUM(1,2)\n\"quoted\""); assert.equal(cell.state, 'final');
  assert.ok(result.artifacts[0].csvContent.includes('"\'  =SUM(1,2)\n""quoted"""'));
  for (const value of ['', null, undefined, '=x', '\t+foo', '-text', '@x', 0, -1, ' x']) {
    const encoded = buildCsv([[value]]); const finalized = finalizeCsvValue(value);
    assert.equal(encoded, /[",\r\n]/.test(finalized) ? '"' + finalized.replaceAll('"', '""') + '"' : finalized);
  }
});

test('UX3 legacy projection does not change mapper artifacts or fingerprint inputs and retains failures', () => {
  const products = [product('BR'), product('SV', { souvenir: 999 }, { id: 2 })];
  const original = buildMagentoPayload(products, catalog());
  const { review, ...reviewed } = buildMagentoPayload(products, catalog(), { review: true });
  assert.deepEqual(reviewed, original);
  assert.equal(review.files[1].rows.length, 2);
  assert.equal(review.files[1].rows[0].readiness, 'attention');
});

test('UX3 observation preserves lazy source support and leaves unvisited cells not evaluated', () => {
  const d = upgradeSourceSupport(homeDefinition(), officeEvidence());
  const p = stored(schema('AR', 3), 29, { id: 14 });
  const compiled = compileDefinition(d);
  const normal = evaluateBatch(compiled, [p]);
  const { review, ...observed } = evaluateBatch(compiled, [p], undefined, { review: true });
  assert.deepEqual(observed, normal);
  assert.ok(review.files[0].rows.every((r) => r.cells.every((cell) => cell.state === 'not-evaluated')));
  const issue = review.files[0].rows[0].issues[0];
  assert.equal(issue.target.kind, 'columns');
  assert.ok(issue.target.columns.length > 0, 'output checks carry their declared column ownership');
  const sourceOnly = structuredClone(d);
  const profile = sourceOnly.groups.find((g) => g.route === p.category);
  profile.evaluate.unshift(...profile.outputChecks.map((entry) => entry.rule));
  const sourceReview = evaluateBatch(compileDefinition(sourceOnly), [p], undefined, { review: true }).review;
  assert.equal(sourceReview.files[0].rows[0].issues[0].target.kind, 'source', 'no cell is guessed outside declared output ownership');
  assert.throws(() => evaluateBatch(compiled, [product('BR')], { work: 1 }, { review: true }), (e) => e.code === 'EVALUATION_LIMIT');
});

test('UX3 history bounds and nullable historical metadata never invent ownership, profile or template', () => {
  assert.equal(historyQuery().limit, 20);
  assert.equal(historyQuery({ limit: '50', scope: 'mine', stream: 'price' }).limit, 50);
  for (const input of [{ limit: 51 }, { limit: 0 }, { stream: 'session' }, { scope: 'admin' }, { after: 'bad' }]) assert.throws(() => historyQuery(input), { statusCode: 422 });
  const metadata = snapshotMetadata({ id: 'old', row_count: 1, created_by_user_id: null, from_sku: 'A', resolved_to_sku: 'A' }, 'product');
  assert.equal(metadata.createdByUserId, null); assert.equal(metadata.recipe.kind, 'historical');
  assert.equal(metadata.sessionId, undefined); assert.equal(metadata.template, undefined);
  const price = snapshotMetadata({ id: 'price', row_count: 1, file_name: 'price.csv', captured_revisions: [{ productId: 1, revision: 100 }] }, 'price');
  assert.equal(price.captured_revisions, undefined); assert.equal(price.artifacts[0].profileVersion, 'sku,price');
});
