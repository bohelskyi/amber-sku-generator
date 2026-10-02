const { randomUUID } = require('node:crypto');
const pool = require('../../db/pool');
const c = require('./binding-contract');
const { createMutationContext } = require('../../audit/mutation-context');
const { writeAuditEvent } = require('../../audit/audit-events');
const { runAccessAdminMutation, assertActorStillAuthorized } = require('../access-admin-transaction');
async function mutate(options, operation) {
  const context = createMutationContext(options.mutationContext);
  return runAccessAdminMutation({ databasePool: options.databasePool || pool, actorUserId: context.actorUserId,
    requiredPermission: 'export_templates.publish', createError: c.error,
    operation: async (client) => {
      await assertActorStillAuthorized(client, context.actorUserId, 'export_templates.manage', c.error);
      return operation(client, context);
    } });
}
async function seal(config, preview, options = {}) {
  return mutate(options, async (client, context) => {
    if (preview.kind === 'option_label') await require('./configuration-option-labels').checkedSource(client, config, preview, context.actorUserId);
    if (preview.kind === 'option') await require('./configuration-option').checkedAttestation(client, config, preview, context.actorUserId);
    const revision = (await client.query('SELECT state,revision FROM magento_binding_revisions WHERE id=$1 FOR UPDATE', [preview.bindingRevisionId])).rows[0];
    if (revision?.state !== (preview.kind === 'option_label' ? 'published' : 'draft') || revision.revision !== preview.expectedRevision) {
      throw c.error(409, 'MAGENTO_BINDING_CONFLICT', 'Draft changed after preview');
    }
    const resourceKey = c.hash(preview.resource); const origin = c.originHash(config.baseUrl);
    const prior = (await client.query("SELECT * FROM magento_configuration_actions WHERE origin_hash=$1 AND kind=$2 AND resource_key=$3 AND state<>'superseded' AND (kind<>'option_label' OR state<>'verified') FOR UPDATE",
    [origin, preview.kind, resourceKey])).rows[0];
    if (prior) {
      if (prior.state === 'sealed' && prior.preview_hash === preview.previewToken) return prior;
      if (prior.state !== 'sealed') throw c.error(409, 'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED', 'Previous dispatched work cannot be resent', { actionId: prior.id, state: prior.state });
      await client.query("UPDATE magento_configuration_actions SET state='superseded' WHERE id=$1 AND state='sealed'", [prior.id]);
    }
    const row = (await client.query(`INSERT INTO magento_configuration_actions
      (id,kind,origin_hash,resource_key,binding_revision_id,binding_revision,actor_user_id,preview_hash,intent,attestation_id,supersedes_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *`,
    [randomUUID(), preview.kind, origin, resourceKey, preview.bindingRevisionId, preview.expectedRevision,
      context.actorUserId, preview.previewToken, JSON.stringify(c.safeData(preview)),preview.attestationId || null,prior?.id || null])).rows[0];
    await writeAuditEvent(client, { mutationContext: context, eventKey: 'magento_configuration.sealed',
      subjectType: 'magento_configuration_action', subjectId: row.id, details: { kind: row.kind, previewHash: row.preview_hash, supersedesId: row.supersedes_id } });
    return row;
  });
}
async function transition(id, from, to, input, options = {}) {
  c.identity(id);
  return mutate(options, async (client, context) => {
    const action = (await client.query('SELECT * FROM magento_configuration_actions WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!action || action.state !== from) throw c.error(409, 'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED', 'Action is no longer eligible for this transition');
    if (from === 'sealed') {
      if (action.kind === 'option_label') await require('./configuration-option-labels').checkedSource(client, {baseUrl:action.intent.origin}, action.intent, context.actorUserId);
      if (action.kind === 'option') await require('./configuration-option').checkedAttestation(client, { baseUrl: action.intent.origin }, action.intent, context.actorUserId);
      const revision = (await client.query('SELECT state,revision FROM magento_binding_revisions WHERE id=$1 FOR UPDATE', [action.binding_revision_id])).rows[0];
      if (revision?.state !== (action.kind === 'option_label' ? 'published' : 'draft') || revision.revision !== action.binding_revision) throw c.error(409, 'MAGENTO_BINDING_CONFLICT', 'Draft changed before dispatch');
    }
    let row;
    if (from === 'sealed' && to === 'dispatched') row = (await client.query("UPDATE magento_configuration_actions SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [id])).rows[0];
    else if (from === 'dispatched' && to === 'returned' && /^[1-9][0-9]*$/.test(input.remoteId) && Number.isSafeInteger(Number(input.remoteId))) {
      row = (await client.query("UPDATE magento_configuration_actions SET state='returned',remote_id=$2,returned_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [id, input.remoteId])).rows[0];
    } else if (from === 'returned' && to === 'verified') row = (await client.query("UPDATE magento_configuration_actions SET state='verified',verification=$2::jsonb,verified_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *", [id, JSON.stringify(c.safeData(input))])).rows[0];
    else c.invalid();
    await writeAuditEvent(client, { mutationContext: context, eventKey: `magento_configuration.${to}`,
      subjectType: 'magento_configuration_action', subjectId: id, details: { kind: action.kind, remoteId: row.remote_id } });
    return row;
  });
}
async function get(config, id, options = {}) {
  c.identity(id);
  const row = (await (options.databasePool || pool).query('SELECT * FROM magento_configuration_actions WHERE id=$1 AND origin_hash=$2', [id, c.originHash(config.baseUrl)])).rows[0];
  if (!row) throw c.error(404, 'MAGENTO_CONFIGURATION_NOT_FOUND', 'Configuration action not found'); return row;
}
function receipt(row) {
  return { id: row.id, kind: row.kind, state: row.state, remoteId: row.remote_id,
    path: row.intent.path ?? null,
    attributeCode: row.intent.target?.attributeCode ?? null, label: row.intent.label ?? null,
    createdAt: row.created_at, verifiedAt: row.verified_at, bound: false,
    canReconcile: row.state === 'returned' || (row.kind === 'option_label' && row.state === 'dispatched'), canReview: row.state === 'sealed', supersedesId: row.supersedes_id,
    message: row.state === 'verified' ? (row.kind === 'option_label' ? 'Назви перевірено; відповідність не змінено' : 'Створено, зв’язок ще не підтверджено')
      : row.state === 'sealed' ? 'Зміну підготовлено, але не надіслано. Повторіть перевірку перед створенням.'
        : row.state === 'superseded' ? 'Замінено новою перевіреною дією; цю дію не буде надіслано.'
          : 'Amber надіслав зміну. Підтвердження кінцевого стану ще немає; повторне надсилання недоступне.' };
}
async function list(config, options = {}) {
  if (!config.configured) return [];
  return (await (options.databasePool || pool).query(`SELECT * FROM magento_configuration_actions
    WHERE origin_hash=$1 ORDER BY created_at DESC,id LIMIT 100`, [c.originHash(config.baseUrl)])).rows.map(receipt);
}
module.exports = { seal, transition, get, receipt, list };
