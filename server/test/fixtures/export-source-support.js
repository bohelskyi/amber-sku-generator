const { officeCatalog, officeEvidence } = require('./magento-v1/office');
const { product } = require('./magento-v1/contract');
const { materializeMagentoV1 } = require('../../src/services/export-templates/magento-v1-definition');
const { upgradeColumns } = require('../../src/services/export-templates/column-contract');
const { buildBaseSku, appendSkuSuffix } = require('../../src/utils/sku');

function schema(category, version = 1) {
  const key = category === 'NM' ? 'extra' : 'size';
  const values = category === 'NM' ? [1, 2] : Array.from({ length: version === 1 ? 27 : version === 2 ? 28 : 31 }, (_, i) => i + 1);
  return { id: (category === 'NM' ? 400 : 500) + version, version, category_code: category,
    questions: [{ key, label: 'Synthetic historical question', sku_index: 0, required: category === 'NM' ? 0 : 1, sku_separator: '.',
      options: values.map((value_id) => ({ value_id, sku_code: String(value_id + 10), label: 'Synthetic semantic ' + value_id })) }] };
}
function stored(schema, value, overrides = {}) {
  const q = schema.questions[0];
  const code = q.options.find((o) => String(o.value_id) === String(value))?.sku_code ?? '0';
  const prefix = schema.category_code + (schema.version === 1 ? '' : `${schema.version}/`);
  return product(schema.category_code, { [q.key]: value }, { sku_schema_version_id: schema.id,
    full_sku: appendSkuSuffix(buildBaseSku(prefix, [{ value: code, sku_separator: q.sku_separator }]), 123), ...overrides });
}
function homeDefinition() {
  const d = upgradeColumns(materializeMagentoV1(officeCatalog()));
  const br = d.groups.find((g) => g.route === 'BR');
  br.columns = ['sku', 'store_view_code', 'name', 'test_export_note', 'test_export_color', 'price', ...br.columns.filter((c) => !['sku', 'store_view_code', 'name', 'price'].includes(c))];
  br.columnLabels.test_export_note = 'Домашня примітка';
  br.rows[0].cells.test_export_note = { op: 'literal', value: 'ПЕРЕВІРКА' };
  br.rows[0].cells.test_export_color = { op: 'lookup', table: 'color4', input: { op: 'semanticKey', input: { op: 'source', id: 'BR.color' } }, otherwise: { op: 'literal', value: '' } };
  br.rows[1].cells.test_export_note = { op: 'literal', value: '' };
  br.rows[1].cells.test_export_color = { op: 'literal', value: '' };
  return d;
}
module.exports = { schema, stored, homeDefinition, officeEvidence };
