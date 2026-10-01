const { randomUUID } = require('node:crypto');
const pool = require('../../db/pool');
const c = require('./binding-contract');
const actions = require('./configuration-actions');
const bindings = require('./binding.service');
const { createMutationContext } = require('../../audit/mutation-context');
const { writeAuditEvent } = require('../../audit/audit-events');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { createMagentoClient, readJson } = require('./client');
const { normalizeAttribute, normalizeOptions } = require('./schema-audit');
const { boundedGet } = require('./integration-readiness');
const { signOptionCreateRequest } = require('./oauth');
const fail = (code, message = 'Потрібна повторна перевірка значення Magento.') => { throw c.error(409, code, message); };
const TARGET_FIELDS = ['bindingRevisionId','expectedRevision','attributeCode','amberGroup','questionKey','valueId'];
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 255 || /[\u0000-\u001f]/.test(value)) c.invalid();
  return value;
}
function characterize(raw) {
  const a = normalizeAttribute(raw);
  let additional = raw.additional_data;
  if (typeof additional === 'string') { try { additional = JSON.parse(additional); } catch { fail('MAGENTO_OPTION_CAPABILITY_UNSUPPORTED'); } }
  for (const swatch of [raw.swatch_input_type,additional?.swatch_input_type]) {
    if (swatch !== undefined && swatch !== 'dropdown') fail('MAGENTO_OPTION_CAPABILITY_UNSUPPORTED');
  }
  if (!['select','multiselect'].includes(a.frontend_input) || a.is_user_defined !== true
    || !Object.hasOwn(raw, 'source_model')
    || ![null,'','Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table'].includes(raw.source_model)
    || (a.frontend_input === 'select' ? a.backend_type !== 'int' : !['varchar','text'].includes(a.backend_type))) {
    fail('MAGENTO_OPTION_CAPABILITY_UNSUPPORTED', 'Створення доступне лише для перевірених звичайних user-defined select/multiselect атрибутів.');
  }
  const metadata = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'options'));
  return { attribute: a, metadataFingerprint: c.hash(c.safeData(metadata,[],32768)), requiresAttestation: true };
}
async function assertAdministrator(client, actor) {
  const yes = (await client.query(`SELECT 1 FROM application_users u JOIN user_role_assignments a ON a.application_user_id=u.id
    JOIN roles r ON r.id=a.role_id WHERE u.id=$1 AND u.status='active' AND a.revoked_at IS NULL
      AND r.status='active' AND r.role_key='administrator'`, [actor])).rowCount;
  if (!yes) throw c.error(403, 'MAGENTO_OPTION_ADMINISTRATOR_REQUIRED', 'Підтвердження можливості створення потребує Administrator.');
}
async function amberSource(db, input, expectedLabel = null, lock = false) {
  if (lock) await db.query('SELECT id FROM questions WHERE category_code=$1 AND key=$2 FOR SHARE',[input.amberGroup,input.questionKey]);
  const value = (await db.query(`SELECT o.label,q.include_in_sku FROM options o JOIN questions q ON q.id=o.question_id
    JOIN categories cat ON cat.code=q.category_code WHERE q.category_code=$1 AND q.key=$2 AND o.value_id=$3
      AND o.archived=false${lock ? ' FOR SHARE OF o' : ''}`, [input.amberGroup,input.questionKey,input.valueId])).rows[0];
  if (!value || (expectedLabel !== null && value.label !== expectedLabel)) fail('MAGENTO_OPTION_AMBER_SOURCE_MISSING');
  if (value.include_in_sku) {
    const published = await db.query(`SELECT 1 FROM sku_schema_versions v JOIN sku_schema_questions q ON q.schema_version_id=v.id
      JOIN sku_schema_options o ON o.schema_question_id=q.id WHERE v.category_code=$1 AND v.status='active'
        AND q.question_key=$2 AND o.value_id=$3 AND o.archived=false${lock ? ' FOR SHARE OF v' : ''}`, [input.amberGroup,input.questionKey,input.valueId]);
    if (!published.rowCount) fail('MAGENTO_OPTION_AMBER_SCHEMA_REQUIRED');
  }
  return value;
}
async function target(config, input, options) {
  c.command(input, TARGET_FIELDS, ['englishLabel','englishAuthoritative']);
  if (!c.code(input.attributeCode) || !c.questionKey(input.questionKey) || !c.semanticId(String(input.valueId))) c.invalid();
  const revision = await bindings.getRevision(c.identity(input.bindingRevisionId), options);
  if (revision.state !== 'draft' || revision.revision !== c.counter(input.expectedRevision)) fail('MAGENTO_BINDING_CONFLICT');
  if (revision.originHash !== c.originHash(config.baseUrl) || revision.schema.storeCode !== 'all') c.invalid();
  const db = options.databasePool || pool;
  const value = await amberSource(db,input);
  const result = { bindingRevisionId: revision.id, expectedRevision: revision.revision, installationKey: revision.installationKey,
    attributeCode: input.attributeCode, amberGroup: input.amberGroup, questionKey: input.questionKey,
    valueId: String(input.valueId), label: label(value.label) };
  if (input.englishLabel !== undefined) {
    if (input.englishAuthoritative !== true) fail('MAGENTO_OPTION_EN_AUTHORITY_REQUIRED');
    result.englishLabel = label(input.englishLabel);
  } else if (input.englishAuthoritative !== undefined) c.invalid();
  return result;
}
async function observe(config, code, english, options) {
  const fetchImpl = boundedGet(options.fetchImpl, { maxRequests: 6 });
  const client = createMagentoClient(config, { fetchImpl });
  const capability = characterize(await client.getProductAttribute(code));
  if (capability.attribute.attribute_code !== code) c.invalid();
  const before = normalizeOptions(await client.getProductAttributeOptions(code));
  const result = { ...capability, before };
  if (english) {
    const views = await client.getStoreViews();
    const en = views.filter((v) => v.code === 'en' && v.is_active === true && Number.isSafeInteger(v.id) && v.id > 0);
    if (en.length !== 1) fail('MAGENTO_OPTION_EN_SCOPE_UNRESOLVED');
    result.englishStoreId = en[0].id;
    result.englishBefore = normalizeOptions(await createMagentoClient(config, { fetchImpl, storeCode: 'en' }).getProductAttributeOptions(code));
  }
  return result;
}
async function inspect(config, input, options = {}) {
  const t = await target(config, input, options); const observed = await observe(config, t.attributeCode, !!t.englishLabel, options);
  const candidates = observed.before.filter((o) => o.label.normalize('NFC') === t.label.normalize('NFC'));
  return { target: t, ...observed, candidates, warning: 'REST не доводить відсутність swatch. Administrator має перевірити поточний тип вручну; підтвердження діє лише для цієї дії протягом 10 хвилин.' };
}
async function attest(config, input, options = {}) {
  c.command(input, [...TARGET_FIELDS,'metadataFingerprint','confirmOrdinary','confirmHiddenLimit','evidence'], ['englishLabel','englishAuthoritative']);
  if (input.confirmOrdinary !== true || input.confirmHiddenLimit !== true || typeof input.evidence !== 'string'
    || input.evidence.trim().length < 3 || input.evidence.length > 2000) c.invalid();
  const { metadataFingerprint, evidence } = input;
  const command = Object.fromEntries([...TARGET_FIELDS,'englishLabel','englishAuthoritative'].filter((k) => Object.hasOwn(input,k)).map((k) => [k,input[k]]));
  const checked = await inspect(config, command, options);
  if (checked.metadataFingerprint !== metadataFingerprint) fail('MAGENTO_OPTION_ATTESTATION_STALE');
  if (checked.candidates.length) fail('MAGENTO_OPTION_ALREADY_EXISTS', 'Значення вже існує: підтвердьте зв’язок окремо, не створюйте дублікат.');
  const context = createMutationContext(options.mutationContext);
  return runAccessAdminMutation({ databasePool: options.databasePool || pool, actorUserId: context.actorUserId,
    requiredPermission: 'export_templates.publish', createError: c.error, operation: async (client) => {
      await assertAdministrator(client, context.actorUserId);
      const row = (await client.query(`INSERT INTO magento_option_capability_attestations
        (id,origin_hash,installation_key,attribute_id,attribute_code,metadata_fingerprint,target_hash,target,actor_user_id,evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id,expires_at`,
      [randomUUID(),c.originHash(config.baseUrl),checked.target.installationKey,checked.attribute.attribute_id,
        checked.target.attributeCode,metadataFingerprint,c.hash(checked.target),JSON.stringify(c.safeData(checked.target)),context.actorUserId,evidence.trim()])).rows[0];
      await writeAuditEvent(client, { mutationContext: context, eventKey: 'magento_option.capability_attested',
        subjectType: 'magento_option_attestation', subjectId: row.id, details: { attributeCode: checked.target.attributeCode, metadataFingerprint, scope: 'single_action' } });
      return { id: row.id, expiresAt: row.expires_at };
    } });
}
async function checkedAttestation(client, config, preview, actor) {
  const row = (await client.query('SELECT *,expires_at>clock_timestamp() AS fresh FROM magento_option_capability_attestations WHERE id=$1', [c.identity(preview.attestationId)])).rows[0];
  await assertAdministrator(client, actor);
  await amberSource(client,preview.target,preview.target.label,true);
  if (!row || !row.fresh || Number(row.actor_user_id) !== actor || row.origin_hash !== c.originHash(config.baseUrl)
    || row.installation_key !== preview.target.installationKey || row.metadata_fingerprint !== preview.metadataFingerprint
    || row.attribute_id !== String(preview.attributeId) || row.attribute_code !== preview.target.attributeCode
    || row.target_hash !== c.hash(preview.target)) fail('MAGENTO_OPTION_ATTESTATION_STALE');
  return row;
}
async function preview(config, input, options = {}) {
  c.command(input, [...TARGET_FIELDS,'attestationId'], ['englishLabel','englishAuthoritative']);
  const { attestationId, ...command } = input; const checked = await inspect(config, command, options);
  if (checked.candidates.length) fail('MAGENTO_OPTION_ALREADY_EXISTS');
  const result = { kind: 'option', bindingRevisionId: checked.target.bindingRevisionId, expectedRevision: checked.target.expectedRevision,
    target: checked.target, origin: config.baseUrl, attestationId: c.identity(attestationId), attributeId: checked.attribute.attribute_id,
    metadataFingerprint: checked.metadataFingerprint, before: checked.before,
    resource: { attributeId: checked.attribute.attribute_id, attributeCode: checked.target.attributeCode, label: checked.target.label.normalize('NFC') },
    label: checked.target.label, body: { option: { label: checked.target.label, sort_order: 0, is_default: false } } };
  if (checked.target.englishLabel) {
    result.englishStoreId = checked.englishStoreId; result.englishBefore = checked.englishBefore;
    result.body.option.store_labels = [{ store_id: 0, label: checked.target.label }, { store_id: checked.englishStoreId, label: checked.target.englishLabel }];
  }
  await checkedAttestation(options.databasePool || pool, config, result, createMutationContext(options.mutationContext).actorUserId);
  return { ...result, previewToken: c.hash(result) };
}
function verifyOption(intent, id, raw) {
  const rows = normalizeOptions(raw); const found = rows.filter((o) => o.label.normalize('NFC') === intent.label.normalize('NFC'));
  if (!/^[1-9][0-9]*$/.test(id) || intent.before.some((o) => o.value === id) || found.length !== 1
    || found[0].value !== id || found[0].label !== intent.label
    || intent.before.some((old) => !rows.some((o) => o.value === old.value && o.label === old.label))) fail('MAGENTO_OPTION_VERIFICATION_FAILED');
  return true;
}
async function reconcile(config, input, options = {}) {
  c.command(input, ['actionId']); const row = await actions.get(config, input.actionId, options);
  if (row.kind !== 'option') c.invalid(); if (row.state === 'verified') return actions.receipt(row);
  if (row.state !== 'returned') fail('MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED');
  const t = row.intent.target; const observed = await observe(config,t.attributeCode,!!t.englishLabel,options);
  if (observed.metadataFingerprint !== row.intent.metadataFingerprint) fail('MAGENTO_OPTION_METADATA_DRIFT');
  verifyOption(row.intent,row.remote_id,observed.before);
  if (t.englishLabel) {
    if (observed.englishStoreId !== row.intent.englishStoreId) fail('MAGENTO_OPTION_EN_SCOPE_UNRESOLVED');
    verifyOption({ before: row.intent.englishBefore, label: t.englishLabel },row.remote_id,observed.englishBefore);
  }
  return actions.receipt(await actions.transition(row.id,'returned','verified',{ remoteId: row.remote_id,
    attributeId: row.intent.attributeId, attributeCode: t.attributeCode, label: t.label,
    metadataFingerprint: observed.metadataFingerprint, optionsHash: c.hash(observed.before) }, options));
}
async function apply(config, input, options = {}) {
  c.command(input,[...TARGET_FIELDS,'attestationId','previewToken'],['englishLabel','englishAuthoritative']);
  const { previewToken, ...command } = input;
  const reviewed = await preview(config,command,options);
  if (reviewed.previewToken !== previewToken) fail('MAGENTO_CONFIGURATION_PREVIEW_STALE');
  const row = await actions.seal(config,reviewed,options);
  const fresh = await preview(config,command,options);
  if (fresh.previewToken !== previewToken) fail('MAGENTO_CONFIGURATION_PREVIEW_STALE');
  await actions.transition(row.id,'sealed','dispatched',{},options);
  const url = `${config.baseUrl}/rest/all/V1/products/attributes/${reviewed.target.attributeCode}/options`;
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(url,{ method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),
      headers:{ Accept:'application/json','Content-Type':'application/json',Authorization:signOptionCreateRequest(url,config) },body:JSON.stringify(reviewed.body) });
    try {
      if (!response.ok) fail('MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED');
      const id = await readJson(response);
      if (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) fail('MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED');
      await actions.transition(row.id,'dispatched','returned',{remoteId:id},options);
    } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  } catch { throw c.error(409,'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED','Amber надіслав зміну, але не підтвердив результат. Повторне надсилання недоступне.',{actionId:row.id}); }
  return reconcile(config,{actionId:row.id},options);
}
module.exports = { characterize, verifyOption, inspect, attest, preview, apply, reconcile, checkedAttestation };
