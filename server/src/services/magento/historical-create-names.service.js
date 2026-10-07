const c = require('./binding-contract');
const s = require('../historical-reactivation-state');
const historical = require('./historical-name-baseline');
const standard = require('./historical-standard-boundary');
const capability = require('./historical-manual-names');
const { readPreviewProduct } = require('./sync-preview-db');
const { previewProduct, planPreview } = require('./sync-preview');
const { evaluate } = require('./binding-evidence-products');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { writeAuditEvent } = require('../../audit/audit-events');

const unavailable = () => { throw c.error(409, 'HISTORICAL_MANUAL_NAMES_UNAVAILABLE', 'Ручна пара потрібна лише архівованому CREATE-кандидату SV, де відсутні назви є єдиним блокуванням.'); };
function selection(input) {
  c.command(input, ['productId', 'article', 'bindingRevisionId', 'intent'], ['subjectUa', 'subjectEn', 'previewToken', 'reviewExpiresAt']);
  if (!Number.isSafeInteger(input.productId) || input.productId <= 0 || input.intent !== 'historical-create'
    || typeof input.article !== 'string' || !input.article.trim()) unavailable();
  c.identity(input.bindingRevisionId);
}
async function context(db, amber, input, config, options, settings) {
  let current;
  try { current = await historical.context(db, amber, input, config, options, settings); }
  catch (cause) { if (cause.code === 'MAGENTO_NAME_PREVIEW_STALE') s.fail('HISTORICAL_REVIEW_STALE'); throw cause; }
  if (amber.product.category !== 'SV' || !(Number(amber.product.weight) > 0)
    || amber.compiled.definition.nameReadiness) unavailable();
  if (current.confirmedRemoteId != null) s.fail('HISTORICAL_REMOTE_OBSERVATION_CHANGED');
  return current;
}
async function preview(input, options = {}) {
  selection(input);
  const env = require('../../config/env'), db = options.databasePool || require('../../db/pool'), config = options.config || env.magento;
  const actor = historical.actor(options), now = (options.now || Date.now)();
  if (!await standard.present(db)) s.fail('HISTORICAL_STANDARD_MIGRATION_REQUIRED');
  const readCurrent = !Object.hasOwn(input, 'subjectUa') && !Object.hasOwn(input, 'subjectEn');
  const normalize = require('../product-magento-name.service').normalizeSubject;
  const subjects = readCurrent ? null : { subjectUa: normalize(input.subjectUa, 'українську'), subjectEn: normalize(input.subjectEn, 'англійську') };
  const published = await s.currentBinding(db, config);
  const amber = await readPreviewProduct(db, { productId: input.productId, bindingRevisionId: published.row.id });
  const current = await context(db, amber, input, config, options);
  // Preserve the source loader's object-bound proof while projecting a future
  // restore and the operator's hypothetical pair. Nothing is written here.
  const original = Object.fromEntries(['status', 'exclude_from_export', 'exportState', 'magento_name_subject_ua', 'magento_name_subject_en', 'magento_name_review_required'].map(key => [key, amber.product[key]]));
  let observation, report, before, names;
  try {
    standard.project(amber);
    if (subjects) Object.assign(amber.product, { magento_name_subject_ua: subjects.subjectUa, magento_name_subject_en: subjects.subjectEn, magento_name_review_required: false });
    report = await previewProduct(config, { databasePool: db, productId: input.productId, bindingRevisionId: input.bindingRevisionId,
      fetchImpl: require('./integration-readiness').boundedGet(options.fetchImpl), discover: options.discover,
      readAmber: async () => amber, onObservation: value => { observation = value; } });
    if (!observation || observation.raw || report.mode !== 'create' || report.identity?.confirmedMagentoId != null) s.fail('HISTORICAL_REMOTE_OBSERVATION_CHANGED');
    const evaluated = evaluate(amber, amber.product);
    names = { nameUa: evaluated.base.name, nameEn: evaluated.english.name };
    Object.assign(amber.product, { magento_name_subject_ua: original.magento_name_subject_ua, magento_name_subject_en: original.magento_name_subject_en,
      magento_name_review_required: original.magento_name_review_required });
    before = subjects ? planPreview(amber, observation.schema, null, observation.categoryNodes, { domainEvidence: observation.domainEvidence }) : report;
  } finally { Object.assign(amber.product, original); }
  const afterContext = await context(db, amber, input, config, options);
  if (current.fingerprint !== afterContext.fingerprint) s.fail('HISTORICAL_REVIEW_STALE');
  const alreadyCompleted = !capability.missingPair(amber.product) && before.sendable;
  if (!capability.available(amber, before) && !alreadyCompleted) unavailable();
  if (subjects && (!report.sendable || !require('../export-templates/effective-product-names').validPair({ all: names.nameUa, en: names.nameEn })
    || Number(report.candidatePayload.product.price) !== Number(amber.product.total_price_uah)
    || report.candidatePayload.product.status !== 2
    || alreadyCompleted && (subjects.subjectUa !== original.magento_name_subject_ua || subjects.subjectEn !== original.magento_name_subject_en))) unavailable();
  await s.authority(db, actor, true);
  const reviewExpiresAt = options.reviewExpiresAt || new Date(now + s.TTL).toISOString();
  const evidence = { intent: 'historical-create', productId: input.productId, article: input.article, bindingRevisionId: input.bindingRevisionId,
    localFingerprint: current.fingerprint, definitionHash: amber.compiled.hash, subjects,
    names: subjects ? names : null, planHash: subjects ? c.hash(require('./sync-job-plan').intent(report)) : null,
    observationHash: standard.observationFingerprint(observation), schemaHash: c.hash(observation.schema), reviewExpiresAt };
  const result = { productId: input.productId, article: input.article, bindingRevisionId: input.bindingRevisionId, intent: 'historical-create',
    deliveryMode: 'create', remoteProductId: null, alreadyCompleted, subjectUa: subjects?.subjectUa ?? original.magento_name_subject_ua,
    subjectEn: subjects?.subjectEn ?? original.magento_name_subject_en, ...(subjects || alreadyCompleted ? names : {}),
    ...(subjects ? { reviewExpiresAt, previewToken: s.signReview(actor, evidence, options.reviewSecret || env.sessionSecret) } : {}) };
  return options.internal ? { ...result, amber, evidence, current } : result;
}
async function apply(input, options = {}) {
  selection(input);
  const env = require('../../config/env'), db = options.databasePool || require('../../db/pool'), config = options.config || env.magento;
  const actor = historical.actor(options), expires = Date.parse(input.reviewExpiresAt), now = (options.now || Date.now)();
  if (!Number.isFinite(expires) || expires <= now || expires > now + s.TTL || !/^[a-f0-9]{64}$/.test(input.previewToken || '')
    || !Object.hasOwn(input, 'subjectUa') || !Object.hasOwn(input, 'subjectEn')) s.fail('HISTORICAL_REVIEW_STALE');
  const reviewOptions = { ...options, internal: true, reviewExpiresAt: input.reviewExpiresAt };
  const initial = await preview(input, reviewOptions), lockClient = await db.connect();
  const locks = [`amber_magento_public_identity:${initial.amber.product.public_product_identity_id}`,
    `amber_magento_sync:${c.originHash(config.baseUrl)}:${input.article}`];
  let held = 0;
  try {
    for (const lock of locks) {
      if (!(await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [lock])).rows[0].held) s.fail('MAGENTO_SYNC_BUSY');
      held++;
    }
    const fresh = await preview(input, reviewOptions);
    s.verifyReview(actor, fresh.evidence, input.previewToken, options.reviewSecret || env.sessionSecret, (options.now || Date.now)());
    if (fresh.alreadyCompleted) s.fail('HISTORICAL_REVIEW_STALE');
    return await runAccessAdminMutation({ databasePool: db, actorUserId: actor, requiredPermission: 'exports.create', createError: c.error, operation: async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${fresh.amber.revision.installationKey}`]);
      const current = await context(client, fresh.amber, input, config, options, { lock: true });
      if (current.fingerprint !== fresh.current.fingerprint) s.fail('HISTORICAL_REVIEW_STALE');
      s.verifyReview(actor, fresh.evidence, input.previewToken, options.reviewSecret || env.sessionSecret, (options.now || Date.now)());
      await client.query(`UPDATE products SET magento_name_subject_ua=$1,magento_name_subject_en=$2,magento_name_review_required=FALSE WHERE id=$3`,
        [fresh.subjectUa, fresh.subjectEn, input.productId]);
      await historical.keepRetired(client, fresh.amber.product);
      await writeAuditEvent(client, { mutationContext: options.mutationContext, eventKey: 'product_magento_name.updated', subjectType: 'product', subjectId: input.productId,
        details: { version: 1, intent: 'historical-create', sku: input.article, bindingRevisionId: input.bindingRevisionId,
          before: { subjectUa: fresh.amber.product.magento_name_subject_ua, subjectEn: fresh.amber.product.magento_name_subject_en },
          after: { subjectUa: fresh.subjectUa, subjectEn: fresh.subjectEn }, names: { all: fresh.nameUa, en: fresh.nameEn }, archivePreserved: true } });
      return { productId: input.productId, article: input.article, bindingRevisionId: input.bindingRevisionId, intent: 'historical-create',
        state: 'archived', subjectsSaved: true, remoteProductId: null, subjectUa: fresh.subjectUa, subjectEn: fresh.subjectEn };
    } });
  } finally {
    while (held > 0) await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [locks[--held]]).catch(() => {});
    lockClient.release();
  }
}
module.exports = { preview, apply };
