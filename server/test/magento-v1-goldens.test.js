const assert = require('node:assert/strict');
const test = require('node:test');
const { mapProduct, buildMagentoPayload } = require('../src/services/magento-products-v1');
const { buildCsv } = require('../src/utils/csv');
const { product, catalog } = require('./fixtures/magento-v1/contract');
const { headers, cases } = require('./fixtures/magento-v1/expected-rows');
const goldens = require('./fixtures/magento-v1/goldens.json');

const bytesEqual = (actual, expected) => assert.deepEqual(
  Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8')
);

for (const fixture of cases) {
  test(`independent complete fields and UTF-8 golden: ${fixture.id}`, () => {
    const input = product(fixture.group, fixture.answers, fixture.product);
    const rules = catalog();
    for (const [key, changes] of Object.entries(fixture.questions || {})) {
      Object.assign(rules.get(fixture.group).get(key), changes);
    }
    const before = structuredClone(input);
    const mapped = mapProduct(input, rules);
    assert.deepEqual(mapped.errors, []);
    for (const side of ['base', 'english']) {
      // Compare every cell, including sparse EN and intentionally absent SEO.
      for (const field of headers[fixture.group]) {
        assert.equal(mapped[side][field] ?? '', fixture[side][field] ?? '', `${side}.${field}`);
      }
      assert.deepEqual(Object.keys(mapped[side]).filter((key) => !headers[fixture.group].includes(key)), []);
    }
    const payload = buildMagentoPayload([input], rules);
    assert.equal(payload.representedCount, 1);
    assert.equal(payload.readyCount, 1);
    assert.deepEqual(payload.errors, []);
    assert.equal(payload.artifacts.length, 1);
    const artifact = payload.artifacts[0];
    assert.deepEqual({ ...artifact, csvContent: undefined }, {
      groupCode: fixture.group,
      groupName: { BR: 'Браслети', NM: 'Намиста', KL: 'Кулони', CH: 'Чотки', AR: 'Картини', SV: 'Сувеніри' }[fixture.group],
      profileVersion: 'magento-products-v1', productCount: 1, rowCount: 2,
      fileName: `amber-magento-${fixture.group}-magento-products-v1.csv`, csvContent: undefined,
    });
    assert.deepEqual(artifact.csvContent.split('\n', 1)[0].split(','), headers[fixture.group]);
    bytesEqual(artifact.csvContent, goldens[fixture.id]);
    assert.equal(artifact.csvContent.startsWith('\uFEFF'), false);
    assert.equal(artifact.csvContent.endsWith('\n'), false);
    assert.deepEqual(input, before, 'export must not change stored input');
  });
}

test('inventory has 164 header positions and ten reviewed complete goldens', () => {
  assert.deepEqual(Object.values(headers).map((h) => h.length), [26, 28, 26, 29, 23, 32]);
  assert.equal(Object.values(headers).flat().length, 164);
  assert.deepEqual(Object.keys(goldens), cases.map((c) => c.id));
});

test('already-selected interleaved inputs preserve caller order; provisional groups follow first ready encounter', () => {
  // Caller normally supplies ascending IDs; lexical SKU order is irrelevant.
  const groups = ['SV', 'CH', 'BR', 'SV', 'NM', 'AR', 'KL', 'BR'];
  const inputs = groups.map((group, i) => product(group, {}, {
    id: i + 1, full_sku: `${group}-${i % 2 ? 'A' : 'Z'}-${i}`,
  }));
  const result = buildMagentoPayload(inputs, catalog());
  assert.equal(result.representedCount, 8);
  assert.equal(result.readyCount, 8);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.artifacts.map((a) => a.groupCode), ['SV', 'CH', 'BR', 'NM', 'AR', 'KL']);
  assert.equal(result.artifacts.reduce((n, a) => n + a.rowCount, 0), 16);
  for (const artifact of result.artifacts) {
    const selected = inputs.filter((p) => p.category === artifact.groupCode);
    assert.equal(artifact.productCount, selected.length);
    // No embedded newlines in these deliberately ordinary rows.
    const actual = artifact.csvContent.split('\n').slice(1).map((row) => row.split(',').slice(0, 2));
    assert.deepEqual(actual, selected.flatMap((p) => [[p.full_sku, ''], [p.full_sku, 'en']]));
  }
  // A pure mapper is not a selector/sorter. Deliberately reversed inputs remain reversed.
  const reversed = buildMagentoPayload([inputs[7], inputs[2]], catalog()).artifacts[0];
  assert.deepEqual(reversed.csvContent.split('\n').slice(1).map((r) => r.split(',')[0]),
    ['BR-A-7', 'BR-A-7', 'BR-Z-2', 'BR-Z-2']);
  assert.deepEqual(buildMagentoPayload([], catalog()), {
    representedCount: 0, readyCount: 0, errors: [], artifacts: [],
  });
});

test('byte comparator rejects changed constants, headers, missing EN, decimals and newlines', () => {
  const expected = goldens.NM;
  const original = buildMagentoPayload([product('NM')], catalog()).artifacts[0].csvContent;
  bytesEqual(original, expected);
  const corruptions = [
    original.replace(',No,Yes,', ',No,No,'),
    original.replace('store_view_code', 'store_view'),
    original.replace('Natural amber necklace. Art: NM-SYNTH-001', ''),
    original.replace('1234.56', '1234.57'),
    original.replace('\n', '\r\n'), original + '\n', '\uFEFF' + original,
  ];
  for (const actual of corruptions) {
    assert.notEqual(actual, expected);
    assert.throws(() => bytesEqual(actual, expected), assert.AssertionError);
  }
});

test('serializer exact bytes: blanks, Unicode, whitespace, escaping and limited formula protection', () => {
  const rows = [
    ['empty', 'null', 'undefined', 'text', 'comma', 'quote', 'CR', 'LF', 'space'],
    ['', null, undefined, 'Бурштин ×', '1,20', 'a"b', 'a\rb', 'a\nb', '  значення  '],
    ['=x', '+x', '-x', '@x', ' =x', '\t+x', '\r-x', '\n=x', '\u00a0=x'],
    [-12.5, '-12.5', '01.20', '0', 0, 'ordinary', ' \t\r@x', '\n +x', ''],
  ];
  const expected = 'empty,null,undefined,text,comma,quote,CR,LF,space\n'
    + ',,,Бурштин ×,"1,20","a""b","a\rb","a\nb",  значення  \n'
    + '\'=x,\'+x,\'-x,\'@x,\' =x,\'\t+x,"\'\r-x","\n=x",\u00a0=x\n'
    + '-12.5,\'-12.5,01.20,0,0,ordinary,"\' \t\r@x","\n +x",';
  bytesEqual(buildCsv(rows), expected);
});
