const test = require('node:test');
const assert = require('node:assert/strict');
const { officeCatalog, officeEvidence } = require('./fixtures/magento-v1/office');
const { product } = require('./fixtures/magento-v1/contract');
const { compileDefinition, getCompiledSourceDependencies } = require('../src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { validateSourceReferences } = require('../src/services/export-templates/source-references');
const { validateDraftSampleSources } = require('../src/services/export-templates/draft-source-scope');
const literal = (value) => ({ op: 'literal', value });
const text = (id) => ({ op: 'text', input: { op: 'source', id }, trim: true, format: 'scalar-v1', onAbsent: 'empty' });
const definition = () => materializeMagentoV1(officeCatalog());
const sample = (d, groups = ['BR'], e = officeEvidence()) => validateDraftSampleSources(compileDefinition(d), e, groups.map((category) => product(category)));

test('draft sample BR partitions exact global blockers; NM, AR and mixed sets block without mutating definitions/evidence', () => {
  const d = definition(); const e = officeEvidence(); const before = structuredClone({ d, e });
  const result = sample(d, ['BR'], e);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.globalSourceDiagnostics, validateSourceReferences(compileDefinition(d).definition, e));
  assert.deepEqual(result.globalSourceDiagnostics.map((v) => v.unresolvedValueIds), [['29', '30', '31'], ['0']]);
  for (const groups of [['NM'], ['AR'], ['BR', 'AR'], ['BR', 'NM']]) assert.ok(sample(d, groups).diagnostics.length);
  assert.deepEqual({ d, e }, before);
});

test('compiler dependency closure follows transitive refs, every fallback/condition, EN and readiness regardless of ID prefix', () => {
  for (const location of ['base', 'english', 'readiness', 'condition', 'fallback']) {
    const d = definition(); const id = 'NM.sharedUnknown';
    d.sources[id] = { kind: 'information', category: 'BR', key: 'unknown', type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] };
    d.bindings.push({ id: 'AR.inner', group: 'BR', value: text(id) }, { id: 'AR.outer', group: 'BR', value: { op: 'ref', id: 'AR.inner' } });
    const ref = { op: 'ref', id: 'AR.outer' }; const group = d.groups.find((g) => g.route === 'BR');
    if (location === 'readiness') group.evaluate.push(ref);
    else if (location === 'condition') group.rows[0].cells.meta_title = { op: 'when', if: { op: 'present', input: ref, policy: 'answer-v1' }, then: literal('x'), else: literal('y') };
    else if (location === 'fallback') group.rows[0].cells.meta_title = { op: 'lookup', input: literal('1'), table: 'color4', otherwise: ref };
    else group.rows[location === 'english' ? 1 : 0].cells.meta_title = { op: 'when', if: literal(false), then: ref, else: literal('never evaluated') };
    assert.ok(sample(d).diagnostics.some((v) => v.sourceId === id), location);
    assert.ok(getCompiledSourceDependencies(compileDefinition(d), ['BR']).includes(id));
  }
});

test('compiler closure includes nested captured visibility sources and aliases without trusting caller provenance', () => {
  const d = definition(); const id = 'AR.visibility';
  d.sources[id] = { kind: 'semantic', category: 'BR', key: 'unknown_visibility', type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] };
  d.questionContracts['BR.color'].rule = { $or: [{ 'BR.raw_type': 1 }, { [id]: 0 }] };
  assert.ok(sample(d).diagnostics.some((v) => v.sourceId === id));
  delete d.questionContracts['BR.color'].rule.$or;
  d.sources['BR.color'].aliases = [{ key: 'unknown_alias', schemaId: '999', evidence: 'unverified claim' }];
  assert.ok(sample(d).diagnostics.some((v) => v.requirement === 'alias_ownership'));
});

test('unselected malformed structures, actual cross-category references, unknown groups and uncompiled values fail closed', () => {
  for (const mutate of [
    (d) => { d.groups[4].rows[0].cells.name = { op: 'execute' }; },
    (d) => { d.groups[4].rows[0].cells.name = { op: 'ref', id: 'missing' }; },
    (d) => { d.groups[4].rows[0].cells.name = literal(1); },
    (d) => { d.groups[0].rows[0].cells.name = text('NM.extra'); },
    (d) => { d.formatVersion = 99; },
    (d) => { d.sources['AR.size'].key = '__proto__'; },
  ]) { const d = definition(); mutate(d); assert.throws(() => sample(d), { code: 'TEMPLATE_INVALID' }); }
  assert.throws(() => sample(definition(), ['UNKNOWN']), { code: 'TEMPLATE_INVALID' });
  assert.throws(() => getCompiledSourceDependencies({ definition: definition() }, ['BR']), { code: 'TEMPLATE_INVALID' });
});
