const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { catalog, product } = require('./fixtures/magento-v1/contract');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { describeMapper } = require('../src/services/magento/mapper-schema');
const { routeTools } = require('../src/services/magento/binding-evidence-routes');
const { auditBindingEvidence } = require('../src/services/magento/binding-evidence-audit');
const { evaluate } = require('../src/services/magento/binding-evidence-products');
const { PLANS } = require('../src/services/magento/compatibility-evidence-plans');
const { numericComparison, orientation, sizeOrientation, sizeTextOccurs } = require('../src/services/magento/compatibility-evidence-comparisons');
const { parseMagentoConfig } = require('../src/config/magento');
const { runBindingEvidenceAudit, parseArguments } = require('../scripts/magento-binding-evidence-audit');

const env = { MAGENTO_BASE_URL: 'https://compatibility.example.invalid', MAGENTO_CONSUMER_KEY: 'synthetic-consumer-key',
  MAGENTO_CONSUMER_SECRET: 'synthetic-consumer-secret', MAGENTO_ACCESS_TOKEN: 'synthetic-access-token',
  MAGENTO_ACCESS_TOKEN_SECRET: 'synthetic-access-secret' };
const config = parseMagentoConfig(env);
const now = () => '2026-09-27T00:00:00.000Z';
function fixture() {
  const captured = catalog();
  for (const id of ['29', '30', '31']) captured.get('AR').get('size').options.push({ value_id: id, sku_code: `0${id}`, label: `Size ${id}` });
  const compiled = compileDefinition(materializeMagentoV1(captured));
  const mapper = describeMapper(compiled.definition);
  const attributes = mapper.targets.map((t, i) => ({ attribute_code: t.target, attribute_id: i + 1,
    frontend_input: t.usages.some((u) => u.values.some((v) => v.kind === 'dictionary')) ? 'select' : 'text',
    options: [...new Set(t.usages.flatMap((u) => u.values.map((v) => v.label)))].filter(Boolean)
      .map((label, j) => ({ value: String(j + 100), label, isEmpty: false })) }));
  attributes.find((a) => a.attribute_code === 'kulony_dodatkovo').options = [{ value: '6047', label: 'Інзклюз', isEmpty: false }];
  const plans = routeTools(compiled.definition).plans;
  const attributeSets = plans.map((p, i) => ({ attribute_set_id: p.amberGroup === 'SV' ? p.predicates[0].equal ? 154 : 151 : 140 + i,
    attribute_set_name: p.attributeSetName, attributeCodes: attributes.map((a) => a.attribute_code)
      .filter((t) => !(p.amberGroup === 'SV' && p.predicates[0].equal && t === 'rozmir_suveniriv')) }));
  const current = [...captured].flatMap(([category_code, qs]) => [...qs].map(([key, q], i) => ({ ...q,
    id: i + 1, category_code, key, kind: 'semantic', options: q.options.map((o) => ({ ...o, label: o.label || 'Synthetic label' })) })));
  const amber = { observedAt: now(), compiled, plans, current,
    historical: [{ ...structuredClone(current.find((q) => q.category_code === 'AR' && q.key === 'size')),
      schemaId: 1, version: 1, options: [{ value_id: '28', sku_code: 'legacy-028', label: 'Historical size' }] }],
    schemas: [], template: { kind: 'system', definitionHash: compiled.hash }, products: [], candidates: [], usage: [] };
  const schema = { attributes, attributeSets, storeTopology: { websites: [], storeGroups: [],
    storeViews: [{ code: 'ua', is_active: true }, { code: 'en', is_active: true }, { code: 'ru', is_active: false }] } };
  function add(planId, count = 1, answers = {}) {
    const plan = PLANS.find((p) => p.id === planId);
    for (let n = 0; n < count; n++) {
      const id = amber.products.length + 1;
      amber.products.push(product(plan.category, { ...(plan.key ? { [plan.key]: plan.value } : {}), ...answers },
        { id, full_sku: `${plan.category}/SYNTH-${id}`, weight: '19.9',
          magento_name_subject_ua: 'Sample', magento_name_subject_en: 'Sample' }));
      amber.candidates.push({ route_id: planId, product_id: id, local_status: 'active', eligible_count: count });
    }
  }
  return { amber, schema, add };
}
async function run(f, { missing = () => false, change = () => {} } = {}) {
  const calls = [];
  const report = await auditBindingEvidence(config, { mode: 'compatibility', now,
    readAmber: async (_, options) => { assert.equal(options.mode, 'compatibility'); return f.amber; },
    discover: async () => f.schema, fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
      const u = new URL(url); assert.match(u.pathname, /^\/rest\/(all|ua|en)\/V1\/products$/);
      assert.equal(u.searchParams.get('searchCriteria[pageSize]'), '2');
      assert.equal(u.searchParams.get('searchCriteria[filter_groups][0][filters][0][condition_type]'), 'eq');
      const sku = u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
      const p = f.amber.products.find((p) => p.full_sku === sku); const scope = u.pathname.split('/')[2];
      calls.push({ id: p.id, scope });
      let items = [];
      if (!missing(p, scope)) {
        const mapped = evaluate(f.amber, p);
        const values = { ...mapped.base, ...(scope === 'en' ? mapped.english : {}) };
        const raw = { id: p.id + 500, sku, attribute_set_id: f.schema.attributeSets
          .find((s) => s.attribute_set_name === mapped.base.attribute_set_code)?.attribute_set_id || 140,
        status: 1, visibility: 4, name: values.name || '', custom_attributes: [],
        unrelated_secret: env.MAGENTO_ACCESS_TOKEN };
        for (const a of f.schema.attributes.filter((a) => !['name', 'sku', 'status', 'visibility'].includes(a.attribute_code))) {
          if (!Object.hasOwn(values, a.attribute_code)) continue;
          raw.custom_attributes.push({ attribute_code: a.attribute_code,
            value: a.options.find((o) => o.label === values[a.attribute_code])?.value ?? values[a.attribute_code] });
        }
        change(raw, p, scope); items = [raw];
      }
      return new Response(JSON.stringify({ total_count: items.length, items }), { headers: { 'content-type': 'application/json' } });
    } });
  return { report, calls };
}
function set(raw, target, value) {
  raw.custom_attributes = raw.custom_attributes.filter((a) => a.attribute_code !== target);
  if (value !== undefined) raw.custom_attributes.push({ attribute_code: target, value });
}

