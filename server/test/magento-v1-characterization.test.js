const assert = require('node:assert/strict');
const test = require('node:test');
const { mapProduct, buildMagentoPayload } = require('../src/services/magento-products-v1');
const { product, catalog, dictionaries, attributes } = require('./fixtures/magento-v1/contract');
const { cases } = require('./fixtures/magento-v1/expected-rows');

const categoryError = { field: 'categories', message: 'Немає мапінгу однієї з характеристик категорії.' };
const priceError = { field: 'price', message: 'Немає додатної збереженої фінальної ціни UAH.' };
const manualError = { field: 'name', code: 'manual_name_required', message: 'Потрібна збережена українська та англійська назва товару.' };
const manualPair = { magento_name_subject_ua: 'Сова', magento_name_subject_en: 'owl' };
const map = (group, answers = {}, overrides = {}, rules = catalog()) => mapProduct(product(group, answers, overrides), rules);
const unmapped = (field, key, value) => ({ field, message: `Немає Magento-мапінгу для ${key}=${value}.` });

test('independent inventory covers 41 semantic bindings and 31 dictionaries including AR sizes', () => {
  assert.equal(Object.values(attributes).flat().length, 41);
  assert.equal(Object.keys(dictionaries).length, 31);
  assert.deepEqual(new Set(Object.values(attributes).flat().map((a) => a[2])), new Set(Object.keys(dictionaries)));
});

for (const [group, bindings] of Object.entries(attributes)) {
  for (const [key, field, dictionary] of bindings) {
    test(`every semantic dictionary entry: ${group}.${key} -> ${field}`, () => {
      for (const [id, expected] of Object.entries(dictionaries[dictionary])) {
        for (const value of [id, Number(id)]) {
          const mapped = map(group, { [key]: value }, group === 'SV' ? manualPair : {});
          assert.equal(mapped.base[field], expected, `${key}=${JSON.stringify(value)}`);
          assert.equal(mapped.english[field], undefined);
          const categoryRejected = group === 'CH' && ((key === 'count' && id === '9') || (key === 'texture' && id === '8'));
          assert.deepEqual(mapped.errors, categoryRejected ? [categoryError] : []);
          const result = buildMagentoPayload([product(group, { [key]: value }, group === 'SV' ? manualPair : {})], catalog());
          assert.equal(result.readyCount, categoryRejected ? 0 : 1);
          assert.equal(result.artifacts.length, categoryRejected ? 0 : 1);
        }
      }
      const invalid = map(group, { [key]: 999 }, group === 'SV' ? manualPair : {});
      assert.equal(invalid.base[field], '');
      assert.ok(invalid.errors.some((e) => e.field === field), `${group}.${key} unknown present value must fail`);
    });
  }
}

test('KL current/legacy dimensions use presence only and SKU identity stays opaque', () => {
  const dimensions = [
    [{ pedant_size: ' 2 см ', exact_size: undefined }, '2 см'],
    [{ pedant_size: undefined, exact_size: ' 3.8/2.5 ' }, '3.8/2.5'],
    [{ pedant_size: ' current ', exact_size: 'legacy' }, 'current'],
    ...[null, '', ' \t\r\n '].map((pedant_size) => [{ pedant_size, exact_size: ' legacy ' }, 'legacy']),
    [{ pedant_size: undefined, exact_size: undefined }, ''],
    [{ pedant_size: 'довільний текст × / см' }, 'довільний текст × / см'],
    [{ pedant_size: 0, exact_size: 'legacy' }, '0'],
    [{ pedant_size: '0', exact_size: 'legacy' }, '0'],
  ];
  for (const sku of ['KL100-001', 'KL2/123-002-003', 'KL-V3-123-004', ' KL arbitrary  ']) {
    for (const [answers, expected] of dimensions) {
      const mapped = map('KL', answers, { full_sku: sku });
      assert.deepEqual(mapped.errors, []);
      assert.equal(mapped.base.rozmir_iuvelirnoho_vyrobu, expected);
      assert.equal(mapped.base.sku, sku);
      assert.equal(mapped.english.sku, sku);
      assert.equal(mapped.base.name, `Кулон з натурального бурштину. Арт: ${sku}`);
      assert.equal(mapped.english.name, `Natural amber pendant. Art: ${sku}`);
    }
  }
});

