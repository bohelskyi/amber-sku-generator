// Internal first-sync preparation. Caller owns authority, product CAS and transaction.
// No HTTP, identity changes, configuration publication or independent transaction.
const c = require('./binding-contract');
const { normalizeDecimal } = require('./first-sync-field-plan');
const configurations = require('../product/characteristic-config');
const { normalizeProductInputAnswers, isQuestionVisibleForSku } = require('../product/product-answers');
const { inspectNonSkuAnswer } = require('../product/product-validation');
const prices = require('../product-price-change.service');
const { roundAutomaticUah, toUahNumber } = require('../../utils/money');
const currency = require('../currency.service');
const { loadPricingContext } = require('../pricing.service');
const { getPricingContextFingerprint } = require('../pricing/pricing-context-fingerprint');
const evaluator = require('./binding-evidence-products');
const { normalizeBindings } = require('./binding-validation');
const fail = code => { throw c.error(409, code, code); };
const present = value => value !== undefined && value !== null && String(value).trim() !== '';
const correctionProvenance = product => {
  const correction = product.details?.correction, basis = product.details?.customUsdPerGramBasis;
  return Number.isSafeInteger(Number(product.corrected_from_product_id)) && Number(product.corrected_from_product_id) > 0
    && Number(correction?.sourceProductId) === Number(product.corrected_from_product_id)
    && typeof correction.sourceSku === 'string' && correction.sourceSku.trim()
    && typeof correction.reason === 'string' && Array.isArray(correction.changes)
    && (basis?.correctionRequestId === undefined || Number.isSafeInteger(basis.correctionRequestId) && basis.correctionRequestId > 0);
};
const positive = value => normalizeDecimal(value) !== null && Number(value) > 0;

function existingDecision(product) {
  const details = product.details || {}, final = normalizeDecimal(product.total_price_uah, 2);
  if (!positive(final) || product.legacy_uah_price_unset) fail('FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN');
  const manual = details.manualPriceUah, custom = details.customUsdPerGramBasis;
  if (present(manual)) {
    if (custom || !positive(manual) || normalizeDecimal(manual, 2) !== final) fail('FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN');
    // Preserve the already selected exact manual result, including earlier rounding.
    return { mode: 'manual_uah', manualPriceUah: final, marketingRoundingEnabled: false };
  }
  if (normalizeDecimal(details.autoPriceUah, 2) !== final || !positive(details.calculatedPriceUah)) {
    fail('FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN');
  }
  if (custom) {
    if (!positive(custom.usdPerGram) || typeof custom.marketingRoundingEnabled !== 'boolean'
      || !(typeof custom.source === 'string' && custom.source.trim() || custom.source === undefined && correctionProvenance(product))
      || details.pricingScenario
      || !positive(product.weight) || !positive(product.uah_rate) || !positive(product.total_price)
      || normalizeDecimal(product.price_per_gram,4) !== normalizeDecimal(custom.usdPerGram,4)) fail('FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN');
    const raw = Number(custom.usdPerGram) * Number(product.weight) * Number(product.uah_rate);
    const automatic = custom.marketingRoundingEnabled ? roundAutomaticUah(raw) : toUahNumber(raw);
    if (normalizeDecimal(details.calculatedPriceUah,2) !== normalizeDecimal(toUahNumber(raw),2)
      || normalizeDecimal(automatic,2) !== final
      || normalizeDecimal(product.total_price,2) !== normalizeDecimal(Number((Number(custom.usdPerGram)*Number(product.weight)).toFixed(2)),2)) fail('FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN');
    return { mode: 'usd_per_gram', usdPerGram: custom.usdPerGram, marketingRoundingEnabled: custom.marketingRoundingEnabled };
  }
  const mode = details.pricingScenario?.price_mode || details.pricingScenario?.priceMode;
  if (!['fixed_uah', 'per_gram_usd'].includes(mode)
    || ![toUahNumber(details.calculatedPriceUah),roundAutomaticUah(Number(details.calculatedPriceUah))]
      .some(value => normalizeDecimal(value,2) === final)) fail('FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN');
  if (mode === 'fixed_uah') {
    if (normalizeDecimal(product.price_per_gram) !== '0' || normalizeDecimal(product.total_price) !== '0') fail('FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN');
  } else {
    if (![product.weight,product.price_per_gram,product.uah_rate,product.total_price].every(positive)) fail('FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN');
    const usd = Number(product.weight)*Number(product.price_per_gram);
    if (normalizeDecimal(product.total_price,2) !== normalizeDecimal(Number(usd.toFixed(2)),2)
      || normalizeDecimal(details.calculatedPriceUah,2) !== normalizeDecimal(toUahNumber(usd*Number(product.uah_rate)),2)) fail('FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN');
  }
  return { mode: 'system_auto' };
}

