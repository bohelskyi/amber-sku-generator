const c = require('./binding-contract');
const FORMAT = 'historical-manual-render-v1';
const ref = id => ({ op: 'ref', id });
const source = id => ({ op: 'source', id });
const text = (input, trim, format = 'scalar-v1') => ({ op: 'text', input, trim, format, onAbsent: 'empty' });
const equal = (a, b) => a != null && c.hash(a) === c.hash(b);
function nameRender(amber) {
  const d = amber.compiled.definition, bindings = new Map(d.bindings.map(b => [b.id, b]));
  const binding = id => bindings.get(id)?.value;
  const group = d.groups.find(g => g.route === 'SV');
  const expected = {
    sku: text(source('public_sku'), false),
    'SV.manualUa': text(source('magento_name_subject_ua'), true, 'string-only-v1'),
    'SV.manualEn': text(source('magento_name_subject_en'), true, 'string-only-v1'),
    'SV.manualPair': { op: 'all', items: ['SV.manualUa', 'SV.manualEn'].map(id => ({ op: 'present', input: ref(id), policy: 'answer-v1' })) },
  };
  if (d.nameReadiness || !group || Object.entries(expected).some(([id, value]) => !equal(binding(id), value))
    || ['public_sku', 'magento_name_subject_ua', 'magento_name_subject_en'].some(field => !equal(d.sources[field],
      { kind: 'product', field, type: field === 'public_sku' ? 'text' : 'scalar' }))) return null;
  const result = { format: FORMAT };
  for (const [language, rowId, id, subject] of [['ua', 'base', 'SV.nameUa', 'SV.manualUa'], ['en', 'english', 'SV.nameEn', 'SV.manualEn']]) {
    const expression = binding(id), manual = expression?.then;
    if (!equal(group.rows.find(r => r.id === rowId)?.cells.name, ref(id)) || expression?.op !== 'when'
      || !equal(expression.if, ref('SV.manualPair')) || manual?.op !== 'interpolate'
      || !equal(manual.slots, { subject: ref(subject), sku: ref('sku') })
      || typeof manual.template !== 'string' || manual.template.length > 1024
      || manual.template.split('{subject}').length !== 2 || manual.template.split('{sku}').length !== 2
      || /[{}]/.test(manual.template.replace('{subject}', '').replace('{sku}', ''))) return null;
    const [prefix, suffix] = manual.template.replace('{sku}', amber.product.public_sku).split('{subject}');
    result[language] = { prefix, suffix };
  }
  return result;
}
module.exports = { nameRender, FORMAT };
