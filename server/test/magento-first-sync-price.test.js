const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const c = require('../src/services/magento/binding-contract');
const { normalizeBindings } = require('../src/services/magento/binding-validation');
const { normalizeDecimal } = require('../src/services/magento/first-sync-field-plan');
const prices = require('../src/services/product-price-change.service');
const currency = require('../src/services/currency.service');
const { readCurrencyEvidence, prepareFirstSyncPrice, applyFirstSyncPrice } = require('../src/services/magento/first-sync-price');
const originalPreview = prices.previewProductPriceChange;
const originalApply = prices.applyProductPriceChangeInTransaction;
test.afterEach(() => { prices.previewProductPriceChange = originalPreview; prices.applyProductPriceChangeInTransaction = originalApply; });
const config = { configured: true, baseUrl: 'https://fixture-magento.example',
  consumerKey: 'fixture-key', consumerSecret: 'fixture-secret', accessToken: 'fixture-token', accessTokenSecret: 'fixture-token-secret' };
function fixture() {
  const definition = structuredClone(fixtures.definition());
  definition.sources.price = { kind: 'product', field: 'total_price_uah', type: 'scalar' };
  definition.groups[0].rows[0].cells.product_websites = { op: 'literal', value: 'fixture' };
  definition.groups[0].rows[0].cells.price = { op: 'text', input: { op: 'source', id: 'price' },
    trim: false, format: 'scalar-v1', onAbsent: 'empty' };
  definition.groups.forEach(group => { group.rows[1].cells.price = { op: 'literal', value: '' }; });
  const compiled = compileDefinition(definition);
  const schema = structuredClone(fixtures.schema());
  schema.storeTopology.websites[0].default_group_id = 802;
  schema.storeTopology.storeGroups[0].default_store_id = 805;
  schema.storeTopology.storeViews.push({ id: 805, code: 'default', name: 'Ukrainian',
    website_id: 801, store_group_id: 802, is_active: true });
  const normalized = c.normalizeSchema(schema);
  const bindingInput = fixtures.approvedBindings(compiled.definition, normalized);
  const websiteBinding = bindingInput.attributes.find(attribute => attribute.target === 'product_websites');
  const allPolicy = bindingInput.policies.find(policy => policy.bindingKey === c.hash({
    routeKey: websiteBinding.routeKey, rowId: websiteBinding.rowId, target: websiteBinding.target }));
  allPolicy.policy = 'authoritative_create_update';
  const bindings = normalizeBindings(bindingInput);
  const revision = { id: '11111111-1111-1111-1111-111111111111', state: 'published',
    originHash: c.originHash(config.baseUrl), definitionHash: compiled.hash,
    schema: normalized, bindings, schemaFingerprint: c.hash(normalized),
    topologyFingerprint: c.hash(normalized.storeTopology) };
  const observation = { amber: { product: { id: 21, public_sku: 'BR-fixture', full_sku: 'BR-fixture',
    category: 'BR', weight: 5, total_price_uah: null,
    details: { answers: { binding_test_semantic: 7, binding_test_size: '17' } } },
  compiled, revision }, raw: { id: 81, sku: 'BR-fixture', attribute_set_id: 8001, price: '43,2500' }, schema: normalized };
  const source = { kind: 'product', field: 'total_price_uah', bindingRevisionId: revision.id,
    definitionHash: compiled.hash, routeKey: 'BR:all' };
  const local = { known: true, present: false, value: null, unit: 'UAH' };
  const remote = { known: true, present: true, value: observation.raw.price, unit: 'UAH' };
  const metadata = { target: 'price', scope: 'all', persistence: 'price', source, storagePath: 'total_price_uah',
    outwardPolicy: 'authoritative_create_update', mappingHash: '3'.repeat(64), requiresRuntimeValidation: true };
  const projection = { projection: [metadata],
    fields: [{ target: 'price', scope: 'all', kind: 'scalar', type: 'decimal', unit: 'UAH', scale: 2,
      mapping: { proven: true }, local, remote }],
    plan: { fields: [{ target: 'price', scope: 'all', status: 'imported', importValue: '43.25' }] } };
  const accepted = { target: 'price', scope: 'all', state: 'imported', before: local, remote,
    after: '43.25', source: { ...source, productId: 21, manifestHash: c.hash([
      { target: 'price', scope: 'all', mappingHash: metadata.mappingHash }]) }, mappingHash: metadata.mappingHash };
  return { observation, projection, acceptedFields: [accepted], actorUserId: 7,
    rateObservation: { rateInfo: { rate: 41, source: 'fixture', rateDate: '2026-10-09',
      fetchedAt: new Date().toISOString(), stale: false }, rateError: null } };
}
const configs = () => [{ id: 805, code: 'default', website_id: 801, locale: 'uk_UA', base_currency_code: 'UAH' },
  { id: 804, code: 'en', website_id: 801, locale: 'en_US', base_currency_code: 'UAH' }];