function validateConfiguration(configuration, product, answers, changedKeys) {
  if (configuration?.category_code !== product.category || !Array.isArray(configuration.questions)) fail('FIRST_SYNC_CANONICAL_CONFIGURATION_UNPROVEN');
  const previous = product.details?.answers || {}, calibrated = answers.is_calibrated ?? product.details?.isCalibrated;
  const normalized = normalizeProductInputAnswers(product.category, answers, configuration.questions, { previousAnswers: previous });
  for (const key of changedKeys) {
    const questions = configuration.questions.filter(question => question.key === key);
    if (questions.length !== 1 || questions[0].archived
      || !isQuestionVisibleForSku(questions[0], normalized, calibrated)) fail('FIRST_SYNC_CANONICAL_TARGET_UNAVAILABLE');
    if (String(normalized[key]) !== String(answers[key])) fail('FIRST_SYNC_CANONICAL_VALUE_NORMALIZED');
  }
  for (const question of configuration.questions) {
    const inspection = inspectNonSkuAnswer(question, normalized, calibrated, { previousAnswers: previous });
    if (inspection.issue) fail('FIRST_SYNC_CANONICAL_ANSWER_' + inspection.issue.toUpperCase());
    if (present(previous[question.key]) && !question.archived
      && isQuestionVisibleForSku(question, previous, previous.is_calibrated ?? product.details?.isCalibrated)
      && !inspection.visible) fail('FIRST_SYNC_CANONICAL_DEPENDENT_ANSWER_HIDDEN');
  }
}

