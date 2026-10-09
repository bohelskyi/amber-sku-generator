// Internal ledger only: caller owns authorization, lifecycle/product locks,
// BEGIN/COMMIT/ROLLBACK and authoritative readback/planner validation.
// No pool, network, startup enrollment, outward gate or product/history writes.
const { randomUUID } = require('node:crypto');
const { hash } = require('./binding-contract');
const { writeAuditEvent } = require('../../audit/audit-events');

const TERMINAL = new Set(['imported', 'equal', 'optional_empty', 'outward_verified', 'name_received']);
const STATES = new Set([...TERMINAL, 'conflict', 'unknown', 'pending_outward_confirmation', 'review_required']);
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MAX_BYTES = 1024 * 1024;
const fail = (suffix, statusCode = 409) => {
  throw Object.assign(new Error('First-sync ledger ' + suffix.toLowerCase()), { code: 'FIRST_SYNC_LEDGER_' + suffix, statusCode });
};
function plain(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail('INPUT', 422);
}
function data(value) {
  let nodes = 0;
  const walk = (v, depth) => {
    if (++nodes > 50000 || depth > 24) fail('INPUT', 422);
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') { if (v.length > MAX_BYTES || /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)) fail('INPUT', 422); return; }
    if (typeof v === 'number') { if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) fail('INPUT', 422); return; }
    if (!v || typeof v !== 'object' || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)) fail('INPUT', 422);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Array.isArray(v) && (Object.keys(v).length !== v.length || v.length > 5000)) fail('INPUT', 422);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (Array.isArray(v) && key === 'length') continue;
      const d = descriptors[key];
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
        || !Object.hasOwn(d, 'value') || !d.enumerable
        || Array.isArray(v) && !/^(0|[1-9]\d*)$/.test(key)) fail('INPUT', 422);
      walk(key, depth + 1); walk(d.value, depth + 1);
    }
  };
  walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail('INPUT', 422);
  return value;
}
function counter(value, zero = false) {
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9]\d{0,18})$/ : /^[1-9]\d{0,18}$/).test(value)
    || BigInt(value) > 9223372036854775806n) fail('INPUT', 422);
  return value;
}
function keyInput(key) {
  data(key); plain(key, ['originHash', 'publicIdentityId']);
  if (!HEX.test(key.originHash) || typeof key.originHash !== 'string') fail('INPUT', 422);
  counter(key.publicIdentityId); return key;
}
const fieldKey = field => field.target + '\u0000' + field.scope;
function scopeInput(field) {
  if (typeof field.target !== 'string' || !LABEL.test(field.target)
    || typeof field.scope !== 'string' || !LABEL.test(field.scope)) fail('INPUT', 422);
}
function validate(input) {
  // Strip only the explicitly allowed callback before traversing all data.
  plain(input, ['key', 'identity', 'expectedRevision', 'previewHash', 'fields', 'actorUserId'],
    ['applyLocal', 'complete', 'requiredScopes', 'readyForOutbound']);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const d of Object.values(descriptors)) if (!Object.hasOwn(d, 'value')) fail('INPUT', 422);
  if (input.applyLocal !== undefined && typeof input.applyLocal !== 'function') fail('INPUT', 422);
  const raw = { ...input }; delete raw.applyLocal;
  data(raw);
  const command = JSON.parse(JSON.stringify(raw)); keyInput(command.key);
  plain(command.identity, ['installationKey', 'publicSku', 'remoteProductId', 'contractVersion', 'initialProductId', 'initialBindingRevisionId']);
  const i = command.identity;
  if (typeof i.installationKey !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(i.installationKey)
    || typeof i.publicSku !== 'string' || !i.publicSku.length || i.publicSku.length > 255 || i.publicSku.trim() !== i.publicSku || /[\u0000-\u001f\u007f]/.test(i.publicSku)
    || typeof i.contractVersion !== 'string' || !LABEL.test(i.contractVersion)
    || !Number.isSafeInteger(i.initialProductId) || i.initialProductId <= 0
    || typeof i.initialBindingRevisionId !== 'string' || !UUID.test(i.initialBindingRevisionId)) fail('INPUT', 422);
  counter(i.remoteProductId); counter(command.expectedRevision, true);
  if (typeof command.previewHash !== 'string' || !HEX.test(command.previewHash)
    || !Number.isSafeInteger(command.actorUserId) || command.actorUserId <= 0
    || !Array.isArray(command.fields) || command.fields.length > 500
    || command.complete !== undefined && typeof command.complete !== 'boolean'
    || command.readyForOutbound !== undefined && typeof command.readyForOutbound !== 'boolean') fail('INPUT', 422);
  const seen = new Set();
  for (const field of command.fields) {
    plain(field, ['target', 'scope', 'state', 'before', 'remote', 'after', 'source', 'mappingHash']);
    scopeInput(field);
    if (!STATES.has(field.state) || typeof field.mappingHash !== 'string' || !HEX.test(field.mappingHash)
      || !field.source || Object.getPrototypeOf(field.source) !== Object.prototype || !Object.keys(field.source).length
      || seen.has(fieldKey(field))) fail('INPUT', 422);
    const provenance = field.source;
    if (typeof provenance.kind !== 'string' || !LABEL.test(provenance.kind)
      || Object.hasOwn(provenance, 'key') === Object.hasOwn(provenance, 'field')
      || typeof (provenance.key ?? provenance.field) !== 'string' || !LABEL.test(provenance.key ?? provenance.field)
      || !Number.isSafeInteger(provenance.productId) || provenance.productId <= 0
      || typeof provenance.bindingRevisionId !== 'string' || !UUID.test(provenance.bindingRevisionId)
      || typeof provenance.definitionHash !== 'string' || !HEX.test(provenance.definitionHash)
      || typeof provenance.routeKey !== 'string' || !provenance.routeKey.length || provenance.routeKey.length > 512
      || provenance.routeKey.trim() !== provenance.routeKey || /[\u0000-\u001f\u007f]/.test(provenance.routeKey)) fail('INPUT', 422);
    seen.add(fieldKey(field));
  }
  command.complete = command.complete === true;
  command.requiredScopes = command.requiredScopes || [];
  if (!Array.isArray(command.requiredScopes) || command.requiredScopes.length > 500
    || command.complete && !command.requiredScopes.length || !command.fields.length && !command.complete) fail('INPUT', 422);
  const required = new Set();
  for (const scope of command.requiredScopes) {
    plain(scope, ['target', 'scope']); scopeInput(scope);
    if (required.has(fieldKey(scope))) fail('INPUT', 422);
    required.add(fieldKey(scope));
  }
  command.fields.sort((a, b) => fieldKey(a).localeCompare(fieldKey(b), 'en'));
  command.requiredScopes.sort((a, b) => fieldKey(a).localeCompare(fieldKey(b), 'en'));
  // No aliases to caller-owned objects may change evidence while waiting on locks.
  return JSON.parse(JSON.stringify(command));
}
async function transactionId(client) {
  if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') fail('TRANSACTION_REQUIRED');
  return (await client.query('SELECT txid_current()::text id')).rows[0].id;
}
async function readOnClient(client, key) {
  keyInput(key);
  const session = (await client.query(`SELECT * FROM magento_first_sync_sessions
    WHERE origin_hash=$1 AND public_product_identity_id=$2`, [key.originHash, key.publicIdentityId])).rows[0];
  if (!session) return null;
  const fields = (await client.query(`SELECT DISTINCT ON (target,scope) target,scope,state,evidence,revision,recorded_at
    FROM magento_first_sync_fields WHERE session_id=$1 AND revision<=$2 ORDER BY target,scope,revision DESC`, [session.id, session.revision])).rows;
  return { session, fields: fields.map(row => ({ ...row.evidence, revision: row.revision, recordedAt: row.recorded_at })) };
}
async function recordProgressOnClient(client, input) {
  const command = validate(input), commandHash = hash(command);
  const tx = await transactionId(client);
  if (await transactionId(client) !== tx) fail('TRANSACTION_REQUIRED');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
    ['amber_magento_first_sync:' + command.key.originHash + ':' + command.key.publicIdentityId]);
  const current = await readOnClient(client, command.key);
  if (current) await client.query('SELECT id FROM magento_first_sync_sessions WHERE id=$1 FOR UPDATE', [current.session.id]);
  if (current) {
    const s = current.session, i = command.identity;
    if (s.installation_key !== i.installationKey || s.public_sku !== i.publicSku || s.remote_product_id !== i.remoteProductId
      || s.initial_product_id !== i.initialProductId || s.initial_binding_revision_id !== i.initialBindingRevisionId) fail('IDENTITY');
    const prior = (await client.query('SELECT command_hash,result FROM magento_first_sync_progress WHERE session_id=$1 AND preview_hash=$2',
      [s.id, command.previewHash])).rows[0];
    if (prior) {
      if (prior.command_hash !== commandHash) fail('RECEIPT_CONFLICT');
      return { ...prior.result, alreadyApplied: true };
    }
    if (s.completed_at) fail('COMPLETED');
  }
  if ((current?.session.revision || '0') !== command.expectedRevision) fail('STALE');
  const latest = new Map((current?.fields || []).map(field => [fieldKey(field), field]));
  const changed = [];
  for (const field of command.fields) {
    const previous = latest.get(fieldKey(field));
    if (previous && TERMINAL.has(previous.state)) {
      const evidence = { ...previous }; delete evidence.revision; delete evidence.recordedAt;
      if (hash(evidence) !== hash(field)) fail('TERMINAL');
      continue;
    }
    changed.push(field); latest.set(fieldKey(field), field);
  }
  if (latest.size > 500) fail('INPUT', 422);
  if (command.complete && ([...latest.values()].some(field => !TERMINAL.has(field.state))
    || command.requiredScopes.some(scope => !TERMINAL.has(latest.get(fieldKey(scope))?.state)))) fail('INCOMPLETE');
  const id = current?.session.id || randomUUID(), next = String(BigInt(command.expectedRevision) + 1n);
  if (!current) {
    await client.query(`INSERT INTO magento_first_sync_sessions
      (id,origin_hash,public_product_identity_id,installation_key,public_sku,remote_product_id,initial_product_id,initial_binding_revision_id,initial_contract_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, command.key.originHash, command.key.publicIdentityId, command.identity.installationKey,
      command.identity.publicSku, command.identity.remoteProductId, command.identity.initialProductId,
      command.identity.initialBindingRevisionId, command.identity.contractVersion]);
  }
  // Only new import/name-receipt transitions can authorize a local patch.
  // Existing terminal receipts, equal fields and unresolved/outward-only evidence
  // must never restore old local values after an ordinary manager edit.
  // The callback owns no transaction or remote I/O and receives detached evidence.
  const acceptedFields = changed.filter(field => ['imported', 'name_received'].includes(field.state));
  if (input.applyLocal && acceptedFields.length) await input.applyLocal(client, JSON.parse(JSON.stringify(acceptedFields)));
  if (await transactionId(client) !== tx) fail('TRANSACTION_REQUIRED');
  const result = { sessionId: id, revision: next, completed: command.complete,
    ...(command.readyForOutbound !== undefined ? { readyForOutbound: command.readyForOutbound } : {}),
    changedFields: changed.map(({ target, scope, state }) => ({ target, scope, state })),
    terminalScopes: [...latest.values()].filter(field => TERMINAL.has(field.state)).map(({ target, scope, state }) => ({ target, scope, state })),
    alreadyApplied: false };
  const audit = await writeAuditEvent(client, { mutationContext: { actorUserId: command.actorUserId },
    eventKey: 'magento.first_sync_progress_recorded', subjectType: 'magento_first_sync', subjectId: id,
    details: { revision: next, previewHash: command.previewHash, commandHash, result } });
  await client.query(`INSERT INTO magento_first_sync_progress
    (session_id,revision,preview_hash,command_hash,command,result,actor_user_id,audit_event_id,completed,transaction_id)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,txid_current())`,
  [id, next, command.previewHash, commandHash, JSON.stringify(command), JSON.stringify(result), command.actorUserId, audit.id, command.complete]);
  for (const field of changed) await client.query(`INSERT INTO magento_first_sync_fields
    (session_id,revision,target,scope,state,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
  [id, next, field.target, field.scope, field.state, JSON.stringify(field)]);
  const updated = await client.query(`UPDATE magento_first_sync_sessions SET revision=$2,
    completed_at=CASE WHEN $3 THEN (SELECT recorded_at FROM magento_first_sync_progress WHERE session_id=$1 AND revision=$2) ELSE NULL END
    WHERE id=$1 AND revision=$4 RETURNING id`,
  [id, next, command.complete, command.expectedRevision]);
  if (!updated.rowCount) fail('STALE');
  return result;
}
module.exports = { readOnClient, recordProgressOnClient };