test('SV distribution, presence, membership and found/not-found sampling remain bounded and deterministic', async () => {
  const f = fixture(); f.add('sv_stone', 50);
  f.amber.candidates.reverse();
  const options = { missing: (p) => p.id <= 15, change: (raw, p) => {
    raw.attribute_set_id = p.id === 16 ? 154 : p.id === 17 ? 999 : 151;
    set(raw, 'rozmir_suveniriv', '5');
  } };
  const { report, calls } = await run(f, options); const s = report.svStoneAttributeSetEvidence;
  assert.equal(s.attempts, 35); assert.equal(s.found, 20); assert.equal(s.notFound, 15);
  assert.equal(s.set151Count, 18); assert.equal(s.set154Count, 1); assert.equal(s.actualSetDistribution['999'], 1);
  assert.equal(s.fieldPresenceCounts.rozmir_suveniriv, 20); assert.equal(s.unexaminedLocalCount, 15);
  const field = s.products.find((p) => p.actualAttributeSetId === 151).fields.find((f) => f.target === 'rozmir_suveniriv');
  assert.equal(field.predictedSetMembership, false); assert.equal(field.actualSetMembership, true);
  assert.deepEqual(calls.map((c) => c.id), Array.from({ length: 35 }, (_, i) => i + 1));
  assert.deepEqual((await run(f, options)).report, report);
  const absent = await run(f, { missing: () => true });
  assert.equal(absent.calls.length, 40); assert.equal(absent.report.svStoneAttributeSetEvidence.stopReason, 'attempt_limit');
  assert.equal(absent.report.svStoneAttributeSetEvidence.notFound, 40);
});

