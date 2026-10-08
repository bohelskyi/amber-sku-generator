const c = require('./binding-contract');
const s = require('../historical-reactivation-state');
const historical = require('./historical-name-baseline');
const standard = require('./historical-standard-boundary');
const gate = require('../full-product-cutover-gate');
const { readPreviewProductOnClient } = require('./sync-preview-db');
const { evaluate } = require('./binding-evidence-products');
const { loadSupportInputs } = require('../export-templates/support-inputs');
const { loadPricingContext } = require('../pricing/pricing-context');
const { calculatePricingBase } = require('../pricing/pricing-calculator');
const { equivalentCommaWeight, equivalentDotWeight, targetProduct } = require('../sv-readiness-repair');
const { runAccessAdminMutation, assertActorStillAuthorized } = require('../access-admin-transaction');
const { writeAuditEvent } = require('../../audit/audit-events');
const { createMutationContext } = require('../../audit/mutation-context');
const FORMAT = 'historical-sv-weight-normalization-v1';
const EVENT = 'product.sv_weight_representation_repaired';
const unavailable = () => { throw c.error(409, 'HISTORICAL_WEIGHT_NORMALIZATION_UNAVAILABLE',
  'Виправлення формату доступне лише для точної додатної ваги з комою, що дорівнює збереженій вазі архівованого SV. Іншу або відсутню вагу потрібно розглянути окремо.'); };
function selection(input) {
  c.command(input, ['productId', 'article', 'bindingRevisionId'], ['previewToken', 'reviewExpiresAt', 'confirmEquivalentWeightNormalization']);
  if (!Number.isSafeInteger(input.productId) || input.productId <= 0 || typeof input.article !== 'string' || !input.article.trim()) unavailable();
  c.identity(input.bindingRevisionId);
}
function capability(amber, report) {
  const target = equivalentCommaWeight(amber.product);
  if (amber.product.category !== 'SV' || target === null || !report.blockers.some(b => b.code === 'PRODUCT_EVALUATION_NOT_READY'
    && b.evaluationIssues?.some(issue => issue.field === 'decor_weight'))) return null;
  return { sourceWeight: amber.product.details.answers.weight, targetWeight: target, canonicalWeight: String(amber.product.weight) };
}
async function metadata(db, lock) {
  const questions = (await db.query(`SELECT * FROM questions WHERE category_code='SV' AND key='weight' ${lock ? 'FOR SHARE' : ''}`)).rows;
  if (questions.length !== 1 || questions[0].input_type !== 'text' || questions[0].include_in_sku !== 0) unavailable();
  return { questions, pricing: await loadPricingContext('SV', db) };
}
async function prepare(input, options, db, config, lock = false) {
  await assertActorStillAuthorized(db, historical.actor(options), 'products.recount', c.error, { readOnly: !lock });
  const published = await s.currentBinding(db, config);
  const amber = await readPreviewProductOnClient(db, { productId: input.productId, bindingRevisionId: published.row.id });
  const current = await historical.context(db, amber, input, config, options, { lock });
  const p = amber.product, target = equivalentCommaWeight(p), completed = equivalentDotWeight(p);
  if (p.category !== 'SV' || target === null && !completed) unavailable();
  const identity = (await db.query(`SELECT r.first_product_id,
    (SELECT count(*)::int FROM products q WHERE q.full_sku=$1) identity_count FROM sku_registry r WHERE r.full_sku=$1`, [p.full_sku])).rows[0];
  if (Number(identity?.first_product_id) !== p.id || identity?.identity_count !== 1) s.fail('HISTORICAL_WEIGHT_IDENTITY_CHANGED');
  const ctx = await metadata(db, lock);
  const products = await loadSupportInputs(db, amber.compiled.definition, [structuredClone(p), ...(target !== null ? [targetProduct(p)] : [])]);
  products.products.forEach(product => standard.project({ product }));
  const before = evaluate(amber, products.products[0]), after = target !== null ? evaluate(amber, products.products[1]) : before;
  if (before.failed || after.failed || after.evaluationIssues?.some(issue => issue.field === 'decor_weight')) unavailable();
  if (target !== null) {
    if (!before.evaluationIssues?.some(issue => issue.field === 'decor_weight')
      || c.hash(before.evaluationIssues.filter(issue => issue.field !== 'decor_weight')) !== c.hash(after.evaluationIssues)) unavailable();
    const pricing = product => {
      const result = calculatePricingBase({ categoryCode: 'SV', answers: product.details.answers, weight: Number(product.weight),
        isCalibrated: product.details.isCalibrated, context: ctx.pricing });
      delete result.weightVal;
      return result;
    };
    if (c.hash(pricing(p)) !== c.hash(pricing(targetProduct(p)))) unavailable();
  }
  return { amber, current, ctx, target, completed, after,
    raw: (await db.query('SELECT to_jsonb(p) product FROM products p WHERE id=$1', [p.id])).rows[0].product };
}
const evidence = (input, prepared, reviewExpiresAt) => ({ purpose: FORMAT, productId: input.productId, article: input.article,
  bindingRevisionId: input.bindingRevisionId, localFingerprint: prepared.current.fingerprint, definitionHash: prepared.amber.compiled.hash,
  metadataHash: c.hash(prepared.ctx), sourceWeight: prepared.amber.product.details.answers.weight,
  targetWeight: prepared.target, canonicalWeight: String(prepared.amber.product.weight), targetIssues: prepared.after.evaluationIssues, reviewExpiresAt });
