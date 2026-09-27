const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { catalog, product } = require('./fixtures/magento-v1/contract');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { describeMapper } = require('../src/services/magento/mapper-schema');
const { routeTools } = require('../src/services/magento/binding-evidence-routes');
const { analyzeBindings } = require('../src/services/magento/binding-evidence-analysis');
const { auditBindingEvidence, assertEvidenceSafe } = require('../src/services/magento/binding-evidence-audit');
const { readAmberEvidence } = require('../src/services/magento/binding-evidence-db');
const { parseMagentoConfig } = require('../src/config/magento');
const { runBindingEvidenceAudit, parseArguments } = require('../scripts/magento-binding-evidence-audit');

const env = { MAGENTO_BASE_URL: 'https://evidence.example.invalid', MAGENTO_CONSUMER_KEY: 'synthetic-consumer-key',
  MAGENTO_CONSUMER_SECRET: 'synthetic-consumer-secret', MAGENTO_ACCESS_TOKEN: 'synthetic-access-token',
  MAGENTO_ACCESS_TOKEN_SECRET: 'synthetic-access-secret' };
const config = parseMagentoConfig(env);
const now = () => '2026-09-27T00:00:00.000Z';
function fixture() {
  const captured = catalog();
  captured.get('SV').get('statuette').visible_if_json = { souvenir: 1 };
  captured.get('SV').get('material').visible_if_json = { souvenir: [1, 6] };
  captured.get('SV').get('additional_stone').visible_if_json = { souvenir: 5 };
  captured.get('AR').get('size').options = captured.get('AR').get('size').options.filter((o) => o.value_id !== '28');
  const compiled = compileDefinition(materializeMagentoV1(captured));
  const plans = routeTools(compiled.definition).plans;
  let id = 1;
  const current = [...captured].flatMap(([category_code, questions]) => [...questions].map(([key, q]) => ({
    ...q, id: id++, category_code, key, kind: 'semantic', input_type: 'options', include_in_sku: 1,
    label: key, options: q.options.map((o, i) => ({ ...o, id: i + 1, sku_code: `8${o.value_id}`, archived: false })) })));
  const historical = [structuredClone(current.find((q) => q.category_code === 'KL' && q.key === 'addit')),
    { id: 801, category_code: 'AR', key: 'size', kind: 'semantic', options: [{ id: 900, value_id: '28', sku_code: '06', label: 'Historical square' }] }]
    .map((q) => ({ ...q, schemaId: 20, version: 2, schemaStatus: 'archived' }));
  const products = plans.map((plan, i) => product(plan.amberGroup,
    plan.amberGroup === 'SV' ? { souvenir: plan.predicates[0].equal ? 5 : 6, additional_stone: 1, stone_processing: 1 }
      : plan.amberGroup === 'KL' ? { addit: 1 } : {},
    { id: i + 1, full_sku: `${plan.amberGroup}3/${i + 1}`, magento_name_subject_ua: 'Sample', magento_name_subject_en: 'Sample' }));
  const mapper = describeMapper(compiled.definition);
  const attributes = mapper.targets.filter((t) => t.kind !== 'csv_control').map((t, i) => ({
    attribute_id: i + 1, attribute_code: t.target,
    frontend_input: ['old_product', 'is_ownproduction'].includes(t.target) ? 'boolean'
      : ['dovzhyna_brasletu_diuimiv', 'dovzhyna_namysta', 'visibility'].includes(t.target)
        || t.usages.some((u) => u.values.some((v) => v.kind === 'dictionary')) ? 'select' : 'text',
    options: [...new Set(t.usages.flatMap((u) => u.values.map((v) => v.label)))].filter(Boolean)
      .filter((label) => !['Інклюз', '15×15', '?'].includes(label))
      .map((label, j) => ({ value: String(j + 100), label, isEmpty: false })) }));
  attributes.find((a) => a.attribute_code === 'kulony_dodatkovo').options.push({ value: '6047', label: 'Інзклюз', isEmpty: false });
  const attributeSets = plans.map((p, i) => ({ attribute_set_id: 100 + i, attribute_set_name: p.attributeSetName,
    attributeCodes: attributes.map((a) => a.attribute_code).filter((target) => !(p.amberGroup === 'SV' && p.predicates[0].equal
      && ['decor_weight', 'vyd_statuetky', 'typy_obrobky_burshtynu'].includes(target))) }));
  return { amber: { observedAt: now(), compiled, plans, current, historical,
    schemas: [{ id: 20, category_code: 'AR', version: 2, status: 'archived' }],
    template: { kind: 'system', definitionHash: compiled.hash }, products,
    candidates: plans.map((p, i) => ({ route_id: p.id, product_id: i + 1 })),
    usage: [{ category: 'AR', key: 'size', valueId: '28', current: 0, total: 1 },
      { category: 'CH', key: 'count', valueId: '9', current: 1, total: 1 }] },
  schema: { attributes, attributeSets, storeTopology: { websites: [{ id: 1 }], storeGroups: [{ id: 1 }],
    storeViews: [{ code: 'ua', is_active: true }, { code: 'en', is_active: true }, { code: 'ru', is_active: false }] } } };
}
function fetchProducts(f, calls, { missing = false, mismatch = false, scopeDifference = false } = {}) {
  return async (url, options) => {
    const u = new URL(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.match(u.pathname, /^\/rest\/(all|ua|en)\/V1\/products$/);
    assert.equal(u.searchParams.get('searchCriteria[filter_groups][0][filters][0][condition_type]'), 'eq');
    assert.equal(u.searchParams.get('searchCriteria[pageSize]'), '2');
    const sku = u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
    calls.push({ scope: u.pathname.split('/')[2], sku });
    if (missing) return new Response(JSON.stringify({ total_count: 0, items: [] }), { headers: { 'content-type': 'application/json' } });
    const local = f.amber.products.find((p) => p.full_sku === sku);
    const mapped = evaluateProduct(f.amber.compiled, local);
    const set = f.schema.attributeSets.find((s) => s.attribute_set_name === mapped.base.attribute_set_code);
    const scope = u.pathname.split('/')[2];
    const fields = { ...mapped.base, ...(scope === 'en' ? mapped.english : {}) };
    const raw = { id: local.id + 500, sku, attribute_set_id: mismatch ? 9999 : set.attribute_set_id, status: 1, visibility: 4,
      unrelated: { Authorization: env.MAGENTO_ACCESS_TOKEN }, custom_attributes: [] };
    for (const a of f.schema.attributes) {
      if (!Object.hasOwn(fields, a.attribute_code) || a.attribute_code === 'visibility') continue;
      const value = a.options.find((o) => o.label === fields[a.attribute_code])?.value ?? fields[a.attribute_code];
      if (['sku', 'name', 'price'].includes(a.attribute_code)) raw[a.attribute_code] = fields[a.attribute_code];
      else raw.custom_attributes.push({ attribute_code: a.attribute_code, value });
    }
    if (scopeDifference && scope === 'ua') raw.name = 'Scoped Ukrainian name';
    return new Response(JSON.stringify({ total_count: 1, items: [raw] }), { headers: { 'content-type': 'application/json' } });
  };
}
async function audit(f, calls = [], options) {
  return auditBindingEvidence(config, { readAmber: async () => f.amber, discover: async () => f.schema,
    fetchImpl: fetchProducts(f, calls, options), now });
}

test('semantic IDs/codes/labels stay separate; exact matches and drift are only candidates', () => {
  const f = fixture();
  const a = analyzeBindings(f.amber, f.schema);
  const color = a.bindingEvidence.find((e) => e.target === 'kolir' && e.amberGroup === 'BR');
  const value = color.values.find((v) => v.amber.some((id) => id.value_id === '1'));
  assert.equal(value.status, 'exact_option_candidate');
  assert.equal(value.authority, 'candidate_evidence_only');
  assert.equal(value.amber[0].current[0].sku_code, '81');
  assert.notEqual(value.exact[0].optionId, value.amber[0].value_id);
  assert.equal(a.knownCases[0].classification, 'LABEL_DRIFT_REVIEW_REQUIRED');
  assert.deepEqual(a.knownCases[0].reportedOption, { optionId: '6047', label: 'Інзклюз' });
  assert.equal(a.knownCases[1].semanticEvidence.presence, 'historical_only');
  assert.equal(a.knownCases[1].templateOutput, 'blocked_by_template');
  assert.equal(a.knownCases[1].semanticEvidence.historical[0].sku_code, '06');
  assert.equal(a.knownCases[2].semanticEvidence.presence, 'current_only');
  assert.ok(a.diagnostics.some((d) => d.code === 'AMBER_HISTORICAL_VALUE_NOT_IN_MAGENTO' && d.value_id === '28'));
  assert.ok(a.diagnostics.some((d) => d.code === 'AMBER_CURRENT_VALUE_NOT_IN_MAGENTO' && d.value_id === '9'));
});

test('dynamic information, bands, scalar and native transport remain different strategies', () => {
  const f = fixture(); const a = analyzeBindings(f.amber, f.schema);
  assert.equal(a.bindingEvidence.find((e) => e.target === 'dovzhyna_brasletu_diuimiv').strategy, 'dynamic_exact_label_option');
  assert.equal(a.bindingEvidence.find((e) => e.target === 'dovzhyna_namysta').strategy, 'numeric_band_option');
  assert.equal(a.bindingEvidence.find((e) => e.target === 'price').strategy, 'scalar');
  for (const target of ['attribute_set_code', 'product_online', 'visibility', 'old_product', 'is_ownproduction']) {
    assert.ok(a.transportControls.some((c) => c.target === target));
    assert.ok(!a.diagnostics.some((d) => d.target === target && /NOT_FOUND|NOT_IN_MAGENTO/.test(d.code)));
  }
});

test('SV branch rules prove non-applicability while evaluated populated fields expose real membership gaps', async () => {
  const f = fixture(); const report = await audit(f);
  const stone = report.routeEvidence.find((r) => r.amberGroup === 'SV' && r.predicates[0].equal);
  assert.equal(stone.targets.find((t) => t.target === 'typy_obrobky_burshtynu').canPopulate, false);
  assert.equal(stone.targets.find((t) => t.target === 'decor_weight').canPopulate, true);
  assert.ok(report.diagnostics.some((d) => d.code === 'ATTRIBUTE_NOT_APPLICABLE_TO_SELECTED_SET' && d.target === 'vyd_statuetky'));
  assert.ok(report.diagnostics.some((d) => d.code === 'ATTRIBUTE_NOT_IN_SELECTED_SET' && d.target === 'decor_weight'));
  assert.ok(!report.diagnostics.some((d) => d.code === 'ATTRIBUTE_NOT_IN_SELECTED_SET' && d.target === 'typy_obrobky_burshtynu'));
});

test('bounded exact query GETs report missing products, set mismatches and store observations', async () => {
  const f = fixture(); const calls = [];
  const report = await audit(f, calls, { mismatch: true, scopeDifference: true });
  assert.equal(report.sampleProducts.length, 7);
  assert.equal(calls.length, 11);
  assert.ok(!calls.some((c) => c.scope === 'ru'));
  assert.ok(report.diagnostics.some((d) => d.code === 'PRODUCT_ATTRIBUTE_SET_MISMATCH'));
  assert.ok(report.diagnostics.some((d) => d.code === 'STORE_SCOPE_VALUE_MISMATCH'));
  assert.equal(report.sampleProducts[0].storeScopeEvidence.baseRowScope, 'unconfirmed');
  assert.ok(!JSON.stringify(report).includes('Authorization'));
  assert.ok(!JSON.stringify(report).includes(env.MAGENTO_ACCESS_TOKEN));
  const missing = await audit(f, [], { missing: true });
  assert.equal(missing.summary.samplesFound, 0);
  assert.equal(missing.diagnostics.filter((d) => d.code === 'MAGENTO_PRODUCT_NOT_FOUND').length, 7);
  assert.deepEqual(await audit(f), await audit(f));
});

test('identity ambiguity is explicit and absent local classes are not fabricated', async () => {
  const f = fixture();
  const color = f.amber.current.find((q) => q.category_code === 'BR' && q.key === 'color');
  color.options.push({ ...color.options[0], id: 400, sku_code: '222' });
  f.amber.candidates = [];
  const report = await audit(f);
  assert.ok(report.diagnostics.some((d) => d.code === 'SEMANTIC_IDENTITY_AMBIGUOUS'));
  assert.equal(report.sampleProducts.length, 0);
  assert.equal(report.diagnostics.filter((d) => d.code === 'LOCAL_SAMPLE_NOT_FOUND').length, 7);
});

test('failed evaluation preserves bounded observed product evidence without claiming expected values', async () => {
  const f = fixture();
  f.amber.candidates = f.amber.candidates.slice(0, 1);
  f.amber.products[0].details.answers.raw_type = true;
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, 'GET');
    const sku = new URL(url).searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
    return new Response(JSON.stringify({ total_count: 1, items: [{ id: 501, sku, attribute_set_id: 100,
      name: 'Observed saved name', status: 1, visibility: 4, custom_attributes: [] }] }),
    { headers: { 'content-type': 'application/json' } });
  };
  const report = await auditBindingEvidence(config, { readAmber: async () => f.amber,
    discover: async () => f.schema, fetchImpl, now });
  const sample = report.sampleProducts[0];
  assert.equal(sample.evaluation.ready, false);
  const field = sample.fields.find((v) => v.target === 'name');
  assert.equal(field.observed, 'Observed saved name');
  assert.equal(field.expectedAvailable, false);
  assert.equal(field.classification, 'not_evaluated');
});

