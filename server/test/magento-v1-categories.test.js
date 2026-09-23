const assert = require('node:assert/strict');
const test = require('node:test');
const { mapProduct } = require('../src/services/magento-products-v1');
const { product, catalog, dictionaries } = require('./fixtures/magento-v1/contract');
const { cases } = require('./fixtures/magento-v1/expected-rows');

// Explicit category suffixes, independent of production category dictionaries.
// Each case replaces one path in the independently specified complete base row.
const pathCases = {
  BR: [
    ['raw_type', 1, ['Браслети з цільного каменю бурштину', 'Браслети з формованого бурштину']],
    ['processing', 2, ['Браслети з полірованими намистинами', 'Браслети з шліфованими намистинами']],
    ['texture', 3, ['Браслети з прозорою фактурою намистин', 'Браслети з напівпрозорою фактурою намистин', 'Браслети з матовою фактурою намистин', 'Браслети з прозорою фактурою намистин', 'Браслети з напівпрозорою фактурою намистин', 'Браслети з матовою фактурою намистин', 'Браслети з пейзажною фактурою намистин', 'Браслети з змішаною фактурою намистин']],
    ['color', 4, ['Браслети світлого кольору', 'Браслети темного кольору', 'Браслети пейзажного кольору', 'Браслети комбінованого кольору']],
    ['shape', 5, ['Браслети з намистинами: кулі', 'Браслети з намистинами: бочки', 'Браслети з намистинами: оливки', 'Браслети з намистинами: сегменти', 'Браслети з намистинами: галька', 'Браслети з намистинами: геометрія', 'Браслети з намистинами: змішана форма']],
    ['style', 6, ['Класичні браслети', 'Комбіновані браслети', 'Комбіновані браслети', 'Комбіновані браслети', 'Шамбала']],
  ],
  NM: [
    ['raw_type', 1, ['Намиста з цільного каменю бурштину', 'Намиста з формованого бурштину']],
    ['processing', 2, ['Намиста з полірованими намистинами', 'Намиста з шліфованими намистинами']],
    ['texture', 3, ['Намиста з прозорою фактурою намистин', 'Намиста з напівпрозорою фактурою намистин', 'Намиста з матовою фактурою намистин', 'Намиста з прозорою фактурою намистин', 'Намиста з напівпрозорою фактурою намистин', 'Намиста з матовою фактурою намистин', 'Намиста з пейзажною фактурою намистин', 'Намиста з змішаною фактурою намистин']],
    ['color', 4, ['Намиста світлого кольору', 'Намиста темного кольору', 'Намиста пейзажного кольору', 'Намиста комбінованого кольору']],
    ['shape', 5, ['Намиста з намистинами: кулі', 'Намиста з намистинами: бочки', 'Намиста з намистинами: оливки', 'Намиста з намистинами: сегменти', 'Намиста з намистинами: галька', 'Намиста з намистинами: геометрія', 'Намиста з намистинами: змішані форми']],
    ['style', 6, ['Класичні намиста', 'Комбіновані намиста', 'Комбіновані намиста', 'Комбіновані намиста']],
  ],
  KL: [
    ['raw_type', 1, ['Кулони з цільного каменю бурштину', 'Кулони з формованого бурштину']],
    ['processing', 2, ['Кулони з полірованою поверхнею', 'Кулони з шліфованою поверхнею']],
    ['texture', 3, ['Кулони з прозорою фактурою', 'Кулони з напівпрозорою фактурою', 'Кулони з матовою фактурою', 'Кулони з прозорою фактурою', 'Кулони з напівпрозорою фактурою', 'Кулони з матовою фактурою', 'Кулони з пейзажною фактурою']],
    ['color', 4, ['Кулони світлого кольору', 'Кулони темного кольору']],
    ['type', 5, ['Природна форма кулона', 'Форма: коло', 'Форма: овал', 'Форма: серце', 'Форма: крапля', 'Форма: хрест']],
  ],
  CH: [
    ['raw_type', 1, ['Чотки з цільного каменю бурштину', 'Чотки з формованого бурштину']],
    ['texture', 2, ['Чотки з прозорими намистинами', 'Чотки з напівпрозорими намистинами', 'Чотки з матовими намистинами', 'Чотки з прозорими намистинами', 'Чотки з напівпрозорими намистинами', 'Чотки з матовими намистинами', 'Чотки з пейзажними намистинами']],
    ['color', 3, ['Чотки світлого кольору', 'Чотки темного кольору', 'Чотки пейзажного кольору']],
    ['shape', 4, ['Чотки з намистинами у формі кулі', 'Чотки з намистинами у формі бочки', 'Чотки з намистинами у формі оливки']],
    ['religion', 5, ['Мусульманські чотки', 'Християнські чотки']],
  ],
};