test('KL addit: absent versus present zero, visible/hidden, optional/required (compatibility, not approval)', () => {
  const baseline = cases.find((c) => c.id === 'KL').base.categories;
  for (const visible of [true, false]) {
    for (const required of [0, 1]) {
      for (const [answers, present, semanticOne] of [
        [{}, false, false], [{ addit: null }, false, false], [{ addit: '' }, false, false],
        [{ addit: ' \t ' }, false, false], [{ addit: 0 }, true, false],
        [{ addit: '0' }, true, false], [{ addit: 1 }, true, true], [{ addit: '1' }, true, true],
      ]) {
        const rules = catalog();
        Object.assign(rules.get('KL').get('addit'), { required, visible_if_json: visible ? null : { raw_type: 2 } });
        const input = product('KL', answers);
        const before = structuredClone(input);
        const mapped = mapProduct(input, rules);
        assert.equal(mapped.base.categories, baseline + (present ? ',Default/Кулони/З інклюзом' : ''));
        assert.equal(mapped.base.kulony_dodatkovo, visible && semanticOne ? 'Інклюз' : '');
        const expected = !visible ? [] : present && !semanticOne
          ? [unmapped('kulony_dodatkovo', 'addit', 0)]
          : !present && required ? [{ field: 'kulony_dodatkovo', message: 'Немає відповіді addit.' }] : [];
        assert.deepEqual(mapped.errors, expected);
        const payload = buildMagentoPayload([input], rules);
        assert.equal(payload.readyCount, expected.length ? 0 : 1);
        assert.equal(payload.artifacts.length, expected.length ? 0 : 1);
        assert.deepEqual(input, before);
      }
    }
  }
});

test('NM bands include exact boundaries, gaps, comma spelling and nonnumeric passthrough', () => {
  const bands = [
    ['19', 'Колар (30-35 см)'], ['35', 'Колар (30-35 см)'],
    ['35.001', 'Чокер (35-40 см)'], ['42', 'Чокер (35-40 см)'],
    ['43', 'Принцеса (43-48 см)'], ['49', 'Принцеса (43-48 см)'],
    ['50', 'Матіне (50-63 см)'], ['65', 'Матіне (50-63 см)'],
    ['66', 'Опера (66-91 см)'], ['91', 'Опера (66-91 см)'],
    ['92', 'Роуп (120-180 см)'], ['180', 'Роуп (120-180 см)'],
    [' 35,5 ', 'Чокер (35-40 см)'], ['довільно', 'довільно'],
    ['40 см', '40 см'], ['NaN', 'NaN'], ['Infinity', 'Infinity'], ['1,2,3', '1,2,3'],
    ['0x28', 'Чокер (35-40 см)'], ['4e1', 'Чокер (35-40 см)'],
  ];
  for (const [neckle_size, expected] of bands) {
    const mapped = map('NM', { neckle_size });
    assert.deepEqual(mapped.errors, []);
    assert.equal(mapped.base.dovzhyna_namysta, expected);
    assert.equal(mapped.base.dovzhyna_namysta_tochna, neckle_size.trim());
  }
  for (const neckle_size of ['18.999', '42.001', '42.999', '49.001', '49.999', '65.001', '65.999', '91.001', '91.999', '180.001', '0', '-1']) {
    const mapped = map('NM', { neckle_size });
    assert.equal(mapped.base.dovzhyna_namysta, '');
    assert.deepEqual(mapped.errors, [{ field: 'dovzhyna_namysta', message: 'Довжина не має затвердженого діапазону.' }]);
  }
  for (const neckle_size of [undefined, null, '', '  ']) {
    assert.deepEqual(map('NM', { neckle_size }).errors,
      [{ field: 'dovzhyna_namysta_tochna', message: 'Немає відповіді neckle_size.' }]);
  }
});

test('CH preserves raw size spelling, zero decimals and calibration 0/1/2/historical 3', () => {
  for (const is_calibrated of [0, 1, 2, 3]) {
    for (const [value, expected] of [[' 015,80 ', '015.80'], ['08.20', '08.20'], [0, '0'], ['0', '0'], ['000.000', '000.000']]) {
      const input = product('CH', { bead_length: value, bead_width: value, rosary_length: value, is_calibrated });
      const before = structuredClone(input);
      const mapped = mapProduct(input, catalog());
      assert.deepEqual(mapped.errors, []);
      assert.equal(mapped.base.dovzhyna_namystyny, expected);
      assert.equal(mapped.base.diametr_namystyny, expected);
      assert.equal(mapped.base.dovzhyna_vyrobu, expected);
      assert.equal(mapped.base.rozmir_kameniu, `${String(value).trim()}×${String(value).trim()}`);
      assert.equal(mapped.base.is_calibrated, undefined);
      assert.deepEqual(input, before);
    }
  }
});

