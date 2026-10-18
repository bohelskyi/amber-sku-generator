// Reviewed operator batch for an absent legacy answer and/or truncated weight: the UI direct recount, then
// the UI stable_recount_exposure recovery. No SQL writes and no Magento writes here.
const c = require('./magento/binding-contract');
const products = require('./product.service');
const recovery = require('./magento/lifecycle-recovery');
const characteristics = require('./product/characteristic-config');
const { administrator } = require('./magento/binding-publication');
const { assertActorStillAuthorized } = require('./access-admin-transaction');
const FORMAT = 'legacy-answer-recount-batch-v1', MAX_ITEMS = 50;
// products.recount: POST /recount/preview|apply; exports.reconcile: /admin/magento-recovery lifecycle routes.
const PERMISSIONS = ['products.recount', 'exports.reconcile'];
const RECOVERY_REASON = 'Оператор підтвердив узгодження поточної версії після переобліку за перевіреним сервером планом.';
const STATUSES = ['ready', 'recovery_pending', 'already_applied', 'blocked'];
const BUSY_ATTEMPTS = 24, BUSY_DELAY_MS = 5000;
const fail = (code, details) => { throw Object.assign(new Error(code), { code, statusCode: 409, ...(details ? { details } : {}) }); };
const plain = v => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const text = v => typeof v === 'string' && !/[\u0000-\u001f\u007f]/.test(v);
const value = v => v === undefined || v === null || String(v).trim() === '' ? null : String(v);
const errorCode = (e, prefix = 'LEGACY_ANSWER') => [e?.publicCode, e?.code].find(v => typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,159}$/.test(v))
  || `${prefix}_${Number.isInteger(e?.statusCode) ? e.statusCode : 'FAILED'}`;

