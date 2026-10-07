const c = require('./binding-contract');
const s = require('../historical-reactivation-state');
const historical = require('./historical-name-baseline');
const standard = require('./historical-standard-boundary');
const capability = require('./historical-manual-names');
const { nameRender } = require('./historical-manual-render');
const { readPreviewProduct } = require('./sync-preview-db');
const { previewProduct, planPreview } = require('./sync-preview');
const { evaluate } = require('./binding-evidence-products');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { writeAuditEvent } = require('../../audit/audit-events');

const unavailable = () => { throw c.error(409, 'HISTORICAL_MANUAL_NAMES_UNAVAILABLE', 'Ручна пара потрібна лише архівованому CREATE-кандидату SV, де відсутні назви є єдиним блокуванням.'); };
function selection(input) {
  c.command(input, ['productId', 'article', 'bindingRevisionId', 'intent'],
    ['subjectUa', 'subjectEn', 'previewToken', 'preparationToken', 'reviewedNameUa', 'reviewedNameEn', 'reviewExpiresAt']);
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
const originalFields = amber => Object.fromEntries(['status', 'exclude_from_export', 'exportState', 'magento_name_subject_ua',
  'magento_name_subject_en', 'magento_name_review_required'].map(key => [key, amber.product[key]]));
const setSubjects = (amber, subjects) => Object.assign(amber.product, { magento_name_subject_ua: subjects.subjectUa,
  magento_name_subject_en: subjects.subjectEn, magento_name_review_required: false });
const validNames = names => require('../export-templates/effective-product-names').validPair({ all: names.nameUa, en: names.nameEn });
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
  const current = await context(db, amber, input, config, options), original = originalFields(amber);
  const render = nameRender(amber); if (!render) unavailable();
  let before, evaluated, names;
  try {
    // Local presentation only. Keep the source loader's object-bound proof.
    standard.project(amber); before = evaluate(amber, amber.product);
    if (subjects) setSubjects(amber, subjects);
    evaluated = subjects ? evaluate(amber, amber.product) : before;
    names = { nameUa: evaluated.base.name, nameEn: evaluated.english.name };
  } finally { Object.assign(amber.product, original); }
  const afterContext = await context(db, amber, input, config, options);
  if (current.fingerprint !== afterContext.fingerprint) s.fail('HISTORICAL_REVIEW_STALE');
  const alreadyCompleted = !capability.missingPair(amber.product) && before.ready && validNames(names);
  const missingOnlyNames = capability.missingPair(amber.product) && !before.ready && before.evaluationIssues?.length
    && before.evaluationIssues.every(issue => issue.code === 'manual_name_required' && issue.field === 'name');
  if (!missingOnlyNames && !alreadyCompleted) unavailable();
  if (subjects && (!evaluated.ready || !validNames(names)
    || names.nameUa !== render.ua.prefix + subjects.subjectUa + render.ua.suffix
    || names.nameEn !== render.en.prefix + subjects.subjectEn + render.en.suffix
    || alreadyCompleted && (subjects.subjectUa !== original.magento_name_subject_ua || subjects.subjectEn !== original.magento_name_subject_en))) unavailable();
  await s.authority(db, actor, true);
  const reviewExpiresAt = options.reviewExpiresAt || new Date(now + s.TTL).toISOString();
  const formEvidence = { purpose: 'historical-manual-form-v2', intent: 'historical-create', productId: input.productId,
    article: input.article, bindingRevisionId: input.bindingRevisionId, localFingerprint: current.fingerprint,
    definitionHash: amber.compiled.hash, render, reviewExpiresAt };
  const evidence = { ...formEvidence, purpose: 'historical-manual-pair-v2', subjects, names: subjects ? names : null };
  const secret = options.reviewSecret || env.sessionSecret;
  const result = { productId: input.productId, article: input.article, bindingRevisionId: input.bindingRevisionId, intent: 'historical-create',
    deliveryMode: 'create', remoteProductId: null, alreadyCompleted, subjectUa: subjects?.subjectUa ?? original.magento_name_subject_ua,
    subjectEn: subjects?.subjectEn ?? original.magento_name_subject_en, ...(subjects || alreadyCompleted ? names : {}),
    nameRender: render, preparationToken: s.signReview(actor, formEvidence, secret), reviewExpiresAt,
    ...(subjects ? { previewToken: s.signReview(actor, evidence, secret) } : {}) };
  return options.internal ? { ...result, amber, evidence, formEvidence, current } : result;
}
async function apply(input, options = {}) {
  selection(input);
  const env = require('../../config/env'), db = options.databasePool || require('../../db/pool'), config = options.config || env.magento;
  const actor = historical.actor(options), expires = Date.parse(input.reviewExpiresAt), now = (options.now || Date.now)();
  const prepared = Object.hasOwn(input, 'preparationToken'), token = prepared ? input.preparationToken : input.previewToken;
  if (!Number.isFinite(expires) || expires <= now || expires > now + s.TTL || !/^[a-f0-9]{64}$/.test(token || '')
    || !Object.hasOwn(input, 'subjectUa') || !Object.hasOwn(input, 'subjectEn') || prepared && Object.hasOwn(input, 'previewToken')) s.fail('HISTORICAL_REVIEW_STALE');
  const reviewOptions = { ...options, internal: true, reviewExpiresAt: input.reviewExpiresAt };
  const fresh = await preview(input, reviewOptions);
  const evidence = prepared ? fresh.formEvidence : fresh.evidence, secret = options.reviewSecret || env.sessionSecret;
  const verify = () => s.verifyReview(actor, evidence, token, secret, (options.now || Date.now)());
  verify();
  if (fresh.alreadyCompleted) s.fail('HISTORICAL_REVIEW_STALE');
  if (prepared && (input.reviewedNameUa !== fresh.nameUa || input.reviewedNameEn !== fresh.nameEn)) s.fail('HISTORICAL_REVIEW_STALE');
  const lockClient = await db.connect(), locks = [`amber_magento_public_identity:${fresh.amber.product.public_product_identity_id}`,
    `amber_magento_sync:${c.originHash(config.baseUrl)}:${input.article}`];
  let held = 0;
  try {
    for (const lock of locks) {
      if (!(await lockClient.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [lock])).rows[0].held) s.fail('MAGENTO_SYNC_BUSY');
      held++;
    }
    // One fresh complete target plan. No database row lock spans Magento I/O.
    const original = originalFields(fresh.amber); let observation, report, before;
    try {
      standard.project(fresh.amber); setSubjects(fresh.amber, fresh);
      report = await previewProduct(config, { databasePool: db, productId: input.productId, bindingRevisionId: input.bindingRevisionId,
        fetchImpl: require('./integration-readiness').boundedGet(options.fetchImpl), discover: options.discover,
        readAmber: async () => fresh.amber, onObservation: value => { observation = value; } });
      if (!observation || observation.raw || report.mode !== 'create' || report.identity?.confirmedMagentoId != null) s.fail('HISTORICAL_REMOTE_OBSERVATION_CHANGED');
      Object.assign(fresh.amber.product, { magento_name_subject_ua: original.magento_name_subject_ua,
        magento_name_subject_en: original.magento_name_subject_en, magento_name_review_required: original.magento_name_review_required });
      before = planPreview(fresh.amber, observation.schema, null, observation.categoryNodes, { domainEvidence: observation.domainEvidence });
    } finally { Object.assign(fresh.amber.product, original); }
    if (!capability.available(fresh.amber, before) || !report.sendable
      || Number(report.candidatePayload.product.price) !== Number(fresh.amber.product.total_price_uah)
      || report.candidatePayload.product.status !== 2) unavailable();
    verify();
    return await runAccessAdminMutation({ databasePool: db, actorUserId: actor, requiredPermission: 'exports.create', createError: c.error, operation: async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${fresh.amber.revision.installationKey}`]);
      const current = await context(client, fresh.amber, input, config, options, { lock: true });
      if (current.fingerprint !== fresh.current.fingerprint) s.fail('HISTORICAL_REVIEW_STALE');
      verify();
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
