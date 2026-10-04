const { digest } = require('../export-exposure/repair-manifest');
const { BATCH_SIZE } = require('../full-product-cutover.service');

const FORMAT = 'amber-full-product-cutover-v1';
const hashPattern = /^[a-f0-9]{64}$/;

function approvedManifest(event, hash, database) {
  const { contentSha256, ...body } = event?.details?.manifest || {};
  return body.format === FORMAT && body.kind === 'cutover' && body.database === database
    && body.policy?.batchSize === BATCH_SIZE && Array.isArray(body.entries)
    && body.entries.every(e => e && Number.isSafeInteger(e.productId) && ['preserve','hold','legacy_baseline','first_delivery'].includes(e.action))
    && contentSha256 === hash && digest(body) === hash ? body : null;
}
function matchesBaseline(member, entry) {
  const { product: p, lifecycle: f } = member, before = entry?.before, after = entry?.after;
  return entry?.productId === p.id && entry.sku === p.full_sku && entry.action === 'hold'
    && before?.evidence?.origin === 'migration_039' && before.evidence.coverage === 'unresolved_historical'
    && before.revision === '1' && before.confirmed_revision === '0' && before.source_correction_id === null
    && before.evidence.independentExclusion !== true && before.evidence.exclusionProvenance !== 'independent_exclusion'
    && before.business_exclusion_state === 'unknown' && before.recount_compatibility_excluded === false
    && after?.route === 'hold' && after.source_correction_id === null
    && after.business_exclusion_state === 'unknown' && after.recount_compatibility_excluded === false
    && after.evidence?.origin === 'cutover' && after.evidence.decision === 'hold'
    && f.source_correction_id === null && f.business_exclusion_state === 'unknown'
    && f.recount_compatibility_excluded === false && digest(f.evidence) === digest(after.evidence);
}

// Read immutable canonical approval AND application receipts. An origin label or
// a matching manifest alone never proves that cutover applied this baseline.
// Retiring the source later may change its route/counters, not its provenance.
async function read(client, members) {
  const result = new Map();
  const candidates = members.filter(m => m.product.status === 'corrected' && m.lifecycle?.route === 'retired'
    && m.lifecycle.evidence?.origin === 'cutover' && hashPattern.test(m.lifecycle.repair_manifest_hash));
  if (!candidates.length || candidates.length > 30) return result;
  const gate = (await client.query('SELECT current_database() AS database,phase FROM full_product_export_activation WHERE singleton')).rows[0];
  if (gate?.phase !== 'active') return result;
  const hashes = [...new Set(candidates.map(m => m.lifecycle.repair_manifest_hash))];
  const approvals = (await client.query(`SELECT id,subject_id,details FROM audit_events
    WHERE event_key='full_product_cutover.approved' AND subject_type='cutover_manifest' AND subject_id=ANY($1::text[])
    ORDER BY id`, [hashes])).rows;
  const pending = [];
  for (const hash of hashes) {
    const events = approvals.filter(e => e.subject_id === hash);
    if (events.length !== 1) continue;
    const approval = events[0], manifest = approvedManifest(approval, hash, gate.database);
    if (!manifest) continue;
    const changed = manifest.entries.filter(e => e.action !== 'preserve');
    for (const member of candidates.filter(m => m.lifecycle.repair_manifest_hash === hash)) {
      const entries = manifest.entries.filter(e => e.productId === member.product.id);
      if (entries.length !== 1 || !matchesBaseline(member, entries[0])) continue;
      const entry = entries[0], batchNumber = Math.floor(changed.indexOf(entry) / BATCH_SIZE);
      const batch = changed.slice(batchNumber * BATCH_SIZE, (batchNumber + 1) * BATCH_SIZE);
      pending.push({ member, entry, approval, hash, batchNumber, batch, key: `${hash}:${batchNumber}` });
    }
  }
  if (!pending.length) return result;
  const receipts = (await client.query(`SELECT id,subject_id,details FROM audit_events
    WHERE event_key='full_product_cutover.batch_applied' AND subject_type='cutover_batch' AND subject_id=ANY($1::text[])
    ORDER BY id`, [[...new Set(pending.map(p => p.key))]])).rows;
  for (const p of pending) {
    const events = receipts.filter(e => e.subject_id === p.key);
    if (events.length !== 1) continue;
    const receipt = events[0], applied = receipt.details?.result;
    if (!/^[0-9]+$/.test(String(receipt.id)) || !/^[0-9]+$/.test(String(p.approval.id))
      || BigInt(receipt.id) <= BigInt(p.approval.id) || applied?.manifestHash !== p.hash || applied.batchNumber !== p.batchNumber || !Array.isArray(applied.productIds)
      || digest(applied.productIds) !== digest(p.batch.map(e => e.productId)) || receipt.details.beforeAfterHash !== digest(p.batch)) continue;
    result.set(p.member.product.id, { productId: p.member.product.id, manifestHash: p.hash,
      approvalEventId: String(p.approval.id), batchEventId: String(receipt.id), entryHash: digest(p.entry),
      evidenceHash: digest(p.member.lifecycle.evidence) });
  }
  return result;
}

function verified(member) {
  const proof = member.cutoverBaseline;
  return member.lifecycle?.evidence?.origin === 'cutover' && proof?.productId === member.product.id
    && proof.manifestHash === member.lifecycle.repair_manifest_hash && hashPattern.test(proof.manifestHash)
    && proof.evidenceHash === digest(member.lifecycle.evidence);
}
module.exports = { read, verified };