test('CH invalid numeric forms fail exactly at their numeric field; absent differs from invalid', () => {
  for (const [key, field] of [['bead_length', 'dovzhyna_namystyny'], ['bead_width', 'diametr_namystyny'], ['rosary_length', 'dovzhyna_vyrobu']]) {
    for (const value of ['1,2.3', '15 cm', '1e2', '0x10', '+1', '-1', '.5', '1.', '1,', '1/2', 'NaN', 'Infinity', true, false, {}, '9'.repeat(400)]) {
      const mapped = map('CH', { [key]: value });
      assert.deepEqual(mapped.errors, [{ field, message: 'Некоректне числове значення для Magento.' }]);
      assert.equal(mapped.base[field], '');
    }
    for (const value of [undefined, null, '', '  ']) {
      assert.deepEqual(map('CH', { [key]: value }).errors, [{ field, message: `Немає відповіді ${key}.` }]);
    }
  }
  const rejectedCount = map('CH', { count: 9 });
  assert.equal(rejectedCount.base.kilkist_namystyn, '?');
  assert.equal(rejectedCount.base.categories.includes('Чотки на'), false);
  assert.deepEqual(rejectedCount.errors, [categoryError]);
  const rejectedTexture = map('CH', { texture: 8 });
  assert.equal(rejectedTexture.base.faktura_namystyn, 'Змішана');
  assert.ok(rejectedTexture.base.categories.includes('Чотки з undefined намистинами'));
  assert.deepEqual(rejectedTexture.errors, [categoryError]);
});

test('AR size requires live membership plus fixed mapping; postcheck runs even when hidden', () => {
  const mappingError = { field: 'rozmir_kartyny', message: 'Немає Magento-мапінгу для size=99.' };
  assert.deepEqual(map('AR', { size: 99 }).errors, [
    { field: 'rozmir_kartyny', message: 'Невідоме value_id 99 для size.' }, mappingError,
  ]);
  const allowedUnmapped = catalog();
  allowedUnmapped.get('AR').get('size').options.push({ value_id: 99 });
  assert.deepEqual(map('AR', { size: 99 }, {}, allowedUnmapped).errors, [mappingError]);
  const missingKnown = catalog();
  missingKnown.get('AR').get('size').options = [];
  assert.deepEqual(map('AR', { size: 1 }, {}, missingKnown).errors, [
    { field: 'rozmir_kartyny', message: 'Невідоме value_id 1 для size.' },
    { field: 'rozmir_kartyny', message: 'Немає Magento-мапінгу для size=1.' },
  ]);
  const hidden = catalog();
  Object.assign(hidden.get('AR').get('size'), { required: 1, visible_if_json: { type: 7 } });
  assert.deepEqual(map('AR', { size: 1 }, {}, hidden).errors,
    [{ field: 'rozmir_kartyny', message: 'Немає Magento-мапінгу для size=1.' }]);
  assert.deepEqual(map('AR', { size: undefined }, {}, hidden).errors, []);
  assert.deepEqual(map('AR', { size: undefined }).errors, []);
});

test('AR absent glass defaults after validation; explicit zero is never absence', () => {
  for (const visible of [true, false]) {
    for (const required of [0, 1]) {
      for (const value of [undefined, null, '', '  ', 0, '0', 1]) {
        const rules = catalog();
        Object.assign(rules.get('AR').get('glass'), { required, visible_if_json: visible ? null : { type: 7 } });
        const mapped = map('AR', { glass: value }, {}, rules);
        const absent = [undefined, null, '', '  '].includes(value);
        assert.equal(mapped.base.sklo, absent ? 'Без скла' : visible && value === 1 ? 'Зі склом' : '');
        assert.deepEqual(mapped.errors, !visible ? [] : absent
          ? required ? [{ field: 'sklo', message: 'Немає відповіді glass.' }] : []
          : value === 1 ? [] : [unmapped('sklo', 'glass', 0)]);
      }
    }
  }
  const missing = catalog();
  missing.get('AR').delete('glass');
  const result = map('AR', {}, {}, missing);
  assert.equal(result.base.sklo, 'Без скла');
  assert.deepEqual(result.errors, [{ field: 'sklo', message: 'В каталозі немає питання glass.' }]);
});