for (const [group, variations] of Object.entries(pathCases)) {
  test(`${group} every category-only phrase, in complete path order`, () => {
    const baseline = cases.find((c) => c.id === group).base.categories.split(',');
    for (const [key, position, values] of variations) {
      for (const [index, suffix] of values.entries()) {
        const expected = [...baseline];
        expected[position] = `${baseline[0]}/${suffix}`;
        const mapped = mapProduct(product(group, { [key]: index + 1 }), catalog());
        assert.deepEqual(mapped.errors, []);
        assert.equal(mapped.base.categories, expected.join(','), `${key}=${index + 1}`);
      }
    }
  });
}

test('natural/pressed UA and EN names across all four jewelry groups', () => {
  for (const [group, ua, en] of [['BR', 'Браслет', 'bracelet'], ['NM', 'Намисто', 'necklace'], ['KL', 'Кулон', 'pendant'], ['CH', 'Чотки', 'rosary']]) {
    for (const [raw_type, material, english] of [[1, 'натурального', 'Natural'], [2, 'формованого', 'Pressed']]) {
      const mapped = mapProduct(product(group, { raw_type }), catalog());
      assert.deepEqual(mapped.errors, []);
      assert.equal(mapped.base.name, `${ua} з ${material} бурштину. Арт: ${group}-SYNTH-001`);
      assert.equal(mapped.english.name, `${english} amber ${en}. Art: ${group}-SYNTH-001`);
    }
  }
});

test('NM extra path and CH genuine count zero through all accepted counts', () => {
  const nm = cases.find((c) => c.id === 'NM').base.categories;
  for (const [extra, suffix] of [[0, ''], ['0', ''], [1, ',Default/Намиста/Намиста з підвісками'], [2, '']]) {
    const mapped = mapProduct(product('NM', { extra }), catalog());
    assert.deepEqual(mapped.errors, []);
    assert.equal(mapped.base.categories, nm + suffix);
  }
  const prefix = cases.find((c) => c.id === 'CH').base.categories.split(',').slice(0, -1).join(',');
  for (const [count, beads] of [[0, '30'], ['0', '30'], [1, '33'], [2, '39'], [3, '45'], [4, '51'], [5, '66'], [6, '75'], [7, '99']]) {
    const mapped = mapProduct(product('CH', { count }), catalog());
    assert.deepEqual(mapped.errors, []);
    assert.equal(mapped.base.categories, `${prefix},Default/Чотки/Чотки на ${beads} намистин`);
  }
});

test('AR seven type branches have exact names, categories and complete SEO', () => {
  const rows = [
    [1, 'Ікона з бурштину', 'Amber icon', 'Ікони', 'ікони'],
    [2, 'Картина з бурштину пейзаж', 'Amber landscape painting', 'Пейзажі', 'пейзажі'],
    [3, 'Панно з бурштину', 'Amber panel', 'Панно', 'панно'],
    [4, 'Картина з бурштину символіка', 'Amber symbolic painting', 'Символіка', 'картини із символікою'],
    [5, 'Картина з бурштину натюрморт', 'Amber still life painting', 'Натюрморти', 'натюрморти'],
    [6, 'Портрет з бурштину', 'Amber portrait', 'Портрети', 'портрети'],
    [7, 'Мозаїка з бурштину', 'Amber mosaic', 'Мозаїка', 'декоративну мозаїку'],
  ];
  for (const [type, ua, en, title, subject] of rows) {
    const mapped = mapProduct(product('AR', { type }), catalog());
    assert.deepEqual(mapped.errors, []);
    assert.equal(mapped.base.name, `${ua}. Арт: AR-SYNTH-001`);
    assert.equal(mapped.english.name, `${en}. Art: AR-SYNTH-001`);
    assert.equal(mapped.base.categories, `Default/Картини,Default/Картини/${title}`);
    assert.equal(mapped.base.meta_title, `${title} з бурштину від виробника | купити в Amber Galbin`);
    const description = type === 7
      ? 'Купити декоративну мозаїку з бурштину від виробника Amber Galbin. Ручне оформлення підкреслює природну фактуру бурштину. Картини з бурштину від Amber Galbin'
      : `Купити ${subject} з бурштину від виробника Amber Galbin. Ручна робота підкреслює природну фактуру та красу бурштину. Картини з бурштину від Amber Galbin`;
    assert.equal(mapped.base.meta_description, description);
    assert.equal(mapped.english.meta_title, undefined);
    assert.equal(mapped.english.meta_description, undefined);
  }
});

