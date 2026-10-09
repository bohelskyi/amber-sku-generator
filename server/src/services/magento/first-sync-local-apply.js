// Internal callback only. Caller owns authority, locks, snapshot CAS, the ledger
// subset and transaction. This module never starts a transaction or contacts Magento.
const c = require('./binding-contract');
const information = require('../product-information.service');
const previews = require('./sync-preview-db');
const evaluator = require('./binding-evidence-products');
const names = require('./name-state');
const { same, reconcileNames } = require('./name-reconciliation');
const { validName, validPair } = require('../export-templates/effective-product-names');
const lifecycle = require('../full-product-export.service');
const audit = require('../../audit/audit-events');

const canonical = require('./first-sync-canonical-inputs');
const prepared = new WeakMap();
const scopes = ['all', 'en'];
const fail = (code, message = code) => { throw c.error(409, code, message); };
const identity = field => `${field.scope}/${field.target}`;
const effectiveNames = result => ({ ...(typeof result.base?.name === 'string' ? { all: result.base.name } : {}),
  ...(typeof result.english?.name === 'string' ? { en: result.english.name } : {}) });
function generatedNames(result) {
  const generated = result.generatedNames;
  if (result.failed || !generated || typeof generated !== 'object' || Array.isArray(generated)
    || Object.keys(generated).some(key => !scopes.includes(key) || typeof generated[key] !== 'string')) {
    fail('FIRST_SYNC_LOCAL_NAME_ANCHOR_UNAVAILABLE');
  }
  return generated;
}
function retainedNames(product, generated) {
  const retained = {};
  for (const key of ['magento_name_rule_pin', 'magento_name_override']) {
    const saved = product[key];
    if (saved && same(saved.generated, generated)) for (const scope of scopes) {
      if (validName(saved.values?.[scope])) retained[scope] = saved.values[scope];
    }
  }
  return retained;
}
function remoteNames(observation, projection) {
  const english = projection.fields.find(field => field.target === 'name' && field.scope === 'en');
  return { ...(typeof observation.raw?.name === 'string' ? { all: observation.raw.name } : {}),
    ...(english?.remote.known && typeof observation.domainEvidence?.english?.fields?.name === 'string'
      ? { en: observation.domainEvidence.english.fields.name } : {}) };
}
function receivedNameObservation(change, previous, projection) {
  if (validPair(change.remote) && same(change.values, change.remote)) {
    return { action: 'confirm', baseline: change.remote, resolution: null };
  }
  const baseline = previous?.baseline_names ?? null;
  let resolution = previous?.resolution && same(previous.resolution.amber, change.values)
    && same(previous.resolution.remote, change.remote) ? previous.resolution : null;
  // A new receipt authorizes only its language. It cannot review an ordinary
  // conflict in a previously received language, or a populated unselected name.
  const emptyUnreceivedOnly = scopes.every(scope => {
    if (change.values[scope] === change.remote[scope]) return true;
    const field = projection.fields.find(item => item.target === 'name' && item.scope === scope);
    return field && !field.receipt?.received && !field.receipt?.state
      && field.remote.known === true && field.remote.present === false && validName(change.values[scope]);
  });
  if (emptyUnreceivedOnly) resolution = { amber: change.values, remote: change.remote };
  const ordinary = reconcileNames(baseline, change.values, change.remote, resolution);
  // saveObservation's accept_external branch claims the remote pair was imported.
  // Leave that action to ordinary reconciliation; here only the NEW subset changed.
  return { action: ordinary.action === 'accept_external' ? 'conflict' : ordinary.action, baseline, resolution };
}
function evidenceFor(field, projection, amber) {
  const metadata = projection.projection.filter(item => identity(item) === identity(field));
  const inputs = projection.fields.filter(item => identity(item) === identity(field));
  const decisions = projection.plan?.fields?.filter(item => identity(item) === identity(field)) || [];
  if (metadata.length !== 1 || inputs.length !== 1 || decisions.length !== 1) fail('FIRST_SYNC_LOCAL_EVIDENCE_MISMATCH');
  const meta = metadata[0], input = inputs[0], decision = decisions[0];
  const { manifestHash, decision: choice, ...source } = field.source || {};
  const acceptedConflict = decision.status === 'conflict' && choice === 'accept_remote' && input.remote.known && input.remote.present;
  const reverseValues = meta.persistence === 'characteristic' ? [...new Set((input.reverseCandidates || [])
    .filter(candidate => candidate.optionId === String(input.remote.value)).map(candidate => String(candidate.value)))] : null;
  const acceptedValue = acceptedConflict && reverseValues?.length === 1 ? reverseValues[0] : input.remote.value;
  const receivedEqualName = field.state === 'name_received' && meta.persistence === 'name' && decision.status === 'equal'
    && input.local.known && input.remote.known && input.local.value === input.remote.value;
  if (!['imported', 'name_received'].includes(field.state) || !(decision.status === 'imported' || acceptedConflict || receivedEqualName)
    || manifestHash !== undefined && !/^[a-f0-9]{64}$/.test(manifestHash)
    || choice !== undefined && choice !== 'accept_remote'
    || !same(field.after, acceptedConflict || receivedEqualName ? acceptedValue : decision.importValue)
    || !same(field.before, input.local) || !same(field.remote, input.remote)
    || field.mappingHash !== meta.mappingHash || !same(source, { ...meta.source, productId: Number(amber.product.id) })
    || meta.source.bindingRevisionId !== amber.revision.id || meta.source.definitionHash !== amber.compiled.hash
    || !input.mapping?.proven || meta.reason || meta.importBlocker || meta.readReason) fail('FIRST_SYNC_LOCAL_EVIDENCE_MISMATCH');
  if (meta.persistence === 'information') {
    if (field.state !== 'imported' || field.scope !== 'all' || meta.source.kind !== 'information'
      || !information.INFORMATION_FIELDS_V1[amber.product.category]?.includes(meta.source.key)
      || meta.storagePath !== `details.answers.${meta.source.key}`) fail('FIRST_SYNC_LOCAL_SETTER_UNSUPPORTED');
  } else if (meta.persistence === 'weight') {
    if (field.state !== 'imported' || field.scope !== 'all' || input.unit !== 'g' || input.scale !== 3
      || !['decor_weight', 'vaha_vyrobu'].includes(field.target) || meta.storagePath !== 'weight'
      || !(meta.source.kind === 'product' && meta.source.field === 'weight'
        || meta.source.kind === 'information' && meta.source.key === 'weight' && amber.product.category === 'SV')) fail('FIRST_SYNC_LOCAL_SETTER_UNSUPPORTED');
  } else if (meta.persistence === 'characteristic') {
    if (field.state !== 'imported' || field.scope !== 'all' || meta.source.kind !== 'semantic'
      || meta.storagePath !== `details.answers.${meta.source.key}` || reverseValues?.length !== 1
      || String(field.after) !== reverseValues[0]) fail('FIRST_SYNC_LOCAL_SETTER_UNSUPPORTED');
  } else if (meta.persistence === 'name') {
    if (field.target !== 'name' || !scopes.includes(field.scope) || meta.source.kind !== 'name'
      || meta.source.field !== `magento_name_override.values.${field.scope}`
      || meta.storagePath !== meta.source.field || !validName(field.after)
      || !input.remote.known || !input.remote.present || field.after !== input.remote.value) fail('FIRST_SYNC_LOCAL_NAME_INVALID');
  } else fail('FIRST_SYNC_LOCAL_SETTER_UNSUPPORTED');
  return meta;
}