test('read-only snapshot rolls back and releases on query failure without external reads', async () => {
  const calls = [];
  await assert.rejects(readAmberEvidence({ connect: async () => ({ query: async (sql) => {
    calls.push(sql); if (sql.startsWith('SELECT')) throw new Error('synthetic failure'); return { rows: [] };
  }, release: () => calls.push('RELEASE') }) }));
  assert.equal(calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(calls.at(-2), 'ROLLBACK');
  assert.equal(calls.at(-1), 'RELEASE');
});

test('explicit publication reads verify immutable identity and all SQL stays within the read-only transaction', async () => {
  const f = fixture();
  const queries = [];
  const row = { id: '77', template_id: '9', version_number: '2', definition: f.amber.compiled.definition,
    definition_hash: f.amber.compiled.hash, format_version: 1,
    evaluator_version: f.amber.compiled.definition.evaluatorVersion, output_contract: f.amber.compiled.definition.outputContract };
  const pool = { connect: async () => ({ query: async (sql, params) => {
    queries.push({ sql, params });
    assert.match(sql.trim(), /^(BEGIN|SELECT|COMMIT|ROLLBACK)\b/);
    if (sql.includes('FROM export_template_activation')) return { rows: [{ implementation: 'template', template_version_id: '77', generation: '3' }] };
    if (sql.includes('FROM export_template_versions')) { assert.deepEqual(params, ['77']); return { rows: [row] }; }
    if (sql.includes('transaction_timestamp()')) return { rows: [{ observed_at: now() }] };
    return { rows: [] };
  }, release: () => queries.push({ sql: 'RELEASE' }) }) };
  const result = await readAmberEvidence(pool, { templateVersionId: 'selected' });
  assert.equal(result.template.kind, 'published');
  assert.equal(result.template.versionId, '77');
  assert.equal(result.compiled.hash, f.amber.compiled.hash);
  assert.equal(queries[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(queries.at(-2).sql, 'COMMIT');
  assert.equal(queries.at(-1).sql, 'RELEASE');
  row.definition_hash = 'invalid';
  await assert.rejects(readAmberEvidence(pool, { templateVersionId: '77' }), { code: 'MAGENTO_BINDING_EVIDENCE_INVALID' });
  assert.equal(queries.at(-2).sql, 'ROLLBACK');
});

test('CLI keeps reports private, never overwrites, and never reflects remote/credential errors', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'binding-evidence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'report.json');
  const entries = [];
  const log = { info: (event, value) => entries.push({ event, ...value }), error: (event, value) => entries.push({ event, ...value }) };
  assert.equal(await runBindingEvidenceAudit({ args: ['--help'], env: {}, log }), 0);
  const f = fixture();
  const report = await audit(f);
  const args = { args: ['--output', output], env, databasePool: {}, audit: async () => report, log, now };
  assert.equal(await runBindingEvidenceAudit(args), 0);
  const bytes = await fs.readFile(output, 'utf8');
  assert.equal(await runBindingEvidenceAudit(args), 1);
  assert.equal(await fs.readFile(output, 'utf8'), bytes);
  assert.equal(await runBindingEvidenceAudit({ ...args, audit: async () => { throw new Error(JSON.stringify(env)); } }), 1);
  for (const value of Object.values(env)) assert.ok(!JSON.stringify(entries).includes(value));
  for (const value of [env.MAGENTO_ACCESS_TOKEN, 'Authorization: OAuth signature', 'postgresql://user:password@host/db']) {
    assert.throws(() => assertEvidenceSafe({ value }, config), { code: 'MAGENTO_AUDIT_SENSITIVE_DATA' });
  }
  assert.throws(() => parseArguments(['--method', 'POST']), { code: 'MAGENTO_BINDING_AUDIT_ARGUMENTS' });
  assert.throws(() => parseArguments(['--template-version', '../bad']), { code: 'MAGENTO_BINDING_AUDIT_ARGUMENTS' });
});
