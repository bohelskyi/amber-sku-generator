// Child-process-only adapter: unchanged PR1A assertions receive NEW evaluator results.
// Each call also compares against the real mapper on the exact same catalog/input.
const assert = require('node:assert/strict');
const legacy = require('../../../src/services/magento-products-v1');
const { compileDefinition } = require('../../../src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../../../src/services/export-templates/magento-v1-definition');
const { evaluateProduct, evaluateBatch, legacyPreview } = require('../../../src/services/export-templates/evaluate');
const { classify, assertOld } = require('./differences');
const originalMap = legacy.mapProduct;
const originalBatch = legacy.buildMagentoPayload;
const cache = new Map();
const stats = { maps: {}, batches: {}, differences: {} };
function compile(catalog = new Map()) {
  const key = JSON.stringify([...catalog].map(([group, questions]) => [group, [...questions]]));
  if (!cache.has(key)) cache.set(key, compileDefinition(materializeMagentoV1(catalog)));
  return cache.get(key);
}
function difference(entry, input, catalog) {
  assertOld(entry, originalMap(input, catalog));
  assert.throws(() => evaluateProduct(compile(catalog), input), { code: entry.code });
  stats.differences[entry.id] = (stats.differences[entry.id] || 0) + 1;
}
legacy.mapProduct = (input, catalog = new Map()) => {
  const old = originalMap(input, catalog);
  const entry = classify(input, catalog);
  if (entry) {
    difference(entry, input, catalog);
    // These enumerated calls are explicitly NON-parity, tested for rejection above.
    return old;
  }
  const before = structuredClone(input);
  const actual = evaluateProduct(compile(catalog), input);
  assert.deepEqual(actual, old, `Differential product ${input.category}`);
  assert.deepEqual(input, before);
  stats.maps[input.category] = (stats.maps[input.category] || 0) + 1;
  return actual;
};
legacy.buildMagentoPayload = (inputs, catalog = new Map()) => {
  const old = originalBatch(inputs, catalog);
  const entries = inputs.map((p) => classify(p, catalog));
  if (entries.some(Boolean)) {
    assert.equal(inputs.length, 1, 'No broad mixed-batch difference exemption');
    difference(entries[0], inputs[0], catalog);
    assert.throws(() => evaluateBatch(compile(catalog), inputs), { code: entries[0].code });
    return old;
  }
  const actual = legacyPreview(evaluateBatch(compile(catalog), inputs));
  assert.deepEqual(actual, old, 'Differential complete preview');
  actual.artifacts.forEach((a, i) => assert.deepEqual(Buffer.from(a.csvContent, 'utf8'), Buffer.from(old.artifacts[i].csvContent, 'utf8')));
  for (const p of inputs) stats.batches[p.category] = (stats.batches[p.category] || 0) + 1;
  return actual;
};
process.on('exit', () => console.log(`PR1B_REPLAY ${JSON.stringify(stats)}`));
