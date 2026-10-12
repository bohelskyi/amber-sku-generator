const assert = require('node:assert/strict');
const { fixture: successorFixture } = require('./magento-successor');
const { product } = require('./magento-v1/contract');
const { compileDefinition } = require('../../src/services/export-templates/definition');
const { upgradeColumns } = require('../../src/services/export-templates/column-contract');
const { evaluate } = require('../../src/services/magento/binding-evidence-products');
const { buildCandidates } = require('../../src/services/magento/binding-bootstrap');
const { resolveCategories } = require('../../src/services/magento/sync-preview-categories');

const category = bindings => bindings.attributes.find(attribute => attribute.routeKey === 'NM:all'
  && attribute.rowId === 'base' && attribute.target === 'categories');

// Deterministic repository-generated data, with no production product or binding
// contents. The previously valid source holds 17 category paths in 6087 bytes.
function fixture() {
  const base = successorFixture();
  const compiled = compileDefinition(upgradeColumns(base.next));
  const make = (index, answers = {}) => product('NM', {
    raw_type: index % 2 + 1, processing: index % 2 + 1, texture: index % 8 + 1,
    color: index % 4 + 1, shape: index % 7 + 1, style: index % 4 + 1, extra: index % 3, ...answers,
  }, { id: index + 1, full_sku: 'NM-SYNTH-' + index, public_sku: 'NM-SYNTH-' + index });
  const products = Array.from({ length: 50 }, (_, index) => make(index));
  const amber = { compiled, products, current: [] };
  const mapped = products.map(current => evaluate(amber, current));
  assert.ok(mapped.every(row => row.ready));
  const paths = [...new Set(mapped.flatMap(row => row.base.categories.split(',')))];
  const nodes = paths.map((path, index) => ({ categoryId: String(300 + index), path,
    normalizedPath: path, comparable: true }));
  const build = selected => buildCandidates({ ...amber, products: selected }, base.schema, nodes,
    { includeStaticCategories: true });
  const sourceBindings = build([make(0)]);
  const rows = resolveCategories(paths.join(','), nodes, { known: true, links: [] }).requested.map(row => ({
    requestedPath: row.requestedPath, normalizedPath: row.normalizedPath, categoryId: row.categoryId,
    candidates: row.exactCandidates, reviewState: 'approved',
  }));
  const sourceIndices = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 13, 15, 16, 17, 18, 19];
  const sourceCategory = category(sourceBindings);
  sourceCategory.evidence = { ...sourceCategory.evidence, categories: sourceIndices.map(index => rows[index]), sampleCount: 17 };
  sourceCategory.reviewState = 'approved';
  const selectedProduct = make(0, { style: 2, shape: 7 });
  assert.equal(evaluate(amber, selectedProduct).ready, true);
  const targetBindings = build([selectedProduct]);
  const targetCategory = category(targetBindings);
  const missing = sourceCategory.evidence.categories.filter(old =>
    !targetCategory.evidence.categories.some(current => current.normalizedPath === old.normalizedPath));
  const live = { format: 'amber-magento-binding-reviewed-carry-forward-live-v1', originHash: base.source.originHash,
    storeCode: 'all', categories: missing.map(row => ({ bindingKey: targetCategory.bindingKey,
      requestedPath: row.requestedPath, normalizedPath: row.normalizedPath, categoryId: row.categoryId,
      matches: row.candidates })), dynamicOptions: [] };
  const source = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', state: 'published', revision: '4',
    originHash: base.source.originHash, schema: base.schema, bindings: sourceBindings };
  const target = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', state: 'draft', revision: '1',
    originHash: base.source.originHash, schema: base.schema, bindings: targetBindings };
  return { compiled, definition: compiled.definition, schema: base.schema, amber, products, paths, nodes,
    sourceBindings, targetBindings, source, target, live, selectedProduct,
    newPaths: targetCategory.evidence.categories.filter(current =>
      !sourceCategory.evidence.categories.some(old => old.normalizedPath === current.normalizedPath))
      .map(row => row.normalizedPath) };
}

module.exports = { fixture, category };
