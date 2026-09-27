import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { questionField, editQuestionMapping, optionEvidence } from '../src/lib/export-template-attributes.js';
import { parsePreviewCsv } from '../src/lib/export-template-csv.js';
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { ATTRIBUTE } = require('../../server/src/services/export-templates/magento-v1-data');
const { catalog, product } = require('../../server/test/fixtures/magento-v1/contract');
const { compileDefinition, hashJsonData } = require('../../server/src/services/export-templates/definition');
const { evaluateProduct } = require('../../server/src/services/export-templates/evaluate');
const path = (d, group, field) => ['groups', d.groups.findIndex((g) => g.route === group), 'rows', 0, 'cells', field];
test('all 41 standard question attributes have shape-based direct mapping lenses without mutations', () => {
  const d = materializeMagentoV1(catalog()); const hash = hashJsonData(d); let count = 0;
  for (const [group, fields] of Object.entries(ATTRIBUTE)) for (const [field, [key, table]] of Object.entries(fields)) {
    const lens = questionField(d, path(d, group, field));
    assert.equal(lens.sourceId, `${group}.${key}`); assert.equal(lens.lookup.table, table); count++;
  }
  assert.equal(count, 41); assert.equal(hashJsonData(d), hash);
});
test('shape recognition follows renamed refs and wrappers; local shared-root edits coordinate private readiness only', () => {
  const d = materializeMagentoV1(catalog()); const p = path(d, 'NM', 'dodatkovo_namysta');
  const g = d.groups[p[1]]; const originalId = g.rows[0].cells.dodatkovo_namysta.id;
  d.bindings.find((b) => b.id === originalId).id = 'NM.renamed';
  const rename = (n) => { if (!n || typeof n !== 'object') return; if (n.op === 'ref' && n.id === originalId) n.id = 'NM.renamed'; Object.values(n).forEach(rename); }; rename(d);
  g.rows[0].cells.meta_title = { op: 'ref', id: 'NM.renamed' };
  const before = structuredClone(d);
  const next = editQuestionMapping(d, p, 'local', (t) => ({ ...t, 1: 'Локальне' }));
  const value = evaluateProduct(compileDefinition(next), product('NM', { extra: 1 }));
  assert.equal(value.base.dodatkovo_namysta, 'Локальне'); assert.equal(value.base.meta_title, 'З підвісками');
  assert.deepEqual(value.errors, []); assert.deepEqual(d, before);
  assert.equal(next.groups[p[1]].evaluate.some((n) => n.id === next.groups[p[1]].rows[0].cells.dodatkovo_namysta.id), true);
  const shared = editQuestionMapping(d, p, 'shared', (t) => ({ ...t, 1: 'Разом' }));
  assert.equal(evaluateProduct(compileDefinition(shared), product('NM', { extra: 1 })).base.meta_title, 'Разом');
});
test('zero, empty output, absent mapping, unknown IDs and hidden/required AR contracts stay distinct', () => {
  const d = materializeMagentoV1(catalog()); const p = path(d, 'NM', 'dodatkovo_namysta');
  assert.equal(evaluateProduct(compileDefinition(d), product('NM', { extra: 0 })).base.dodatkovo_namysta, '');
  const removed = editQuestionMapping(d, p, 'local', (t) => Object.fromEntries(Object.entries(t).filter(([id]) => id !== '0')));
  assert.ok(evaluateProduct(compileDefinition(removed), product('NM', { extra: 0 })).errors.some((e) => e.field === 'dodatkovo_namysta'));
  assert.ok(evaluateProduct(compileDefinition(d), product('NM', { extra: 999 })).errors.some((e) => e.field === 'dodatkovo_namysta'));
  const ar = path(d, 'AR', 'rozmir_kartyny');
  d.questionContracts['AR.size'].rule = { 'AR.type': 999 };
  const hidden = editQuestionMapping(d, ar, 'local', (t) => ({ ...t, 1: 'зміна' }));
  assert.deepEqual(evaluateProduct(compileDefinition(hidden), product('AR', { size: 1 })), evaluateProduct(compileDefinition(d), product('AR', { size: 1 })));
  d.questionContracts['AR.size'].rule = {}; d.questionContracts['AR.size'].required = true;
  const required = editQuestionMapping(d, ar, 'local', (t) => ({ ...t, 1: 'зміна' }));
  assert.deepEqual(evaluateProduct(compileDefinition(required), product('AR', { size: null })), evaluateProduct(compileDefinition(d), product('AR', { size: null })));
  assert.deepEqual(optionEvidence({ current: [], historical: [] }, '0'), { current: [], historical: [] });
  assert.equal(questionField(d, path(d, 'AR', 'sku')), null);
});
test('a guarded AR glass field detaches from another output without stale readiness or changing its absent fallback', () => {
  const d = materializeMagentoV1(catalog()); const p = path(d, 'AR', 'sklo'); const g = d.groups[p[1]];
  const id = g.rows[0].cells.sklo.then.id; g.rows[0].cells.meta_title = { op: 'ref', id };
  const next = editQuestionMapping(d, p, 'local', (t) => ({ ...t, 1: 'Локальне скло' }));
  assert.deepEqual(next.groups[p[1]].rows[0].cells.sklo.else, g.rows[0].cells.sklo.else);
  const result = evaluateProduct(compileDefinition(next), product('AR', { glass: 1 }));
  assert.equal(result.base.sklo, 'Локальне скло'); assert.notEqual(result.base.meta_title, result.base.sklo);
  assert.deepEqual(evaluateProduct(compileDefinition(next), product('AR', { glass: null })), evaluateProduct(compileDefinition(d), product('AR', { glass: null })));
  assert.equal(next.groups[p[1]].evaluate.some((n) => n.id === next.groups[p[1]].rows[0].cells.sklo.then.id), true);
});
test('inline question fields coordinate structurally identical inline and referenced readiness projections', () => {
  for (const inlineReadiness of [false, true]) {
    const d = materializeMagentoV1(catalog()); const p = path(d, 'NM', 'dodatkovo_namysta'); const g = d.groups[p[1]];
    const original = g.rows[0].cells.dodatkovo_namysta;
    const value = d.bindings.find((b) => b.id === original.id).value;
    g.rows[0].cells.dodatkovo_namysta = structuredClone(value);
    if (inlineReadiness) g.evaluate = g.evaluate.map((n) => n.id === original.id ? structuredClone(value) : n);
    // An unknown stored value becomes mapped locally; stale readiness must not
    // continue reporting the old missing-map error for this same field.
    const next = editQuestionMapping(d, p, 'local', (t) => ({ ...t, 99: 'Власний текст' }));
    const result = evaluateProduct(compileDefinition(next), product('NM', { extra: 99 }));
    assert.equal(result.base.dodatkovo_namysta, 'Власний текст');
    assert.ok(!result.errors.some((e) => e.field === 'dodatkovo_namysta'));
    assert.deepEqual(next.questionContracts, d.questionContracts);
  }
});
test('quote-aware presentation preserves CRLF, embedded delimiters, escaped quotes, blanks and rejects invalid CSV', () => {
  const csv = '\ufeffsku,store_view_code,name,empty\r\n"BR,1",,"a""b\r\nc",\r\nBR1,en,English,\r\n';
  assert.deepEqual(parsePreviewCsv(csv), { headers: ['sku','store_view_code','name','empty'], rows: [['BR,1','','a"b\r\nc',''],['BR1','en','English','']] });
  for (const invalid of ['a,b\n1', 'a\n"unterminated', 'a\n"x"junk', 'a\nb"c']) assert.throws(() => parsePreviewCsv(invalid));
});
test('AR local output and its postcheck/readiness stay coordinated, other fields and frozen rules stay identical', () => {
  const d = materializeMagentoV1(catalog()); const p = path(d, 'AR', 'rozmir_kartyny');
  const next = editQuestionMapping(d, p, 'local', (t) => ({ ...t, 1: '' }));
  assert.deepEqual(next.questionContracts, d.questionContracts); assert.deepEqual(next.sources, d.sources);
  assert.equal(d.tables.arSize[1], '10×15');
  const result = evaluateProduct(compileDefinition(next), product('AR', { size: 1 }));
  assert.ok(result.errors.some((e) => e.field === 'rozmir_kartyny'));
  for (const group of ['BR', 'NM', 'KL', 'CH', 'SV']) assert.deepEqual(evaluateProduct(compileDefinition(next), product(group)), evaluateProduct(compileDefinition(d), product(group)));
  const again = editQuestionMapping(next, p, 'local', (t) => ({ ...t, 1: 'Власний розмір' }));
  assert.equal(Object.keys(again.tables).length, Object.keys(next.tables).length);
  assert.equal(evaluateProduct(compileDefinition(again), product('AR', { size: 1 })).base.rozmir_kartyny, 'Власний розмір');
});