test('SV fractions immediately below/at/above every threshold use answer weight, not product weight', () => {
  const boundaries = [
    [2, '0-2', '2-5'], [5, '2-5', '5-10'], [10, '5-10', '10-20'],
    [20, '10-20', '20-50'], [50, '20-50', '50-100'], [100, '50-100', '100-200'],
    [200, '100-200', '200-300'], [300, '200-300', '300-500'],
    [500, '300-500', '500-1000'], [1000, '500-1000', '1000+'],
  ];
  for (const [boundary, below, at] of boundaries) {
    for (const [weight, fraction] of [[boundary - 0.001, below], [boundary, at], [boundary + 0.001, at]]) {
      const mapped = map('SV', { souvenir: 5, weight: String(weight) }, { ...manualPair, weight: '8888' });
      assert.deepEqual(mapped.errors, []);
      assert.equal(mapped.base.decor_weight, String(weight));
      assert.equal(mapped.base.fraction, fraction);
      assert.equal(mapped.base.attribute_set_code, 'Камінь');
      assert.equal(mapped.english.attribute_set_code, 'Камінь');
      assert.equal(map('SV', { souvenir: 6, weight }).base.fraction, '');
    }
  }
});

test('SV only key chain auto-names; saved complete pair wins, including key chains', () => {
  for (const souvenir of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    // Concrete subtype IDs do not supply approved EN names.
    const answers = { souvenir, statuette: 1, '2': 2, bird: 3, plants: 1, table_games: 1 };
    const automatic = map('SV', answers);
    assert.deepEqual(automatic.errors, souvenir === 6 ? [] : [manualError]);
    assert.equal(automatic.base.name, souvenir === 6 ? 'Брелок з бурштину. Арт: SV-SYNTH-001' : '');
    assert.equal(automatic.english.name, souvenir === 6 ? 'Amber key chain. Art: SV-SYNTH-001' : '');
    const manual = map('SV', answers, { magento_name_subject_ua: '  Сова  нічна  ', magento_name_subject_en: '\t night  owl \n' });
    assert.deepEqual(manual.errors, []);
    assert.equal(manual.base.name, 'Сова  нічна з бурштину. Арт: SV-SYNTH-001');
    assert.equal(manual.english.name, 'Amber night  owl. Art: SV-SYNTH-001');
    for (const pair of [
      { magento_name_subject_ua: 'Сова' }, { magento_name_subject_en: 'owl' },
      { magento_name_subject_ua: 'Сова', magento_name_subject_en: ' \t ' },
      { magento_name_subject_ua: '\n ', magento_name_subject_en: 'owl' },
      { magento_name_subject_ua: 1, magento_name_subject_en: 'owl' },
    ]) {
      const partial = map('SV', answers, pair);
      assert.deepEqual(partial.errors, automatic.errors);
      assert.equal(partial.base.name, automatic.base.name);
      assert.equal(partial.english.name, automatic.english.name);
    }
  }
});

test('final stored price is authoritative, Number formatting/coercion and legacy zero stay unchanged', () => {
  for (const [value, expected] of [['1234.56', '1234.56'], ['2000.00', '2000'], [' 001.20 ', '1.2'], ['0x10', '16'], ['1e2', '100'], ['9007199254740993', '9007199254740992'], [true, '1'], [[12], '12']]) {
    const mapped = map('BR', {}, { total_price_uah: value, calculatedPriceUah: 444, autoPriceUah: 555, manualPriceUah: 666 });
    assert.deepEqual(mapped.errors, []);
    assert.equal(mapped.base.price, expected);
    assert.equal(mapped.english.price, undefined);
  }
  for (const value of [undefined, null, '', ' ', '1,20', 'bad', NaN, Infinity, -1, '-1', 0, '0', false, {}]) {
    const input = product('BR', {}, { total_price_uah: value, legacy_uah_price_unset: true });
    const before = structuredClone(input);
    const mapped = mapProduct(input, catalog());
    assert.deepEqual(mapped.errors, [priceError]);
    assert.equal(mapped.base.price, '');
    assert.equal(buildMagentoPayload([input], catalog()).readyCount, 0);
    assert.deepEqual(input, before, 'no fallback to evidence prices or mutation of legacy zero');
  }
});

