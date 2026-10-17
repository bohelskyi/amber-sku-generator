// Reviewed disposition of one retained legacy export file (migration 082).
// Evidence is a fresh GET-only Magento readback: every product of the stored
// CSV exists in this origin and was created there inside the file's import
// window. Recording it permits first-sync history admission to treat that
// file's membership as resolved; it changes no snapshot, product or delivery.
const c = require('./binding-contract');
const repair = require('../export-exposure/repair-loader');
const { buildHistoricalIndex } = require('../export-exposure/historical-index');
const { writeAuditEvent } = require('../../audit/audit-events');

const FORMAT = 'retained-export-disposition-v1';
const DISPOSITION = 'consumed_and_reconciled';
const BASIS = 'magento_readback_v1';
const EVENT = 'export.retained_disposition_recorded';
const MAX_MEMBERS = 1000;
// Magento creation may precede the stored generation time only by clock or
// time-zone skew, and an import is expected within days of generation.
const WINDOW_BEFORE_MS = 24 * 3600 * 1000;
const WINDOW_AFTER_MS = 7 * 24 * 3600 * 1000;
const fail = (status, code, message) => { throw c.error(status, code, message || code); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validSnapshotId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) {
    fail(422, 'RETAINED_DISPOSITION_INPUT_INVALID');
  }
  return id;
}

// Local, read-only view of the retained file inside the caller's transaction.
async function inspectOnClient(client, snapshotId) {
  const input = await repair.readRepairInput(client), retained = buildHistoricalIndex(input);
  const snapshot = input.snapshots.find(s => s.id === snapshotId);
  if (!snapshot) fail(404, 'RETAINED_DISPOSITION_SNAPSHOT_NOT_FOUND');
  if (snapshot.full_product_lifecycle_version != null) fail(409, 'RETAINED_DISPOSITION_LEGACY_FILE_REQUIRED');
  if (retained.diagnostics.length) fail(409, 'RETAINED_DISPOSITION_FILES_UNRESOLVED');
  const entry = retained.snapshots.find(s => s.snapshotId === snapshotId);
  if (!entry || !entry.memberIds.length || entry.memberIds.length > MAX_MEMBERS) fail(409, 'RETAINED_DISPOSITION_MEMBERS_UNSUPPORTED');
  const products = new Map(input.products.map(p => [Number(p.id), p]));
  const members = entry.memberIds.map(productId => ({ productId, sku: products.get(productId).full_sku }));
  const generatedAt = new Date(snapshot.generated_at);
  if (Number.isNaN(generatedAt.getTime())) fail(409, 'RETAINED_DISPOSITION_SNAPSHOT_INVALID');
  return { snapshotId, fileName: snapshot.file_name, generatedAt: generatedAt.toISOString(),
    csvSha256: entry.evidence.snapshot.csvSha256, members };
}

async function inspect(pool, snapshotId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const local = await inspectOnClient(client, snapshotId);
    const prior = (await client.query('SELECT evidence_hash FROM retained_export_dispositions WHERE snapshot_id=$1', [snapshotId])).rows[0];
    await client.query('COMMIT');
    return { local, priorEvidenceHash: prior?.evidence_hash || null };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

function getOnly(fetchImpl) {
  return (url, init = {}) => {
    const method = init.method || (typeof url === 'object' && url?.method) || 'GET';
    if (typeof method !== 'string' || method.toUpperCase() !== 'GET' || init.body != null) fail(500, 'RETAINED_DISPOSITION_REMOTE_WRITE_DENIED');
    return fetchImpl(url, init);
  };
}

async function readback(config, members, fetchImpl) {
  const { createMagentoClient } = require('./client');
  const client = createMagentoClient(config, { fetchImpl: getOnly(fetchImpl) });
  const readings = [];
  for (const member of members) {
    try {
      const item = await client.findProductBySku(member.sku);
      readings.push({ ...member, remoteId: item.id, createdAt: typeof item.created_at === 'string' ? item.created_at : null });
    } catch (error) {
      const code = error?.code === 'MAGENTO_PRODUCT_NOT_FOUND' ? 'MAGENTO_PRODUCT_MISSING'
        : error?.code === 'MAGENTO_PRODUCT_AMBIGUOUS' ? 'MAGENTO_PRODUCT_AMBIGUOUS' : 'MAGENTO_READ_FAILED';
      readings.push({ ...member, code });
    }
  }
  return readings;
}

// Magento REST reports created_at as UTC "YYYY-MM-DD HH:MM:SS".
function remoteTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const time = Date.parse(value.replace(' ', 'T') + 'Z');
  return Number.isNaN(time) ? null : time;
}