async function prepareLocal(client, { observation, acceptedFields, projection, actorUserId, config, lockCatalog = false, reanchorAfterPrice = false, rateObservation, canonicalPriceConflict = false, expectedCanonicalHash }) {
  if (!client || typeof client.query !== 'function' || !Array.isArray(acceptedFields) || acceptedFields.length > 500
    || !Array.isArray(projection?.projection) || !Array.isArray(projection?.fields)
    || !Number.isSafeInteger(actorUserId) || actorUserId <= 0) fail('FIRST_SYNC_LOCAL_INPUT_INVALID');
  const result = { supportedFields: [], blockedFields: [] };
  if (!acceptedFields.length && !reanchorAfterPrice) { prepared.set(result, {}); return result; }
  const original = observation?.amber, productId = Number(original?.product?.id);
  if (!Number.isSafeInteger(productId) || productId <= 0 || !original?.revision?.id
    || !Number.isSafeInteger(observation.raw?.id) || observation.raw.id <= 0
    || observation.raw.sku !== (original.product.public_sku || original.product.full_sku)
    || original.revision.originHash !== c.originHash(config.baseUrl)) fail('FIRST_SYNC_LOCAL_IDENTITY_MISMATCH');
  // The loader owns a private WeakMap proof on its product. Never spread that product.
  const amber = await previews.readPreviewProductOnClient(client, { productId, bindingRevisionId: original.revision.id });
  const product = amber.product;
  if (Number(product.id) !== productId || String(product.public_product_identity_id) !== String(original.product.public_product_identity_id)
    || (product.public_sku || product.full_sku) !== observation.raw.sku || product.status !== 'active' || product.corrected_to_product_id
    || amber.revision.id !== original.revision.id || amber.compiled.hash !== original.compiled.hash) fail('FIRST_SYNC_LOCAL_IDENTITY_MISMATCH');
  for (const key of ['magento_name_override', 'magento_name_rule_pin', 'magento_name_subject_ua', 'magento_name_subject_en', 'magento_name_review_required']) {
    if (!same(product[key], original.product[key])) fail('FIRST_SYNC_LOCAL_SOURCE_CHANGED');
  }
  const supported = [], seen = new Set();
  const block = (field, cause) => {
    if (result.blockedFields.some(item => identity(item) === identity(field))) return;
    const code = cause.code || cause.publicCode || 'FIRST_SYNC_LOCAL_INFORMATION_INVALID';
    result.blockedFields.push({ target: field.target, scope: field.scope, code, reason: String(cause.message || code).slice(0, 600) });
  };
  for (const field of acceptedFields) {
    if (seen.has(identity(field))) fail('FIRST_SYNC_LOCAL_DUPLICATE_FIELD');
    seen.add(identity(field));
    try {
      const meta = evidenceFor(field, projection, amber);
      if (meta.persistence === 'name' && field.after !== remoteNames(observation, projection)[field.scope]) fail('FIRST_SYNC_LOCAL_EVIDENCE_MISMATCH');
      supported.push({ field, meta });
    }
    catch (cause) { block(field, cause); }
  }
  const informationFields = supported.filter(item => item.meta.persistence === 'information');
  for (const item of informationFields) {
    try {
      const key = item.meta.source.key;
      if (!same(product.details?.answers?.[key], original.product.details?.answers?.[key])) fail('FIRST_SYNC_LOCAL_SOURCE_CHANGED');
      if (informationFields.some(other => other.meta.source.key === key && other.field.after !== item.field.after)) {
        fail('FIRST_SYNC_LOCAL_CANONICAL_FIELD_CONFLICT');
      }
      const preview = await information.prepareProductInformationOnClient(client, product, { [key]: item.field.after }, { lockCatalog });
      if (preview.newAnswers[key] !== item.field.after) fail('FIRST_SYNC_LOCAL_VALUE_NORMALIZED');
    } catch (cause) { block(item.field, cause); }
  }
  const active = () => supported.filter(item => !result.blockedFields.some(field => identity(field) === identity(item.field)));
  let informationPreview = null;
  const patch = Object.fromEntries(active().filter(item => item.meta.persistence === 'information').map(item => [item.meta.source.key, item.field.after]));
  if (Object.keys(patch).length) {
    try { informationPreview = await information.prepareProductInformationOnClient(client, product, patch, { lockCatalog }); }
    catch (cause) { for (const item of active().filter(item => item.meta.persistence === 'information')) block(item.field, cause); }
  }
  let canonicalPreview = null;
  const canonicalFields = active().filter(item => ['weight', 'characteristic'].includes(item.meta.persistence));
  if (canonicalFields.length) {
    try {
      if (canonicalPriceConflict) fail('FIRST_SYNC_CANONICAL_PRICE_FIRST_REOBSERVE_REQUIRED');
      canonicalPreview = await canonical.prepareCanonicalInputs(client, { amber, entries: canonicalFields,
        answers: informationPreview?.newAnswers || product.details?.answers || {}, rateObservation, lockCatalog });
      if (expectedCanonicalHash !== undefined && canonicalPreview.evidenceHash !== expectedCanonicalHash) fail('FIRST_SYNC_CANONICAL_PREVIEW_STALE');
    } catch (cause) { for (const item of canonicalFields) block(item.field, cause); }
  }
  result.canonicalHash = canonicalPreview?.evidenceHash || null;
  let nameChange = null;
  const nameFields = active().filter(item => item.meta.persistence === 'name');
  if (nameFields.length || informationPreview || canonicalPreview || reanchorAfterPrice && (product.magento_name_override || product.magento_name_rule_pin)) {
    // A preceding authorized price setter may already have changed generated
    // inputs. Recognize active overrides against the original observed anchor.
    const before = evaluator.evaluate(original, original.product);
    const savedDetails = product.details;
    const pricingKeys = ['weight','total_price','total_price_uah','price_per_gram','uah_rate'];
    const savedPricing = Object.fromEntries(pricingKeys.filter(key => Object.hasOwn(product,key)).map(key => [key,product[key]]));
    let post, generated, retained;
    try {
      retained = retainedNames(original.product, generatedNames(before));
      if (informationPreview) product.details = { ...product.details, answers: informationPreview.newAnswers };
      if (canonicalPreview) Object.assign(product, { weight: canonicalPreview.weight, details: canonicalPreview.pricing.details,
        total_price: canonicalPreview.pricing.totalPrice, total_price_uah: canonicalPreview.pricing.totalPriceUah,
        price_per_gram: canonicalPreview.pricing.pricePerGram, uah_rate: canonicalPreview.pricing.uahRate });
      post = evaluator.evaluate(amber, product);
      generated = generatedNames(post);
    } catch (cause) {
      if (reanchorAfterPrice && !acceptedFields.length) throw cause;
      for (const item of [...nameFields, ...active().filter(item => ['information','weight','characteristic'].includes(item.meta.persistence))]) block(item.field, cause);
      informationPreview = null; canonicalPreview = null; result.canonicalHash = null;
    } finally { product.details = savedDetails; Object.assign(product, savedPricing); for (const key of pricingKeys) if (!Object.hasOwn(savedPricing,key)) delete product[key]; }
    if (generated) {
      const values = { ...effectiveNames(post), ...retained };
      for (const item of nameFields) values[item.field.scope] = item.field.after;
      if (!validPair(values)) {
        for (const item of nameFields) block(item.field, { code: 'FIRST_SYNC_LOCAL_NAME_PAIR_REQUIRED' });
        // Information alone must not detach an active accepted/manual override.
        if (Object.keys(retained).length && !same(generated, before.generatedNames)) {
          if (reanchorAfterPrice && !acceptedFields.length) fail('FIRST_SYNC_LOCAL_NAME_PAIR_REQUIRED');
          for (const item of active().filter(item => ['information','weight','characteristic'].includes(item.meta.persistence))) block(item.field, { code: 'FIRST_SYNC_LOCAL_NAME_PAIR_REQUIRED' });
          informationPreview = null; canonicalPreview = null; result.canonicalHash = null;
        }
      } else if (nameFields.length || Object.keys(retained).length && !same(generated, before.generatedNames)) {
        nameChange = { generated, values, before: effectiveNames(before), remote: remoteNames(observation, projection),
          receiving: nameFields.length > 0,
          needsOverride: !same(values, effectiveNames(post)) || Object.keys(retained).length > 0 && !same(generated, before.generatedNames) };
      }
    }
  }
  result.supportedFields = active().map(item => item.field);
  prepared.set(result, { amber, productId, informationPreview, canonicalPreview, nameChange });
  return result;
}

