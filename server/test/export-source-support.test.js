const test = require('node:test');
const assert = require('node:assert/strict');
const { officeCatalog, officeEvidence } = require('./fixtures/magento-v1/office');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { validateSourceReferences } = require('../src/services/export-templates/source-references');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct, evaluateBatch } = require('../src/services/export-templates/evaluate');
const { upgradeSourceSupport, projectSupportProducts } = require('../src/services/export-templates/source-support');
const { schema, stored, homeDefinition } = require('./fixtures/export-source-support');
const { product } = require('./fixtures/magento-v1/contract');
const corrected = () => upgradeSourceSupport(homeDefinition(), officeEvidence());
const run = (d, p, schemas) => evaluateProduct(compileDefinition(d), projectSupportProducts([p], schemas)[0]);
const invalid = (result) => assert.ok(result.errors.some((e) => e.code === 'SOURCE_SUPPORT_INVALID'), JSON.stringify(result.errors));

test('SUPPORT opt-in removes only the evidenced NM placeholder / explicitly deferred AR false claims', () => {
  const before = materializeMagentoV1(officeCatalog());
  const evidence = officeEvidence();
  assert.deepEqual(validateSourceReferences(before, evidence).map((d) => d.unresolvedValueIds), [['0'], ['29', '30', '31']]);
  const support = require('../src/services/export-templates/source-support');
  const after = support.upgradeSourceSupport(before, evidence);
  assert.deepEqual(validateSourceReferences(after, evidence), []);
  assert.deepEqual(after.tables, before.tables);
  assert.deepEqual(after.groups, before.groups);
  assert.deepEqual(after.questionContracts, before.questionContracts);
});

test('SUPPORT numeric NM placeholders reconstruct under each own historical version; raw data stays unchanged', () => {
  const d = corrected();
  for (const version of [1, 2, 3, 4]) {
    const s = schema('NM', version);
    for (const value of [0, 1, 2]) {
      const p = stored(s, value); const before = structuredClone(p);
      const result = run(d, p, [s]);
      assert.deepEqual(result.errors, []);
      assert.equal(result.base.dodatkovo_namysta, d.tables.nmExtra[value]);
      assert.deepEqual(p, before);
    }
  }
});

test('SUPPORT NM rejects foreign/missing/mismatched schemas, reconstruction, required and encoded-zero conflicts', () => {
  const d = corrected(); const s = schema('NM'); const p = stored(s, 0);
  for (const schemas of [[], [{ ...s, id: s.id + 1 }], [{ ...s, category_code: 'AR' }], [{ ...s, version: 2 }]]) invalid(run(d, p, schemas));
  invalid(run(d, { ...p, sku_schema_version_id: null }, [s]));
  invalid(run(d, { ...p, full_sku: 'NM999999' }, [s]));
  const required = structuredClone(s); required.questions[0].required = 1;
  invalid(run(d, p, [required]));
  for (const code of ['0', '00']) {
    const conflicting = structuredClone(s); conflicting.questions[0].options.push({ value_id: 7, sku_code: code });
    invalid(run(d, p, [conflicting]));
  }
  invalid(evaluateProduct(compileDefinition(d), { ...p, sourceSupport: { proven: true }, schema: s }));
  const another = stored(s, 1);
  projectSupportProducts([another], [s]);
  invalid(evaluateProduct(compileDefinition(d), p));
});

test('SUPPORT exact string zero is rejected as placeholder; absent/null/blank remain absent and genuine zero is semantic', () => {
  const d = corrected(); const s = schema('NM');
  for (const v of ['0', false, '00']) invalid(run(d, stored(s, v), [s]));
  for (const v of [undefined, null, '', '  ']) assert.equal(run(d, stored(s, v), []).base.dodatkovo_namysta, '');
  for (const v of [[], {}]) assert.throws(() => run(d, stored(s, v), [s]), { code: 'INPUT_INVALID' });
  s.questions[0].options.push({ value_id: 0, sku_code: '8' });
  for (const v of [0, '0']) invalid(run(d, stored(s, v), [s]));
  d.sourceSupport.sources['NM.extra'].semanticValues.push('0');
  s.questions[0].required = 1;
  for (const v of [0, '0']) assert.deepEqual(run(d, stored(s, v), [s]).errors, [], 'genuine zero uses evidenced semantic path even when required');
});

