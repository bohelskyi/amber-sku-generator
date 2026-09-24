// Synthetic model of the narrowly inspected OFFICE evidence, not a data dump.
const { catalog } = require('./contract');
const { materializeMagentoV1 } = require('../../../src/services/export-templates/magento-v1-definition');

function officeCatalog() {
  const result = catalog();
  result.get('AR').get('size').options = Array.from({ length: 31 }, (_, i) => ({ value_id: i + 1 }));
  return result;
}

function officeEvidence() {
  const definition = materializeMagentoV1(officeCatalog());
  const evidence = { categories: definition.groups.map((g) => g.route), questions: [], schemas: [] };
  for (const [id, source] of Object.entries(definition.sources)) {
    if (source.kind === 'product' || id === 'KL.exact_size') continue;
    const allowed = definition.questionContracts[id]?.allowed || [];
    const sku = ['NM.extra', 'AR.size'].includes(id);
    evidence.questions.push({ category_code: source.category, key: source.key,
      label: id === 'NM.extra' ? 'Додатково' : id === 'AR.size' ? 'Розмір картини' : source.key,
      include_in_sku: sku ? 1 : 0, input_type: source.kind === 'information' ? 'text' : 'options', value_ids: allowed });
    if (sku) evidence.schemas.push({ id: id === 'NM.extra' ? 12 : 14, category_code: source.category,
      questions: [{ key: source.key, value_ids: id === 'NM.extra' ? ['1', '2'] : allowed.slice(0, 28) }] });
  }
  return evidence;
}

module.exports = { officeCatalog, officeEvidence };
