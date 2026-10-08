const { hash } = require('./magento/binding-contract');
const gate = require('./full-product-cutover-gate');
const { repairTransaction, lockRepairProducts, receipt, error } = require('./recount-repair.service');
const { assertActorStillAuthorized } = require('./access-admin-transaction');
const { advanceFullProductRevision } = require('./full-product-export.service');
const { writeAuditEvent } = require('../audit/audit-events');
const { compileDefinition } = require('./export-templates/definition');
const { evaluateProduct } = require('./export-templates/evaluate');
const { loadSupportInputs } = require('./export-templates/support-inputs');
const { loadPricingContext } = require('./pricing/pricing-context');
const { calculatePricingBase } = require('./pricing/pricing-calculator');

const FORMAT = 'sv-saved-weight-representation-v1';
const EVENT = 'product.sv_weight_representation_repaired';
const fail = () => { throw error(409, 'SV_REPAIR_CONFLICT', 'Refresh the evidence-bound SV repair plan'); };
function normalizedWeight(value) {
  if (typeof value !== 'string' || !/^\d+,\d+$/.test(value)) return null;
  const normalized = value.replace(',', '.');
  return Number.isFinite(Number(normalized)) && Number(normalized) > 0 ? normalized : null;
}
// Compare decimal digits exactly; Number equality can hide a conflicting fraction.
function decimalWeightKey(value) {
  if (!['string', 'number'].includes(typeof value)) return null;
  const text = String(value);
  if (text.length > 64 || !/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text)) || !(Number(text) > 0)) return null;
  const [integer, fraction = ''] = text.split('.');
  return (integer.replace(/^0+/, '') || '0') + '.' + fraction.replace(/0+$/, '');
}
function equivalentCommaWeight(product) {
  const target = normalizedWeight(product.details?.answers?.weight), canonical = decimalWeightKey(product.weight);
  return target !== null && canonical !== null && decimalWeightKey(target) === canonical ? target : null;
}
function equivalentDotWeight(product) {
  const answer = product.details?.answers?.weight, canonical = decimalWeightKey(product.weight);
  return typeof answer === 'string' && canonical !== null && decimalWeightKey(answer) === canonical;
}
function targetProduct(product) {
  const weight = normalizedWeight(product.details?.answers?.weight);
  return weight === null ? null : { ...product, details: { ...product.details,
    answers: { ...product.details.answers, weight } } };
}
async function readState(client, id) {
  const state = (await client.query(`SELECT to_jsonb(p) product,to_jsonb(f) lifecycle,
    (SELECT to_jsonb(r) FROM sku_registry r WHERE r.full_sku=p.full_sku) reservation,
    (SELECT count(*)::int FROM products other WHERE other.full_sku=p.full_sku) identity_count,
    EXISTS(SELECT 1 FROM product_corrections c WHERE c.source_product_id=p.id OR c.corrected_product_id=p.id) correction,
    EXISTS(SELECT 1 FROM products q WHERE q.corrected_from_product_id=p.id OR q.corrected_to_product_id=p.id) linked,
    EXISTS(SELECT 1 FROM correction_requests c WHERE c.source_product_id=p.id AND c.status IN ('pending','in_progress')) active_request
    FROM products p LEFT JOIN product_full_export_state f ON f.product_id=p.id WHERE p.id=$1`, [id])).rows[0];
  if (!state) fail();
  return state;
}
async function context(client, bindingId, lock = false) {
  const r = (await client.query(`SELECT id,revision::text,template_version_id FROM magento_binding_revisions
    WHERE id=$1 ${lock ? 'FOR SHARE' : ''}`, [bindingId])).rows[0];
  if (!r) fail();
  const v = (await client.query('SELECT definition,definition_hash FROM export_template_versions WHERE id=$1', [r.template_version_id])).rows[0];
  if (!v || compileDefinition(v.definition).hash !== v.definition_hash) fail();
  const questions = (await client.query(`SELECT * FROM questions WHERE category_code='SV' AND key='weight' ${lock ? 'FOR SHARE' : ''}`)).rows;
  if (questions.length !== 1 || questions[0].input_type !== 'text' || questions[0].include_in_sku !== 0) fail();
  return { binding: r, definition: v.definition, definitionHash: v.definition_hash, questions,
    pricing: await loadPricingContext('SV', client) };
}
async function entry(client, state, ctx) {
  const p = state.product, f = state.lifecycle, target = targetProduct(p);
  const blockers = [];
  if (p.category !== 'SV' || p.status !== 'active' || p.corrected_to_product_id != null || !f || f.route === 'retired') blockers.push('NOT_CURRENT_SV');
  if (state.correction || state.linked || state.active_request || p.corrected_from_product_id != null) blockers.push('CORRECTION_STATE');
  if (state.reservation?.first_product_id !== p.id || state.identity_count !== 1) blockers.push('SKU_IDENTITY_CONFLICT');
  if (!target) blockers.push('NO_EXACT_COMMA_WEIGHT');
  const compiled = compileDefinition(ctx.definition);
  const projected = await loadSupportInputs(client, ctx.definition, [p, ...(target ? [target] : [])]);
  const before = evaluateProduct(compiled, projected.products[0]);
  const after = target ? evaluateProduct(compiled, projected.products[1]) : before;
  if (target) {
    const pricing = (product) => {
      const calculation = calculatePricingBase({ categoryCode: 'SV', answers: product.details.answers,
        weight: Number(product.weight), isCalibrated: product.details.isCalibrated, context: ctx.pricing });
      // Physical column and all stored prices remain unchanged. A different
      // fallback weight is harmless only when no current pricing result changes.
      delete calculation.weightVal;
      return calculation;
    };
    if (hash(pricing(p)) !== hash(pricing(target))) blockers.push('PRICING_RESULT_CHANGED');
    const remainingBefore = before.errors.filter(e => e.field !== 'decor_weight');
    if (!before.errors.some(e => e.field === 'decor_weight') || after.errors.some(e => e.field === 'decor_weight')
      || hash(remainingBefore) !== hash(after.errors)) blockers.push('TARGET_REVALIDATION_FAILED');
  }
  return { productId: p.id, sku: p.full_sku, subtype: p.details?.answers?.souvenir,
    beforeFingerprint: hash(state), contextFingerprint: hash(ctx),
    source: { field: 'details.answers.weight', value: p.details?.answers?.weight ?? null },
    target: target?.details.answers.weight ?? null, blockers, eligible: blockers.length === 0,
    beforeIssues: before.errors, targetIssues: after.errors, targetReady: after.errors.length === 0 };
}
async function preview(options) {
  const c = await options.databasePool.connect();
  try {
    await gate.begin(c, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if ((await c.query('SELECT current_database() name')).rows[0].name !== options.expectedDatabase) fail();
    const ctx = await context(c, options.bindingRevisionId);
    const rows = (await c.query("SELECT id FROM products WHERE category='SV' AND status='active' AND corrected_to_product_id IS NULL ORDER BY id LIMIT 1001")).rows;
    if (rows.length > 1000) fail();
    const entries = [];
    for (const row of rows) entries.push(await entry(c, await readState(c, row.id), ctx));
    const plan = { format: FORMAT, database: options.expectedDatabase, bindingRevisionId: options.bindingRevisionId,
      bindingCounter: ctx.binding.revision, generatedAt: new Date().toISOString(), entries,
      summary: { scanned: entries.length, eligible: entries.filter(e => e.eligible).length,
        fullyReadyAfterRepair: entries.filter(e => e.eligible && e.targetReady).length } };
    await gate.commit(c);
    return { ...plan, planHash: hash(plan) };
  } catch (e) { await gate.rollback(c); throw e; }
  finally { await gate.release(c); c.release(); }
}
function verify(plan, expectedHash, database) {
  const { planHash, ...body } = plan || {};
  if (plan?.format !== FORMAT || plan.database !== database || planHash !== expectedHash || hash(body) !== expectedHash
    || !Array.isArray(plan.entries) || plan.entries.length > 1000
    || new Set(plan.entries.map(e => e.productId)).size !== plan.entries.length) fail();
}
async function applyEntry(plan, approved, options) {
  verify(plan, options.expectedHash, options.expectedDatabase);
  if (!approved.eligible || !plan.entries.some(e => hash(e) === hash(approved))) fail();
  const key = hash({ planHash: plan.planHash, entry: approved });
  return repairTransaction(options, async (c, mutationContext) => {
    await assertActorStillAuthorized(c, mutationContext.actorUserId, 'products.recount', error);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sv-readiness:${key}`]);
    const prior = await receipt(c, key, EVENT);
    if (prior) return { ...prior.result, alreadyApplied: true };
    await lockRepairProducts(c, [approved.productId]);
    const state = await readState(c, approved.productId), ctx = await context(c, plan.bindingRevisionId, true);
    const fresh = await entry(c, state, ctx);
    if (!fresh.eligible || hash(fresh) !== hash(approved)) fail();
    await c.query("UPDATE products SET details=jsonb_set(details,'{answers,weight}',$2::jsonb,false) WHERE id=$1", [approved.productId, JSON.stringify(fresh.target)]);
    // Re-read and evaluate the persisted TARGET, not the source product.
    const changed = (await c.query('SELECT to_jsonb(p) product FROM products p WHERE id=$1', [approved.productId])).rows[0].product;
    const projected = await loadSupportInputs(c, ctx.definition, [changed]);
    const evaluated = evaluateProduct(compileDefinition(ctx.definition), projected.products[0]);
    if (hash(evaluated.errors) !== hash(fresh.targetIssues) || hash(changed) !== hash(targetProduct(state.product))) fail();
    const lifecycle = await advanceFullProductRevision(c, approved.productId, state.lifecycle.revision);
    const result = { productId: approved.productId, sku: approved.sku, source: fresh.source, target: fresh.target,
      fullRevision: String(lifecycle.revision), targetIssues: evaluated.errors, targetReady: evaluated.errors.length === 0 };
    await writeAuditEvent(c, { mutationContext, eventKey: EVENT, subjectType: 'sv_readiness_repair', subjectId: key,
      details: { planHash: plan.planHash, evidence: fresh, result } });
    return { ...result, alreadyApplied: false };
  });
}
async function apply(plan, options) {
  verify(plan, options.expectedHash, options.expectedDatabase);
  const result = { planHash: plan.planHash, complete: false, succeeded: [], skipped: [], conflicted: [], failed: [] };
  const checkpoint = async () => { result.counts = Object.fromEntries(['succeeded','skipped','conflicted','failed'].map(k => [k, result[k].length])); await options.checkpoint?.(result); };
  await checkpoint();
  for (const approved of plan.entries.filter(e => e.eligible)) {
    try { const r = await applyEntry(plan, approved, options); result[r.alreadyApplied ? 'skipped' : 'succeeded'].push(r.productId); }
    catch (e) { result[e.statusCode === 409 ? 'conflicted' : 'failed'].push(approved.productId); }
    await checkpoint();
  }
  result.complete = true; await checkpoint(); return result;
}
module.exports = { normalizedWeight, targetProduct, decimalWeightKey, equivalentCommaWeight, equivalentDotWeight, preview, verify, applyEntry, apply };