test('all weight sources reject missing, nonpositive and comma values with exact diagnostics', () => {
  for (const group of ['BR', 'NM', 'KL', 'CH', 'SV']) {
    for (const weight of [undefined, null, '', ' ', 0, '0', -1, 'NaN', 'Infinity', '1,2']) {
      const input = group === 'SV' ? product(group, { weight }, { weight: '55' }) : product(group, {}, { weight });
      const mapped = mapProduct(input, catalog());
      const field = group === 'CH' ? 'vaha_vyrobu' : 'decor_weight';
      assert.deepEqual(mapped.errors, [{ field, message: 'Немає додатної ваги для Magento.' }]);
      assert.equal(mapped.base[field], '');
    }
  }
  assert.deepEqual(map('AR', {}, { weight: null }).errors, []);
});

test('readiness preserves product/field order and multiple errors per field; no deduplication', () => {
  const badAr = product('AR', { type: 99, size: 99 }, { id: '8', total_price_uah: 0 });
  const unknown = product('XX', {}, { id: '9', full_sku: 'OPAQUE' });
  const expectedAr = {
    productId: 8, sku: 'AR-SYNTH-001', group: 'AR', fields: [
      unmapped('kartynyy', 'type', 99),
      { field: 'rozmir_kartyny', message: 'Невідоме value_id 99 для size.' },
      { field: 'rozmir_kartyny', message: 'Немає Magento-мапінгу для size=99.' },
      { field: 'name', message: 'Немає назви для AR.type.' }, priceError,
    ],
  };
  const unknownError = { productId: 9, sku: 'OPAQUE', group: 'XX', fields: [
    { field: 'attribute_set_code', message: 'Немає Magento-профілю для категорії.' },
  ] };
  const result = buildMagentoPayload([product('SV'), badAr, unknown, product('BR'), badAr], catalog());
  assert.equal(result.representedCount, 5);
  assert.equal(result.readyCount, 2);
  assert.deepEqual(result.errors, [expectedAr, unknownError, expectedAr]);
  assert.deepEqual(result.artifacts.map((a) => [a.groupCode, a.productCount, a.rowCount]), [['SV', 1, 2], ['BR', 1, 2]]);
  const firstInvalid = buildMagentoPayload([
    badAr, product('SV', {}, { id: 9 }), product('AR', {}, { id: 10 }),
  ], catalog());
  assert.equal(firstInvalid.representedCount, 3);
  assert.equal(firstInvalid.readyCount, 2);
  assert.deepEqual(firstInvalid.errors, [expectedAr]);
  assert.deepEqual(firstInvalid.artifacts.map((a) => a.groupCode), ['SV', 'AR']);
  // These are provisional mapper artifacts; this is NOT snapshot permission.
  for (const category of [undefined, null, '', 'br', ' BR', 'Stone']) {
    const mapped = mapProduct(product('BR', {}, { category }), catalog());
    assert.deepEqual(mapped.errors, unknownError.fields);
    assert.equal(mapped.base, undefined);
  }
});

test('live catalog labels/options do not select semantic text; existence/visibility/requiredness do', () => {
  const normal = map('BR');
  const rules = catalog();
  for (const question of rules.get('BR').values()) {
    question.label = 'Renamed question';
    question.options = [{ value_id: 777, sku_code: '1', label: 'Натуральний' }];
  }
  assert.deepEqual(map('BR', {}, {}, rules), normal, 'non-AR mappings ignore option membership and labels');
  assert.deepEqual(map('BR', { raw_type: 777 }, {}, rules).errors, [
    unmapped('typy_obrobky_burshtynu', 'raw_type', 777),
    { field: 'name', message: 'Немає мапінгу raw_type для назви.' },
    { field: 'categories', message: 'Немає категорії для raw_type.' },
  ]);
  rules.get('BR').delete('raw_type');
  assert.deepEqual(map('BR', {}, {}, rules).errors,
    [{ field: 'typy_obrobky_burshtynu', message: 'В каталозі немає питання raw_type.' }]);
  const optional = catalog();
  assert.deepEqual(map('NM', { extra: undefined }, {}, optional).errors, []);
  optional.get('NM').get('extra').required = '1';
  assert.deepEqual(map('NM', { extra: undefined }, {}, optional).errors,
    [{ field: 'dodatkovo_namysta', message: 'Немає відповіді extra.' }]);
  optional.get('NM').get('extra').visible_if_json = { raw_type: 2 };
  assert.deepEqual(map('NM', { extra: 999 }, {}, optional).errors, []);
  assert.equal(map('NM', { extra: 1 }, {}, optional).base.dodatkovo_namysta, '');
  assert.ok(map('NM', { extra: 1 }, {}, optional).base.categories.endsWith('/Намиста з підвісками'));
});