function dependencies(options) {
  const env = require('../../config/env');
  return { db: options.databasePool || require('../../db/pool'), config: options.config || env.magento,
    secret: options.reviewSecret || env.sessionSecret, now: options.now || Date.now, actor: historical.actor(options) };
}
async function preview(input, options = {}) {
  selection(input);
  const { db, config, secret, now, actor } = dependencies(options), client = await db.connect();
  try {
    await gate.begin(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const prepared = await prepare(input, options, client, config), reviewExpiresAt = new Date(now() + s.TTL).toISOString();
    const result = { format: FORMAT, ...input, state: 'archived', canonicalWeight: String(prepared.amber.product.weight),
      sourceWeight: prepared.amber.product.details.answers.weight, targetWeight: prepared.target ?? prepared.amber.product.details.answers.weight,
      alreadyCompleted: prepared.completed, remainingIssues: prepared.after.evaluationIssues,
      ...(prepared.target !== null ? { previewToken: s.signReview(actor, evidence(input, prepared, reviewExpiresAt), secret), reviewExpiresAt } : {}) };
    await gate.commit(client);
    return result;
  } catch (cause) { await gate.rollback(client); throw cause; }
  finally { await gate.release(client); client.release(); }
}
async function apply(input, options = {}) {
  selection(input);
  if (input.confirmEquivalentWeightNormalization !== true) throw c.error(422, 'HISTORICAL_WEIGHT_CONFIRMATION_REQUIRED', 'Підтвердьте лише виправлення формату цієї ваги.');
  const { db, config, secret, now, actor } = dependencies(options), expires = Date.parse(input.reviewExpiresAt);
  if (!Number.isFinite(expires) || expires <= now() || expires > now() + s.TTL || !/^[a-f0-9]{64}$/.test(input.previewToken || '')) s.fail('HISTORICAL_REVIEW_STALE');
  const mutationContext = createMutationContext(options.mutationContext);
  return runAccessAdminMutation({ databasePool: db, actorUserId: actor, requiredPermission: 'products.recount', createError: c.error,
    operation: async client => {
      const published = await s.currentBinding(client, config);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${published.row.installation_key}`]);
      const prepared = await prepare(input, options, client, config, true);
      if (prepared.target === null) s.fail('HISTORICAL_REVIEW_STALE');
      const proof = evidence(input, prepared, input.reviewExpiresAt);
      s.verifyReview(actor, proof, input.previewToken, secret, now());
      await client.query("UPDATE products SET details=jsonb_set(details,'{answers,weight}',$2::jsonb,false) WHERE id=$1", [input.productId, JSON.stringify(prepared.target)]);
      const persisted = (await client.query('SELECT to_jsonb(p) product FROM products p WHERE id=$1', [input.productId])).rows[0].product;
      if (c.hash(persisted) !== c.hash(targetProduct(prepared.raw)) || !equivalentDotWeight(persisted)) unavailable();
      const support = await loadSupportInputs(client, prepared.amber.compiled.definition, [{ ...prepared.amber.product, ...persisted }]);
      // The stored row remains archived. Projection is evaluation only.
      standard.project({ product: support.products[0] });
      const checked = evaluate(prepared.amber, support.products[0]);
      if (checked.failed || c.hash(checked.evaluationIssues) !== c.hash(prepared.after.evaluationIssues)
        || c.hash(await metadata(client, true)) !== c.hash(prepared.ctx)) unavailable();
      s.verifyReview(actor, proof, input.previewToken, secret, now());
      await historical.keepRetired(client, prepared.amber.product);
      const result = { format: FORMAT, productId: input.productId, article: input.article, bindingRevisionId: input.bindingRevisionId,
        state: 'archived', canonicalWeight: proof.canonicalWeight, sourceWeight: proof.sourceWeight, targetWeight: prepared.target,
        weightNormalized: true, remainingIssues: checked.evaluationIssues };
      await writeAuditEvent(client, { mutationContext, eventKey: EVENT, subjectType: 'product', subjectId: input.productId,
        details: { purpose: FORMAT, ...result, localFingerprint: proof.localFingerprint, definitionHash: proof.definitionHash, metadataHash: proof.metadataHash } });
      return result;
    } });
}
module.exports = { FORMAT, capability, preview, apply };
