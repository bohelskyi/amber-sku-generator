// Caller obtains currency/rate evidence before DB locks. Price preparation and
// application reuse the ordinary guarded price command on the caller's transaction.
const c = require('./binding-contract');
const { createMagentoClient } = require('./client');
const { evaluateProduct } = require('../export-templates/evaluate');
const { requirements, normalizeBindings } = require('./binding-validation');
const { normalizeDecimal } = require('./first-sync-field-plan');
const prices = require('../product-price-change.service');
const currency = require('../currency.service');
const { same } = require('./name-reconciliation');
const currencyProofs = new WeakMap();
const ready = new WeakMap();
const key = field => field.scope + '/' + field.target;
const positive = value => normalizeDecimal(value) !== null && Number(value) > 0;
const denied = reason => ({ verified: false, reason });
const block = (code, reason = code) => ({ target: 'price', scope: 'all', code,
  reason: String(reason).slice(0, 600) });
const fail = code => { throw c.error(409, code, 'Потрібна актуальна перевірка ціни першої синхронізації.'); };
function observationIdentity(observation) {
  const amber = observation?.amber, raw = observation?.raw;
  if (!amber?.revision || !amber.compiled || !amber.product || !raw
    || !Number.isSafeInteger(raw.id) || raw.id <= 0
    || raw.sku !== (amber.product.public_sku || amber.product.full_sku)) fail('FIRST_SYNC_PRICE_IDENTITY_INVALID');
  return { bindingRevisionId: amber.revision.id, definitionHash: amber.compiled.hash,
    remoteId: raw.id, sku: raw.sku, productId: Number(amber.product.id) };
}
function exactActive(current, pinned, code) {
  const a = current.storeViews.filter(view => view.code === code && view.is_active === true);
  const b = pinned.storeViews.filter(view => view.code === code && view.is_active === true);
  return a.length === 1 && b.length === 1
    && ['id', 'website_id', 'store_group_id'].every(field => a[0][field] === b[0][field]) ? a[0] : null;
}
async function readCurrencyEvidence(config, observation, { fetchImpl } = {}) {
  try {
    const identity = observationIdentity(observation), amber = observation.amber;
    if (amber.revision.state !== 'published' || amber.revision.definitionHash !== amber.compiled.hash
      || amber.revision.originHash !== c.originHash(config.baseUrl)) return denied('PRICE_BINDING_INSTALLATION_NOT_PROVEN');
    const current = c.normalizeSchema(observation.schema), pinned = c.normalizeSchema(amber.revision.schema);
    if (current.storeCode !== 'all' || pinned.storeCode !== 'all'
      || c.hash(pinned) !== amber.revision.schemaFingerprint
      || c.hash(pinned.storeTopology) !== amber.revision.topologyFingerprint) return denied('PRICE_PINNED_SCHEMA_NOT_PROVEN');
    const bindings = normalizeBindings(amber.revision.bindings);
    const plans = requirements(amber.compiled.definition, pinned);
    const routes = bindings.routes.filter(route => route.enabled && route.reviewState === 'approved'
      && route.setId === observation.raw.attribute_set_id
      && plans.some(plan => plan.routeKey === route.routeKey && plan.amberGroup === amber.product.category));
    if (routes.length !== 1) return denied('PRICE_BOUND_ROUTE_NOT_UNIQUE');
    const websiteBinding = bindings.attributes.find(attribute => attribute.routeKey === routes[0].routeKey
      && attribute.rowId === 'base' && attribute.target === 'product_websites'
      && attribute.reviewState === 'approved' && attribute.strategy === 'transport_control');
    const websitePolicy = bindings.policies.find(policy => policy.bindingKey === websiteBinding?.bindingKey
      && policy.storeCode === 'all' && policy.reviewState === 'approved'
      && policy.policy === 'authoritative_create_update');
    if (!websiteBinding || !websitePolicy) return denied('PRICE_BOUND_WEBSITE_NOT_PROVEN');
    // Keep the original product's private immutable-source association.
    const evaluated = evaluateProduct(amber.compiled, amber.product);
    const codes = typeof evaluated.base?.product_websites === 'string'
      ? evaluated.base.product_websites.split(',').map(code => code.trim()).filter(Boolean) : [];
    if (codes.length !== 1) return denied('PRICE_BOUND_WEBSITE_NOT_UNIQUE');
    const a = current.storeTopology.websites.filter(website => website.code === codes[0]);
    const b = pinned.storeTopology.websites.filter(website => website.code === codes[0]);
    if (a.length !== 1 || b.length !== 1 || a[0].id !== b[0].id
      || a[0].default_group_id !== b[0].default_group_id || !a[0].default_group_id) {
      return denied('PRICE_WEBSITE_IDENTITY_NOT_PROVEN');
    }
    const website = a[0];
    const groups = current.storeTopology.storeGroups.filter(group => group.id === website.default_group_id
      && group.website_id === website.id);
    const savedGroups = pinned.storeTopology.storeGroups.filter(group => group.id === website.default_group_id
      && group.website_id === website.id);
    if (groups.length !== 1 || savedGroups.length !== 1
      || groups[0].default_store_id !== savedGroups[0].default_store_id || !groups[0].default_store_id) {
      return denied('PRICE_UA_DEFAULT_STORE_NOT_PROVEN');
    }
    const defaults = current.storeTopology.storeViews.filter(view => view.id === groups[0].default_store_id);
    const ua = defaults.length === 1 ? exactActive(current.storeTopology, pinned.storeTopology, defaults[0].code) : null;
    const en = exactActive(current.storeTopology, pinned.storeTopology, 'en');
    if (!ua || !en || ua.id === en.id || ua.website_id !== website.id || en.website_id !== website.id
      || ua.store_group_id !== groups[0].id) return denied('PRICE_UA_EN_SCOPE_NOT_PROVEN');
    const configs = await createMagentoClient(config, { fetchImpl, storeCode: 'all' }).getStoreConfigs();
    if (!Array.isArray(configs) || configs.length > 100 || configs.some(row => !row || typeof row !== 'object'
      || Array.isArray(row)) || new Set(configs.map(row => row.id)).size !== configs.length
      || new Set(configs.map(row => row.code)).size !== configs.length) return denied('PRICE_STORE_CONFIGS_INVALID');
    const matches = [ua, en].map(view => configs.filter(row => row.id === view.id && row.code === view.code
      && row.website_id === view.website_id));
    if (matches.some(rows => rows.length !== 1)) return denied('PRICE_STORE_CONFIG_IDENTITY_NOT_PROVEN');
    if (!/^uk(?:_|-)/.test(matches[0][0].locale || '') || !/^en(?:_|-)/.test(matches[1][0].locale || '')) {
      return denied('PRICE_UA_EN_LOCALE_NOT_PROVEN');
    }
    if (matches.some(rows => rows[0].base_currency_code !== 'UAH')) return denied('PRICE_BASE_CURRENCY_NOT_UAH');
    const evidence = { verified: true, currency: 'UAH' };
    currencyProofs.set(evidence, { identity, observedSchemaHash: c.hash(current),
      pinnedSchemaHash: c.hash(pinned), stores: [ua, en].map(view => ({ id: view.id, code: view.code, websiteId: view.website_id })) });
    return evidence;
  } catch {
    return denied('PRICE_CURRENCY_READ_UNAVAILABLE');
  }
}
function currencyProven(observation, evidence) {
  try {
    const proof = evidence && currencyProofs.get(evidence);
  return evidence?.verified === true && evidence.currency === 'UAH' && proof
    && same(proof.identity, observationIdentity(observation))
    && proof.observedSchemaHash === c.hash(c.normalizeSchema(observation.schema))
    && proof.pinnedSchemaHash === c.hash(c.normalizeSchema(observation.amber.revision.schema));
  } catch { return false; }
}
function priceEvidence(args) {
  const { observation, acceptedFields, projection } = args;
  const identity = observationIdentity(observation);
  if (!Array.isArray(acceptedFields) || acceptedFields.length !== 1
    || !Array.isArray(projection?.projection) || !Array.isArray(projection?.fields)
    || !Array.isArray(projection.plan?.fields)) fail('FIRST_SYNC_PRICE_EVIDENCE_INVALID');
  const field = acceptedFields[0];
  if (field.target !== 'price' || field.scope !== 'all' || field.state !== 'imported') fail('FIRST_SYNC_PRICE_FIELD_UNSUPPORTED');
  const items = projection.projection.filter(item => key(item) === key(field));
  const inputs = projection.fields.filter(item => key(item) === key(field));
  const decisions = projection.plan.fields.filter(item => key(item) === key(field));
  if (items.length !== 1 || inputs.length !== 1 || decisions.length !== 1) fail('FIRST_SYNC_PRICE_EVIDENCE_INVALID');
  const meta = items[0], input = inputs[0], decision = decisions[0];
  const source = { ...meta.source, productId: identity.productId };
  if (meta.persistence !== 'price' || meta.source.kind !== 'product' || meta.source.field !== 'total_price_uah'
    || meta.storagePath !== 'total_price_uah' || meta.reason || meta.importBlocker || meta.readReason
    || meta.source.bindingRevisionId !== identity.bindingRevisionId || meta.source.definitionHash !== identity.definitionHash
    || !input.mapping?.proven || input.unit !== 'UAH' || input.scale !== 2
    || !input.remote.known || !input.remote.present || !input.local.known
    || !same(field.before, input.local) || !same(field.remote, input.remote)
    || field.mappingHash !== meta.mappingHash || !field.source
    || Object.entries(source).some(([name, value]) => !same(field.source[name], value))) fail('FIRST_SYNC_PRICE_EVIDENCE_INVALID');
  const manifestHash = c.hash(projection.projection.map(({ target, scope, mappingHash }) => ({ target, scope, mappingHash })));
  if (field.source.manifestHash !== undefined && field.source.manifestHash !== manifestHash) fail('FIRST_SYNC_PRICE_MANIFEST_CHANGED');
  const explicitConflict = decision.status === 'conflict' && field.source.decision === 'accept_remote'
    && field.source.manifestHash === manifestHash;
  if (!explicitConflict && (decision.status !== 'imported'
    || field.source.decision !== undefined || normalizeDecimal(decision.importValue, 2) !== normalizeDecimal(field.after, 2))) {
    fail('FIRST_SYNC_PRICE_IMPORT_NOT_ACCEPTED');
  }
  const value = normalizeDecimal(input.remote.value, 2);
  if (!value || !positive(value) || normalizeDecimal(field.after, 2) !== value
    || normalizeDecimal(Number(value), 2) !== value) fail('FIRST_SYNC_PRICE_EXACT_DECIMAL_UNSUPPORTED');
  return { field, input, value, productId: identity.productId,
    decision: { mode: 'manual_uah', manualPriceUah: value, marketingRoundingEnabled: false } };
}
async function prepareFirstSyncPrice(client, args = {}) {
  if (!client || typeof client.query !== 'function' || !Array.isArray(args.acceptedFields)
    || args.acceptedFields.length > 500) fail('FIRST_SYNC_PRICE_INPUT_INVALID');
  const result = { supportedFields: [], blockedFields: [] };
  if (!args.acceptedFields.length) { ready.set(result, null); return result; }
  try {
    const input = priceEvidence(args);
    const evidence = args.currencyEvidence || args.observation.currencyEvidence;
    if (!currencyProven(args.observation, evidence)) fail('FIRST_SYNC_PRICE_CURRENCY_NOT_PROVEN');
    // Never allow the ordinary pricing service to fall back to a live rate read
    // while this caller holds locks or an open transaction.
    if (!args.rateObservation || args.rateObservation.rateError
      || !positive(args.rateObservation.rateInfo?.rate)) fail('FIRST_SYNC_PRICE_RATE_OBSERVATION_REQUIRED');
    currency.assertUsdRateObservationCurrent(args.rateObservation);
    const preview = await prices.previewProductPriceChange({ productId: input.productId,
      pricingDecision: input.decision }, { queryable: client, rateObservation: args.rateObservation });
    if (preview.productId !== input.productId
      || (preview.publicSku || preview.sku) !== args.observation.raw.sku
      || normalizeDecimal(preview.resultingPriceUah, 2) !== input.value
      || !same(preview.pricingDecision, prices.normalizePriceChangeDecision(input.decision))
      || typeof preview.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(preview.previewToken)) {
      fail('FIRST_SYNC_PRICE_PREVIEW_NOT_EXACT');
    }
    const current = preview.currentPricing?.totalPriceUah;
    if (input.input.local.present ? normalizeDecimal(current, 2) !== normalizeDecimal(input.input.local.value, 2)
      : current !== null && current !== undefined && current !== '') fail('FIRST_SYNC_PRICE_LOCAL_STATE_CHANGED');
    const baseline = preview.resultingPricing;
    if (!positive(baseline?.calculatedPriceUah) || !positive(baseline?.autoPriceUah)
      || !positive(baseline?.uahRate) || baseline?.customUsdPerGramBasis !== null
      || normalizeDecimal(baseline?.manualPriceUah, 2) !== input.value) fail('FIRST_SYNC_PRICE_AUTOMATIC_BASELINE_UNAVAILABLE');
    if (preview.unchanged) fail('FIRST_SYNC_PRICE_ALREADY_EQUAL_REOBSERVE');
    ready.set(result, { ...input, preview, rateObservation: args.rateObservation });
    result.supportedFields.push(input.field);
  } catch (cause) {
    result.blockedFields.push(block(cause.code || cause.publicCode || 'FIRST_SYNC_PRICE_BASELINE_VALIDATION_REQUIRED',
      cause.message));
  }
  return result;
}
async function applyFirstSyncPrice(client, args = {}) {
  if (!Array.isArray(args.acceptedFields)) fail('FIRST_SYNC_PRICE_INPUT_INVALID');
  if (!args.acceptedFields.length) return { changed: false, supportedFields: [], blockedFields: [] };
  if (!Number.isSafeInteger(args.actorUserId) || args.actorUserId <= 0) fail('FIRST_SYNC_PRICE_ACTOR_REQUIRED');
  const preparation = await prepareFirstSyncPrice(client, args);
  if (preparation.blockedFields.length) fail(preparation.blockedFields[0].code);
  const prepared = ready.get(preparation);
  if (!prepared) fail('FIRST_SYNC_PRICE_PREPARATION_REQUIRED');
  const result = await prices.applyProductPriceChangeInTransaction({ productId: prepared.productId,
    pricingDecision: prepared.decision, previewToken: prepared.preview.previewToken },
  { queryable: client, rateObservation: prepared.rateObservation, mutationContext: { actorUserId: args.actorUserId } });
  if (result.success !== true || normalizeDecimal(result.resultingPriceUah, 2) !== prepared.value) {
    fail('FIRST_SYNC_PRICE_APPLY_NOT_EXACT');
  }
  return { changed: true, ...result, supportedFields: preparation.supportedFields, blockedFields: [] };
}
module.exports = { readCurrencyEvidence, prepareFirstSyncPrice, applyFirstSyncPrice };
