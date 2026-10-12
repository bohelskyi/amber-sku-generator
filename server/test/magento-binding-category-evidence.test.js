const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, category } = require('./fixtures/magento-category-evidence');
const { normalizeBindings, MAX_CATEGORY_EVIDENCE_BYTES, MAX_EVIDENCE_BYTES } = require('../src/services/magento/binding-validation');
const { carryReviewedBindings } = require('../src/services/magento/binding-carry-forward');
const { buildCandidates } = require('../src/services/magento/binding-bootstrap');
const { evaluate } = require('../src/services/magento/binding-evidence-products');
const { resolveCategories } = require('../src/services/magento/sync-preview-categories');
const { review } = require('../src/services/magento/binding-review');
const { hash } = require('../src/services/magento/binding-contract');

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const clone = value => structuredClone(value);
let cached;
const setup = () => {
  const value = clone(cached ||= fixture());
  // Evaluator admission belongs to the actual compiled object, not its clone.
  value.compiled = cached.compiled;
  value.amber.compiled = cached.compiled;
  value.definition = cached.definition;
  return value;
};
const invalid = action => assert.throws(action, { code: 'MAGENTO_BINDING_INVALID' });
const pathRow = index => {
  const path = 'Default/Bounded category ' + index, categoryId = String(1000 + index);
  return { requestedPath: path, normalizedPath: path, categoryId,
    candidates: [{ categoryId, path }], reviewState: 'proposed', note: '' };
};

function categoryEvidence(size) {
  const evidence = { categories: Array.from({ length: 100 }, (_, index) => pathRow(index)) };
  let remaining = size - bytes(evidence);
  assert.ok(remaining >= 0);
  for (const row of evidence.categories) {
    const padding = Math.min(2000, remaining);
    row.note = 'Ж'.repeat(Math.floor(padding / 2)) + (padding % 2 ? 'x' : '');
    remaining -= padding;
  }
  assert.equal(remaining, 0);
  assert.equal(bytes(evidence), size);
  return evidence;
}

function ordinaryEvidence(size) {
  const evidence = { diagnosticCodes: Array.from({ length: 80 }, () => 'D'.repeat(70)), note: '' };
  evidence.note = 'x'.repeat(size - bytes(evidence));
  assert.ok(evidence.note.length <= 2000);
  assert.equal(bytes(evidence), size);
  return evidence;
}

test('carry preserves the full 6087-byte source plus two new category paths beyond the old cap', () => {
  const f = setup(), sourceHash = hash(f.source), targetHash = hash(f.target);
  assert.equal(f.definition.outputContract, 'magento-products-columns-v2');
  assert.equal(category(f.source.bindings).evidence.categories.length, 17);
  assert.equal(bytes(category(f.source.bindings).evidence), 6087);
  assert.doesNotThrow(() => normalizeBindings(f.source.bindings));
  assert.doesNotThrow(() => normalizeBindings(f.target.bindings));
  const result = carryReviewedBindings(f.source, f.target, f.definition, f.live);
  assert.deepEqual(result.blockers, []);
  const evidence = category(result.bindings).evidence;
  assert.equal(evidence.categories.length, 19);
  assert.equal(bytes(evidence), 6798);
  assert.ok(bytes(evidence) > MAX_EVIDENCE_BYTES);
  const expectedPaths = new Set([...category(f.source.bindings).evidence.categories,
    ...category(f.target.bindings).evidence.categories].map(row => row.normalizedPath));
  assert.deepEqual(new Set(evidence.categories.map(row => row.normalizedPath)), expectedPaths);
  for (const old of category(f.source.bindings).evidence.categories) {
    assert.deepEqual(evidence.categories.find(row => row.normalizedPath === old.normalizedPath), old);
  }
  assert.equal(f.newPaths.length, 2);
  for (const path of f.newPaths) {
    const actual = evidence.categories.find(row => row.normalizedPath === path);
    const fresh = category(f.target.bindings).evidence.categories.find(row => row.normalizedPath === path);
    assert.deepEqual(actual, fresh);
    assert.equal(actual.reviewState, 'proposed');
  }
  const reviewed = review({ schema: f.schema, bindings: result.bindings }).filter(row => row.kind === 'category'
    && row.routeKey === 'NM:all' && row.row === 'base');
  assert.equal(reviewed.filter(row => row.reviewState === 'approved').length, 17);
  assert.equal(reviewed.filter(row => row.reviewState === 'proposed').length, 2);
  const output = evaluate(f.amber, f.selectedProduct).base.categories;
  const resolved = resolveCategories(output, f.nodes, { known: true, links: [] }, { decisions: evidence.categories });
  assert.ok(resolved.requested.filter(row => f.newPaths.includes(row.normalizedPath))
    .every(row => row.authority === 'candidate_only'));
  assert.ok(resolved.requested.filter(row => !f.newPaths.includes(row.normalizedPath))
    .every(row => row.authority === 'authoritative'));
  assert.equal(hash(f.source), sourceHash);
  assert.equal(hash(f.target), targetHash);
});