test('SV category routing, all statuette/game paths, Stone processing and literal key 2', () => {
  const manual = { magento_name_subject_ua: 'Предмет', magento_name_subject_en: 'object' };
  for (const [souvenir, name] of Object.entries(dictionaries.svSouvenir)) {
    const mapped = mapProduct(product('SV', { souvenir }, manual), catalog());
    assert.deepEqual(mapped.errors, []);
    const expected = souvenir === '5'
      ? 'Default/Камінь,Default/Камінь/Камінь сувенірний'
      : `Default/Сувеніри,Default/Сувеніри/${name}`;
    assert.equal(mapped.base.categories, expected);
  }
  for (const [statuette, name] of Object.entries(dictionaries.svStatuette)) {
    const mapped = mapProduct(product('SV', { souvenir: 1, statuette }, manual), catalog());
    assert.deepEqual(mapped.errors, []);
    assert.equal(mapped.base.categories, `Default/Сувеніри,Default/Сувеніри/Статуетки,Default/Сувеніри/Статуетки/${name}`);
  }
  for (const [table_games, name] of Object.entries(dictionaries.svGames)) {
    const mapped = mapProduct(product('SV', { souvenir: 2, table_games }, manual), catalog());
    assert.deepEqual(mapped.errors, []);
    assert.equal(mapped.base.categories, `Default/Сувеніри,Default/Сувеніри/Настільні ігри,Default/Сувеніри/Настільні ігри/${name}`);
  }
  for (const [stone_processing, name] of [[0, 'Необроблений'], ['0', 'Необроблений'], [1, 'Полірований']]) {
    const mapped = mapProduct(product('SV', { souvenir: 5, stone_processing }, manual), catalog());
    assert.deepEqual(mapped.errors, []);
    assert.equal(mapped.base.categories, `Default/Камінь,Default/Камінь/Камінь сувенірний,Default/Камінь/${name}`);
  }
  const theme = mapProduct(product('SV', { '2': 2, theme: 6, bird: 3 }, manual), catalog());
  assert.equal(theme.base.tematyka_vyrobu, 'Птахи');
  assert.equal(theme.base.vyd_ptakha, 'Сова');
});

test('hidden attributes do not consistently hide categories or names (legacy compatibility)', () => {
  const rules = catalog();
  rules.get('BR').get('style').visible_if_json = { raw_type: 2 };
  const br = mapProduct(product('BR', { style: 999 }), rules);
  assert.deepEqual(br.errors, []);
  assert.equal(br.base.typ_vykonannia, '');
  assert.ok(br.base.categories.endsWith('/Комбіновані браслети'));
  rules.get('BR').get('raw_type').visible_if_json = { raw_type: 2 };
  assert.deepEqual(mapProduct(product('BR', { raw_type: 0 }), rules).errors, [
    { field: 'name', message: 'Немає мапінгу raw_type для назви.' },
    { field: 'categories', message: 'Немає категорії для raw_type.' },
  ]);
  rules.get('AR').get('type').visible_if_json = { type: 7 };
  const ar = mapProduct(product('AR'), rules);
  assert.deepEqual(ar.errors, []);
  assert.equal(ar.base.kartynyy, '');
  assert.equal(ar.base.categories, 'Default/Картини,Default/Картини/');
  assert.equal(ar.base.name, 'Ікона з бурштину. Арт: AR-SYNTH-001');
  rules.get('SV').get('souvenir').visible_if_json = { souvenir: 1 };
  const sv = mapProduct(product('SV'), rules);
  assert.deepEqual(sv.errors, []);
  assert.equal(sv.base.categories, 'Default/Сувеніри,Default/Сувеніри/');
});

test('current source-key references have no alias resolution or historical schema fallback', () => {
  const rules = catalog();
  const old = rules.get('SV').get('2');
  rules.get('SV').delete('2');
  rules.get('SV').set('theme', old);
  const mapped = mapProduct(product('SV', { theme: 2 }, { sku_schema_version_id: 77 }), rules);
  assert.equal(mapped.base.tematyka_vyrobu, '');
  assert.deepEqual(mapped.errors, [{ field: 'tematyka_vyrobu', message: 'В каталозі немає питання 2.' }]);
  // Existing catalog key but renamed stored answer: optional answer becomes blank.
  const missingAnswer = mapProduct(product('SV', { theme: 2 }), catalog());
  assert.deepEqual(missingAnswer.errors, []);
  assert.equal(missingAnswer.base.tematyka_vyrobu, '');
});