async function proven(args, rows = configs()) {
  args.currencyEvidence = await readCurrencyEvidence(config, args.observation,
    { fetchImpl: async () => new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } }) });
  assert.equal(args.currencyEvidence.verified, true);
  return args;
}
function preview(args, overrides = {}) {
  return { productId: 21, publicSku: 'BR-fixture', sku: 'BR-fixture', previewToken: '4'.repeat(64),
    pricingDecision: { mode: 'manual_uah', manualPriceUah: 43.25, marketingRoundingEnabled: false },
    resultingPriceUah: 43.25, unchanged: false,
    currentPricing: { totalPriceUah: args.projection.fields[0].local.present ? args.projection.fields[0].local.value : null },
    resultingPricing: { calculatedPriceUah: 50, autoPriceUah: 60, manualPriceUah: 43.25,
      uahRate: 41, customUsdPerGramBasis: null }, ...overrides };
}
const client = { query: async () => { throw Error('Helper must use delegated command'); } };
test('currency evidence uses one signed closed GET and exact default-UA/en identities', async () => {
  const args = fixture(); const calls = [];
  const result = await readCurrencyEvidence(config, args.observation, { fetchImpl: async (url, init) => {
    calls.push({ url, method: init.method, redirect: init.redirect });
    return new Response(JSON.stringify(configs()), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(result, { verified: true, currency: 'UAH' });
  assert.deepEqual(calls, [{ url: 'https://fixture-magento.example/rest/all/V1/store/storeConfigs', method: 'GET', redirect: 'manual' }]);
});
test('currency proof never guesses ua code, missing pinned default-store identity remains unsupported', async () => {
  const args = fixture(); args.observation.schema = structuredClone(args.observation.schema);
  delete args.observation.schema.storeTopology.storeGroups[0].default_store_id;
  const result = await readCurrencyEvidence(config, args.observation, { fetchImpl: async () => { throw Error('No call expected'); } });
  assert.equal(result.verified, false); assert.equal(result.reason, 'PRICE_UA_DEFAULT_STORE_NOT_PROVEN');
});
test('unreadable and failed currency requests remain unknown', async () => {
  for (const fetchImpl of [async () => { throw Error('network'); },
    async () => new Response('not-json'), async () => new Response('', { status: 500 })]) {
    const result = await readCurrencyEvidence(config, fixture().observation, { fetchImpl });
    assert.equal(result.verified, false); assert.equal(result.reason, 'PRICE_CURRENCY_READ_UNAVAILABLE');
  }
});
test('wrong base currency, swapped store identities and duplicate configs do not establish UAH', async () => {
  for (const change of [
    rows => { rows[1].base_currency_code = 'USD'; },
    rows => { rows[0].website_id = 99; },
    rows => { rows.push({ ...rows[0] }); },
    rows => { rows[0].locale = 'en_US'; },
  ]) {
    const rows = configs(); change(rows);
    const result = await readCurrencyEvidence(config, fixture().observation,
      { fetchImpl: async () => new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } }) });
    assert.equal(result.verified, false);
  }
});
test('inactive or changed EN topology and unknown website policy cannot establish currency proof', async () => {
  for (const change of [
    args => { args.observation.schema = structuredClone(args.observation.schema);
      args.observation.schema.storeTopology.storeViews.find(view => view.code === 'en').is_active = false; },
    args => { args.observation.schema = structuredClone(args.observation.schema);
      args.observation.schema.storeTopology.storeViews.find(view => view.code === 'en').id++; },
    args => { const binding = args.observation.amber.revision.bindings.attributes.find(attribute => attribute.target === 'product_websites');
      args.observation.amber.revision.bindings.policies.find(policy => policy.bindingKey === binding.bindingKey).policy = 'magento_managed'; },
  ]) {
    const args = fixture(); change(args);
    assert.equal((await readCurrencyEvidence(config, args.observation,
      { fetchImpl: async () => new Response(JSON.stringify(configs()), { headers: { 'content-type': 'application/json' } }) })).verified, false);
  }
});
test('price preparation delegates exact manual UAH with rounding disabled on caller client', async () => {
  const args = await proven(fixture()); const calls = [];
  prices.previewProductPriceChange = async (payload, options) => { calls.push({ payload, options }); return preview(args); };
  const result = await prepareFirstSyncPrice(client, args);
  assert.deepEqual(result.blockedFields, []); assert.deepEqual(result.supportedFields, args.acceptedFields);
  assert.deepEqual(calls[0].payload, { productId: 21,
    pricingDecision: { mode: 'manual_uah', manualPriceUah: '43.25', marketingRoundingEnabled: false } });
  assert.equal(calls[0].options.queryable, client); assert.equal(calls[0].options.rateObservation, args.rateObservation);
});
test('price apply obtains a fresh preview and delegates existing transactional audit/export command', async () => {
  const args = await proven(fixture()); const calls = [];
  prices.previewProductPriceChange = async () => { calls.push('preview'); return preview(args); };
  prices.applyProductPriceChangeInTransaction = async (payload, options) => {
    calls.push({ payload, options });
    return { success: true, resultingPriceUah: 43.25, priceExportRevision: 8, auditEventId: 19 };
  };
  const result = await applyFirstSyncPrice(client, args);
  assert.equal(result.changed, true); assert.equal(result.priceExportRevision, 8); assert.equal(result.auditEventId, 19);
  assert.equal(calls[0], 'preview'); assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.previewToken, '4'.repeat(64));
  assert.equal(calls[1].options.queryable, client); assert.equal(calls[1].options.rateObservation, args.rateObservation);
  assert.deepEqual(calls[1].options.mutationContext, { actorUserId: 7 });
});
test('empty acceptance never starts pricing or rate reads and never changes records', async () => {
  const args = { acceptedFields: [] };
  prices.previewProductPriceChange = async () => { throw Error('Unexpected preview'); };
  assert.deepEqual(await prepareFirstSyncPrice(client, args), { supportedFields: [], blockedFields: [] });
  assert.deepEqual(await applyFirstSyncPrice(client, args), { changed: false, supportedFields: [], blockedFields: [] });
});
test('unproven or cloned currency evidence cannot enter the price command', async () => {
  for (const makeEvidence of [
    async args => { args.currencyEvidence = { verified: true, currency: 'UAH' }; },
    async args => { await proven(args); args.currencyEvidence = { ...args.currencyEvidence }; },
    async args => { args.currencyEvidence = { verified: false, reason: 'failed' }; },
  ]) {
    const args = fixture(); await makeEvidence(args); let count = 0;
    prices.previewProductPriceChange = async () => { count++; return preview(args); };
    const result = await prepareFirstSyncPrice(client, args);
    assert.equal(result.blockedFields[0].code, 'FIRST_SYNC_PRICE_CURRENCY_NOT_PROVEN'); assert.equal(count, 0);
  }
});
test('currency proof is tied to exact observation and cannot be reused after schema mutation', async () => {
  const args = await proven(fixture()); args.observation.schema = structuredClone(args.observation.schema);
  args.observation.schema.storeTopology.storeViews.find(view => view.code === 'en').id++;
  const result = await prepareFirstSyncPrice(client, args);
  assert.equal(result.blockedFields[0].code, 'FIRST_SYNC_PRICE_CURRENCY_NOT_PROVEN');
});
test('missing, failed, invalid or expired captured rate remains explicit review and never falls back to network', async () => {
  for (const rateObservation of [undefined, { rateInfo: null, rateError: 'failed' },
    { rateInfo: { rate: 0 }, rateError: null },
    { rateInfo: { rate: 41, stale: true, fetchedAt: '2000-01-01T00:00:00Z' }, rateError: null }]) {
    const args = await proven(fixture()); args.rateObservation = rateObservation; let count = 0;
    prices.previewProductPriceChange = async () => { count++; return preview(args); };
    const result = await prepareFirstSyncPrice(client, args);
    assert.equal(result.supportedFields.length, 0); assert.equal(result.blockedFields.length, 1); assert.equal(count, 0);
  }
});
test('a changed current local price fails CAS before apply', async () => {
  const args = await proven(fixture());
  prices.previewProductPriceChange = async () => preview(args, { currentPricing: { totalPriceUah: 20 } });
  assert.equal((await prepareFirstSyncPrice(client, args)).blockedFields[0].code, 'FIRST_SYNC_PRICE_LOCAL_STATE_CHANGED');
});
test('automatic baseline, rate and obsolete custom gram basis must all remain coherent', async () => {
  for (const override of [
    { calculatedPriceUah: null }, { autoPriceUah: 0 }, { uahRate: null },
    { customUsdPerGramBasis: { usdPerGram: 5 } }, { manualPriceUah: 44 },
  ]) {
    const args = await proven(fixture());
    prices.previewProductPriceChange = async () => {
      const result = preview(args); result.resultingPricing = { ...result.resultingPricing, ...override }; return result;
    };
    assert.equal((await prepareFirstSyncPrice(client, args)).blockedFields[0].code, 'FIRST_SYNC_PRICE_AUTOMATIC_BASELINE_UNAVAILABLE');
  }
});
test('rounded or changed remote decimal is never accepted through numeric tolerance', async () => {
  for (const price of ['43.251', '0', false, '9007199254740990.99']) {
    const args = await proven(fixture()); args.projection.fields[0].remote.value = price;
    args.acceptedFields[0].after = price; args.projection.plan.fields[0].importValue = price;
    let count = 0; prices.previewProductPriceChange = async () => { count++; return preview(args); };
    const result = await prepareFirstSyncPrice(client, args);
    assert.equal(result.supportedFields.length, 0); assert.equal(count, 0);
  }
});
test('preview amount, identity, protected decision and token must match exactly', async () => {
  for (const override of [{ resultingPriceUah: 43.26 }, { publicSku: 'other' }, { productId: 22 },
    { previewToken: 'invalid' }, { pricingDecision: { mode: 'manual_uah', manualPriceUah: 43.25, marketingRoundingEnabled: true } }]) {
    const args = await proven(fixture());
    prices.previewProductPriceChange = async () => preview(args, override);
    assert.equal((await prepareFirstSyncPrice(client, args)).blockedFields[0].code, 'FIRST_SYNC_PRICE_PREVIEW_NOT_EXACT');
  }
});
test('source, mapping, exact local/remote evidence and manifest changes are blocked', async () => {
  for (const change of [
    args => { args.acceptedFields[0].source.definitionHash = '0'.repeat(64); },
    args => { args.acceptedFields[0].mappingHash = '0'.repeat(64); },
    args => { args.acceptedFields[0].before = { known: false }; },
    args => { args.acceptedFields[0].remote = { known: false }; },
    args => { args.acceptedFields[0].source.manifestHash = '0'.repeat(64); },
  ]) {
    const args = await proven(fixture()); change(args); let count = 0;
    prices.previewProductPriceChange = async () => { count++; return preview(args); };
    const result = await prepareFirstSyncPrice(client, args);
    assert.equal(result.supportedFields.length, 0); assert.equal(count, 0);
  }
});
test('admin accept_remote conflict is allowed only with exact server manifest and fresh local evidence', async () => {
  const args = await proven(fixture()); const local = { known: true, present: true, value: '40.00', unit: 'UAH' };
  args.projection.fields[0].local = local; args.acceptedFields[0].before = local;
  args.projection.plan.fields[0] = { target: 'price', scope: 'all', status: 'conflict' };
  args.acceptedFields[0].source.decision = 'accept_remote';
  prices.previewProductPriceChange = async () => preview(args);
  assert.equal((await prepareFirstSyncPrice(client, args)).supportedFields.length, 1);
  delete args.acceptedFields[0].source.manifestHash;
  assert.equal((await prepareFirstSyncPrice(client, args)).blockedFields[0].code, 'FIRST_SYNC_PRICE_IMPORT_NOT_ACCEPTED');
});
test('unauthorized conflict and keep_local cannot invoke the price importer', async () => {
  for (const choice of [undefined, 'keep_local']) {
    const args = await proven(fixture()); args.projection.plan.fields[0].status = 'conflict';
    args.acceptedFields[0].source.decision = choice;
    assert.equal((await prepareFirstSyncPrice(client, args)).blockedFields[0].code, 'FIRST_SYNC_PRICE_IMPORT_NOT_ACCEPTED');
  }
});
test('ordinary preview failure produces a precise review blocker without partial mutation', async () => {
  const args = await proven(fixture());
  prices.previewProductPriceChange = async () => { throw Object.assign(Error('Missing configured baseline'), { publicCode: 'AUTOMATIC_PRICE_UNAVAILABLE' }); };
  const result = await prepareFirstSyncPrice(client, args);
  assert.equal(result.blockedFields[0].code, 'AUTOMATIC_PRICE_UNAVAILABLE'); assert.equal(result.supportedFields.length, 0);
});
test('apply requires actor and a successful exact ordinary command result', async () => {
  const args = await proven(fixture()); prices.previewProductPriceChange = async () => preview(args);
  delete args.actorUserId;
  await assert.rejects(applyFirstSyncPrice(client, args), { code: 'FIRST_SYNC_PRICE_ACTOR_REQUIRED' });
  args.actorUserId = 7;
  prices.applyProductPriceChangeInTransaction = async () => ({ success: true, resultingPriceUah: 44 });
  await assert.rejects(applyFirstSyncPrice(client, args), { code: 'FIRST_SYNC_PRICE_APPLY_NOT_EXACT' });
});
test('helper normalizer remains exact and currency rate currentness uses existing server policy', () => {
  assert.equal(normalizeDecimal('43,250000', 2), '43.25');
  assert.throws(() => currency.assertUsdRateObservationCurrent({ rateInfo: { stale: true, fetchedAt: '2000-01-01Z' } }));
});