test('numeric formatting, orientation ambiguity, explicit rounding and genuine differences are separate', () => {
  assert.equal(numericComparison('31', '31.000000'), 'numeric_equivalent');
  assert.equal(numericComparison('12,8', '12.800000'), 'numeric_equivalent');
  assert.equal(numericComparison('19.9', '20', true), 'rounded');
  assert.equal(numericComparison('19.9', '20'), 'different');
  assert.equal(numericComparison('19.4', '20', true), 'different');
  assert.equal(numericComparison('20', '20', true), 'exact');
  assert.equal(numericComparison({}, '20', true), 'unavailable_or_non_numeric');
  assert.equal(orientation('12,8', '7,3', '12.800', '7.300'), 'direct');
  assert.equal(orientation('12,8', '7,3', '7.300', '12.800'), 'reversed');
  assert.equal(orientation('12', '12', '12', '12'), 'ambiguous_equal_axes');
  assert.equal(orientation('12', '7', '5', '12'), 'different');
  assert.equal(sizeOrientation('12,8', '7,3', '7.3×12.8'), 'reversed');
  assert.equal(sizeTextOccurs('Artwork 15 x 15 cm', '15×15'), true);
  assert.equal(sizeTextOccurs('Artwork 115x150 cm', '15×15'), false);
});

test('CH report compares actual evaluator output and physical values without treating formatting as semantic mismatch', async () => {
  const f = fixture(); f.add('ch_dimensions', 2, { bead_length: '12,8', bead_width: '7,3', rosary_length: '31' });
  const { report } = await run(f, { change: (raw, p) => {
    set(raw, 'dovzhyna_namystyny', p.id === 1 ? '7.300000' : '12.800000');
    set(raw, 'diametr_namystyny', p.id === 1 ? '12.800000' : '7.300000');
    set(raw, 'dovzhyna_vyrobu', '31.000000'); set(raw, 'vaha_vyrobu', p.id === 1 ? '20.000000' : '19.900000');
    set(raw, 'rozmir_kameniu', '7.3×12.8');
  } });
  assert.deepEqual(report.chDimensionEvidence.orientationCounts, { direct: 1, reversed: 1 });
  assert.deepEqual(report.chDimensionEvidence.weightCounts, { numeric_equivalent: 1, rounded: 1 });
  assert.equal(report.chDimensionEvidence.products[0].comparisons.rosaryLength, 'numeric_equivalent');
  assert.equal(report.chDimensionEvidence.products[0].fields.find((f) => f.target === 'rozmir_kameniu').expected, '12,8×7,3');
});

test('AR witnesses retain current/published semantic IDs and codes and bound sizes 29–31 to three local products', async () => {
  const f = fixture(); f.add('ar_28', 2); f.add('ar_29', 7); f.add('ar_30', 1);
  f.amber.usage = [{ category: 'AR', key: 'size', valueId: '28', current: 2, total: 2 },
    { category: 'AR', key: 'size', valueId: '29', current: 7, total: 7 }];
  const { report } = await run(f, { missing: (p) => p.id === 2, change: (raw) => { raw.name = 'Artwork 15x15'; } });
  const [v28, v29, v30, v31] = report.arSizeEvidence.values;
  assert.equal(v28.products.length, 2); assert.equal(v28.notFound, 1); assert.equal(v28.usage.current, 2);
  assert.equal(v28.semanticEvidence.presence, 'both');
  assert.equal(v28.semanticEvidence.historical[0].sku_code, 'legacy-028');
  assert.equal(v28.products[0].alternativeSizeEvidence.matches[0].target, 'name');
  assert.equal(v29.semanticEvidence.presence, 'current_only'); assert.equal(v29.semanticEvidence.current[0].sku_code, '029');
  assert.equal(v29.templateOutput, 'not_enumerated'); assert.equal(v29.products.length, 3); assert.equal(v29.usage.current, 7);
  assert.equal(v30.products.length, 1); assert.equal(v31.products.length, 0);
});

test('KL 6047 convention and SV subtype exceptions are evidence only, eligibility uses the evaluator', async () => {
  const f = fixture(); f.add('kl_inclusion', 2);
  f.add('sv_subtype', 2, { souvenir: 1, statuette: 5, symbolic_stat: 5 });
  f.add('sv_subtype', 1, { souvenir: 6, statuette: 0, symbolic_stat: 0 });
  const { report } = await run(f, { change: (raw, p) => {
    if (p.category === 'KL') set(raw, 'kulony_dodatkovo', p.id === 1 ? '6047' : '999');
    if (p.id === 4) set(raw, 'vyd_symvoliky', undefined);
  } });
  assert.deepEqual(report.klInclusionEvidence.conventionCounts, { exception: 1, observed_6047_reported_label: 1 });
  assert.equal(report.klInclusionEvidence.products[0].fields[0].resolvedOptions[0].label, 'Інзклюз');
  assert.deepEqual(report.svSubtypeEvidence.comparisonCounts, { exact: 1, mismatch: 1 });
  assert.equal(report.svSubtypeEvidence.skipped.length, 1);
});

