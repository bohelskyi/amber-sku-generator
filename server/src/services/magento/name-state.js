const { randomUUID } = require('node:crypto');
const c = require('./binding-contract');
const { same, reconcileNames } = require('./name-reconciliation');
const { evaluate } = require('./binding-evidence-products');
const { writeAuditEvent } = require('../../audit/audit-events');
const automatic = require('./automatic-sync-boundary');

function intentNames(intent) {
  const core = intent?.operations?.find((o) => o.domain === 'coreProduct')?.payload?.product;
  return { ...(typeof core?.name === 'string' ? { all: core.name } : {}),
    ...(typeof intent?.englishValues?.name === 'string' ? { en: intent.englishValues.name } : {}) };
}
function nameStateEvidence(state) {
  if (!state) return null;
  return Object.fromEntries(['remote_product_id', 'baseline_names', 'observed_amber_names',
    'observed_remote_names', 'resolution', 'state', 'version'].filter((key) => key in state)
    .map((key) => [key, state[key]]));
}
async function readNameState(db, origin, identityId, { lock = false } = {}) {
  const state = (await db.query(`SELECT * FROM magento_name_sync_states
    WHERE origin_hash=$1 AND public_product_identity_id=$2${lock ? ' FOR SHARE' : ''}`, [origin, identityId])).rows[0];
  if (state) return state;
  return (await acknowledgedNameStates(db, origin, [identityId])).get(String(identityId)) || null;
}
// Share the single-product fallback with publication's bounded pages. Only a
// succeeded, acknowledged durable intent is confirmed common evidence; select
// the latest qualifying job before inspecting its names, never an older match.
async function acknowledgedNameStates(db, origin, identityIds) {
  const jobs = (await db.query(`SELECT DISTINCT ON (public_product_identity_id)
      public_product_identity_id,intent,remote_product_id FROM magento_sync_jobs
    WHERE origin_hash=$1 AND public_product_identity_id=ANY($2::bigint[]) AND state='succeeded'
      AND acknowledged_at IS NOT NULL AND remote_product_id IS NOT NULL
    ORDER BY public_product_identity_id,acknowledged_at DESC,created_at DESC`, [origin, identityIds])).rows;
  const states = new Map();
  for (const job of jobs) {
    const names = intentNames(job.intent);
    if (names.all) states.set(String(job.public_product_identity_id), {
      baseline_names: names, remote_product_id: job.remote_product_id, version: '0',
    });
  }
  return states;
}
async function readNameStates(db, origin, identityIds) {
  if (!identityIds.length) return [];
  const states = (await db.query(`SELECT * FROM magento_name_sync_states WHERE origin_hash=$1
    AND public_product_identity_id=ANY($2::bigint[]) ORDER BY public_product_identity_id`, [origin, identityIds])).rows;
  const present = new Set(states.map(s => String(s.public_product_identity_id)));
  const missing = identityIds.filter(id => !present.has(String(id)));
  if (!missing.length) return states;
  const confirmed = await acknowledgedNameStates(db, origin, missing);
  for (const id of missing) {
    const state = confirmed.get(String(id));
    if (state) states.push({ public_product_identity_id: id, ...state });
  }
  return states;
}
function namesFromObservation(observation) {
  const expected = evaluate(observation.amber, observation.amber.product);
  const amber = { ...(typeof expected.base.name === 'string' ? { all: expected.base.name } : {}),
    ...(typeof expected.english.name === 'string' ? { en: expected.english.name } : {}) };
  const remoteUa = observation.raw?.name;
  const remote = { ...(typeof remoteUa === 'string' ? { all: remoteUa } : {}),
    ...(typeof observation.domainEvidence?.english?.fields?.name === 'string'
      ? { en: observation.domainEvidence.english.fields.name } : {}) };
  return { amber, remote, generated: expected.generatedNames, ready: expected.ready };
}
function decisionFor(observation, { allowIncompleteAmber = false } = {}) {
  const names = namesFromObservation(observation);
  const state = observation.amber.nameState;
  if (!observation.raw) return { action: 'create', ...names };
  if (require('./native-identity-ownership').issue(observation.amber, observation.raw)) return { action: 'foreign_identity', ...names };
  if (state && Number(state.remote_product_id) !== Number(observation.raw.id)) {
    return { action: 'identity_changed', ...names };
  }
  if (allowIncompleteAmber && observation.amber.compiled.definition.nameReadiness === require('../export-templates/effective-product-names').POLICY
    && require('../export-templates/effective-product-names').validPair(names.remote)) {
    return { action: 'completion_review', ...names };
  }
  if (!names.amber.all || !names.remote.all || !same(Object.keys(names.amber).sort(), Object.keys(names.remote).sort())) {
    return { action: 'unavailable', ...names };
  }
  return { ...reconcileNames(state?.baseline_names, names.amber, names.remote, state?.resolution), ...names };
}
async function saveObservation(client, origin, product, remoteId, result, baseline, resolution = null) {
  return (await client.query(`INSERT INTO magento_name_sync_states
    (origin_hash,public_product_identity_id,remote_product_id,baseline_names,observed_amber_names,observed_remote_names,resolution,state)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8)
    ON CONFLICT(origin_hash,public_product_identity_id) DO UPDATE SET
      remote_product_id=EXCLUDED.remote_product_id,baseline_names=EXCLUDED.baseline_names,
      observed_amber_names=EXCLUDED.observed_amber_names,observed_remote_names=EXCLUDED.observed_remote_names,
      resolution=EXCLUDED.resolution,state=EXCLUDED.state,
      version=magento_name_sync_states.version+CASE WHEN
        ROW(magento_name_sync_states.remote_product_id,magento_name_sync_states.baseline_names,
          magento_name_sync_states.observed_amber_names,magento_name_sync_states.observed_remote_names,
          magento_name_sync_states.resolution,magento_name_sync_states.state)
        IS DISTINCT FROM ROW(EXCLUDED.remote_product_id,EXCLUDED.baseline_names,
          EXCLUDED.observed_amber_names,EXCLUDED.observed_remote_names,EXCLUDED.resolution,EXCLUDED.state)
        THEN 1 ELSE 0 END,observed_at=CURRENT_TIMESTAMP
    RETURNING *`, [origin, product.public_product_identity_id, remoteId, JSON.stringify(baseline),
    JSON.stringify(result.action === 'accept_external' ? result.remote : result.amber), JSON.stringify(result.remote), JSON.stringify(resolution),
    result.action === 'confirm' || result.action === 'accept_external' ? 'common'
      : result.action === 'send_amber' ? 'amber_changed' : result.action === 'baseline_required' ? 'baseline_required' : 'conflict'])).rows[0];
}
async function auditName(client, actorUserId, product, event, details) {
  await writeAuditEvent(client, { mutationContext: { actorUserId, requestId: `magento-name-${randomUUID()}` },
    eventKey: `product.magento_name_${event}`, subjectType: 'product', subjectId: String(product.id), details });
}
async function importRemote(client, actorUserId, product, result) {
  await client.query(`UPDATE products SET magento_name_override=$2::jsonb,magento_name_review_required=FALSE
    WHERE id=$1`, [product.id, JSON.stringify({ generated: result.generated, values: result.remote })]);
  const [lifecycle] = await require('../full-product-export.service').readFullProductStates(client, [Number(product.id)], { lock: true });
  await require('../full-product-export.service').advanceFullProductRevision(client, Number(product.id), lifecycle.revision);
  await auditName(client, actorUserId, product, 'external_accepted', { before: result.amber, after: result.remote });
}
async function reconcileObservation(config, observation, options) {
  const result = decisionFor(observation);
  if (['create', 'unavailable', 'identity_changed', 'foreign_identity'].includes(result.action)) return result;
  const client = await options.databasePool.connect();
  const product = observation.amber.product; const origin = c.originHash(config.baseUrl);
  try {
    await client.query('BEGIN');
    if (options.automatic) await automatic.assertEnabled(client, options);
    if (observation.amber.revision) {
      const currentBinding = (await client.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1
        AND state='published' ORDER BY version_number DESC LIMIT 1`, [observation.amber.revision.installationKey])).rows[0];
      if (currentBinding?.id !== observation.amber.revision.id) throw c.error(409, 'MAGENTO_SYNC_BINDING_CHANGED', 'Відповідності змінилися.');
    }
    const current = (await client.query('SELECT * FROM products WHERE id=$1 FOR NO KEY UPDATE', [product.id])).rows[0];
    if (!current || c.hash(current) !== c.hash(Object.fromEntries(Object.keys(current).map((key) => [key, product[key]])))) {
      throw c.error(409, 'MAGENTO_SYNC_AMBER_CHANGED', 'Товар змінився.');
    }
    if (options.automatic) await automatic.assertGeneration(client, options);
    const state = await readNameState(client, origin, product.public_product_identity_id);
    if (!same(nameStateEvidence(state), nameStateEvidence(observation.amber.nameState))) throw c.error(409, 'MAGENTO_SYNC_AMBER_CHANGED', 'Стан назви змінився.');
    if (result.action === 'accept_external') await importRemote(client, options.actorUserId, product, result);
    const baseline = ['confirm', 'accept_external'].includes(result.action) ? result.remote : state?.baseline_names ?? null;
    const saved = await saveObservation(client, origin, product, observation.raw.id, result, baseline,
      result.action === 'send_amber' ? state?.resolution ?? null : null);
    if (result.action === 'confirm' && ['conflict', 'baseline_required'].includes(state?.state)) {
      // A fresh equal observation resolves this name blocker. Re-evaluate all
      // ordinary obligations; never reset an unresolved dispatched mutation.
      await client.query(`UPDATE magento_product_sync_requests SET desired_generation=desired_generation+1,
        state='pending',reason_code=NULL,diagnostics='[]'::jsonb,next_attempt_at=CURRENT_TIMESTAMP
        WHERE public_product_identity_id=$1 AND state='needs_attention'
          AND reason_code IS DISTINCT FROM 'reconciliation_required'`, [product.public_product_identity_id]);
    }
    if (['conflict', 'baseline_required'].includes(result.action)) {
      await client.query(`UPDATE magento_product_sync_requests SET state='needs_attention',reason_code='data_or_binding'
        WHERE public_product_identity_id=$1 AND reason_code IS DISTINCT FROM 'reconciliation_required'`, [product.public_product_identity_id]);
    }
    await client.query('COMMIT');
    observation.amber.nameState = saved;
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
async function confirmJobNames(client, job) {
  const names = intentNames(job.intent);
  if (!names.all || !job.remote_product_id) return;
  await saveObservation(client, job.origin_hash, { public_product_identity_id: job.public_product_identity_id }, job.remote_product_id,
    { action: 'confirm', amber: names, remote: names }, names);
}
module.exports = { intentNames, readNameState, readNameStates, namesFromObservation, decisionFor,
  nameStateEvidence, saveObservation, importRemote, auditName, reconcileObservation, confirmJobNames };
