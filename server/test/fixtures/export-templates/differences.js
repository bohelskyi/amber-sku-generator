// Closed PR1B non-parity register. No catch-all coercion or readiness exemption.
const assert = require('node:assert/strict');
const { product, catalog } = require('../magento-v1/contract');
const malformedRules = ['{broken', 'null', '[]', '42', '"text"', [], true, 42, { $and: 'bad' }];
const cases = malformedRules.map((rule, i) => ({ id: `D-rule-${i + 1}`, code: 'TEMPLATE_INVALID',
  input: product('NM', { extra: 1 }), rules: (() => {
    const rules = catalog(); rules.get('NM').get('extra').visible_if_json = rule; return rules;
  })(), oldField: 'dodatkovo_namysta', oldValue: i === 8 ? '' : 'З підвісками', oldErrors: [] }));
for (const [key, field] of [['bead_length', 'dovzhyna_namystyny'], ['bead_width', 'diametr_namystyny'], ['rosary_length', 'dovzhyna_vyrobu']]) {
  cases.push({ id: `D-composite-${key}`, code: 'INPUT_INVALID', input: product('CH', { [key]: {} }), rules: catalog(),
    oldField: field, oldValue: '', oldErrors: [{ field, message: 'Некоректне числове значення для Magento.' }] });
}
cases.push(
  { id: 'D-price-array', code: 'INPUT_INVALID', input: product('BR', {}, { total_price_uah: [12] }), rules: catalog(),
    oldField: 'price', oldValue: '12', oldErrors: [] },
  { id: 'D-price-object', code: 'INPUT_INVALID', input: product('BR', {}, { total_price_uah: {} }), rules: catalog(),
    oldField: 'price', oldValue: '', oldErrors: [{ field: 'price', message: 'Немає додатної збереженої фінальної ціни UAH.' }] },
  { id: 'D-text-object', code: 'INPUT_INVALID', input: product('BR', { braclet_size: {} }), rules: catalog(),
    oldField: 'dovzhyna_brasletu_diuimiv', oldValue: '[object Object]', oldErrors: [] },
  { id: 'D-semantic-array', code: 'INPUT_INVALID', input: product('BR', { raw_type: [1] }), rules: catalog(),
    oldField: 'typy_obrobky_burshtynu', oldValue: 'Натуральний', oldErrors: [] },
  { id: 'D-semantic-boolean', code: 'INPUT_INVALID', input: product('NM', { extra: false }), rules: catalog(),
    oldField: 'dodatkovo_namysta', oldValue: '', oldErrors: [{ field: 'dodatkovo_namysta', message: 'Немає Magento-мапінгу для extra=false.' }] }
);

function classify(input, rules) {
  // Matching only the exact malformed values present in the immutable oracle.
  const rule = rules.get('NM')?.get('extra')?.visible_if_json;
  const index = malformedRules.findIndex((r) => JSON.stringify(r) === JSON.stringify(rule));
  if (input.category === 'NM' && index >= 0) return cases[index];
  const answers = input.details?.answers || {};
  const emptyObject = (v) => v && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length === 0;
  if (input.category === 'CH') {
    for (const key of ['bead_length', 'bead_width', 'rosary_length']) {
      if (emptyObject(answers[key])) return cases.find((c) => c.id === `D-composite-${key}`);
    }
  }
  if (input.category === 'BR') {
    if (Array.isArray(input.total_price_uah) && input.total_price_uah.length === 1 && input.total_price_uah[0] === 12) return cases.find((c) => c.id === 'D-price-array');
    if (emptyObject(input.total_price_uah)) return cases.find((c) => c.id === 'D-price-object');
    if (emptyObject(answers.braclet_size)) return cases.find((c) => c.id === 'D-text-object');
    if (Array.isArray(answers.raw_type) && answers.raw_type.length === 1 && answers.raw_type[0] === 1) return cases.find((c) => c.id === 'D-semantic-array');
  }
  if (input.category === 'NM' && answers.extra === false) return cases.find((c) => c.id === 'D-semantic-boolean');
  return null;
}
function assertOld(entry, mapped) {
  assert.equal(mapped.base[entry.oldField], entry.oldValue, entry.id);
  assert.deepEqual(mapped.errors, entry.oldErrors, entry.id);
}
const supplemental = [
  { id: 'D-sku-number', input: product('BR', {}, { full_sku: 0 }), oldField: 'sku', oldValue: '', oldErrors: [] },
  { id: 'D-sku-boolean', input: product('BR', {}, { full_sku: false }), oldField: 'sku', oldValue: '', oldErrors: [] },
  { id: 'D-manual-composite', input: product('SV', {}, { magento_name_subject_ua: {}, magento_name_subject_en: 'owl' }),
    oldField: 'name', oldValue: 'Брелок з бурштину. Арт: SV-SYNTH-001', oldErrors: [] },
  ...[NaN, Infinity].map((value) => ({ id: `D-semantic-${String(value)}`, input: product('NM', { extra: value }),
    oldField: 'dodatkovo_namysta', oldValue: '',
    oldErrors: [{ field: 'dodatkovo_namysta', message: `Немає Magento-мапінгу для extra=${String(value)}.` }] })),
];
const catalogCases = [
  ['D-catalog-required', (q) => { q.required = 2; }, 'Натуральний'],
  ['D-catalog-options-shape', (q) => { q.options = {}; }, 'Натуральний'],
  ['D-catalog-duplicate-option', (q) => { q.options.push({ value_id: '1' }); }, 'Натуральний'],
  ['D-catalog-option-type', (q) => { q.options = [{ value_id: {} }]; }, 'Натуральний'],
  ['D-catalog-rule-object', (q) => { q.visible_if_json = { raw_type: {} }; }, ''],
].map(([id, mutate, oldValue]) => {
  const rules = catalog(); mutate(rules.get('BR').get('raw_type'));
  return { id, rules, input: product('BR'), oldField: 'typy_obrobky_burshtynu', oldValue, oldErrors: [] };
});
module.exports = { cases, supplemental, catalogCases, classify, assertOld };