test('scope differences are ownership evidence, no inactive scope or unrelated secret is retained', async () => {
  const f = fixture(); for (const g of ['BR', 'NM', 'KL', 'CH', 'AR']) f.add(`scope_${g}`, 4);
  const { report, calls } = await run(f, { change: (raw, p, scope) => { raw.name = `Merchandising ${scope} ${p.id}`; } });
  assert.equal(report.summary.scopeFound, 10); assert.equal(calls.length, 30);
  assert.ok(calls.every((c) => c.scope !== 'ru'));
  const comparison = report.storeScopeEvidence.groups[0].products[0].comparisons.find((c) => c.field === 'name');
  assert.equal(comparison.classification, 'field_ownership_evidence'); assert.equal(comparison.allEqualsUa, false);
  assert.deepEqual(comparison.nonemptyMagentoDiffersFromTemplate, ['all', 'ua', 'en']);
  assert.match(report.storeScopeEvidence.inheritance, /cannot prove/);
  assert.ok(!JSON.stringify(report).includes(env.MAGENTO_ACCESS_TOKEN));
  assert.ok(!JSON.stringify(report).includes('unrelated_secret'));
  await assert.rejects(run(f, { change: (raw) => { raw.name = env.MAGENTO_ACCESS_TOKEN; } }), { code: 'MAGENTO_AUDIT_SENSITIVE_DATA' });
});

test('all investigation limits hold even for an oversized injected candidate list; malformed evidence fails closed', async () => {
  const f = fixture();
  for (const p of PLANS) f.add(p.id, p.scan + 5, p.id === 'sv_subtype' ? { souvenir: 1, statuette: 5, symbolic_stat: 5 } : {});
  const { report, calls } = await run(f, { missing: () => true });
  assert.equal(calls.length, PLANS.reduce((n, p) => n + p.attempts, 0));
  assert.ok(report.summary.productGetCount <= report.summary.maxProductGets);
  const bad = fixture(); bad.add('sv_stone');
  await assert.rejects(run(bad, { change: (raw) => set(raw, 'decor_weight', { unsafe: 'Authorization: OAuth synthetic' }) }),
    { code: 'MAGENTO_RESPONSE_INVALID' });
  await assert.rejects(auditBindingEvidence(config, { mode: 'unbounded' }), { code: 'MAGENTO_BINDING_AUDIT_ARGUMENTS' });
});

test('lookup cache includes misses and local subtype scanning has its own hard cap', async () => {
  const f = fixture(); f.add('kl_inclusion');
  f.amber.candidates.push({ ...f.amber.candidates[0], route_id: 'scope_KL' });
  const found = await run(f);
  assert.deepEqual(found.calls.map((c) => c.scope), ['all', 'ua', 'en']);
  const missing = await run(f, { missing: () => true });
  assert.equal(missing.calls.length, 1);
  assert.equal(missing.report.klInclusionEvidence.notFound, 1);
  assert.equal(missing.report.storeScopeEvidence.groups.find((g) => g.amberGroup === 'KL').notFound, 1);
  const sv = fixture(); sv.add('sv_subtype', 105, { souvenir: 6, statuette: 0, symbolic_stat: 0 });
  const scanned = await run(sv);
  assert.equal(scanned.calls.length, 0);
  assert.equal(scanned.report.svSubtypeEvidence.examinedLocalCount, 100);
  assert.equal(scanned.report.svSubtypeEvidence.stopReason, 'local_scan_limit');
});

test('compatibility CLI shares immutable artifact writing and rejects arbitrary modes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compatibility-evidence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'report.json'); const log = { info() {}, error() {} };
  const args = { args: ['--mode', 'compatibility', '--output', output], env, databasePool: {}, log,
    audit: async (_, options) => { assert.equal(options.mode, 'compatibility'); return { reportVersion: 1, summary: {} }; } };
  assert.equal(await runBindingEvidenceAudit(args), 0); const before = await fs.readFile(output, 'utf8');
  assert.equal(await runBindingEvidenceAudit(args), 1); assert.equal(await fs.readFile(output, 'utf8'), before);
  assert.throws(() => parseArguments(['--mode', 'write']), { code: 'MAGENTO_BINDING_AUDIT_ARGUMENTS' });
});