test('all 50 selected synthetic products retain all 24 fresh category paths without truncation or approval', () => {
  const f = setup();
  const bindings = buildCandidates(f.amber, f.schema, f.nodes, { includeStaticCategories: true });
  const evidence = category(bindings).evidence;
  assert.equal(f.amber.products.length, 50);
  assert.equal(evidence.sampleCount, 50);
  assert.equal(evidence.categories.length, 24);
  assert.equal(bytes(evidence), 8780);
  assert.deepEqual(evidence.categories.map(row => row.normalizedPath), f.paths);
  assert.ok(evidence.categories.every(row => row.reviewState === 'proposed'));
  assert.deepEqual(category(normalizeBindings(bindings)).evidence, evidence);
});

test('category transport evidence accepts exactly 64 KiB UTF-8 and rejects one byte more', () => {
  assert.equal(MAX_CATEGORY_EVIDENCE_BYTES, 64 * 1024);
  assert.equal(MAX_EVIDENCE_BYTES, 6500);
  const f = setup(), evidence = categoryEvidence(MAX_CATEGORY_EVIDENCE_BYTES);
  category(f.target.bindings).evidence = evidence;
  assert.deepEqual(category(normalizeBindings(f.target.bindings)).evidence, evidence);
  const before = hash(f.target.bindings);
  category(f.target.bindings).evidence = categoryEvidence(MAX_CATEGORY_EVIDENCE_BYTES + 1);
  const oversized = hash(f.target.bindings);
  invalid(() => normalizeBindings(f.target.bindings));
  assert.equal(hash(f.target.bindings), oversized, 'Rejection must not truncate caller evidence');
  assert.notEqual(oversized, before);
});

test('larger category evidence retains existing path count, candidate count and path length guards', async t => {
  const cases = {
    '101 paths': () => ({ categories: Array.from({ length: 101 }, (_, index) => pathRow(index)) }),
    '101 candidate IDs': () => {
      const row = pathRow(0); row.categoryId = null; row.reviewState = 'review_required';
      row.candidates = Array.from({ length: 101 }, (_, index) => ({ categoryId: String(index + 2000), path: row.requestedPath }));
      return { categories: [row] };
    },
    'path longer than 4096 characters': () => {
      const row = pathRow(0), path = 'Default/' + 'x'.repeat(4090);
      row.requestedPath = path; row.normalizedPath = path; row.candidates[0].path = path;
      return { categories: [row] };
    },
    'duplicate path identities': () => ({ categories: [pathRow(0), pathRow(0)] }),
  };
  for (const [name, make] of Object.entries(cases)) await t.test(name, () => {
    const f = setup(); category(f.target.bindings).evidence = make();
    assert.ok(bytes(category(f.target.bindings).evidence) < MAX_CATEGORY_EVIDENCE_BYTES);
    invalid(() => normalizeBindings(f.target.bindings));
  });
});

test('route, scalar attribute, option and policy evidence keep the unchanged 6500-byte cap', async t => {
  const selections = {
    route: bindings => bindings.routes[0],
    'scalar attribute': bindings => bindings.attributes.find(row => row.strategy === 'scalar'),
    option: bindings => bindings.options[0],
    policy: bindings => bindings.policies[0],
  };
  for (const [name, select] of Object.entries(selections)) await t.test(name, () => {
    const f = setup(), row = select(f.target.bindings); assert.ok(row);
    row.evidence = ordinaryEvidence(MAX_EVIDENCE_BYTES);
    assert.doesNotThrow(() => normalizeBindings(f.target.bindings));
    row.evidence = ordinaryEvidence(MAX_EVIDENCE_BYTES + 1);
    invalid(() => normalizeBindings(f.target.bindings));
  });
});

test('category evidence cannot grant the larger cap to another binding context', async t => {
  for (const kind of ['route', 'scalar attribute', 'option', 'policy']) await t.test(kind, () => {
    const f = setup(), bindings = f.target.bindings;
    const row = kind === 'route' ? bindings.routes[0] : kind === 'option' ? bindings.options[0]
      : kind === 'policy' ? bindings.policies[0] : bindings.attributes.find(value => value.strategy === 'scalar');
    row.evidence = categoryEvidence(MAX_CATEGORY_EVIDENCE_BYTES);
    invalid(() => normalizeBindings(bindings));
  });
});