test('SUPPORT AR own schema controls 28; frozen deferred values survive mappings and future publication', () => {
  const d = corrected();
  Object.assign(d.tables.arSize, { 29: '75×78', 30: '74×80', 31: '70×70' });
  for (const [version, values] of [[1, [1, 27]], [2, [1, 28]]]) {
    const s = schema('AR', version);
    for (const value of values) assert.deepEqual(run(d, stored(s, value), [s]).errors, []);
  }
  const v1 = schema('AR');
  invalid(run(d, stored(v1, 28), [v1, schema('AR', 2)]));
  const future = schema('AR', 3);
  for (const value of [29, 30, 31]) {
    invalid(run(d, stored(future, value), [future]));
    const explicit = structuredClone(d);
    explicit.sourceSupport.sources['AR.size'].deferredValues = explicit.sourceSupport.sources['AR.size'].deferredValues.filter((v) => v !== String(value));
    explicit.sourceSupport.sources['AR.size'].semanticValues.push(String(value));
    assert.deepEqual(run(explicit, stored(future, value), [future]).errors, []);
    invalid(run(explicit, stored(v1, value), [v1, future]));
  }
  const evidence = officeEvidence();
  evidence.schemas.push({ ...future, questions: [{ key: 'size', value_ids: future.questions[0].options.map((o) => String(o.value_id)) }] });
  assert.deepEqual(upgradeSourceSupport(d, evidence), d, 'no automatic promotion');
  const inconsistent = stored(future, 28); inconsistent.details.answers.size = 29;
  invalid(run(d, inconsistent, [future]));
});

test('SUPPORT direct custom cells, duplicate descriptors, shared refs and readiness reads cannot bypass support; lazy branches stay lazy', () => {
  for (const mode of ['direct', 'ref', 'readiness', 'condition', 'renamed']) {
    const d = corrected(); const g = d.groups.find((g) => g.route === 'AR');
    const sourceId = mode === 'renamed' ? 'local_size' : 'AR.size';
    if (mode === 'renamed') { d.sources.local_size = structuredClone(d.sources['AR.size']); d.questionContracts.local_size = { ...d.questionContracts['AR.size'], source: 'local_size' }; }
    const read = { op: 'text', input: { op: 'source', id: sourceId }, trim: false, format: 'scalar-v1', onAbsent: 'empty' };
    g.evaluate = []; g.outputChecks = [];
    // Remove standard wrappers so only the new dependency can enforce support.
    g.rows[0].cells = { sku: { op: 'ref', id: 'sku' }, store_view_code: { op: 'literal', value: '' }, name: { op: 'literal', value: 'Synthetic' }, attribute_set_code: { op: 'literal', value: 'AR' }, product_type: { op: 'literal', value: 'simple' }, price: { op: 'literal', value: '12' } };
    g.rows[1].cells = { ...g.rows[0].cells, store_view_code: { op: 'literal', value: 'en' } };
    g.columns.push('custom_support');
    if (mode === 'ref') { d.bindings.push({ id: 'sharedSize', group: 'AR', value: read }); g.rows[0].cells.custom_support = { op: 'ref', id: 'sharedSize' }; }
    else if (mode === 'readiness') g.outputChecks.push({ columns: ['custom_support'], rule: { op: 'present', policy: 'answer-v1', input: read } });
    else if (mode === 'condition') g.rows[0].cells.custom_support = { op: 'when', if: { op: 'present', policy: 'answer-v1', input: read }, then: { op: 'literal', value: 'yes' }, else: { op: 'literal', value: '' } };
    else g.rows[0].cells.custom_support = read;
    const s = schema('AR', 3);
    invalid(run(d, stored(s, 29), [s]));
    g.rows[0].cells.custom_support = { op: 'when', if: { op: 'literal', value: false }, then: read, else: { op: 'literal', value: '' } };
    g.outputChecks = [];
    assert.deepEqual(run(d, stored(s, 29), []).errors, []);
  }
});

