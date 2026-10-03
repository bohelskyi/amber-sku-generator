const { materializeMagentoV1 } = require('../../src/services/export-templates/magento-v1-definition');
const { compileDefinition } = require('../../src/services/export-templates/definition');
const { describeMapper } = require('../../src/services/magento/mapper-schema');
const { buildCandidates } = require('../../src/services/magento/binding-bootstrap');
const { normalizeSchema, originHash } = require('../../src/services/magento/binding-contract');
const { catalog } = require('./magento-v1/contract');

// Full v3/fixed-column materialization, including the legacy eager checks that
// caused the production reset. No production catalog or remote data is used.
function fixture() {
  const next = materializeMagentoV1(catalog(), { publicSku: true });
  const old = structuredClone(next);
  const size = old.bindings.find(b => b.id === 'SV.rozmir_suveniriv');
  size.value = size.value.else;
  const mapper = describeMapper(next);
  const schema = normalizeSchema({ storeCode: 'all',
    storeTopology: { websites: [{ id: 701, code: 'fixture', name: 'Fixture' }],
      storeGroups: [{ id: 702, name: 'Group', website_id: 701, root_category_id: 703, default_store_id: 704 }],
      storeViews: [{ id: 704, code: 'en', name: 'English', website_id: 701, store_group_id: 702, is_active: true }] },
    attributes: mapper.targets.map((target, index) => ({ attribute_code: target.target, attribute_id: 10000 + index,
      frontend_input: target.usages.some(u => u.values.some(v => v.kind === 'dictionary')) ? 'select' : 'text',
      options: [...new Set(target.usages.flatMap(u => u.values.map(v => v.label)))].filter(Boolean)
        .map((label, i) => ({ value: String(20000 + index * 100 + i), label })) })),
    attributeSets: mapper.attributeSets.map((set, i) => ({ attribute_set_id: 30000 + i,
      attribute_set_name: set.attribute_set_code, attributeCodes: mapper.targets.map(t => t.target) })) });
  // One unchanged refused option on both SV routes; fresh discovery still lacks it.
  schema.attributes.find(a => a.attribute_code === 'kolir').options =
    schema.attributes.find(a => a.attribute_code === 'kolir').options.filter(o => o.label !== 'Пейзажний');
  const candidates = (definition = next, observation = schema) => buildCandidates({
    compiled: compileDefinition(definition), products: [], current: [],
  }, observation, [], { includeStaticCategories: true });
  const bindings = candidates(old);
  const souvenir = bindings.routes.find(r => r.routeKey === 'SV.souvenir!=value_id:5');
  for (const r of bindings.routes) { r.reviewState = 'approved'; r.enabled = true; }
  // Previously reviewed compatibility decision: both SV routes use Souvenirs.
  bindings.routes.find(r => r.routeKey === 'SV.souvenir=value_id:5').setId = souvenir.setId;
  for (const a of bindings.attributes) {
    a.reviewState = 'approved';
    for (const category of a.evidence.categories || []) category.reviewState = category.categoryId ? 'approved' : 'blocked';
  }
  for (const o of bindings.options) o.reviewState = o.optionId ? 'approved' : 'blocked';
  for (const p of bindings.policies) {
    const a = bindings.attributes.find(a => a.bindingKey === p.bindingKey);
    p.reviewState = 'approved';
    p.policy = a.target === 'product_online' ? 'initialize_create_only'
      : a.target === 'name' ? 'magento_managed' : 'authoritative_create_update';
    if (p.policy === 'initialize_create_only') p.evidence.createValue = 2;
  }
  return { old, next, schema, candidates,
    source: { originHash: originHash('https://successor.invalid'), schema, bindings } };
}

module.exports = { fixture };
