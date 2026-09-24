import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { columnChange, bindColumnSource, availableSources } from '../src/lib/export-template-columns.js';
import { parsePreviewCsv } from '../src/lib/export-template-csv.js';
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { upgradeColumns } = require('../../server/src/services/export-templates/column-contract');
const { compileDefinition, hashJsonData } = require('../../server/src/services/export-templates/definition');
const { evaluateBatch } = require('../../server/src/services/export-templates/evaluate');
const { catalog, product } = require('../../server/test/fixtures/magento-v1/contract');
const { cases } = require('../../server/test/fixtures/magento-v1/expected-rows');
const goldens = require('../../server/test/fixtures/magento-v1/goldens.json');
const baseline = () => materializeMagentoV1(catalog());
const output = (d, p = product('BR')) => evaluateBatch(compileDefinition(d), [p]);
test('explicit column upgrade preserves all ten independent serialized goldens and old hashes', () => {
  for (const fixture of cases) {
    const rules = catalog(); for (const [key, changes] of Object.entries(fixture.questions || {})) Object.assign(rules.get(fixture.group).get(key), changes);
    const d = materializeMagentoV1(rules); const hash = hashJsonData(d); const v2 = upgradeColumns(d);
    const result = output(v2, product(fixture.group, fixture.answers, fixture.product));
    assert.equal(result.artifacts[0].csvContent, goldens[fixture.id]);
    assert.equal(hashJsonData(d), hash); assert.notEqual(hashJsonData(v2), hash);
    assert.deepEqual(v2.sources, d.sources); assert.deepEqual(v2.questionContracts, d.questionContracts);
    assert.deepEqual(v2.bindings, d.bindings); assert.deepEqual(v2.tables, d.tables);
    assert.deepEqual(v2.groups.map((g) => g.rows), d.groups.map((g) => g.rows));
    assert.deepEqual(upgradeColumns(v2), v2);
  }
});
test('real add, source binding, rename, move, independent duplicate and delete change exact CSV cells', () => {
  const original = upgradeColumns(baseline()); const expected = parsePreviewCsv(output(original).artifacts[0].csvContent);
  let d = columnChange(original, 0, 'add', null, 'synthetic_custom');
  d = bindColumnSource(d, 0, 0, 'synthetic_custom', { id: 'BR.braclet_size', descriptor: original.sources['BR.braclet_size'] });
  d = columnChange(d, 0, 'duplicate', 'synthetic_custom', 'synthetic_copy');
  d.groups[0].rows[0].cells.synthetic_copy = { op: 'literal', value: `=a,
"quoted"` };
  d = columnChange(d, 0, 'rename', 'synthetic_custom', 'synthetic_renamed');
  d = columnChange(d, 0, 'move', 'synthetic_renamed', 1);
  let table = parsePreviewCsv(output(d).artifacts[0].csvContent);
  assert.equal(table.headers[1], 'synthetic_renamed');
  assert.equal(table.rows[1][1], '');
  assert.equal(table.rows[0][1], String(product('BR').details.answers.braclet_size));
  assert.equal(table.rows[0].at(-1), `'=a,
"quoted"`);
  d = columnChange(d, 0, 'remove', 'synthetic_renamed'); d = columnChange(d, 0, 'remove', 'synthetic_copy');
  table = parsePreviewCsv(output(d).artifacts[0].csvContent);
  assert.deepEqual(table, expected); assert.deepEqual(d.groups.slice(1), original.groups.slice(1));
});
test('protected deletion, unsafe headers and stale output ownership fail closed', () => {
  const d = upgradeColumns(baseline());
  assert.throws(() => columnChange(d, 0, 'remove', 'sku'), /Захищена/);
  for (const code of ['constructor', '__proto__', '=sum', 'bad,code', `x
header`, 'sku']) assert.throws(() => columnChange(d, 0, 'add', null, code));
  const bad = structuredClone(d); bad.groups[0].columns = bad.groups[0].columns.filter((c) => c !== 'sku');
  assert.throws(() => compileDefinition(bad), /Protected/);
  const optional = columnChange(d, 0, 'remove', 'typ_vykonannia');
  assert.equal(output(optional, product('BR', { style: 999 })).status, 'ready');
  assert.equal(output(d, product('BR', { style: 999 })).status, 'not-ready');
});
test('new approved informational characteristic is offered without a hardcoded mapping', () => {
  const choices = availableSources({ productFields: ['full_sku'], references: { questions: [
    { category_code: 'BR', key: 'synthetic_note', label: 'Test note', include_in_sku: 0, input_type: 'text' },
    { category_code: 'BR', key: 'unpublished_sku', include_in_sku: 1 }
  ], schemas: [] } }, 'BR');
  assert.ok(choices.some((s) => s.id === 'BR.synthetic_note'));
  assert.ok(!choices.some((s) => s.id === 'BR.unpublished_sku'));
});

