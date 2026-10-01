const test = require('node:test');
const assert = require('node:assert/strict');
const { schema: historicalSchema, stored, homeDefinition, officeEvidence } = require('./fixtures/export-source-support');
const { upgradeSourceSupport, projectSupportProducts } = require('../src/services/export-templates/source-support');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { describeMapper, CSV_FIELDS } = require('../src/services/magento/mapper-schema');
const { buildCandidates } = require('../src/services/magento/binding-bootstrap');
const { normalizeSchema, hash } = require('../src/services/magento/binding-contract');
const { planPreview } = require('../src/services/magento/sync-preview');
const { readPreviewProduct } = require('../src/services/magento/sync-preview-db');

function fixture(value = 0, alter = () => {}) {
  const definition = upgradeSourceSupport(homeDefinition(), officeEvidence());
  const historical = historicalSchema('NM');
  alter(definition, historical);
  const compiled = compileDefinition(definition);
  const product = stored(historical, value, { status: 'active', exclude_from_export: 0 });
  const mapper = describeMapper(definition);
  const attributes = mapper.targets.filter((t) => !CSV_FIELDS.has(t.target)).map((t, i) => ({
    attribute_id: 100 + i, attribute_code: t.target,
    frontend_input: t.usages.some((u) => u.values.some((v) => v.kind === 'dictionary')) ? 'select' : 'text',
    options: [...new Set(t.usages.flatMap((u) => u.values.map((v) => v.label)))].filter(Boolean)
      .map((label, j) => ({ value: String(1000 + j), label })),
  }));
  const schema = normalizeSchema({ storeCode: 'all', attributes,
    attributeSets: mapper.attributeSets.map((s, i) => ({ attribute_set_id: 600 + i,
      attribute_set_name: s.attribute_set_code, attributeCodes: attributes.map((a) => a.attribute_code) })),
    storeTopology: { websites: [], storeGroups: [], storeViews: [] } });
  const amber = { compiled, product: projectSupportProducts([product], [historical])[0],
    current: [{ category_code: 'NM', key: 'extra', options: [{ value_id: 0 }] }], products: [] };
  const bindings = buildCandidates(amber, schema, [], { group: 'NM' });
  amber.revision = { id: 'synthetic', revision: '1', schema, schemaFingerprint: hash(schema),
    topologyFingerprint: hash(schema.storeTopology), bindings };
  return { amber, schema, historical, product, definition };
}
const preview = (f) => planPreview(f.amber, f.schema, null, []);
const extra = (r) => r.attributes.find((a) => a.target === 'dodatkovo_namysta');

test('proven NM numeric-zero placeholder omits the Magento field while retaining its blocked emission decision', () => {
  const f = fixture(); const before = structuredClone(f.amber.revision.bindings);
  const r = preview(f);
  assert.equal(r.evaluation.ready, true);
  assert.equal(extra(r).authority, 'not_applicable');
  assert.equal(r.blockers.some((b) => b.target === 'dodatkovo_namysta'), false);
  assert.equal(r.candidatePayload.product.custom_attributes.some((a) => a.attribute_code === 'dodatkovo_namysta'), false);
  const updated = planPreview(f.amber, f.schema, { id: 12, sku: f.product.full_sku,
    attribute_set_id: r.attributeSet.selected.id, custom_attributes: [{ attribute_code: 'dodatkovo_namysta', value: 'retained-id' }],
    extension_attributes: { category_links: [] } }, []);
  assert.equal(extra(updated).authority, 'not_applicable');
  assert.equal(updated.candidatePayload.product.custom_attributes.some((a) => a.attribute_code === 'dodatkovo_namysta'), false);
  assert.ok(updated.untouchedMagentoFields.some((a) => a.field === 'dodatkovo_namysta' && a.action === 'preserve'));
  assert.deepEqual(f.amber.revision.bindings, before);
});

test('placeholder omission never authorizes emitted, genuine-zero, string-zero or unproven values', () => {
  const cases = [fixture('0'), fixture(0, (d) => { d.tables.nmExtra[0] = 'Unexpected'; }),
    fixture(0, (d, s) => { s.questions[0].options.push({ value_id: 0, sku_code: '8' });
      d.sourceSupport.sources['NM.extra'].semanticValues.push('0'); }), fixture()];
  cases.at(-1).amber.product = { ...cases.at(-1).amber.product }; // drops trusted schema projection
  for (const f of cases) {
    const decision = f.amber.revision.bindings.options.find((o) => o.questionKey === 'extra' && o.valueId === '0');
    Object.assign(decision, { reviewState: 'blocked', evaluatedOutput: null, optionId: null });
    const r = preview(f);
    assert.equal(extra(r).authority, 'blocked');
    assert.ok(r.blockers.some((b) => b.code === 'MAPPING_EXPLICITLY_BLOCKED' && b.target === 'dodatkovo_namysta'));
    assert.equal(r.sendable, false);
  }
});

test('database sync-preview loader retains authoritative historical support for NM zero and nonzero answers', async () => {
  for (const value of [0, 1]) {
    const f = fixture(value); const compiled = f.amber.compiled;
    const client = { release() {}, async query(sql) {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
      if (sql.includes('public_match')) return { rows: [{ ...f.product, public_sku: f.product.full_sku,
        public_match: true, internal_match: true }] };
      if (sql.includes('SELECT id FROM products')) return { rows: [{ id: f.product.id }] };
      if (sql.includes('SELECT * FROM export_template_versions')) return { rows: [{ id: 'synthetic',
        definition: f.definition, definition_hash: compiled.hash, evaluator_version: f.definition.evaluatorVersion,
        output_contract: f.definition.outputContract, format_version: f.definition.formatVersion }] };
      if (sql.includes('WHERE p.id = ANY')) return { rows: [{ ...f.product, public_sku: f.product.full_sku }] };
      if (sql.includes('FROM sku_schema_versions')) return { rows: [f.historical] };
      if (sql.includes('FROM product_full_export_state')) return { rows: [] };
      if (sql.includes('transaction_timestamp')) return { rows: [{ observed_at: new Date() }] };
      throw new Error('Unexpected query');
    } };
    const loaded = await readPreviewProduct({ connect: async () => client }, {
      sku: f.product.full_sku, templateVersionId: '11111111-1111-4111-8111-111111111111' });
    const result = require('../src/services/magento/binding-evidence-products').evaluate(loaded, loaded.product);
    assert.equal(result.ready, true);
    assert.equal(result.base.dodatkovo_namysta, f.definition.tables.nmExtra[value]);
  }
});