async function prepareCanonicalInputs(client, { amber, entries, answers, rateObservation, lockCatalog = false }) {
  if (!entries.length) return null;
  const product = amber.product;
  if (product.full_sku || !product.characteristic_version_id || product.sku_schema_version_id) {
    fail('FIRST_SYNC_CANONICAL_NATIVE_VERSION_REQUIRED');
  }
  if (lockCatalog) {
    // Existing writers have no shared category advisory lock. NOWAIT also
    // excludes insert phantoms; release with caller's short transaction.
    await client.query('LOCK TABLE categories,questions,options,price_scenarios,price_weight_bands,price_matrix,price_modifiers IN SHARE MODE NOWAIT');
  }
  if ((await client.query(`SELECT id FROM correction_requests WHERE source_product_id=$1
    AND status IN ('pending','in_progress') LIMIT 1`, [product.id])).rows.length) fail('ACTIVE_CORRECTION_REQUEST');
  const frozen = await configurations.getCharacteristicVersion(client, product.characteristic_version_id);
  const current = await configurations.readCharacteristicConfiguration(client, product.category);
  const patch = {}, weights = [], changedKeys = new Set();
  for (const { field, meta } of entries) {
    if (field.scope !== 'all') fail('LOCALIZED_CANONICAL_SETTER_NOT_PROVEN');
    if (meta.persistence === 'weight') {
      const weight = normalizeDecimal(field.after, 3);
      if (!positive(weight) || normalizeDecimal(Number(weight), 3) !== weight) fail('FIRST_SYNC_CANONICAL_WEIGHT_INVALID');
      weights.push(weight);
    } else {
      const key = meta.source.key;
      if (key === 'is_calibrated') fail('FIRST_SYNC_CANONICAL_CALIBRATION_REVIEW_REQUIRED');
      if (Object.hasOwn(patch, key) && String(patch[key]) !== String(field.after)) fail('FIRST_SYNC_LOCAL_CANONICAL_FIELD_CONFLICT');
      patch[key] = field.after; changedKeys.add(key);
    }
  }
  if (new Set(weights).size > 1) fail('FIRST_SYNC_LOCAL_CANONICAL_FIELD_CONFLICT');
  const weight = weights[0] ?? product.weight;
  const oldMirror = product.details?.answers?.weight;
  if (present(product.weight) && present(oldMirror)
    && normalizeDecimal(product.weight, 3) !== normalizeDecimal(oldMirror, 3)) fail('CANONICAL_WEIGHT_ANSWER_INCOHERENT');
  const hasWeightQuestion = frozen?.questions?.some(question => question.key === 'weight');
  if (weights.length && (product.category === 'SV' || hasWeightQuestion || present(oldMirror))) {
    patch.weight = weight; changedKeys.add('weight');
  }
  const candidateAnswers = { ...answers, ...patch };
  validateConfiguration(frozen, product, candidateAnswers, changedKeys);
  validateConfiguration(current, product, candidateAnswers, changedKeys);
  if ((Number(frozen.requires_weight) === 1 || Number(current.requires_weight) === 1) && !positive(weight)) fail('FIRST_SYNC_CANONICAL_WEIGHT_REQUIRED');
  const decision = existingDecision(product);
  let provenance = null;
  if (decision.mode === 'usd_per_gram' && product.details.customUsdPerGramBasis.source === undefined) {
    const sourceId = Number(product.corrected_from_product_id), correction = product.details.correction;
    const proof = (await client.query(`SELECT a.id,a.details,s.full_sku,i.public_sku,s.corrected_to_product_id,s.status
      FROM audit_events a JOIN products s ON s.id=$1 JOIN public_product_identities i ON i.id=s.public_product_identity_id
      WHERE a.event_key='product.recounted' AND a.subject_type='product' AND a.subject_id=$2
        AND a.details->>'correctedProductId'=$3 ORDER BY a.id LIMIT 2`, [sourceId,String(sourceId),String(product.id)])).rows;
    const row = proof[0], basis = product.details.customUsdPerGramBasis;
    if (proof.length !== 1 || row.status !== 'corrected' || Number(row.corrected_to_product_id) !== Number(product.id)
      || row.details.sourceSku !== correction.sourceSku || (row.full_sku || row.public_sku) !== correction.sourceSku
      || (basis.correctionRequestId !== undefined && row.details.correctionRequestId !== basis.correctionRequestId)) {
      fail('FIRST_SYNC_CANONICAL_CUSTOM_PROVENANCE_UNPROVEN');
    }
    provenance = { auditId: String(row.id), sourceProductId: sourceId, details: row.details };
  }
  if (!rateObservation || rateObservation.rateError || !positive(rateObservation.rateInfo?.rate)) fail('FIRST_SYNC_CANONICAL_RATE_REQUIRED');
  currency.assertUsdRateObservationCurrent(rateObservation);
  const context = await loadPricingContext(product.category, client);
  // Keep the original source-support-owned object during prospective evaluation.
  const prospectiveKeys = ['details','weight','total_price','total_price_uah','price_per_gram','uah_rate'];
  const saved = Object.fromEntries(prospectiveKeys.filter(key => Object.hasOwn(product,key)).map(key => [key,product[key]]));
  let pricing;
  try {
    product.details = { ...saved.details, answers: candidateAnswers }; product.weight = weight;
    pricing = await prices.calculatePriceChange(product, prices.normalizePriceChangeDecision(decision), client, rateObservation);
    if (normalizeDecimal(pricing.totalPriceUah, 2) !== normalizeDecimal(saved.total_price_uah, 2)) fail('FIRST_SYNC_CANONICAL_PRICE_REVIEW_REQUIRED');
    if (saved.details.customUsdPerGramBasis) pricing.details.customUsdPerGramBasis = saved.details.customUsdPerGramBasis;
    Object.assign(product, { details: pricing.details, total_price: pricing.totalPrice, total_price_uah: pricing.totalPriceUah,
      price_per_gram: pricing.pricePerGram, uah_rate: pricing.uahRate });
    const mapped = evaluator.evaluate(amber, product);
    if (mapped.failed) fail('FIRST_SYNC_CANONICAL_FORWARD_UNPROVEN');
    const bindings = normalizeBindings(amber.revision.bindings);
    const options = bindings.options;
    for (const { field, meta } of entries) {
      if (mapped.issueFields?.includes(field.target)) fail('FIRST_SYNC_CANONICAL_FORWARD_UNPROVEN');
      const output = mapped.base?.[field.target];
      if (meta.persistence === 'weight') {
        if (normalizeDecimal(output, 3) !== normalizeDecimal(field.after, 3)) fail('FIRST_SYNC_CANONICAL_FORWARD_UNPROVEN');
      } else {
        const matches = options.filter(option => option.reviewState === 'approved' && option.sourceKind === 'semantic'
          && option.amberGroup === product.category && option.questionKey === meta.source.key
          && String(option.valueId) === String(field.after) && option.optionId === String(field.remote.value)
          && bindings.attributes.some(attribute => attribute.bindingKey === option.bindingKey
            && attribute.routeKey === meta.source.routeKey && attribute.rowId === 'base' && attribute.target === field.target));
        if (matches.length !== 1 || output !== matches[0].evaluatedOutput) fail('FIRST_SYNC_CANONICAL_FORWARD_UNPROVEN');
      }
    }
  } finally { Object.assign(product, saved); for (const key of prospectiveKeys) if (!Object.hasOwn(saved,key)) delete product[key]; }
  const changes = Object.entries(patch).map(([key, after]) => ({ key, before: product.details?.answers?.[key] ?? null, after }));
  const evidence = { version: 1, productId: product.id, characteristicVersionId: product.characteristic_version_id,
    frozenHash: frozen.config_hash, currentHash: current.config_hash, pricingHash: getPricingContextFingerprint(context),
    decision, provenance, weight, pricing: { ...pricing, details: { ...pricing.details,
      rateMetadata: Object.fromEntries(Object.entries(pricing.details.rateMetadata || {}).filter(([key]) => key !== 'fetchedAt')) } }, changes };
  return { weight, pricing, changes, evidenceHash: c.hash(evidence), evidence };
}
module.exports = { prepareCanonicalInputs, existingDecision };