test('synthetic revision-six local BR changes and all AR 29/30/31 mappings survive conversion exactly', async () => {
  const { editQuestionMapping } = await import('../src/lib/export-template-attributes.js');
  const { editField } = await import('../src/lib/export-template-presentation.js');
  const { officeCatalog } = require('../../server/test/fixtures/magento-v1/office');
  let d = materializeMagentoV1(officeCatalog());
  d = editField(d, ['groups', 0, 'rows', 0, 'cells', 'name'], [{ ref: 'BR.nameUa' }, 'then'], 'local',
    (n) => ({ ...n, template: '[ТЕСТ] ' + n.template }));
  d = editQuestionMapping(d, ['groups', 0, 'rows', 0, 'cells', 'kolir'], 'local', (t) => ({ ...t, '1': 'Локальний колір' }));
  d = editQuestionMapping(d, ['groups', 4, 'rows', 0, 'cells', 'rozmir_kartyny'], 'local',
    (t) => ({ ...t, '29': '75×78', '30': '74×80', '31': '70×70' }));
  const converted = upgradeColumns(d);
  assert.deepEqual(converted.sources, d.sources);
  assert.deepEqual(converted.questionContracts, d.questionContracts);
  assert.deepEqual(converted.tables, d.tables);
  assert.deepEqual(converted.bindings, d.bindings);
  assert.deepEqual(converted.groups.map((g) => g.rows), d.groups.map((g) => g.rows));
  for (const [id, expected] of [['29','75×78'],['30','74×80'],['31','70×70']]) {
    const result = output(converted, product('AR', { size: Number(id) }));
    assert.equal(result.status, 'ready'); assert.ok(result.artifacts[0].csvContent.includes(expected));
  }
});

test('rename only copies diagnostic paths owned by the column and required price cannot be unresolved', () => {
  let d = upgradeColumns(baseline());
  d = columnChange(d, 0, 'add', null, 'synthetic_old');
  d.bindings.push({ id: 'synthetic.diagnostic', scope: 'BR', value: { op: 'error', code: 'TEST', field: 'synthetic_old', message: 'Test' } });
  d.groups[0].rows[0].cells.synthetic_old = { op: 'ref', id: 'synthetic.diagnostic' };
  const shared = structuredClone(d.bindings);
  const next = columnChange(d, 0, 'rename', 'synthetic_old', 'synthetic_new');
  assert.deepEqual(next.bindings.slice(0, shared.length), shared);
  const ref = next.groups[0].rows[0].cells.synthetic_new.id;
  assert.notEqual(ref, 'synthetic.diagnostic');
  assert.equal(next.bindings.find((b) => b.id === ref).value.field, 'synthetic_new');
  const missingPrice = upgradeColumns(baseline());
  delete missingPrice.groups[0].rows[0].cells.price;
  assert.throws(() => compileDefinition(missingPrice), /Base price rule required/);
  const blankName = upgradeColumns(baseline());
  blankName.groups[0].rows[0].cells.name = { op: 'literal', value: '' };
  assert.throws(() => compileDefinition(blankName), /Unresolved protected cell/);
});
