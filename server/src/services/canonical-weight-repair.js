const crypto = require('node:crypto');
const manifest = require('./canonical-weight-manifest');
const { repairTransaction, lockRepairProducts } = require('./recount-repair.service');
const { assertActorStillAuthorized } = require('./access-admin-transaction');
const { createMutationContext } = require('../audit/mutation-context');
const { writeAuditEvent } = require('../audit/audit-events');
const { originHash, installation, identity, hash } = require('./magento/binding-contract');
const { readPreviewProductOnClient } = require('./magento/sync-preview-db');
const { loadSupportInputs } = require('./export-templates/support-inputs');
const { evaluate } = require('./magento/binding-evidence-products');
const { normalizeDecimal } = require('./magento/first-sync-field-plan');
const { loadPricingContext } = require('./pricing/pricing-context');
const { calculatePricingBase } = require('./pricing/pricing-calculator');
const gate = require('./full-product-cutover-gate');
const fail = code => { throw manifest.error(`SV_CANONICAL_WEIGHT_${code}`); };
const READBACK_LIMIT = 100, INCOHERENT = 'CANONICAL_WEIGHT_ANSWER_INCOHERENT';
const GLOBAL = /PUBLICATION|PUBLISHED|BINDING_CHANGED|INSTALLATION|PERMISSION|ADMINISTRATOR|AUTHORI|ACTOR|DATABASE|NOT_CONFIGURED|MIGRATION/;
const safeCode = cause => typeof cause?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(cause.code) ? cause.code : 'READBACK_FAILED';
function required(options) {
  if (!options.databasePool || !options.expectedDatabase || !options.config?.configured) fail('CONTEXT_REQUIRED');
  installation(options.installationKey); identity(options.bindingRevisionId);
  return createMutationContext(options.mutationContext);
}
async function context(client, options) {
  const schema = (await client.query(`SELECT current_database() name,
    to_regprocedure('sv_weight_repair_state(integer)') IS NOT NULL AND to_regclass('product_weight_repair_receipts') IS NOT NULL
      AND to_regprocedure('sv_weight_magento_candidate(products,boolean)') IS NOT NULL installed`)).rows[0];
  if (schema.name !== options.expectedDatabase) fail('DATABASE_MISMATCH');
  if (!schema.installed) fail('GUARD_NOT_INSTALLED');
  const text = (await client.query('SELECT sv_weight_repair_configuration($1)::text value', [options.bindingRevisionId])).rows[0].value;
  const value = text ? JSON.parse(text) : null;
  if (!value || value.activation?.installation_key !== options.installationKey || value.binding?.installation_key !== options.installationKey
    || value.binding.state !== 'published' || value.currentBinding !== options.bindingRevisionId
    || value.binding.origin_hash !== originHash(options.config.baseUrl)) fail('CONTEXT_STALE');
  return text;
}
// answer: undefined keeps details unchanged (recorded answer); {value} sets details.answers.weight; {remove} deletes it.
async function state(client, productId, targetWeight, answer) {
  const row = answer === undefined ? (await client.query(`SELECT evidence::text before,
    jsonb_set(evidence,'{product,weight}',to_jsonb($2::numeric(14,3)))::text after
    FROM (SELECT sv_weight_repair_state($1) evidence) x`, [productId,targetWeight])).rows[0]
    : (await client.query(`SELECT evidence::text before,(CASE WHEN $3 THEN x #- '{product,details,answers,weight}'
      ELSE jsonb_set(x,'{product,details,answers,weight}',$4::jsonb) END)::text after
      FROM (SELECT evidence,jsonb_set(evidence,'{product,weight}',to_jsonb($2::numeric(14,3))) x
        FROM (SELECT sv_weight_repair_state($1) evidence) e) y`, [productId,targetWeight,answer.remove === true,
      answer.remove === true ? null : JSON.stringify(answer.value)])).rows[0];
  if (!row.before || Buffer.byteLength(row.before) > manifest.MAX_EVIDENCE_BYTES || Buffer.byteLength(row.after) > manifest.MAX_EVIDENCE_BYTES) fail('EVIDENCE_LIMIT');
  return row;
}
const projectable = product => ({ ...product, public_sku: product.public_sku, is_test_product: product.is_test_product,
  exportState: product.exportState, magento_name_rule_pin: product.magento_name_rule_pin });
