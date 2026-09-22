const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ATTRIBUTE, GROUPS, HEADERS, mapProduct,
} = require('../src/services/magento-products-v1');

const ANSWERS = {
  BR: { raw_type: 1, processing: 1, texture: 1, color: 1,
    shape: 1, style: 1, braclet_size: '16' },
  NM: { raw_type: 1, processing: 1, texture: 1, color: 1,
    shape: 1, style: 1, extra: 0, neckle_size: '40' },
  KL: { raw_type: 1, processing: 1, texture: 1, color: 1,
    type: 1, addit: 1, pedant_size: '2 см' },
  CH: { raw_type: 1, texture: 1, color: 1, shape: 1,
    religion: 1, count: 1, bead_length: '9', bead_width: '8',
    rosary_length: '30', is_calibrated: 3 },
  AR: { type: 1, size: 1, glass: 1, additional: 1, backlight: 1 },
  SV: { material: 1, color: 1, souvenir: 6, weight: '25', size: '5 см' },
};

function catalogFor(group, answers) {
  const questions = new Map();
  for (const [key] of Object.values(ATTRIBUTE[group])) {
    questions.set(key, { required: 0, visible_if_json: null,
      options: answers[key] === undefined ? [] : [{ value_id: answers[key] }] });
  }
  return new Map([[group, questions]]);
}

test('each Magento group maps semantic answers to a complete base row and a sparse EN row', () => {
  for (const [group, answers] of Object.entries(ANSWERS)) {
    const mapped = mapProduct({
      id: 1, category: group, full_sku: `${group}-ART-001`,
      weight: 10, total_price_uah: '2000.00', details: { answers },
    }, catalogFor(group, answers));
    assert.deepEqual(mapped.errors, [], `${group}: ${JSON.stringify(mapped.errors)}`);
    assert.equal(mapped.base.attribute_set_code, GROUPS[group]);
    assert.equal(mapped.english.attribute_set_code, mapped.base.attribute_set_code);
    assert.equal(mapped.base.price, '2000');
    assert.equal(mapped.base.store_view_code, '');
    assert.equal(mapped.english.store_view_code, 'en');
    assert.equal(mapped.base.is_ownproduction, 'Yes');
    assert.equal(mapped.base.old_product, 'No');
    assert.equal(mapped.base.product_type, 'simple');
    assert.equal(mapped.english.product_type, 'simple');
    assert.deepEqual(Object.keys(mapped.english).sort(), [
      'sku', 'store_view_code', 'name', 'attribute_set_code', 'product_type',
      ...(['NM', 'KL'].includes(group) ? ['meta_title'] : []),
      ...(group === 'NM' ? ['meta_description'] : []),
    ].sort());
    assert.equal(HEADERS[group][0], 'sku');
    assert.equal(HEADERS[group][1], 'store_view_code');
  }
});

test('KL dimensions use current pedant_size before stored legacy exact_size', () => {
  const mapKl = (answers) => mapProduct({
    id: 2, category: 'KL', full_sku: 'KL-ART-002', weight: 10,
    total_price_uah: '2000.00', details: { answers },
  }, catalogFor('KL', answers));
  const current = { ...ANSWERS.KL, pedant_size: '4,2/2,7 см', exact_size: '3.8/2.5' };
  assert.equal(mapKl(current).base.rozmir_iuvelirnoho_vyrobu, '4,2/2,7 см');
  const legacy = { ...ANSWERS.KL, exact_size: '3.8/2.5' };
  delete legacy.pedant_size;
  assert.equal(mapKl(legacy).base.rozmir_iuvelirnoho_vyrobu, '3.8/2.5');
  delete legacy.exact_size;
  assert.equal(mapKl(legacy).base.rozmir_iuvelirnoho_vyrobu, '');
});

test('CH numeric attributes normalize decimal separators without changing stone size', () => {
  const answers = { ...ANSWERS.CH, bead_length: '15,8', bead_width: '8.2', rosary_length: ' 30,5 ' };
  const mapped = mapProduct({ category: 'CH', full_sku: 'CH-DECIMAL', weight: 10,
    total_price_uah: 2000, details: { answers } }, catalogFor('CH', answers));
  assert.deepEqual(mapped.errors, []);
  assert.equal(mapped.base.dovzhyna_namystyny, '15.8');
  assert.equal(mapped.base.diametr_namystyny, '8.2');
  assert.equal(mapped.base.dovzhyna_vyrobu, '30.5');
  assert.equal(mapped.base.rozmir_kameniu, '15,8×8.2');
});

test('CH invalid present numeric attributes fail readiness for the exact field', () => {
  for (const [key, field] of [['bead_length', 'dovzhyna_namystyny'],
    ['bead_width', 'diametr_namystyny'], ['rosary_length', 'dovzhyna_vyrobu']]) {
    for (const value of ['15,8 cm', '1,2.3', 'NaN', 'Infinity', '0x10', '1e2', true, '9/8']) {
      const answers = { ...ANSWERS.CH, [key]: value };
      const mapped = mapProduct({ category: 'CH', full_sku: 'CH-INVALID', weight: 10,
        total_price_uah: 2000, details: { answers } }, catalogFor('CH', answers));
      assert.ok(mapped.errors.some((error) => error.field === field), `${key}: ${value}`);
      assert.equal(mapped.base[field], '');
    }
  }
});

test('Stone EN attribute set matches its base row', () => {
  const answers = { ...ANSWERS.SV, souvenir: 5, stone: 1 };
  const mapped = mapProduct({ category: 'SV', full_sku: 'SV-STONE', weight: 10,
    total_price_uah: 2000, details: { answers },
    magento_name_subject_ua: 'Камінь', magento_name_subject_en: 'Stone' }, catalogFor('SV', answers));
  assert.equal(mapped.base.attribute_set_code, 'Камінь');
  assert.equal(mapped.english.attribute_set_code, mapped.base.attribute_set_code);
});