function assess(local, readings, originHash) {
  const generated = Date.parse(local.generatedAt);
  const from = generated - WINDOW_BEFORE_MS, to = generated + WINDOW_AFTER_MS;
  const blockers = [];
  for (const reading of readings) {
    if (reading.code) { blockers.push({ sku: reading.sku, code: reading.code }); continue; }
    const time = remoteTime(reading.createdAt);
    if (!Number.isSafeInteger(reading.remoteId) || reading.remoteId <= 0 || time === null) blockers.push({ sku: reading.sku, code: 'MAGENTO_CREATED_AT_INVALID' });
    else if (time < from || time > to) blockers.push({ sku: reading.sku, code: 'MAGENTO_CREATED_OUTSIDE_IMPORT_WINDOW', createdAt: reading.createdAt });
  }
  const evidence = { format: FORMAT, basis: BASIS, snapshotId: local.snapshotId, fileName: local.fileName,
    generatedAt: local.generatedAt, csvSha256: local.csvSha256, originHash,
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    members: [...readings].sort((a, b) => a.productId - b.productId)
      .map(r => ({ productId: r.productId, sku: r.sku, remoteId: r.remoteId ?? null, createdAt: r.createdAt ?? null })) };
  const created = readings.map(r => r.createdAt).filter(Boolean).sort();
  return { evidence, evidenceHash: c.hash(evidence), blockers,
    summary: { members: readings.length, createdFrom: created[0] || null, createdTo: created.at(-1) || null } };
}

async function preview(config, { snapshotId }, { databasePool, fetchImpl = globalThis.fetch } = {}) {
  validSnapshotId(snapshotId);
  const { local, priorEvidenceHash } = await inspect(databasePool, snapshotId);
  const result = assess(local, await readback(config, local.members, fetchImpl), c.originHash(config.baseUrl));
  return { snapshotId, fileName: local.fileName, generatedAt: local.generatedAt, ...result.summary,
    blockers: result.blockers, alreadyRecorded: priorEvidenceHash !== null,
    ...(result.blockers.length ? {} : { previewToken: result.evidenceHash }) };
}

async function apply(config, { snapshotId, previewToken, reason }, { databasePool, actorUserId, fetchImpl = globalThis.fetch } = {}) {
  validSnapshotId(snapshotId);
  if (!hex(previewToken) || typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 1000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) fail(422, 'RETAINED_DISPOSITION_INPUT_INVALID');
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) fail(422, 'RETAINED_DISPOSITION_ACTOR_REQUIRED');
  const originHash = c.originHash(config.baseUrl);
  // Magento is read before the transaction; the local file and token are rechecked inside it.
  const { local: observed } = await inspect(databasePool, snapshotId);
  const readings = await readback(config, observed.members, fetchImpl);
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    const actor = (await client.query(`SELECT 1 FROM application_users u JOIN user_role_assignments a ON a.application_user_id=u.id
      JOIN roles r ON r.id=a.role_id WHERE u.id=$1 AND u.status='active' AND a.revoked_at IS NULL
      AND r.role_key='administrator' AND r.status='active'`, [actorUserId])).rowCount;
    if (!actor) fail(403, 'RETAINED_DISPOSITION_ADMINISTRATOR_REQUIRED');
    await client.query('SELECT id FROM export_snapshots WHERE id=$1 FOR KEY SHARE', [snapshotId]);
    const prior = (await client.query('SELECT evidence_hash,audit_event_id::text FROM retained_export_dispositions WHERE snapshot_id=$1 FOR UPDATE',
      [snapshotId])).rows[0];
    if (prior) {
      if (prior.evidence_hash !== previewToken) fail(409, 'RETAINED_DISPOSITION_ALREADY_RECORDED');
      await client.query('COMMIT');
      return { snapshotId, auditEventId: prior.audit_event_id, alreadyApplied: true };
    }
    const local = await inspectOnClient(client, snapshotId);
    if (c.hash(local.members) !== c.hash(observed.members)) fail(409, 'RETAINED_DISPOSITION_CHANGED');
    const result = assess(local, readings, originHash);
    if (result.blockers.length) fail(409, 'RETAINED_DISPOSITION_EVIDENCE_INCOMPLETE');
    if (result.evidenceHash !== previewToken) fail(409, 'RETAINED_DISPOSITION_CHANGED');
    const event = await writeAuditEvent(client, { mutationContext: { actorUserId }, eventKey: EVENT,
      subjectType: 'export_snapshot', subjectId: snapshotId,
      details: { disposition: DISPOSITION, basis: BASIS, csvSha256: local.csvSha256, originHash,
        evidenceHash: result.evidenceHash, members: result.summary.members, reason: reason.trim() } });
    await client.query(`INSERT INTO retained_export_dispositions(snapshot_id,disposition,basis,csv_sha256,origin_hash,
      evidence,evidence_hash,reason,actor_user_id,audit_event_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
    [snapshotId, DISPOSITION, BASIS, local.csvSha256, originHash, JSON.stringify(result.evidence), result.evidenceHash,
      reason.trim(), actorUserId, event.id]);
    await client.query('COMMIT');
    return { snapshotId, auditEventId: String(event.id), alreadyApplied: false };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

// Snapshots of this origin whose recorded disposition still matches the stored bytes.
async function resolvedSnapshotsOnClient(client, retained, originHash) {
  const rows = (await client.query(`SELECT snapshot_id,csv_sha256,evidence_hash,audit_event_id::text
    FROM retained_export_dispositions WHERE origin_hash=$1 ORDER BY snapshot_id`, [originHash])).rows;
  return rows.filter(row => retained.snapshots.some(s => s.snapshotId === row.snapshot_id
    && s.evidence.snapshot.csvSha256 === row.csv_sha256))
    .map(row => ({ snapshotId: row.snapshot_id, csvSha256: row.csv_sha256, evidenceHash: row.evidence_hash, auditEventId: row.audit_event_id }));
}

module.exports = { preview, apply, assess, remoteTime, resolvedSnapshotsOnClient, FORMAT, DISPOSITION, BASIS, EVENT };