// Retain the actual conditional publication: both mutually exclusive SV routes
// bind the same remote attribute set. Only local semantic evidence selects one.
function conditionalSvObservation(souvenir) {
  const real = require('./fixtures/legacy-sv-schema6');
  const publication = real.publication();
  const compiled = compileDefinition(publication.definition);
  const schema = c.normalizeSchema(publication.schema);
  const product = real.product(souvenir === 5 ? 2198 : 1919);
  product.details.answers.souvenir = souvenir;
  product.total_price_uah = '4600.00';
  const revision = { id: '11111111-1111-1111-1111-111111111111', state: 'published',
    templateVersionId: '22222222-2222-2222-2222-222222222222',
    originHash: c.originHash(config.baseUrl), definitionHash: compiled.hash,
    evaluatorVersion: compiled.definition.evaluatorVersion, outputContract: compiled.definition.outputContract,
    formatVersion: compiled.definition.formatVersion, schema,
    bindings: normalizeBindings(publication.bindings), schemaFingerprint: c.hash(schema),
    topologyFingerprint: c.hash(schema.storeTopology) };
  const raw = { id: 991919, sku: product.public_sku || product.full_sku, attribute_set_id: 151,
    price: 10000, custom_attributes: [] };
  return { amber: { product, compiled, revision,
    template: { kind: 'published', versionId: revision.templateVersionId, definitionHash: compiled.hash } },
  raw, schema, domainEvidence: { english: { id: raw.id, sku: raw.sku, fields: { name: 'Fixture EN' } }, failures: [] } };
}
const conditionalConfigs = () => [
  { id: 1, code: 'ua', website_id: 1, locale: 'uk_UA', base_currency_code: 'UAH' },
  { id: 3, code: 'en', website_id: 1, locale: 'en_US', base_currency_code: 'UAH' },
];
test('actual schema6 price proof selects souvenir 4, 5 and 6 before testing shared-set route uniqueness', async () => {
  for (const souvenir of [4, 5, 6]) {
    const observation = conditionalSvObservation(souvenir), calls = [];
    const evidence = await readCurrencyEvidence(config, observation, { fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      return new Response(JSON.stringify(conditionalConfigs()), { headers: { 'content-type': 'application/json' } });
    } });
    assert.deepEqual(evidence, { verified: true, currency: 'UAH' }, `souvenir=${souvenir}`);
    assert.deepEqual(calls, [{ url: 'https://fixture-magento.example/rest/all/V1/store/storeConfigs', method: 'GET' }]);
  }
});
test('conditional currency proof rejects unknown semantic route values without treating them as the negative branch', async () => {
  for (const souvenir of [undefined, null, '', 'invalid', true, 5.1, '05', '5 ', {}, Number.MAX_SAFE_INTEGER + 1]) {
    const observation = conditionalSvObservation(souvenir);
    let calls = 0;
    const evidence = await readCurrencyEvidence(config, observation, { fetchImpl: async () => { calls++; throw Error('Unexpected fetch'); } });
    assert.equal(evidence.verified, false);
    assert.equal(evidence.reason, 'PRICE_BOUND_ROUTE_NOT_UNIQUE');
    assert.equal(calls, 0);
  }
});
test('conditional price route must itself be enabled, approved and match the remote set', async () => {
  for (const souvenir of [4, 5, 6]) for (const change of ['disabled', 'review', 'different-set']) {
    const observation = conditionalSvObservation(souvenir);
    const selected = observation.amber.revision.bindings.routes.find(route => route.routeKey
      === (souvenir === 5 ? 'SV.souvenir=value_id:5' : 'SV.souvenir!=value_id:5'));
    if (change === 'disabled') selected.enabled = false;
    if (change === 'review') selected.reviewState = 'review_required';
    if (change === 'different-set') selected.setId = 999;
    let calls = 0;
    const evidence = await readCurrencyEvidence(config, observation, { fetchImpl: async () => { calls++; throw Error('Unexpected fetch'); } });
    assert.equal(evidence.verified, false, `${souvenir}/${change}`);
    assert.equal(evidence.reason, 'PRICE_BOUND_ROUTE_NOT_UNIQUE');
    assert.equal(calls, 0, 'The other approved route cannot substitute for the selected route');
  }
});
test('selected conditional route retains its website policy and remote UAH/read guards', async () => {
  for (const change of ['website-policy', 'currency', 'unreadable']) {
    const observation = conditionalSvObservation(4), rows = conditionalConfigs();
    if (change === 'website-policy') {
      const attribute = observation.amber.revision.bindings.attributes.find(attribute =>
        attribute.routeKey === 'SV.souvenir!=value_id:5' && attribute.target === 'product_websites');
      observation.amber.revision.bindings.policies.find(policy => policy.bindingKey === attribute.bindingKey).policy = 'magento_managed';
    }
    if (change === 'currency') rows[1].base_currency_code = 'USD';
    const evidence = await readCurrencyEvidence(config, observation, { fetchImpl: async () => {
      if (change === 'unreadable') throw Error('Fixture read failure');
      return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } });
    } });
    assert.equal(evidence.verified, false);
    assert.equal(evidence.reason, { 'website-policy': 'PRICE_BOUND_WEBSITE_NOT_PROVEN',
      currency: 'PRICE_BASE_CURRENCY_NOT_UAH', unreadable: 'PRICE_CURRENCY_READ_UNAVAILABLE' }[change]);
  }
});
test('proven conditional price currency preserves populated price conflict and requires an explicit keep-local decision', async () => {
  const { projectFirstSyncFields } = require('../src/services/magento/first-sync-projection');
  const { prepareProgress } = require('../src/services/magento/first-sync-progress-plan');
  const observation = conditionalSvObservation(4), before = JSON.stringify(observation.amber.product);
  const currencyEvidence = await readCurrencyEvidence(config, observation, { fetchImpl: async () =>
    new Response(JSON.stringify(conditionalConfigs()), { headers: { 'content-type': 'application/json' } }) });
  const projection = projectFirstSyncFields({ observation, currencyEvidence });
  const preview = prepareProgress(projection, null);
  const price = preview.rows.find(field => field.target === 'price' && field.scope === 'all');
  assert.equal(price.status, 'conflict');
  assert.equal(price.local.value, '4600.00'); assert.equal(price.remote.value, 10000);
  assert.equal(price.canKeepLocal, true); assert.equal(price.received, false);
  assert.equal(price.record.state, 'conflict');
  const selected = prepareProgress(projection, null, { target: 'price', scope: 'all', choice: 'keep_local' });
  const kept = selected.rows.find(field => field.target === 'price' && field.scope === 'all');
  assert.equal(kept.status, 'pending_outward_confirmation');
  assert.equal(kept.record.after, '4600.00');
  assert.equal(kept.record.source.decision, 'keep_local');
  assert.equal(kept.terminal, false);
  assert.equal(JSON.stringify(observation.amber.product), before, 'Neither preview nor an in-memory decision applies a price');
});
test('currency proof cannot be reused after the same product switches its conditional route', async () => {
  const { projectFirstSyncFields } = require('../src/services/magento/first-sync-projection');
  const { prepareProgress } = require('../src/services/magento/first-sync-progress-plan');
  const observation = conditionalSvObservation(5);
  const currencyEvidence = await readCurrencyEvidence(config, observation, { fetchImpl: async () =>
    new Response(JSON.stringify(conditionalConfigs()), { headers: { 'content-type': 'application/json' } }) });
  assert.equal(currencyEvidence.verified, true);
  observation.amber.product.details.answers.souvenir = 4;
  const projection = projectFirstSyncFields({ observation, currencyEvidence });
  const selected = prepareProgress(projection, null, { target: 'price', scope: 'all', choice: 'accept_remote' });
  const accepted = selected.rows.find(row => row.target === 'price' && row.scope === 'all').record;
  accepted.source.productId = observation.amber.product.id;
  let calls = 0;
  prices.previewProductPriceChange = async () => { calls++; throw Error('Stale currency route must not reach the price command'); };
  const result = await prepareFirstSyncPrice(client, { observation, projection, acceptedFields: [accepted],
    currencyEvidence, actorUserId: 7, rateObservation: fixture().rateObservation });
  assert.equal(result.blockedFields[0].code, 'FIRST_SYNC_PRICE_CURRENCY_NOT_PROVEN');
  assert.equal(result.supportedFields.length, 0); assert.equal(calls, 0);
});