test('legacy malformed rules and coercions are observed, not new publication semantics', () => {
  for (const rule of ['{broken', 'null', '[]', '42', '"text"', [], true, 42]) {
    const rules = catalog();
    rules.get('NM').get('extra').visible_if_json = rule;
    const mapped = map('NM', { extra: 1 }, {}, rules);
    assert.deepEqual(mapped.errors, []);
    assert.equal(mapped.base.dodatkovo_namysta, 'З підвісками');
  }
  for (const [rule, visible] of [
    [{ raw_type: '01' }, true], [{ raw_type: ['2', '01'] }, true],
    [{ $and: [{ raw_type: 1 }, { extra: 1 }] }, true],
    [{ $or: [{ raw_type: 2 }, { extra: 1 }] }, true],
    [{ $and: 'bad' }, false], [{ $or: [] }, false],
  ]) {
    const rules = catalog();
    rules.get('NM').get('extra').visible_if_json = rule;
    assert.equal(map('NM', { extra: 1 }, {}, rules).base.dodatkovo_namysta, visible ? 'З підвісками' : '');
  }
  assert.equal(map('BR', { braclet_size: {} }).base.dovzhyna_brasletu_diuimiv, '[object Object]');
  assert.deepEqual(map('BR', { raw_type: [1] }).errors, []);
  assert.deepEqual(map('NM', { extra: ' 1 ' }).errors, [unmapped('dodatkovo_namysta', 'extra', ' 1 ')]);
  assert.deepEqual(map('NM', { extra: false }).errors, [unmapped('dodatkovo_namysta', 'extra', false)]);
});

test('all 41 question-existence gates remain active, even for absent or hidden answers', () => {
  for (const [group, bindings] of Object.entries(attributes)) {
    for (const [key, field] of bindings) {
      const rules = catalog();
      rules.get(group).delete(key);
      const mapped = map(group, {}, group === 'SV' ? manualPair : {}, rules);
      const expected = [{ field, message: `В каталозі немає питання ${key}.` }];
      if (group === 'AR' && key === 'size') {
        expected.push({ field, message: 'Немає Magento-мапінгу для size=1.' });
      }
      assert.deepEqual(mapped.errors, expected, `${group}.${key}`);
    }
  }
});

test('SV synthetic dependent questions gate unknown values and required answers without changing literal IDs', () => {
  for (const [key, field] of attributes.SV.filter(([key]) => !['souvenir', 'color', 'material'].includes(key))) {
    const rules = catalog();
    Object.assign(rules.get('SV').get(key), { required: 1, visible_if_json: { souvenir: 1 } });
    const hidden = map('SV', { souvenir: 6, [key]: 999 }, {}, rules);
    assert.deepEqual(hidden.errors, []);
    assert.equal(hidden.base[field], '');
    assert.deepEqual(map('SV', { souvenir: 1, [key]: undefined }, manualPair, rules).errors,
      [{ field, message: `Немає відповіді ${key}.` }]);
    assert.deepEqual(map('SV', { souvenir: 1, [key]: 999 }, manualPair, rules).errors,
      [unmapped(field, key, 999)]);
  }
});

test('required free text does not depend on question metadata and SKU has no separate nonblank validation', () => {
  for (const [group, key, field] of [['BR', 'braclet_size', 'dovzhyna_brasletu_diuimiv'], ['SV', 'size', 'rozmir_suveniriv']]) {
    for (const value of [undefined, null, '', ' \t ']) {
      assert.deepEqual(map(group, { [key]: value }).errors, [{ field, message: `Немає відповіді ${key}.` }]);
    }
    assert.equal(map(group, { [key]: 0 }).base[field], '0');
    assert.deepEqual(map(group, { [key]: 0 }).errors, []);
  }
  const blankSku = map('BR', {}, { full_sku: null });
  assert.deepEqual(blankSku.errors, []);
  assert.equal(blankSku.base.sku, '');
  assert.equal(blankSku.base.name, 'Браслет з натурального бурштину. Арт: ');
});
