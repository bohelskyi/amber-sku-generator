const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidates, bootstrap, extendCandidates, extendDraft } = require('../src/services/magento/binding-bootstrap');
const { review, decide, saveDecision } = require('../src/services/magento/binding-review');
const { normalizeBindings, validateBindings } = require('../src/services/magento/binding-validation');
const { resolveCategories } = require('../src/services/magento/sync-preview-categories');
const { parseArguments, runBindings } = require('../scripts/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { describeMapper } = require('../src/services/magento/mapper-schema');
const { catalog, product } = require('./fixtures/magento-v1/contract');
const { parseMagentoConfig } = require('../src/config/magento');
const fixture = require('./fixtures/magento-bindings');

function setup() {
  const compiled = compileDefinition(materializeMagentoV1(catalog()));
  const mapper = describeMapper(compiled.definition);
  const schema = { ...fixture.schema(), attributes: mapper.targets.map((t, i) => ({
    attribute_code: t.target, attribute_id: 1000 + i,
    frontend_input: t.usages.some((u) => u.values.some((v) => v.kind === 'dictionary')) ? 'select' : 'text',
    options: [...new Set(t.usages.flatMap((u) => u.values.map((v) => v.label)))].filter(Boolean).map((label, n) => ({ value: String(7000 + n), label, isEmpty: false })) })) };
  schema.attributeSets = mapper.attributeSets.map((s, i) => ({ attribute_set_id: i + 100,
    attribute_set_name: s.attribute_set_code, attributeCodes: schema.attributes.map((a) => a.attribute_code) }));
  schema.attributes.find((a) => a.attribute_code === 'kulony_dodatkovo').options = [{ value: '6047', label: 'Інзклюз', isEmpty: false }];
  const amber = { compiled, products: [product('KL', { addit: 1 }, { status: 'active' })], current: [] };
  const nodes = [{ categoryId: '5', path: 'Default/Кулони', normalizedPath: 'Default/Кулони', comparable: true }];
  const bindings = buildCandidates(amber, schema, nodes, { group: 'KL' });
  const revision = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', revision: '1', state: 'draft', schema, bindings };
  return { amber, schema, nodes, revision };
}
test('BR extension preserves KL decisions exactly and refuses to replace any reviewed route', () => {
  const { amber, schema, nodes, revision } = setup();
  revision.bindings = decide(revision, { action: 'approve-exact', group: 'KL', expectedRevision: '1' }).bindings;
  const original = structuredClone(revision);
  const candidates = buildCandidates(amber, schema, nodes, { group: 'BR' });
  const result = extendCandidates(revision, candidates, { group: 'BR' });
  assert.deepEqual(revision, original);
  for (const collection of ['routes', 'attributes', 'options', 'policies']) {
    const addedKeys = new Set(candidates.attributes.map((a) => a.bindingKey));
    const kept = (r) => collection === 'routes' ? r.routeKey !== 'BR:all'
      : collection === 'attributes' ? r.routeKey !== 'BR:all' : !addedKeys.has(r.bindingKey);
    assert.deepEqual(result[collection].filter(kept), original.bindings[collection].filter(kept));
  }
  assert.equal(result.routes.find((r) => r.routeKey === 'BR:all').reviewState, 'proposed');
  assert.ok(result.policies.filter((p) => candidates.policies.some((c) => c.bindingKey === p.bindingKey))
    .every((p) => p.reviewState === 'review_required'));
  assert.ok(result.attributes.every((a) => a.unknownOutputPolicy === 'block'));
  assert.throws(() => extendCandidates({ ...revision, bindings: result }, candidates, { group: 'BR' }),
    { code: 'MAGENTO_BINDING_SCOPE_ALREADY_REVIEWED' });
  for (const reviewState of ['approved', 'blocked']) {
    const reviewed = structuredClone(revision);
    reviewed.bindings.routes.find((r) => r.routeKey === 'BR:all').reviewState = reviewState;
    assert.throws(() => extendCandidates(reviewed, candidates, { group: 'BR' }),
      { code: 'MAGENTO_BINDING_SCOPE_ALREADY_REVIEWED' });
  }
});
test('extension uses pinned template/schema, GET-only category discovery, and original CAS; drift never writes', async () => {
  const { amber, schema, revision } = setup();
  const c = require('../src/services/magento/binding-contract');
  const config = parseMagentoConfig({ MAGENTO_BASE_URL: 'https://fixture.invalid', MAGENTO_CONSUMER_KEY: 'ck-fixture',
    MAGENTO_CONSUMER_SECRET: 'cs-fixture', MAGENTO_ACCESS_TOKEN: 'at-fixture', MAGENTO_ACCESS_TOKEN_SECRET: 'ats-fixture' });
  revision.schema = c.normalizeSchema(schema); revision.schemaFingerprint = c.hash(revision.schema);
  revision.originHash = c.originHash(config.baseUrl); revision.definitionHash = amber.compiled.hash;
  revision.templateVersionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  let writes = 0; let gets = 0;
  const options = { bindingService: { getRevision: async () => revision, updateDraft: async (id, input) => {
    assert.equal(id, revision.id); assert.equal(input.expectedRevision, '1'); writes++;
    return { ...revision, revision: '2', bindings: input.bindings };
  } }, readAmber: async (_pool, input) => { assert.equal(input.templateVersionId, revision.templateVersionId); return amber; },
  discover: async () => revision.schema, fetchImpl: async (_url, request) => {
    assert.equal(request.method, 'GET'); assert.equal(request.body, undefined); gets++;
    return new Response(JSON.stringify({ id: 803, parent_id: 1, name: 'Default', children_data: [] }),
      { headers: { 'content-type': 'application/json' } });
  } };
  const input = { id: revision.id, expectedRevision: '1', group: 'BR' };
  assert.equal((await extendDraft(config, input, options)).revision, '2');
  assert.equal(writes, 1); assert.equal(gets, 1);
  const drift = structuredClone(revision.schema); drift.attributes[0].attribute_id += 9000;
  await assert.rejects(extendDraft(config, input, { ...options, discover: async () => drift }),
    { code: 'MAGENTO_BINDING_OBSERVATION_CHANGED' });
  await assert.rejects(extendDraft(config, { ...input, expectedRevision: '2' }, options), { code: 'MAGENTO_BINDING_CONFLICT' });
  await assert.rejects(extendDraft({ ...config, baseUrl: 'https://another.invalid' }, input, options),
    { code: 'MAGENTO_BINDING_INSTALLATION_MISMATCH' });
  assert.equal(writes, 1); assert.equal(gets, 1);
});
test('clone CLI passes explicit source counter without Magento config; clone and extension reject missing CAS/scope', async () => {
  const { revision } = setup(); let cloned = false;
  const args = ['clone', '--revision', revision.id, '--expected-revision', '37', '--actor-user-id', '1', '--json'];
  assert.equal(await runBindings({ args, env: {}, databasePool: {}, print() {}, service: {
    clonePublished: async (id, input, options) => {
      assert.equal(id, revision.id); assert.deepEqual(input, { expectedRevision: '37' });
      assert.equal(options.mutationContext.actorUserId, '1'); cloned = true; return revision;
    },
  } }), 0);
  assert.equal(cloned, true);
  for (const invalid of [args.filter((a) => !['--expected-revision', '37'].includes(a)),
    ['extend', ...args.slice(1)], [...args, '--group', 'BR']]) assert.throws(() => parseArguments(invalid));
});
test('KL bootstrap persists real evaluator set/code/options as proposed; scalar fields exist; inclusion remains review-required', () => {
  const { amber, schema, revision } = setup();
  assert.equal(validateBindings(revision.bindings, amber.compiled.definition, schema).valid, true);
  assert.ok(review(revision).every((e) => e.reviewState !== 'approved'));
  assert.equal(revision.bindings.routes.find((r) => r.routeKey === 'KL:all').reviewState, 'proposed');
  for (const target of ['typy_obrobky_burshtynu', 'vyd_obrobky_kameniu', 'faktura_kulonu', 'kolir', 'vyd_kulonu']) {
    assert.ok(review(revision).some((e) => e.target === target && e.kind === 'option' && e.reviewState === 'proposed'), target);
  }
  for (const target of ['rozmir_iuvelirnoho_vyrobu', 'decor_weight']) {
    assert.ok(revision.bindings.attributes.some((a) => a.target === target && a.strategy === 'scalar' && a.reviewState === 'proposed'));
  }
  const inclusion = revision.bindings.options.find((o) => o.questionKey === 'addit' && o.valueId === '1');
  assert.equal(inclusion.optionId, '6047'); assert.equal(inclusion.reviewState, 'review_required');
  assert.ok(revision.bindings.policies.every((p) => p.reviewState === 'review_required'));
  assert.equal(validateBindings(revision.bindings, amber.compiled.definition, schema, { publish: true }).valid, false);
});
test('bounded explicit exact approval changes only selected route/base identities, never ownership or label drift', () => {
  const { revision } = setup(); const original = structuredClone(revision);
  const result = decide(revision, { action: 'approve-exact', group: 'KL', row: 'base', expectedRevision: '1',
    targets: ['attribute_set_code', 'kolir', 'kulony_dodatkovo', 'product_online'] });
  assert.deepEqual(revision, original);
  assert.ok(result.bindings.routes.find((r) => r.routeKey === 'KL:all').reviewState === 'approved');
  assert.ok(result.bindings.options.filter((o) => o.bindingKey === result.bindings.attributes.find((a) => a.target === 'kolir' && a.rowId === 'base').bindingKey).every((o) => o.reviewState === 'approved'));
  assert.equal(result.bindings.options.find((o) => o.questionKey === 'addit' && o.valueId === '1').reviewState, 'review_required');
  assert.ok(result.bindings.policies.every((p) => p.reviewState === 'review_required'));
  assert.ok(result.bindings.attributes.filter((a) => a.rowId === 'english').every((a) => a.reviewState !== 'approved'));
  assert.throws(() => decide(revision, { action: 'approve-exact', expectedRevision: '1' }));
  assert.throws(() => decide(revision, { action: 'approve-exact', group: 'KL', expectedRevision: '2' }), { code: 'MAGENTO_BINDING_CONFLICT' });
});
test('explicit drift approval requires acknowledgment/reason; policy decisions are separate and explicit', () => {
  const { revision } = setup();
  const drift = review(revision).find((e) => e.kind === 'option' && e.identity === '6047');
  const command = { action: 'approve', binding: drift.id, expectedRevision: '1' };
  assert.throws(() => decide(revision, command), { code: 'MAGENTO_BINDING_REVIEW_ACK_REQUIRED' });
  const changed = decide(revision, { ...command, acceptReview: true, reason: 'Explicit fixture review' });
  assert.equal(changed.bindings.options.find((o) => o.optionId === '6047').reviewState, 'approved');
  const policy = review(revision).find((e) => e.kind === 'policy' && e.target === 'product_online');
  assert.throws(() => decide(revision, { ...command, binding: policy.id, acceptReview: true, reason: 'Review' }));
  const p = decide(revision, { ...command, binding: policy.id, acceptReview: true, reason: 'Review', policy: 'magento_managed' });
  assert.ok(p.bindings.policies.some((v) => v.reviewState === 'approved' && v.policy === 'magento_managed'));
});
test('explicit status create value is scoped, validated and does not approve deferred domains', () => {
  const { revision } = setup();
  const p = review(revision).find((e) => e.kind === 'policy' && e.target === 'product_online' && e.row === 'base');
  const input = { action: 'approve', binding: p.id, expectedRevision: '1', acceptReview: true,
    reason: 'Create disabled; preserve update status', policy: 'initialize_create_only', createValue: '2' };
  const result = normalizeBindings(decide(revision, input).bindings);
  assert.equal(result.policies.find((v) => v.bindingKey === p.id.split(':')[1]).evidence.createValue, 2);
  assert.ok(result.policies.filter((v) => v.bindingKey !== p.id.split(':')[1]).every((v) => v.reviewState === 'review_required'));
  for (const change of [{ createValue: '1' }, { policy: 'authoritative_create_update' },
    { binding: review(revision).find((e) => e.kind === 'attribute').id }]) {
    assert.throws(() => decide(revision, { ...input, ...change }), { code: 'MAGENTO_BINDING_INVALID' });
  }
  const forged = structuredClone(result);
  forged.policies.find((v) => v.evidence.createValue).evidence.createValue = 1;
  assert.throws(() => normalizeBindings(forged), { code: 'MAGENTO_BINDING_INVALID' });
});

test('missing/ambiguous options, unsupported AR values and conflicting SV set stay closed', () => {
  const { amber, schema, nodes, revision } = setup();
  const color = schema.attributes.find((a) => a.attribute_code === 'kolir');
  const expected = review(revision).find((e) => e.kind === 'option' && e.target === 'kolir');
  color.options.push({ value: 'duplicate', label: expected.evaluated, isEmpty: false });
  let b = buildCandidates(amber, schema, nodes, { group: 'KL' });
  assert.ok(b.options.some((o) => o.reviewState === 'review_required' && o.optionId === null));
  schema.attributes.find((a) => a.attribute_code === 'rozmir_kartyny').options = [];
  amber.current = [{ category_code: 'AR', key: 'size', options: [28, 29, 30, 31].map((value_id) => ({ value_id: String(value_id) })) }];
  b = buildCandidates(amber, schema, nodes, { group: 'AR' });
  for (const id of ['28', '29', '30', '31']) assert.ok(b.options.some((o) => o.questionKey === 'size' && o.valueId === id && o.optionId === null && o.reviewState === 'blocked'));
  b = buildCandidates(amber, schema, nodes, { group: 'SV' });
  assert.equal(b.routes.find((r) => r.routeKey === 'SV.souvenir=value_id:5').reviewState, 'review_required');
});
test('category proposals persist under transport evidence and approved IDs require fresh full-path identity', () => {
  const { revision, nodes } = setup();
  const a = revision.bindings.attributes.find((a) => a.target === 'categories' && a.rowId === 'base');
  assert.ok(a.evidence.categories.some((r) => r.reviewState === 'proposed'));
  assert.ok(a.evidence.categories.some((r) => r.reviewState === 'blocked'));
  const entry = review(revision).find((e) => e.kind === 'category' && e.identity === '5');
  const change = decide(revision, { action: 'approve', binding: entry.id, expectedRevision: '1' });
  const decisions = normalizeBindings(change.bindings).attributes.find((v) => v.bindingKey === a.bindingKey).evidence.categories;
  const resolve = (tree) => resolveCategories('Default/Кулони', tree, { known: true, links: [] }, { decisions }).requested[0];
  assert.equal(resolve(nodes).authority, 'authoritative');
  assert.equal(resolve([{ ...nodes[0], categoryId: '999' }]).authority, 'candidate_only');
  assert.equal(resolve([{ ...nodes[0], categoryId: '999' }]).drifted, true);
  const forged = structuredClone(change.bindings);
  forged.attributes.find((v) => v.bindingKey === a.bindingKey).evidence.categories[0].categoryId = 'invented';
  assert.throws(() => normalizeBindings(forged));
});
test('bootstrap orchestrates GET-only schema/categories and atomically seeds a new draft against a frozen template', async () => {
  const { amber, schema } = setup(); const calls = [];
  const config = parseMagentoConfig({ MAGENTO_BASE_URL: 'https://fixture.invalid', MAGENTO_CONSUMER_KEY: 'consumer',
    MAGENTO_CONSUMER_SECRET: 'cs-fixture', MAGENTO_ACCESS_TOKEN: 'at-fixture', MAGENTO_ACCESS_TOKEN_SECRET: 'ats-fixture' });
  const r = await bootstrap(config, { installationKey: 'fixture', templateVersionId: 'system', group: 'KL' }, {
    preflight: async () => { calls.push('preflight'); },
    readAmber: async (_pool, options) => { assert.equal(options.supportSystem, true); return amber; }, discover: async () => schema,
    fetchImpl: async (url, request) => {
      assert.equal(request.method, 'GET'); assert.equal(request.body, undefined); calls.push(new URL(url).pathname);
      return new Response(JSON.stringify({ id: 803, parent_id: 1, name: 'Default', children_data: [] }), { headers: { 'content-type': 'application/json' } });
    }, persist: async (input) => {
      assert.equal(input.templateVersionId, undefined);
      assert.deepEqual(input.definition, amber.compiled.definition);
      assert.ok(Object.values(input.bindings).flat().every((r) => r.reviewState !== 'approved'));
      return { id: 'new-draft', ...input };
    },
  });
  assert.equal(r.id, 'new-draft'); assert.deepEqual(calls, ['preflight', '/rest/all/V1/categories']);
});
test('bootstrap JSON failures never print human errors to stdout, including parse errors and sensitive diagnostics', async () => {
  for (const code of ['TEMPLATE_SOURCE_INVALID', 'MAGENTO_BINDING_MIGRATION_REQUIRED']) {
    const stdout = []; const stderr = [];
    const status = await runBindings({ args: ['bootstrap', '--installation', 'amber', '--template-version', 'system',
      '--group', 'KL', '--sku', 'KL3/11131351005', '--actor-user-id', '1', '--json'],
    env: { MAGENTO_BASE_URL: 'https://fixture.invalid', MAGENTO_CONSUMER_KEY: 'consumer-fixture', MAGENTO_CONSUMER_SECRET: 'secret-fixture',
      MAGENTO_ACCESS_TOKEN: 'token-fixture', MAGENTO_ACCESS_TOKEN_SECRET: 'token-secret-fixture' }, databasePool: {}, service: {},
    bootstrap: async () => { throw Object.assign(new Error('Never echo raw error'), { code,
      details: { diagnostics: [{ sourceId: 'AR.size', unresolvedValueIds: ['29', '30', '31'] }] } }); },
    print: (s) => stdout.push(s), printError: (s) => stderr.push(s) });
    assert.equal(status, 1); assert.equal(stdout.length, 1);
    assert.deepEqual(JSON.parse(stdout[0]), { ok: false });
    assert.equal(JSON.parse(stderr[0]).code, code);
    assert.ok(!stdout.join('').includes('Binding')); assert.ok(!stderr.join('').includes('Never echo raw error'));
  }
  const stdout = []; const stderr = [];
  assert.equal(await runBindings({ args: ['bad', '--json'], print: (s) => stdout.push(s), printError: (s) => stderr.push(s) }), 1);
  assert.deepEqual(JSON.parse(stdout[0]), { ok: false }); assert.equal(stderr.length, 1);
});
test('missing migration preflight stops before evidence reads, remote requests or persistence', async () => {
  let downstream = false;
  await assert.rejects(bootstrap({}, { installationKey: 'amber', templateVersionId: 'system' }, {
    databasePool: { connect: async () => ({ query: async () => ({ rows: [{ present: false, applied: false }] }), release() {} }) },
    readAmber: async () => { downstream = true; }, persist: async () => { downstream = true; },
  }), { code: 'MAGENTO_BINDING_MIGRATION_REQUIRED' });
  assert.equal(downstream, false);
});
test('system snapshot applies the existing source-support contract for current-only AR sizes and NM numeric zero', () => {
  const { upgradeSourceSupport } = require('../src/services/export-templates/source-support');
  const { validateSourceReferences } = require('../src/services/export-templates/source-references');
  const definition = materializeMagentoV1(catalog());
  for (const [id, extra] of [['AR.size', ['29', '30', '31']], ['NM.extra', ['0']]]) {
    const contract = Object.values(definition.questionContracts).find((q) => q.source === id);
    contract.allowed = [...new Set([...contract.allowed, ...extra])];
  }
  const questions = Object.entries(definition.sources).filter(([, s]) => s.kind !== 'product').map(([id, s]) => ({
    id, category_code: s.category, key: s.key, include_in_sku: s.kind === 'semantic' ? 1 : 0,
    value_ids: Object.values(definition.questionContracts).find((q) => q.source === id)?.allowed || [] }));
  const evidence = { categories: definition.groups.map((g) => g.route), questions,
    schemas: definition.groups.map((g) => ({ category_code: g.route, questions: questions.filter((q) => q.category_code === g.route)
      .map((q) => ({ key: q.key, value_ids: q.value_ids.filter((v) => !(q.id === 'AR.size' && ['29', '30', '31'].includes(v)) && !(q.id === 'NM.extra' && v === '0')) })) })) };
  const before = validateSourceReferences(definition, evidence);
  assert.ok(before.some((d) => d.sourceId === 'AR.size' && d.unresolvedValueIds?.includes('29')));
  assert.ok(before.some((d) => d.sourceId === 'NM.extra' && d.unresolvedValueIds?.includes('0')));
  const next = compileDefinition(upgradeSourceSupport(definition, evidence)).definition;
  assert.deepEqual(validateSourceReferences(next, evidence), []);
  assert.deepEqual(next.sourceSupport.sources['AR.size'].deferredValues, ['29', '30', '31']);
  assert.ok(!next.sourceSupport.sources['NM.extra'].semanticValues.includes('0'));
  assert.deepEqual(next.groups, definition.groups, 'no remapping or output expression changes');
});
test('review mutation retains expected revision CAS and CLI rejects broad approvals and write flags', async () => {
  const { revision } = setup();
  await assert.rejects(saveDecision(revision.id, { action: 'approve-exact', group: 'KL', expectedRevision: '1' }, {
    bindingService: { getRevision: async () => revision, updateDraft: async (_id, input) => {
      assert.equal(input.expectedRevision, '1'); throw Object.assign(new Error(), { code: 'MAGENTO_BINDING_CONFLICT' });
    } },
  }), { code: 'MAGENTO_BINDING_CONFLICT' });
  for (const args of [['approve-exact', '--revision', revision.id, '--expected-revision', '1', '--actor-user-id', '1'],
    ['bootstrap', '--apply'], ['review', '--revision', revision.id, '--group', 'KL', '--group', 'AR'],
    ['publish', '--revision', revision.id, '--actor-user-id', '1', '--expected-revision', '1']]) assert.throws(() => parseArguments(args));
  assert.equal(await runBindings({ args: ['--help'], print: () => {} }), 0);
  const logs = [];
  assert.equal(await runBindings({ args: ['review', '--revision', revision.id, '--group', 'KL', '--json'],
    databasePool: {}, env: {}, service: { getRevision: async () => revision }, print: (s) => logs.push(s) }), 0);
  assert.ok(JSON.parse(logs[0]).entries.every((e) => e.group === 'KL'));
});