async function prepareFirstSyncLocal(client, options) {
  // Preview never authorizes an empty-subset mutation from a price callback.
  return prepareLocal(client, { ...options, reanchorAfterPrice: false });
}

async function applyFirstSyncLocal(client, options) {
  // Never use closure-captured plan fields: only the ledger's NEW accepted subset.
  const validation = await prepareLocal(client, { ...options, lockCatalog: true, reanchorAfterPrice: options.reanchorAfterPrice === true });
  if (validation.blockedFields.length) {
    const first = validation.blockedFields[0];
    fail(first.code === 'FIRST_SYNC_LOCAL_SETTER_UNSUPPORTED' ? first.code : 'FIRST_SYNC_LOCAL_VALIDATION_FAILED', first.reason);
  }
  const { amber, productId, informationPreview, canonicalPreview, nameChange } = prepared.get(validation);
  if (!amber) return { changed: false, informationChanges: [], nameChanged: false, fullRevision: null };
  const product = amber.product;
  const nameChanged = Boolean(nameChange?.needsOverride && (!same(product.magento_name_override, { generated: nameChange.generated, values: nameChange.values })
    || product.magento_name_review_required === true));
  if (canonicalPreview) {
    const pricing = canonicalPreview.pricing;
    const updated = await client.query(`UPDATE products SET weight=$2,details=$3::jsonb,total_price=$4,total_price_uah=$5,price_per_gram=$6,uah_rate=$7 WHERE id=$1`,
      [productId,canonicalPreview.weight,JSON.stringify(pricing.details),pricing.totalPrice,pricing.totalPriceUah,pricing.pricePerGram,pricing.uahRate]);
    if (updated.rowCount !== 1) fail('FIRST_SYNC_LOCAL_SOURCE_CHANGED');
    await audit.writeAuditEvent(client, { mutationContext: { actorUserId: options.actorUserId },
      eventKey: 'product.first_sync_canonical_adopted', subjectType: 'product', subjectId: productId,
      details: { publicSku: product.public_sku, beforeWeight: product.weight, evidence: canonicalPreview.evidence } });
  } else if (informationPreview) {
    const updated = await client.query(`UPDATE products SET details=jsonb_set(COALESCE(details,'{}'::jsonb),'{answers}',$2::jsonb,TRUE)
      WHERE id=$1`, [productId, JSON.stringify(informationPreview.newAnswers)]);
    if (updated.rowCount !== 1) fail('FIRST_SYNC_LOCAL_SOURCE_CHANGED');
  }
  if (nameChanged) {
    const updated = await client.query(`UPDATE products SET magento_name_override=$2::jsonb,magento_name_review_required=FALSE
      WHERE id=$1`, [productId, JSON.stringify({ generated: nameChange.generated, values: nameChange.values })]);
    if (updated.rowCount !== 1) fail('FIRST_SYNC_LOCAL_SOURCE_CHANGED');
  }
  let fullRevision = null;
  if (informationPreview || canonicalPreview || nameChanged) {
    const [state] = await lifecycle.readFullProductStates(client, [productId], { lock: true });
    fullRevision = (await lifecycle.advanceFullProductRevision(client, productId, informationPreview?.fullRevision || state.revision)).revision;
  }
  if (informationPreview) await audit.writeAuditEvent(client, { mutationContext: { actorUserId: options.actorUserId },
    eventKey: 'product_information.updated', subjectType: 'product', subjectId: productId,
    details: { sku: product.full_sku, version: 1, changes: informationPreview.changes, reason: 'first_sync_adoption' } });
  if (nameChange) {
    if (nameChange.receiving) {
      const recorded = receivedNameObservation(nameChange, amber.nameState, options.projection);
      const result = { action: recorded.action, amber: nameChange.values, remote: nameChange.remote };
      await names.saveObservation(client, c.originHash(options.config.baseUrl), product, options.observation.raw.id,
        result, recorded.baseline, recorded.resolution);
    }
    if (nameChanged) await names.auditName(client, options.actorUserId, product, nameChange.receiving ? 'external_accepted' : 'first_sync_reanchored',
      { before: nameChange.before, after: nameChange.values, ...(nameChange.receiving ? {} : { reason: 'preserve_existing_names' }) });
  }
  return { productId, changed: Boolean(informationPreview || canonicalPreview || nameChanged), informationChanges: informationPreview?.changes || [], nameChanged, fullRevision };
}
module.exports = { prepareFirstSyncLocal, applyFirstSyncLocal };
