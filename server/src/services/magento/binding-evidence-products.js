const { evaluateProduct } = require('../export-templates/evaluate');
const { createMagentoClient } = require('./client');
const { MagentoIntegrationError } = require('./errors');
const { transport, OPTION_INPUTS, optionCandidates } = require('./binding-evidence-analysis');

const invalid = () => { throw new MagentoIntegrationError('MAGENTO_RESPONSE_INVALID'); };
function scalar(value) {
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string' && value.length <= 16384 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return value;
  return invalid();
}
function productEvidence(raw, targets) {
  if (!raw || !Number.isSafeInteger(raw.id) || raw.id <= 0
    || !Number.isSafeInteger(raw.attribute_set_id) || raw.attribute_set_id <= 0) invalid();
  const fields = {};
  for (const target of targets) if (Object.hasOwn(raw, target)) fields[target] = scalar(raw[target]);
  if (raw.custom_attributes !== undefined) {
    if (!Array.isArray(raw.custom_attributes) || raw.custom_attributes.length > 1000) invalid();
    for (const a of raw.custom_attributes) {
      if (!a || typeof a.attribute_code !== 'string') invalid();
      if (!targets.has(a.attribute_code)) continue;
      if (Object.hasOwn(fields, a.attribute_code)) invalid();
      fields[a.attribute_code] = Array.isArray(a.value) ? a.value.map(scalar) : scalar(a.value);
    }
  }
  for (const field of ['status', 'visibility']) {
    if (raw[field] !== undefined && (!Number.isSafeInteger(raw[field]) || raw[field] < 0)) invalid();
  }
  return { magentoProductId: raw.id, attributeSetId: raw.attribute_set_id,
    status: raw.status ?? null, visibility: raw.visibility ?? null, fields };
}
function evaluate(amber, product) {
  try {
    const mapped = evaluateProduct(amber.compiled, product);
    return { base: mapped.base || {}, english: mapped.english || {}, ready: mapped.errors.length === 0,
      issueFields: [...new Set(mapped.errors.map((e) => e.field).filter((f) => /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(f)))] };
  } catch {
    return { base: {}, english: {}, ready: false, issueFields: [], failed: true };
  }
}
async function sampleProducts(config, amber, schema, analysis, { fetchImpl } = {}) {
  const client = createMagentoClient(config, { fetchImpl, storeCode: 'all' });
  const targets = new Set([...analysis.bindingEvidence.map((e) => e.target),
    ...analysis.transportControls.filter((e) => e.magentoAttributeId !== null).map((e) => e.target)]);
  const diagnostics = [];
  const review = (code, details) => diagnostics.push({ code, severity: 'review', ...details });
  const samples = [];
  const foundProducts = new Map();
  const remote = new Map();
  for (const plan of amber.plans) {
    const candidates = amber.candidates.filter((c) => c.route_id === plan.id);
    if (!candidates.length) review('LOCAL_SAMPLE_NOT_FOUND', { routeId: plan.id, amberGroup: plan.amberGroup });
    for (const candidate of candidates) {
      const product = amber.products.find((p) => p.id === candidate.product_id);
      const publicSku = product.public_sku || product.full_sku;
      const expected = evaluate(amber, product);
      const predicted = expected.base.attribute_set_code || null;
      const sets = schema.attributeSets.filter((s) => s.attribute_set_name === predicted);
      const selected = sets.length === 1 ? sets[0] : null;
      const context = { localProductId: product.id, sku: product.full_sku, internalSku: product.full_sku,
        publicSku, amberGroup: product.category, routeId: plan.id };
      const sample = { ...context, predictedAttributeSet: predicted, predictedAttributeSetId: selected?.attribute_set_id ?? null,
        evaluation: { ready: expected.ready, issueFields: expected.issueFields, provisional: !expected.ready },
        sourceAnswers: Object.fromEntries(Object.values(amber.compiled.definition.sources)
          .filter((s) => s.category === product.category && Object.hasOwn(product.details?.answers || {}, s.key))
          .map((s) => [s.key, scalar(product.details.answers[s.key])])) };
      if (!expected.ready) review('PRODUCT_EVALUATION_NOT_READY', { localProductId: product.id });
      let observed;
      try {
        if (!remote.has(publicSku)) remote.set(publicSku,
          productEvidence(await client.findProductBySku(publicSku), targets));
        observed = remote.get(publicSku);
      } catch (cause) {
        if (cause.code !== 'MAGENTO_PRODUCT_NOT_FOUND') throw cause;
        review('MAGENTO_PRODUCT_NOT_FOUND', { localProductId: product.id, routeId: plan.id });
        samples.push({ ...sample, lookup: 'not_found' });
        continue;
      }
      const attributeSetAgrees = selected ? selected.attribute_set_id === observed.attributeSetId : null;
      if (attributeSetAgrees === false) review('PRODUCT_ATTRIBUTE_SET_MISMATCH', { localProductId: product.id,
        predictedAttributeSetId: selected.attribute_set_id, actualAttributeSetId: observed.attributeSetId });
      const group = amber.compiled.definition.groups.find((g) => g.route === product.category);
      const fields = group.columns.filter((target) => targets.has(target)
        && !transport(target, schema.attributes.find((a) => a.attribute_code === target))).map((target) => {
        const expectedAvailable = Object.hasOwn(expected.base, target);
        const value = expectedAvailable ? expected.base[target] : null;
        const attribute = schema.attributes.find((a) => a.attribute_code === target);
        const raw = observed.fields[target] ?? null;
        const populated = value !== '' && value !== null && value !== undefined;
        const membership = selected ? selected.attributeCodes.includes(target) : null;
        if (populated && membership === false) review('ATTRIBUTE_NOT_IN_SELECTED_SET', { localProductId: product.id,
          routeId: plan.id, target, attributeSetId: selected.attribute_set_id, provisional: !expected.ready });
        const optionIds = raw === null ? [] : (Array.isArray(raw) ? raw : String(raw).split(',')).map(String);
        const labels = OPTION_INPUTS.has(attribute?.frontend_input)
          ? optionIds.map((id) => ({ optionId: id, label: attribute.options.find((o) => o.value === id)?.label ?? null })) : null;
        const options = labels ? optionCandidates(attribute, String(value)) : null;
        const matches = !populated ? null : labels ? options.exact.length === 1 && optionIds.length === 1
          && options.exact[0].optionId === optionIds[0] : String(value) === String(raw);
        if (matches === false) review('PRODUCT_VALUE_MISMATCH', { localProductId: product.id, target, provisional: !expected.ready });
        return { target, expected: value, expectedAvailable, observed: raw, resolvedOptions: labels, matches,
          classification: !expectedAvailable ? 'not_evaluated' : !populated ? 'not_populated_for_sample' : membership === false
            ? 'attribute_missing_in_selected_attribute_set' : 'populated' };
      });
      const result = { ...sample, lookup: 'found', magentoProductId: observed.magentoProductId,
        actualAttributeSetId: observed.attributeSetId, attributeSetAgrees, status: observed.status,
        visibility: observed.visibility, fields, transport: Object.entries(expected.base).filter(([target]) =>
          transport(target, schema.attributes.find((a) => a.attribute_code === target))).map(([target, value]) =>
          ({ target, expectedCsvValue: value, observedNativeValue: observed.fields[target] ?? null,
            comparison: 'native_translation_required' })) };
      samples.push(result);
      foundProducts.set(product.id, { result, expected, observed });
      break;
    }
  }
  // Two found products maximum, favoring different categories. Never query inactive ru.
  const scopeSamples = [];
  for (const item of foundProducts.values()) {
    if (!scopeSamples.some((s) => s.result.amberGroup === item.result.amberGroup)) scopeSamples.push(item);
    if (scopeSamples.length === 2) break;
  }
  for (const { result, expected, observed } of scopeSamples) {
    const group = amber.compiled.definition.groups.find((g) => g.route === result.amberGroup);
    const fields = Object.keys(group.rows[1].cells).filter((field) => field !== 'sku' && targets.has(field));
    const scopes = { all: Object.fromEntries(fields.map((field) => [field, observed.fields[field] ?? null])) };
    for (const scope of ['ua', 'en']) {
      if (!schema.storeTopology.storeViews.some((s) => s.code === scope && s.is_active === true)) {
        review('STORE_SCOPE_UNAVAILABLE', { scope }); continue;
      }
      try {
        const scoped = productEvidence(await createMagentoClient(config, { fetchImpl, storeCode: scope })
          .findProductBySku(result.publicSku), new Set(fields));
        if (scoped.magentoProductId !== result.magentoProductId) invalid();
        scopes[scope] = Object.fromEntries(fields.map((field) => [field, scoped.fields[field] ?? null]));
      } catch (cause) {
        if (cause.code !== 'MAGENTO_PRODUCT_NOT_FOUND') throw cause;
        review('MAGENTO_PRODUCT_NOT_FOUND', { localProductId: result.localProductId, scope });
      }
    }
    result.storeScopeEvidence = { baseRowScope: 'unconfirmed', observations: scopes,
      comparisons: fields.map((field) => {
        const differs = new Set(Object.values(scopes).map((s) => JSON.stringify(s[field]))).size > 1;
        const englishAvailable = Object.hasOwn(expected.english, field);
        const englishMatches = scopes.en && englishAvailable ? String(scopes.en[field]) === String(expected.english[field]) : null;
        if (differs || englishMatches === false) review('STORE_SCOPE_VALUE_MISMATCH', { localProductId: result.localProductId, target: field });
        return { field, scopeValuesDiffer: differs, expectedBase: expected.base[field] ?? null,
          expectedEnglish: expected.english[field] ?? null, englishMatches,
          baseMatchesScopes: Object.hasOwn(expected.base, field) ? Object.entries(scopes)
            .filter(([, values]) => String(values[field]) === String(expected.base[field])).map(([scope]) => scope) : [] };
      }) };
  }
  return { sampleProducts: samples, diagnostics };
}

module.exports = { sampleProducts, productEvidence, evaluate };