test('SUPPORT closed declarations/hash identity, unchanged 28-column HOME CSV, unrelated zero behavior and legacy hashes', () => {
  const original = homeDefinition(); const legacyHash = compileDefinition(original).hash;
  const d = upgradeSourceSupport(original, officeEvidence());
  const compiled = compileDefinition(d);
  assert.equal(compileDefinition(JSON.parse(JSON.stringify(d))).hash, compiled.hash);
  assert.notEqual(compiled.hash, legacyHash);
  assert.equal(compileDefinition(original).hash, legacyHash);
  for (const mutate of [
    (x) => delete x.sourceSupport,
    (x) => x.sourceSupport = null,
    (x) => x.sourceSupport.version = 'future',
    (x) => x.evaluatorVersion = 'magento-declarative-1',
    (x) => delete x.sourceSupport.sources['AR.size'],
    (x) => x.sourceSupport.sources['AR.size'].semanticValues.push('29'),
    (x) => x.sourceSupport.sources['NM.extra'].placeholder = 'all-zero',
    (x) => x.sourceSupport.sources['AR.size'].proof = true,
    (x) => x.sources['AR.size'].kind = 'information',
  ]) { const bad = structuredClone(d); mutate(bad); assert.throws(() => compileDefinition(bad), { code: 'TEMPLATE_INVALID' }); }
  const br = product('BR', { color: 4 });
  const csv = evaluateBatch(compileDefinition(original), [br]).artifacts[0].csvContent;
  assert.equal(original.groups[0].columns.length, 28);
  assert.match(csv, /^sku,store_view_code,name,test_export_note,test_export_color,price,/);
  assert.match(csv, /ПЕРЕВІРКА,Комбінований,1234.56/);
  assert.equal(evaluateBatch(compiled, [br]).artifacts[0].csvContent, csv);
  for (const p of [product('CH', { count: 0 }), product('SV', { souvenir: 5, stone_processing: 0 }), ...[0, 1, 2].map((is_calibrated) => product('BR', { is_calibrated }))]) {
    assert.deepEqual(evaluateProduct(compiled, p), evaluateProduct(compileDefinition(original), p));
  }
  d.tables.arSize['29'] = ' 75×78\n ';
  assert.equal(upgradeSourceSupport(d, officeEvidence()).tables.arSize['29'], ' 75×78\n ');
  const invalidProduct = stored(schema('AR', 3), 29);
  const batch = evaluateBatch(compileDefinition(d), projectSupportProducts([br, invalidProduct], [schema('AR', 3)]));
  assert.equal(batch.status, 'not-ready'); assert.deepEqual(batch.artifacts, []); assert.equal(batch.representedCount, 2);
});

test('SUPPORT fixed v1 opts in independently; other unresolved claims block; hidden placeholder reads retain laziness', () => {
  const old = materializeMagentoV1(officeCatalog());
  const d = upgradeSourceSupport(old, officeEvidence());
  assert.equal(d.outputContract, old.outputContract);
  const s = schema('NM');
  assert.deepEqual(run(d, stored(s, 0), [s]).errors, []);
  const unknown = structuredClone(d); unknown.questionContracts['NM.extra'].allowed.push('9');
  unknown.sourceSupport.sources['NM.extra'].semanticValues.push('9');
  compileDefinition(unknown);
  assert.ok(validateSourceReferences(unknown, officeEvidence()).some((e) => e.unresolvedValueIds.includes('9')));
  const hidden = structuredClone(d);
  hidden.questionContracts['NM.extra'].rule = { 'NM.raw_type': 2 };
  invalid(run(hidden, stored(s, 0), []), 'independent category condition still consumes extra');
  hidden.bindings.find((b) => b.id === 'NM.categories').value = { op: 'literal', value: '' };
  assert.deepEqual(run(hidden, stored(s, 0), []).errors, []);
  const evidence = officeEvidence(); evidence.schemas = evidence.schemas.filter((x) => x.category_code !== 'NM');
  assert.ok(validateSourceReferences(d, evidence).some((e) => e.sourceId === 'NM.extra'));
  const projection = projectSupportProducts([stored(s, 1)], [s])[0];
  assert.deepEqual(evaluateProduct(compileDefinition(d), projection).errors, []);
  projection.details.answers.extra = 2;
  invalid(evaluateProduct(compileDefinition(d), projection));
});