async function comparePublished(client, productId, bindingId, evidence, targetWeight) {
  const amber = await readPreviewProductOnClient(client, { productId, bindingRevisionId: bindingId });
  // Keep the PostgreSQL driver's exact NUMERIC strings used by ordinary delivery.
  // Raw JSON evidence is retained for the receipt, never used to reprice/render money.
  const raw = amber.product;
  if (raw.id !== JSON.parse(evidence).product.id) fail('STALE');
  const projected = await loadSupportInputs(client, amber.compiled.definition, [
    { ...raw, public_sku: amber.product.public_sku, is_test_product: amber.product.is_test_product, exportState: amber.product.exportState,
      magento_name_rule_pin: amber.product.magento_name_rule_pin },
    { ...raw, weight: targetWeight, public_sku: amber.product.public_sku, is_test_product: amber.product.is_test_product,
      exportState: amber.product.exportState, magento_name_rule_pin: amber.product.magento_name_rule_pin }
  ]);
  const before = evaluate(amber, projected.products[0]), after = evaluate(amber, projected.products[1]);
  if (before.failed || after.failed || hash(before) !== hash(after)) fail('PUBLISHED_RESULT_CHANGED');
  return hash(before);
}
// Pure published-result proof for the Magento lane: only decor_weight (and the
// stone weight fraction) may change, and the missing-weight issue must disappear.
function magentoResult(before, after, targetAnswer, souvenir) {
  const issues = result => result.evaluationIssues || [], other = result => issues(result).filter(issue => issue.field !== 'decor_weight');
  const skip = new Set(['decor_weight', ...(String(souvenir) === '5' ? ['fraction'] : [])]);
  const outputs = values => Object.fromEntries(Object.entries(values || {}).filter(([key]) => !skip.has(key)));
  if (before.failed || after.failed || !issues(before).some(issue => issue.field === 'decor_weight')
    || issues(after).some(issue => issue.field === 'decor_weight') || hash(other(before)) !== hash(other(after))
    || normalizeDecimal(after.base?.decor_weight, 3) !== targetAnswer
    || hash(outputs(before.base)) !== hash(outputs(after.base)) || hash(outputs(before.english)) !== hash(outputs(after.english))
    || hash(before.generatedNames ?? null) !== hash(after.generatedNames ?? null) || hash(before.nameSource ?? null) !== hash(after.nameSource ?? null))
    fail('PUBLISHED_RESULT_CHANGED');
  return hash({ before, after });
}
function pricingResult(product, context) {
  try {
    const calculation = calculatePricingBase({ categoryCode: 'SV', answers: product.details?.answers || {},
      weight: Number(product.weight), isCalibrated: product.details?.isCalibrated, context });
    // Stored prices never change; the echoed weight may, any computed price may not.
    delete calculation.weightVal;
    return calculation;
  } catch (cause) { return { error: String(cause?.code || cause?.message || 'PRICING_FAILED') }; }
}
// change: {targetWeight,targetAnswer} for apply, {reverse,sourceAnswerPresent,sourceAnswer} for rollback.
async function comparePublishedMagento(client, productId, bindingId, evidence, change) {
  const amber = await readPreviewProductOnClient(client, { productId, bindingRevisionId: bindingId });
  const raw = amber.product;
  if (raw.id !== JSON.parse(evidence).product.id) fail('STALE');
  const withAnswer = (weight, present, value) => {
    const answers = { ...(raw.details?.answers || {}) };
    if (present) answers.weight = value; else delete answers.weight;
    return { ...projectable(raw), weight, details: { ...raw.details, answers } };
  };
  const [missing, repaired] = change.reverse ? [withAnswer('0.000', change.sourceAnswerPresent, change.sourceAnswer), projectable(raw)]
    : [projectable(raw), withAnswer(change.targetWeight, true, change.targetAnswer)];
  const projected = await loadSupportInputs(client, amber.compiled.definition, [missing, repaired]);
  const result = magentoResult(evaluate(amber, projected.products[0]), evaluate(amber, projected.products[1]),
    change.reverse ? raw.details?.answers?.weight : change.targetAnswer, raw.details?.answers?.souvenir);
  const pricing = await loadPricingContext('SV', client);
  if (hash(pricingResult(missing, pricing)) !== hash(pricingResult(repaired, pricing))) fail('PRICING_RESULT_CHANGED');
  return result;
}
// Pure: the reviewed decor_weight readback of one first-sync inspection.
function remoteFacts(inspection, observation, expected) {
  const amber = observation?.amber, raw = observation?.raw;
  if (inspection?.mode !== 'first') return { reasonCodes: ['READBACK_MODE_NOT_FIRST'], readbackMode: String(inspection?.mode || 'unknown').slice(0, 40) };
  if (amber?.product?.id !== expected.productId || amber.product.public_sku !== expected.sku || amber.revision?.id !== expected.bindingRevisionId
    || raw?.sku !== expected.sku || !manifest.id(raw?.id) || !manifest.fingerprint(amber.compiled?.hash)) return { reasonCodes: ['READBACK_IDENTITY_MISMATCH'] };
  const rows = (inspection.fields || []).filter(field => field.target === 'decor_weight' && field.scope === 'all');
  if (rows.length !== 1) return { reasonCodes: ['READBACK_DECOR_WEIGHT_ABSENT'] };
  const field = rows[0];
  if (field.reason === INCOHERENT || (inspection.blockers || []).some(b => b.code === INCOHERENT && b.target === 'decor_weight'))
    return { reasonCodes: [INCOHERENT], reportOnly: true };
  if (field.reason !== manifest.MISSING_ONLY) return { reasonCodes: ['READBACK_REASON_UNEXPECTED'],
    readbackReason: typeof field.reason === 'string' ? field.reason.slice(0, 160) : null, readbackStatus: typeof field.status === 'string' ? field.status.slice(0, 40) : null };
  const value = field.remote?.value;
  const normalized = field.remote?.known === true && field.remote.present === true ? normalizeDecimal(value, 3) : null;
  if (!normalized || normalized.startsWith('-') || !(Number(normalized) > 0) || normalized.split('.')[0].length > 11)
    return { reasonCodes: ['REMOTE_WEIGHT_NOT_POSITIVE_DECIMAL'] };
  const [integer, fraction = ''] = normalized.split('.');
  return { reasonCodes: [], targetWeight: `${integer}.${fraction.padEnd(3, '0')}`, targetAnswer: normalized,
    remoteEvidence: { sku: expected.sku, remoteProductId: raw.id, target: 'decor_weight', scope: 'all', value,
      fieldStatus: field.status, fieldReason: field.reason, bindingRevisionId: expected.bindingRevisionId, definitionHash: amber.compiled.hash } };
}
const getOnly = fetchImpl => (url, init = {}) => {
  const method = init.method || (typeof url === 'object' && url?.method) || 'GET';
  if (typeof method !== 'string' || method.toUpperCase() !== 'GET' || init.body != null || typeof url === 'object' && url?.body != null)
    fail('REMOTE_WRITE_DENIED');
  return fetchImpl(url, init);
};
// GET-only first-sync inspection outside every repair transaction. It records nothing.
async function readback(options, actorUserId, sku, productId) {
  const first = require('./magento/first-sync.service'), boundary = require('./magento/sync-job.service').recoveryBoundary;
  const run = { ...options, actorUserId, fetchImpl: getOnly(options.fetchImpl || globalThis.fetch) };
  const input = { sku, bindingRevisionId: options.bindingRevisionId };
  return boundary.guard(options.config, input, run, async current => {
    const { observation } = await boundary.observe(options.config, { ...input, sku: current.publicSku }, run);
    return remoteFacts(await first.inspect(options.config, observation, run), observation,
      { sku, productId, bindingRevisionId: options.bindingRevisionId });
  });
}
async function readOnly(options, actor, operation) {
  const client = await options.databasePool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='15000ms'");
    await assertActorStillAuthorized(client, actor.actorUserId, 'exports.reconcile', (s,c) => manifest.error(c,s), { readOnly: true });
    await assertActorStillAuthorized(client, actor.actorUserId, 'products.recount', (s,c) => manifest.error(c,s), { readOnly: true });
    const configurationText = await context(client,options);
    const result = await operation(client, configurationText);
    const observedAt = (await client.query('SELECT transaction_timestamp() time')).rows[0].time.toISOString();
    await client.query('COMMIT');
    return { ...result, configurationText, observedAt };
  } catch (cause) { await client.query('ROLLBACK').catch(()=>{}); throw cause; }
  finally { client.release(); }
}
const PROVENANCE = 'Existing question answer; no independent measurement or proof of earlier canonical-weight loss.';
const MAGENTO_PROVENANCE = 'Reviewed GET-only Magento decor_weight readback; no independent measurement or proof of earlier canonical-weight loss.';
function sealed(options, format, direction, read, entries) {
  return manifest.seal({ format, direction, database: options.expectedDatabase,
    installationKey: options.installationKey, bindingRevisionId: options.bindingRevisionId, originHash: originHash(options.config.baseUrl),
    observedAt: read.observedAt, configurationText: read.configurationText, entries,
    provenance: format === manifest.MAGENTO_FORMAT ? MAGENTO_PROVENANCE : PROVENANCE,
    summary: { scanned: entries.length, eligible: entries.filter(e => e.eligible).length, excluded: entries.filter(e => !e.eligible).length,
      ...(format === manifest.MAGENTO_FORMAT ? { reportOnly: entries.filter(e => e.reportOnly).length } : {}) } });
}
async function magentoEntry(client, row, options, target) {
  const { result, reasonCodes } = row;
  const rules = (await client.query('SELECT sv_weight_numeric_rules_ok(numeric_validation,$2,$3::numeric) ok FROM questions WHERE id=$1',
    [row.source.weightQuestionId, target.targetAnswer, target.targetWeight])).rows[0];
  if (target.targetWeight !== '0.000' && rules?.ok !== true) { reasonCodes.push('REMOTE_WEIGHT_RULES'); return; }
  let evidence, publishedResultHash;
  try { evidence = await state(client,row.id,target.targetWeight,target.answer); }
  catch (cause) { if (cause.code !== 'SV_CANONICAL_WEIGHT_EVIDENCE_LIMIT') throw cause; reasonCodes.push('EVIDENCE_LIMIT'); return; }
  if (target.original && (evidence.before !== target.original.after || evidence.after !== target.original.before)) reasonCodes.push('ROLLBACK_STATE_CHANGED');
  if (!reasonCodes.length) {
    try { publishedResultHash = await comparePublishedMagento(client,row.id,options.bindingRevisionId,evidence.before,target.change); }
    catch (cause) {
      if (!['SV_CANONICAL_WEIGHT_PUBLISHED_RESULT_CHANGED','SV_CANONICAL_WEIGHT_PRICING_RESULT_CHANGED'].includes(cause.code)) throw cause;
      reasonCodes.push(cause.code.slice('SV_CANONICAL_WEIGHT_'.length));
    }
  }
  if (!reasonCodes.length) Object.assign(result, { eligible: true, publicSku: JSON.parse(evidence.before).identity.public_sku,
    beforeEvidence: evidence.before, afterEvidence: evidence.after, beforeFingerprint: manifest.digest(evidence.before),
    afterFingerprint: manifest.digest(evidence.after), targetWeight: target.targetWeight, sourceKind: 'magento_readback',
    sourceAnswer: target.sourceAnswer, sourceAnswerPresent: target.sourceAnswerPresent, targetAnswer: target.targetAnswer,
    remoteEvidence: target.remoteEvidence, weightQuestionId: row.source.weightQuestionId, publishedResultHash,
    ...(target.original ? { originalReceiptId: target.original.id } : {}) });
}
async function previewMagento(options, actor, started) {
  const candidates = await readOnly(options, actor, async client => ({ rows: (await client.query(`SELECT p.id,i.public_sku,
    sv_weight_magento_candidate(p) source FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
    WHERE p.category='SV' AND p.status='active' AND p.corrected_to_product_id IS NULL ORDER BY p.id LIMIT 1001`)).rows }));
  if (candidates.rows.length > manifest.LIMIT) fail('SCOPE_LIMIT');
  const facts = new Map();
  for (const row of candidates.rows.filter(candidate => candidate.source.eligible)) {
    if (Date.now()-started > 300000) fail('PREVIEW_LIMIT');
    if (facts.size >= READBACK_LIMIT) { facts.set(row.id, { reasonCodes: ['READBACK_DEFERRED'], deferred: true }); continue; }
    try { facts.set(row.id, await readback(options, actor.actorUserId, row.public_sku, row.id)); }
    catch (cause) {
      if (GLOBAL.test(cause?.code || '') || cause?.statusCode === 403) throw cause;
      facts.set(row.id, { reasonCodes: ['READBACK_FAILED'], readbackCode: safeCode(cause) });
    }
  }
  const sealedRead = await readOnly(options, actor, async (client, configurationText) => {
    if (configurationText !== candidates.configurationText) fail('CONTEXT_STALE');
    const definitionHash = JSON.parse(configurationText).binding.definition_hash, entries = [];
    const fresh = new Map((await client.query('SELECT p.id,sv_weight_magento_candidate(p) source FROM products p WHERE p.id=ANY($1::int[])',
      [[...facts.keys()]])).rows.map(row => [row.id, row.source]));
    for (const row of candidates.rows) {
      if (Date.now()-started > 300000) fail('PREVIEW_LIMIT');
      const reasonCodes = [...row.source.reasonCodes], result = { productId: row.id, eligible: false, reasonCodes };
      const fact = facts.get(row.id);
      if (fact) {
        reasonCodes.push(...fact.reasonCodes);
        if (fact.reportOnly) result.reportOnly = true;
        if (fact.readbackCode) result.readbackCode = fact.readbackCode;
        for (const key of ['readbackMode','readbackReason','readbackStatus']) if (fact[key] !== undefined) result[key] = fact[key];
        if (fact.remoteEvidence) result.remoteValue = fact.remoteEvidence.value;
        if (hash(fresh.get(row.id) || null) !== hash(row.source)) reasonCodes.push('SOURCE_CHANGED_DURING_READBACK');
        if (!reasonCodes.length && fact.remoteEvidence.definitionHash !== definitionHash) reasonCodes.push('READBACK_DEFINITION_CHANGED');
        if (!reasonCodes.length) await magentoEntry(client, { ...row, result, reasonCodes }, options, { ...fact,
          sourceAnswer: row.source.sourceAnswer, sourceAnswerPresent: row.source.sourceAnswerPresent, answer: { value: fact.targetAnswer },
          change: { targetWeight: fact.targetWeight, targetAnswer: fact.targetAnswer } });
      }
      entries.push(result);
    }
    return { entries };
  });
  return sealed(options, manifest.MAGENTO_FORMAT, 'apply', sealedRead, sealedRead.entries);
}
async function preview(options) {
  const actor = required(options), started = Date.now();
  if (![undefined,'recorded-answer','magento-readback'].includes(options.source)
    || options.source === 'magento-readback' && options.rollbackReceiptIds !== undefined) fail('SCOPE_INVALID');
  if (options.source === 'magento-readback') return previewMagento(options, actor, started);
  const rollback = options.rollbackReceiptIds !== undefined;
  let kind = 'recorded_answer';
  const read = await readOnly(options, actor, async client => {
    const entries = [];
    let rows;
    if (rollback) {
      if (!Array.isArray(options.rollbackReceiptIds) || !options.rollbackReceiptIds.length || options.rollbackReceiptIds.length > manifest.LIMIT
        || options.rollbackReceiptIds.some(id => !manifest.uuid(id)) || new Set(options.rollbackReceiptIds).size !== options.rollbackReceiptIds.length) fail('SCOPE_INVALID');
      rows = (await client.query(`SELECT r.id original_receipt_id,p.id,r.source_kind,r.source_answer,r.target_answer,r.remote_evidence,
        (r.before_state#>'{product,details,answers}') ? 'weight' answer_present,
        CASE WHEN r.source_kind='magento_readback' THEN sv_weight_magento_candidate(p,FALSE) ELSE sv_weight_repair_candidate(p,FALSE) END source,
        r.after_state::text original_after,r.before_state::text original_before,
        EXISTS(SELECT 1 FROM product_weight_repair_receipts i WHERE i.inverse_of=r.id) reversed
        FROM product_weight_repair_receipts r JOIN products p ON p.id=r.product_id
        WHERE r.id=ANY($1::uuid[]) AND r.direction='apply' AND r.state='applied' ORDER BY p.id`, [options.rollbackReceiptIds])).rows;
      if (rows.length !== options.rollbackReceiptIds.length || new Set(rows.map(row => row.source_kind)).size !== 1) fail('SCOPE_INVALID');
      kind = rows[0].source_kind;
    } else {
      rows = (await client.query(`SELECT p.id,sv_weight_repair_candidate(p) source FROM products p
        WHERE p.category='SV' AND p.status='active' AND p.corrected_to_product_id IS NULL
        ORDER BY p.id LIMIT 1001`)).rows;
    }
    if (rows.length > manifest.LIMIT) fail('SCOPE_LIMIT');
    for (const row of rows) {
      if (Date.now()-started > 300000) fail('PREVIEW_LIMIT');
      const source = row.source, reasonCodes = [...source.reasonCodes];
      const result = { productId: row.id, eligible: false, reasonCodes };
      if (rollback && row.reversed) reasonCodes.push('ALREADY_ROLLED_BACK');
      if (!reasonCodes.length && kind === 'magento_readback') {
        await magentoEntry(client, { ...row, result, reasonCodes }, options, { targetWeight: '0.000', targetAnswer: row.target_answer,
          remoteEvidence: row.remote_evidence, sourceAnswer: row.source_answer, sourceAnswerPresent: row.answer_present,
          answer: row.answer_present ? { value: row.source_answer } : { remove: true },
          original: { id: row.original_receipt_id, after: row.original_after, before: row.original_before },
          change: { reverse: true, sourceAnswerPresent: row.answer_present, sourceAnswer: row.source_answer } });
      } else if (!reasonCodes.length) {
        const targetWeight = rollback ? '0.000' : source.targetWeight;
        let evidence;
        try { evidence = await state(client,row.id,targetWeight); }
        catch (cause) { if (cause.code !== 'SV_CANONICAL_WEIGHT_EVIDENCE_LIMIT') throw cause; reasonCodes.push('EVIDENCE_LIMIT'); entries.push(result); continue; }
        const parsed = JSON.parse(evidence.before);
        if (rollback && (evidence.before !== row.original_after || evidence.after !== row.original_before)) reasonCodes.push('ROLLBACK_STATE_CHANGED');
        let publishedResultHash;
        if (!reasonCodes.length) {
          try { publishedResultHash = await comparePublished(client,row.id,options.bindingRevisionId,evidence.before,targetWeight); }
          catch (cause) { if (cause.code !== 'SV_CANONICAL_WEIGHT_PUBLISHED_RESULT_CHANGED') throw cause; reasonCodes.push('PUBLISHED_RESULT_CHANGED'); }
        }
        if (!reasonCodes.length) Object.assign(result, { eligible: true, publicSku: parsed.identity.public_sku,
          beforeEvidence: evidence.before, afterEvidence: evidence.after, beforeFingerprint: manifest.digest(evidence.before),
          afterFingerprint: manifest.digest(evidence.after), targetWeight, sourceAnswer: source.sourceAnswer,
          weightQuestionId: source.weightQuestionId, publishedResultHash,
          ...(rollback ? { originalReceiptId: row.original_receipt_id } : {}) });
      }
      entries.push(result);
    }
    return { entries };
  });
  return sealed(options, kind === 'magento_readback' ? manifest.MAGENTO_FORMAT : manifest.FORMAT, rollback ? 'rollback' : 'apply', read, read.entries);
}
function answerChange(plan, entry) {
  if (plan.format !== manifest.MAGENTO_FORMAT) return undefined;
  if (plan.direction === 'apply') return { value: entry.targetAnswer };
  return entry.sourceAnswerPresent ? { value: entry.sourceAnswer } : { remove: true };
}
async function freshReadback(plan, entry, options, actorUserId) {
  if ((await options.databasePool.query('SELECT 1 FROM product_weight_repair_receipts WHERE plan_hash=$1 AND product_id=$2',
    [plan.planHash,entry.productId])).rowCount) return;
  let facts;
  try { facts = await readback(options, actorUserId, entry.publicSku, entry.productId); }
  catch (cause) {
    if (GLOBAL.test(cause?.code || '') || cause?.statusCode === 403) throw cause;
    throw manifest.error('SV_CANONICAL_WEIGHT_READBACK_FAILED', 502);
  }
  if (facts.reasonCodes.length || hash(facts.remoteEvidence) !== hash(entry.remoteEvidence)
    || facts.targetWeight !== entry.targetWeight || facts.targetAnswer !== entry.targetAnswer) fail('STALE');
}
async function one(plan, entry, manifestText, options, actorUserId) {
  const magento = plan.format === manifest.MAGENTO_FORMAT, change = answerChange(plan, entry);
  // The remote value is re-read GET-only before any local lock is taken.
  if (magento && plan.direction === 'apply') await freshReadback(plan, entry, options, actorUserId);
  const lockClient = await options.databasePool.connect(), locks = [];
  const local = JSON.parse(entry.beforeEvidence);
  try {
    for (const key of [`amber_magento_public_identity:${local.identity.id}`,`amber_magento_sync:${plan.originHash}:${entry.publicSku}`]) {
      if (!(await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) held',[key])).rows[0].held) fail('BUSY');
      locks.push(key);
    }
    return await repairTransaction(options,async (client,actor) => {
      await assertActorStillAuthorized(client,actor.actorUserId,'products.recount',(s,c)=>manifest.error(c,s));
      if ((await gate.readGate(client)).phase === 'preparing') fail('LIFECYCLE_PREPARING');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_magento_binding:${plan.installationKey}`]);
      if (await context(client,options) !== plan.configurationText) fail('CONTEXT_STALE');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_canonical_weight_plan:${plan.planHash}`]);
      await lockRepairProducts(client,[entry.productId]);
      await client.query('SELECT id FROM public_product_identities WHERE id=$1 FOR UPDATE',[local.identity.id]);
      await client.query('SELECT public_product_identity_id FROM magento_product_sync_requests WHERE public_product_identity_id=$1 FOR UPDATE',[local.identity.id]);
      const previous = (await client.query(`SELECT *,before_state::text before_evidence,after_state::text after_evidence
        FROM product_weight_repair_receipts WHERE plan_hash=$1 AND product_id=$2`,[plan.planHash,entry.productId])).rows[0];
      const evidence = await state(client,entry.productId,entry.targetWeight,change);
      if (previous) {
        if (previous.state !== 'applied' || previous.before_evidence !== entry.beforeEvidence || previous.after_evidence !== entry.afterEvidence
          || evidence.before !== previous.after_evidence) fail('RECEIPT_STALE');
        return { productId: entry.productId, receiptId: previous.id, status: 'already_applied', direction: plan.direction };
      }
      if (evidence.before !== entry.beforeEvidence || evidence.after !== entry.afterEvidence) fail('STALE');
      const published = magento ? await comparePublishedMagento(client,entry.productId,plan.bindingRevisionId,evidence.before,
        plan.direction === 'apply' ? { targetWeight: entry.targetWeight, targetAnswer: entry.targetAnswer }
          : { reverse: true, sourceAnswerPresent: entry.sourceAnswerPresent, sourceAnswer: entry.sourceAnswer })
        : await comparePublished(client,entry.productId,plan.bindingRevisionId,evidence.before,entry.targetWeight);
      if (published !== entry.publishedResultHash) fail('STALE');
      const receiptId = crypto.randomUUID(), sourceKind = magento ? 'magento_readback' : 'recorded_answer';
      await client.query("SELECT set_config('amber.canonical_weight_repair_plan',$1,TRUE),set_config('amber.canonical_weight_repair',$2,TRUE)",[plan.planHash,receiptId]);
      await client.query(`INSERT INTO product_weight_repair_plans(plan_hash,manifest_text,actor_user_id)
        VALUES($1,$2,$3) ON CONFLICT(plan_hash) DO NOTHING`,[plan.planHash,manifestText,actor.actorUserId]);
      await client.query(`INSERT INTO product_weight_repair_receipts(id,plan_hash,product_id,actor_user_id,direction,inverse_of,
        before_state,after_state,source_answer,weight_question_id,target_weight,source_kind,target_answer,remote_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11::numeric(14,3),$12,$13::jsonb,$14::jsonb)`,
      [receiptId,plan.planHash,entry.productId,actor.actorUserId,plan.direction,entry.originalReceiptId || null,
        entry.beforeEvidence,entry.afterEvidence,JSON.stringify(entry.sourceAnswer ?? null),entry.weightQuestionId,entry.targetWeight,sourceKind,
        magento ? JSON.stringify(entry.targetAnswer) : null,magento ? JSON.stringify(entry.remoteEvidence) : null]);
      if (!magento) await client.query('UPDATE products SET weight=$2::numeric(14,3) WHERE id=$1',[entry.productId,entry.targetWeight]);
      else if (change.remove) await client.query(`UPDATE products SET weight=$2::numeric(14,3),details=details #- '{answers,weight}' WHERE id=$1`,
        [entry.productId,entry.targetWeight]);
      else await client.query(`UPDATE products SET weight=$2::numeric(14,3),details=jsonb_set(details,'{answers,weight}',$3::jsonb) WHERE id=$1`,
        [entry.productId,entry.targetWeight,JSON.stringify(change.value)]);
      const after = (await client.query('SELECT sv_weight_repair_state($1)::text value',[entry.productId])).rows[0].value;
      if (after !== entry.afterEvidence) fail('SIDE_EFFECT');
      const audit = await writeAuditEvent(client,{ mutationContext: actor,
        eventKey: plan.direction === 'apply' ? 'product.canonical_weight_repaired' : 'product.canonical_weight_rolled_back',
        subjectType: 'canonical_weight_repair', subjectId: receiptId,
        details: { planHash: plan.planHash, productId: entry.productId, publicSku: entry.publicSku,
          beforeFingerprint: entry.beforeFingerprint, afterFingerprint: entry.afterFingerprint,
          sourceAnswer: entry.sourceAnswer, weightQuestionId: entry.weightQuestionId, targetWeight: entry.targetWeight,
          publishedResultHash: entry.publishedResultHash, provenance: plan.provenance, sourceKind,
          remoteEvidence: magento ? entry.remoteEvidence : null, targetAnswer: magento ? entry.targetAnswer : null,
          inverseOf: entry.originalReceiptId || null, storedPricesAndDeliveryPreserved: true } });
      await client.query("UPDATE product_weight_repair_receipts SET state='applied',audit_event_id=$2,completed_at=CURRENT_TIMESTAMP WHERE id=$1",[receiptId,audit.id]);
      return { productId: entry.productId, receiptId, status: 'applied', direction: plan.direction };
    });
  } finally {
    for (const key of locks.reverse()) await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))',[key]);
    lockClient.release();
  }
}
async function apply(plan, options) {
  const actor = required(options);
  if (plan.bindingRevisionId !== options.bindingRevisionId) fail('CONTEXT_STALE');
  const manifestText = manifest.verify(plan,options.expectedHash,options.expectedDatabase,options.installationKey);
  if (plan.originHash !== originHash(options.config.baseUrl)) fail('CONTEXT_STALE');
  const selected = manifest.selection(plan,options.productIds), outcomes = [];
  for (const entry of selected) {
    try { outcomes.push(await one(plan,entry,manifestText,options,actor.actorUserId)); }
    catch (cause) {
      const code = /^SV_CANONICAL_WEIGHT_|^ADMIN_PERMISSION_REVOKED$/.test(cause.code || '') ? cause.code : 'SV_CANONICAL_WEIGHT_ROW_FAILED';
      outcomes.push({ productId: entry.productId, status: cause.statusCode === 409 ? 'conflicted' : 'failed', code });
      if (cause.statusCode === 403 || code === 'SV_CANONICAL_WEIGHT_CONTEXT_STALE') {
        for (const rest of selected.slice(outcomes.length)) outcomes.push({ productId: rest.productId, status: 'not_attempted', code });
        break;
      }
    }
    if (options.checkpoint) await options.checkpoint({ planHash: plan.planHash, direction: plan.direction, outcomes });
  }
  const result = { planHash: plan.planHash, direction: plan.direction, outcomes,
    counts: Object.fromEntries(['applied','already_applied','conflicted','failed','not_attempted'].map(status=>[status,outcomes.filter(row=>row.status===status).length])) };
  if (options.checkpoint) await options.checkpoint(result);
  return result;
}
module.exports = { preview, apply, verify: manifest.verify, comparePublished, comparePublishedMagento, magentoResult, remoteFacts };