function validateInput(input) {
  // answers (absent option answers) and/or weightFromAnswer (truncated physical weight), applied by one recount.
  const shape = plain(input) && Object.keys(input).filter(key => key !== 'weightFromAnswer').sort().join();
  if (!['answers,category,items,reason', 'category,items,reason'].includes(shape)
    || Object.hasOwn(input, 'weightFromAnswer') && input.weightFromAnswer !== true
    || shape === 'category,items,reason' && input.weightFromAnswer !== true) fail('LEGACY_ANSWER_INPUT_INVALID');
  const { category, answers = {}, reason, items } = input, weightFromAnswer = input.weightFromAnswer === true;
  if (typeof category !== 'string' || !/^[A-Z]{2,8}$/.test(category) || !plain(answers)
    || !weightFromAnswer && !Object.keys(answers).length || Object.keys(answers).length > 10
    || Object.entries(answers).some(([key, id]) => !/^[A-Za-z0-9][A-Za-z0-9_]{0,63}$/.test(key) || !Number.isSafeInteger(id) || id < 0 || id > 2147483647)
    || !text(reason) || reason.trim() !== reason || reason.length < 10 || reason.length > 500
    || !Array.isArray(items) || !items.length || items.length > MAX_ITEMS) fail('LEGACY_ANSWER_INPUT_INVALID');
  for (const item of items) if (!plain(item) || Object.keys(item).join() !== 'sku' || !text(item.sku) || !item.sku
    || item.sku.length > 255 || item.sku.trim() !== item.sku) fail('LEGACY_ANSWER_INPUT_INVALID');
  if (new Set(items.map(item => item.sku)).size !== items.length) fail('LEGACY_ANSWER_DUPLICATE_SKU');
  return { category, answers: { ...answers }, ...(weightFromAnswer ? { weightFromAnswer } : {}), reason, items: items.map(({ sku }) => ({ sku })) };
}
async function read(databasePool, operation) {
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await operation(client); await client.query('COMMIT'); return result;
  } catch (cause) { await client.query('ROLLBACK').catch(() => {}); throw cause; }
  finally { client.release(); }
}
async function authority(client, actorUserId) {
  await administrator(client, actorUserId);
  for (const key of PERMISSIONS) await assertActorStillAuthorized(client, actorUserId, key, c.error, { readOnly: true });
}
async function catalog(client, input) {
  let configuration;
  try { configuration = await characteristics.readCharacteristicConfiguration(client, input.category); }
  catch { fail('LEGACY_ANSWER_CATEGORY_INVALID'); }
  for (const [key, id] of Object.entries(input.answers)) {
    const question = configuration.questions.find(q => q.key === key);
    if (!question || question.archived || question.input_type !== 'options'
      || !question.options.some(o => o.value_id === id && !o.archived)) fail('LEGACY_ANSWER_OPTION_INVALID', { key });
  }
  return configuration.config_hash;
}
async function current(client, sku) {
  const rows = (await client.query(`SELECT p.id,p.full_sku,p.category,p.weight,p.details,p.corrected_from_product_id,i.public_sku,
    f.route,f.hold_reason,f.evidence->>'origin' AS lifecycle_origin,(f.evidence ? 'magentoPriorExposure') AS exposure_confirmed FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
    LEFT JOIN product_full_export_state f ON f.product_id=p.id
    WHERE i.public_sku=$1 AND p.status='active' AND p.corrected_to_product_id IS NULL ORDER BY p.id`, [sku])).rows;
  return rows.length === 1 ? rows[0] : { blocked: rows.length ? 'PRODUCT_NOT_UNIQUE' : 'PRODUCT_NOT_FOUND' };
}
// Keep the stored decision; the price-equality check below is the authority against repricing.
function pricingDecision(details = {}) {
  const usd = details.customUsdPerGramBasis;
  if (usd) return { mode: 'usd_per_gram', usdPerGram: usd.usdPerGram, marketingRoundingEnabled: usd.marketingRoundingEnabled };
  return Number(details.manualPriceUah) > 0 ? { mode: 'manual_uah', manualPriceUah: Number(details.manualPriceUah) } : { mode: 'system_auto' };
}
// weightFromAnswer: answers.weight is the exact decimal; products.weight is its truncated/rounded integer.
function answerWeight(product) {
  const raw = product.details?.answers?.weight;
  const textValue = typeof raw === 'number' ? String(raw) : raw;
  if (typeof textValue !== 'string' || !/^\d{1,10}(?:[.,]\d{1,3})?$/.test(textValue)) return { blocked: 'WEIGHT_ANSWER_INVALID' };
  const normalized = textValue.replace(',', '.'), exact = Number(normalized), physical = Number(product.weight);
  if (!(exact > 0) || !Number.isFinite(physical)) return { blocked: 'WEIGHT_ANSWER_INVALID' };
  if (physical === exact) return { exact, physical, consistent: true };
  if (physical !== Math.trunc(exact) && physical !== Math.round(exact)) return { blocked: 'WEIGHT_NOT_TRUNCATED_ANSWER' };
  return { exact, physical, weight: String(exact) };
}
// Stored answers, not decoded placeholders: the successor must hold exactly them plus the patch.
function answerChanges(before = {}, after = {}) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .map(key => ({ key, before: value(before[key]), after: value(after[key]) })).filter(change => change.before !== change.after);
}
function previewBlocker(preview, product, input) {
  const keys = Object.keys(input.answers), source = preview.source, next = preview.corrected;
  const weight = input.weightFromAnswer ? answerWeight(product) : null;
  if (Number(source.productId) !== product.id || source.publicSku !== product.public_sku) return 'RECOUNT_SOURCE_CHANGED';
  if (keys.some(key => value(source.answers?.[key]) !== null)) return 'ANSWER_ALREADY_PRESENT';
  // Stored answers change only by the patch; the SV recount also writes the corrected weight into answers.weight (dot decimal).
  // The recount also rewrites an unchanged answers.weight in canonical dot form ("55.0" -> 55).
  const changed = answerChanges(product.details?.answers, next.answers).filter(change => !(change.key === 'weight'
    && (weight ? Number(change.after) === weight.exact : change.before !== null && Number(change.after) === Number(change.before))));
  if (c.hash([...new Set(preview.changes.map(change => change.key))].sort()) !== c.hash([...keys, ...(weight ? ['weight'] : [])].sort())
    || c.hash(changed.map(change => [change.key, change.after])) !== c.hash([...keys].sort().map(key => [key, String(input.answers[key])]))) return 'ANSWERS_WOULD_CHANGE';
  if (Number(next.weight) !== (weight ? weight.exact : Number(source.weight))) return 'WEIGHT_WOULD_CHANGE';
  if (weight && next.internalSku != null && next.internalSku !== source.internalSku) return 'SKU_CHANGED';
  if (!(Number(source.totalPriceUah) > 0) || Number(next.totalPriceUah) !== Number(source.totalPriceUah)) return 'PRICE_CHANGED';
  if (next.publicSku !== product.public_sku) return 'PUBLIC_SKU_WOULD_CHANGE';
  if (preview.nameChanges) return 'NAMES_WOULD_CHANGE';
  // Both need the stable recount recovery: it confirms the Magento exposure and admits first-sync field review.
  if (next.delivery?.route !== 'hold' || !['historical_ambiguity', 'prior_exposure'].includes(next.delivery.holdReason)) return 'RECOUNT_ROUTE_UNEXPECTED';
  return null;
}
async function inspect(options, input, item) {
  const product = await read(options.databasePool, client => current(client, item.sku));
  if (product.blocked) return { sku: item.sku, status: 'blocked', code: product.blocked };
  const base = { sku: item.sku, productId: product.id, publicSku: product.public_sku };
  if (product.category !== input.category) return { ...base, status: 'blocked', code: 'CATEGORY_MISMATCH' };
  const keys = Object.keys(input.answers), stored = product.details?.answers || {};
  const weight = input.weightFromAnswer ? answerWeight(product) : null;
  if (weight?.blocked) return { ...base, status: 'blocked', code: weight.blocked };
  const answered = keys.some(key => value(stored[key]) !== null);
  if (answered || weight?.consistent) {
    // Only a completed recount that made exactly these corrections counts as a prior run.
    const changes = product.details?.correction?.changes || [], recounted = product.corrected_from_product_id != null;
    const answersDone = keys.every(key => value(stored[key]) === String(input.answers[key])
      && changes.some(change => change.key === key && value(change.from) === null && value(change.to) === String(input.answers[key])));
    const weightDone = !weight || weight.consistent
      && changes.some(change => change.key === 'weight' && Number(change.to) === weight.exact && Number(change.from) !== weight.exact);
    if (!recounted || !answersDone || !weightDone) return { ...base, status: 'blocked', code: answered && !answersDone ? 'ANSWER_ALREADY_PRESENT' : 'WEIGHT_ALREADY_CONSISTENT' };
    return { ...base, internalSku: product.full_sku, lifecycle: { route: product.route, holdReason: product.hold_reason },
      status: product.route === 'hold' && (product.hold_reason === 'historical_ambiguity' || product.hold_reason === 'prior_exposure'
        && product.lifecycle_origin === 'recount' && product.exposure_confirmed !== true) ? 'recovery_pending' : 'already_applied' };
  }
  const decision = pricingDecision(product.details || {});
  let preview;
  try {
    preview = await products.buildProductRecountPreview({ sourceSku: product.public_sku, answers: input.answers,
      ...(weight ? { weight: weight.weight } : {}), reason: input.reason, pricingDecision: decision }, { databasePool: options.databasePool });
  } catch (cause) { return { ...base, status: 'blocked', code: errorCode(cause, 'RECOUNT_PREVIEW'), message: String(cause.message || '').slice(0, 500) }; }
  const evidence = { internalSkuBefore: preview.source.internalSku ?? null, internalSkuAfter: preview.corrected.internalSku ?? null,
    proposedSku: preview.corrected.proposedFullSku ?? null, mode: preview.corrected.mode ?? null,
    ...(weight ? { weightBefore: weight.physical, weightAfter: Number(preview.corrected.weight), recountWeight: weight.weight } : {}),
    answerChanges: answerChanges(product.details?.answers, preview.corrected.answers), priceBeforeUah: Number(preview.source.totalPriceUah), priceAfterUah: Number(preview.corrected.totalPriceUah),
    delivery: { route: preview.corrected.delivery?.route ?? null, holdReason: preview.corrected.delivery?.holdReason ?? null } };
  const code = previewBlocker(preview, product, input);
  if (code) return { ...base, status: 'blocked', code, ...evidence };
  return { ...base, status: 'ready', ...evidence, pricingDecision: decision,
    sourceStateSignature: preview.source.stateSignature, previewToken: preview.previewToken };
}
async function preview(rawInput, options) {
  const input = validateInput(rawInput), { databasePool, expectedDatabase } = options;
  const actorUserId = Number(options.actorUserId);
  const characteristicConfigHash = await read(databasePool, async client => {
    if ((await client.query('SELECT current_database() name')).rows[0].name !== expectedDatabase) fail('LEGACY_ANSWER_DATABASE_MISMATCH');
    await authority(client, actorUserId);
    return catalog(client, input);
  });
  const items = [];
  for (const item of input.items) items.push(await inspect(options, input, item));
  const plan = { format: FORMAT, database: expectedDatabase, actorUserId, category: input.category, answers: input.answers,
    weightFromAnswer: input.weightFromAnswer === true,
    reason: input.reason, characteristicConfigHash, items };
  const summary = { total: items.length, ...Object.fromEntries(STATUSES.map(s => [s, items.filter(i => i.status === s).length])) };
  return { ...plan, summary, planHash: c.hash(plan) };
}
async function apply(rawInput, options) {
  const { databasePool, config, planHash, append = async () => {}, busyWait = ms => new Promise(done => setTimeout(done, ms)) } = options;
  if (typeof planHash !== 'string' || !/^[a-f0-9]{64}$/.test(planHash)) fail('LEGACY_ANSWER_PLAN_HASH_REQUIRED');
  const plan = await preview(rawInput, options);
  await append({ type: 'fresh_preview', planHash: plan.planHash, summary: plan.summary });
  if (plan.planHash !== planHash) fail('PLAN_CHANGED');
  if (plan.summary.blocked) fail('LEGACY_ANSWER_PLAN_BLOCKED');
  const actorUserId = plan.actorUserId;
  const mutationContext = { actorUserId, requestId: `legacy-answer-recount-batch:${planHash.slice(0, 16)}` };
  const recoveryOptions = { ...options.recovery, databasePool, mutationContext };
  const results = [];
  for (const item of plan.items) {
    let step = 'recount', productId = item.productId;
    try {
      if (item.status === 'already_applied') {
        await append({ type: 'skipped', sku: item.sku, productId, status: 'already_applied' });
        results.push({ sku: item.sku, status: 'already_applied' }); continue;
      }
      if (item.status === 'ready') {
        await read(databasePool, client => authority(client, actorUserId));
        await append({ type: 'recount_started', sku: item.sku, productId });
        // Same command and options as POST /recount/apply (routes/public/products.routes.js).
        const result = await products.applyProductRecount({ sourceSku: item.internalSkuBefore ?? item.publicSku,
          answers: plan.answers, ...(item.recountWeight ? { weight: item.recountWeight } : {}), reason: plan.reason, pricingDecision: item.pricingDecision,
          previewToken: item.previewToken, sourceStateSignature: item.sourceStateSignature },
        { authorizedDirectDecision: true, authorizedNameChange: true, mutationContext, databasePool });
        productId = Number(result.correctedProductId);
        await append({ type: 'recount_applied', sku: item.sku, sourceProductId: item.productId, correctedProductId: productId,
          internalSkuAfter: result.corrected.internalSku ?? null, publicSku: result.corrected.publicSku,
          priceAfterUah: Number(result.corrected.totalPriceUah) });
        if (result.success !== true || Number(result.source.productId) !== item.productId || !Number.isSafeInteger(productId)
          || result.corrected.publicSku !== item.publicSku || Number(result.corrected.totalPriceUah) !== item.priceBeforeUah
          || item.recountWeight && Number(result.corrected.weight) !== item.weightAfter) fail('LEGACY_ANSWER_RECOUNT_RESULT_UNEXPECTED');
      }
      step = 'recovery';
      // The fresh successor is usually picked up by the worker at once; the recovery refuses to wait behind
      // dispatched work (EXPOSURE_SYNC_BUSY, before any write) and its preview reports LOCAL_EVIDENCE_CHANGED while the
      // worker moves the product, so retry the whole UI sequence briefly.
      let receipt;
      for (let attempt = 1; ; attempt++) {
        await read(databasePool, client => authority(client, actorUserId));
        // Same sequence as the product problem page: GET recovery state, lifecycle-preview, lifecycle-apply.
        const state = await recovery.productRecovery(config, productId, { ...recoveryOptions, canRecoverJobs: true, canReconcileLifecycle: true });
        if (state.article !== item.sku || state.lifecycle?.blocker || !state.lifecycle?.availableKinds?.includes('stable_recount_exposure'))
          fail('LEGACY_ANSWER_RECOVERY_NOT_AVAILABLE', { blocker: state.lifecycle?.blocker ?? null, availableKinds: state.lifecycle?.availableKinds ?? [] });
        const reviewed = await recovery.preview(config, productId, { kind: 'stable_recount_exposure' }, recoveryOptions);
        if (!reviewed.eligible) {
          // The worker touching the successor during the preview is transient too; anything else stops the run.
          const moving = Array.isArray(reviewed.blockers) && reviewed.blockers.length > 0 && reviewed.blockers.every(code => code === 'LOCAL_EVIDENCE_CHANGED');
          if (!moving || attempt >= BUSY_ATTEMPTS) fail('LEGACY_ANSWER_RECOVERY_BLOCKED', { blockers: reviewed.blockers });
          await append({ type: 'recovery_busy', sku: item.sku, productId, attempt, reason: 'LOCAL_EVIDENCE_CHANGED' });
          await busyWait(BUSY_DELAY_MS); continue;
        }
        await append({ type: 'recovery_previewed', sku: item.sku, productId, reviewHash: reviewed.reviewHash, attempt });
        try {
          receipt = await recovery.apply(config, productId, { review: reviewed.review, reviewHash: reviewed.reviewHash,
            reason: `${RECOVERY_REASON} Коментар: ${plan.reason}` }, recoveryOptions);
          break;
        } catch (cause) {
          if (cause?.code !== 'EXPOSURE_SYNC_BUSY' || attempt >= BUSY_ATTEMPTS) throw cause;
          await append({ type: 'recovery_busy', sku: item.sku, productId, attempt });
          await busyWait(BUSY_DELAY_MS);
        }
      }
      await append({ type: 'recovery_applied', sku: item.sku, productId, handoffId: receipt.handoffId ?? null,
        holdReason: receipt.holdReason ?? null, deliveryVersion: receipt.deliveryVersion ?? null, alreadyApplied: receipt.alreadyApplied === true });
      if (receipt.productId !== productId || receipt.sku !== item.sku || !receipt.handoffId) fail('LEGACY_ANSWER_RECOVERY_RESULT_UNEXPECTED');
      results.push({ sku: item.sku, status: item.status === 'ready' ? 'applied' : 'recovered', productId, handoffId: receipt.handoffId });
    } catch (cause) {
      await append({ type: 'error', sku: item.sku, productId, step, code: errorCode(cause),
        ...(cause.details && !(cause.details instanceof Error) ? { details: cause.details } : {}) });
      throw cause;
    }
  }
  return { planHash, items: results };
}
module.exports = { FORMAT, MAX_ITEMS, PERMISSIONS, validateInput, pricingDecision, answerWeight, previewBlocker, preview, apply, errorCode };
