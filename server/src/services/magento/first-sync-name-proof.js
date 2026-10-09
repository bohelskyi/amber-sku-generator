const { hash } = require('./binding-contract');
const names = require('./name-state');
const { validName, validPair } = require('../export-templates/effective-product-names');
const { TERMINAL } = require('./first-sync-progress-plan');

const proofs = new WeakMap();
const scopes = ['all', 'en'];
const forbidden = new Set(['create', 'identity_changed', 'foreign_identity', 'completion_review']);

function snapshot(observation) {
  const { amber, raw, domainEvidence } = observation || {};
  const product = amber?.product, revision = amber?.revision, english = domainEvidence?.english;
  if (!product || !revision || !raw || !Number.isSafeInteger(raw.id) || raw.id <= 0
    || raw.sku !== product.public_sku || english?.id !== raw.id || english?.sku !== raw.sku
    || domainEvidence?.failures?.some(failure => failure.domain === 'storeViews' || failure.operation === 'storeViews')
    || ![product.id, product.public_product_identity_id, revision.id, revision.installationKey,
      revision.originHash, amber.compiled?.hash].every(value => value !== undefined && value !== null)
    || typeof raw.name !== 'string' || typeof english.fields?.name !== 'string') return null;
  const decision = names.decisionFor(observation);
  // The ordinary pair guard also calls a known empty UA string unavailable.
  // Only that exact case may reach the per-scope initial-write checks below.
  if (forbidden.has(decision.action) || decision.action === 'unavailable' && raw.name !== ''
    || !decision.ready || !validPair(decision.amber)
    || decision.remote?.all !== raw.name || decision.remote?.en !== english.fields.name) return null;
  const identity = { productId: product.id, identityId: String(product.public_product_identity_id),
    bindingId: revision.id, installationKey: revision.installationKey, originHash: revision.originHash,
    definitionHash: amber.compiled.hash, sku: raw.sku, remoteId: raw.id };
  return { identity, amber: decision.amber, remote: decision.remote,
    digest: hash({ identity, amber: decision.amber, remote: decision.remote,
      state: names.nameStateEvidence(amber.nameState) }) };
}

function jobEvidence(job, current) {
  if (!job || !current || job.intent?.mode !== 'update'
    || job.product_id !== current.identity.productId
    || String(job.public_product_identity_id) !== current.identity.identityId
    || job.binding_revision_id !== current.identity.bindingId
    || job.installation_key !== current.identity.installationKey
    || job.origin_hash !== current.identity.originHash || job.sku !== current.identity.sku
    || job.baseline?.raw?.id !== current.identity.remoteId || job.baseline.raw.sku !== current.identity.sku) return null;
  return hash({ id: job.id, productId: job.product_id, identityId: String(job.public_product_identity_id),
    bindingId: job.binding_revision_id, installationKey: job.installation_key, originHash: job.origin_hash,
    sku: job.sku, intent: job.intent, baseline: job.baseline });
}

// Internal, request-owned evidence only. This neither saves a name decision nor
// creates a baseline; the runtime still owns receipt CAS and dispatch authority.
function issue({ observation, prepared, projection, job = null }) {
  try {
    const current = snapshot(observation);
    if (!current || !prepared?.readyForOutbound || prepared.blockers?.length
      || !Array.isArray(projection?.fields) || !Array.isArray(projection.projection)
      || !Array.isArray(prepared.rows)) return null;
    const pending = [];
    for (const scope of scopes) {
      const inputs = projection.fields.filter(field => field.target === 'name' && field.scope === scope);
      const metadata = projection.projection.filter(field => field.target === 'name' && field.scope === scope);
      const rows = prepared.rows.filter(field => field.target === 'name' && field.scope === scope);
      if (inputs.length !== 1 || metadata.length !== 1 || rows.length !== 1) return null;
      const field = inputs[0], meta = metadata[0], row = rows[0];
      if (field.kind !== 'name' || !field.mapping?.proven || meta.persistence !== 'name'
        || !field.local?.known || !field.remote?.known || field.local.present !== true
        || field.local.value !== current.amber[scope] || field.remote.value !== current.remote[scope]) return null;
      const received = field.receipt?.received === true || TERMINAL.has(field.receipt?.state) || row.received === true;
      if (current.amber[scope] === current.remote[scope]) continue;
      // Never authorize an ordinary received-language mismatch, even when the
      // other language is still awaiting its first write.
      if (received || field.remote.present !== false || current.remote[scope] !== ''
        || row.status !== 'pending_outward_confirmation' || row.record?.state !== 'pending_outward_confirmation'
        || meta.outwardPolicy !== 'authoritative_create_update') return null;
      pending.push(scope);
    }
    if (!pending.length) return null;
    const boundJob = job ? jobEvidence(job, current) : null;
    if (job && !boundJob) return null;
    const token = Object.freeze({});
    proofs.set(token, { digest: current.digest, pending, job: boundJob });
    return token;
  } catch { return null; }
}

function allows(observation, token) {
  try {
    const proof = proofs.get(token), current = snapshot(observation);
    return Boolean(proof && current && proof.digest === current.digest);
  } catch { return false; }
}

// The caller supplies the CURRENT observation. Historical baseline permission
// is narrower and never turns an already received scope into an initial write.
function baselineAllows(job, observation, token) {
  try {
    if (!allows(observation, token)) return false;
    const proof = proofs.get(token), current = snapshot(observation);
    if (!proof.job || proof.job !== jobEvidence(job, current)) return false;
    const raw = job.baseline.raw, english = job.baseline.domainEvidence?.english;
    if (english?.id !== raw.id || english?.sku !== raw.sku
      || job.baseline.domainEvidence?.failures?.some(failure => failure.domain === 'storeViews' || failure.operation === 'storeViews')) return false;
    const remote = { all: raw.name, en: english.fields?.name }, sent = names.intentNames(job.intent);
    return scopes.every(scope => typeof remote[scope] === 'string'
      && (remote[scope] === current.amber[scope]
        || proof.pending.includes(scope) && remote[scope] === '' && sent[scope] === current.amber[scope]));
  } catch { return false; }
}

function baselineObservationAllows(job, baselineObservation, freshObservation, token) {
  try {
    if (!baselineAllows(job, freshObservation, token)
      || baselineObservation?.amber !== freshObservation.amber
      || baselineObservation.schema !== freshObservation.schema) return false;
    const raw = baselineObservation.raw, expected = job.baseline.raw;
    const english = baselineObservation.domainEvidence?.english, expectedEnglish = job.baseline.domainEvidence?.english;
    return Boolean(raw && english && raw.id === expected.id && raw.sku === expected.sku && raw.name === expected.name
      && english.id === expectedEnglish.id && english.sku === expectedEnglish.sku
      && hash(english.fields) === hash(expectedEnglish.fields)
      && !baselineObservation.domainEvidence?.failures?.some(failure => failure.domain === 'storeViews' || failure.operation === 'storeViews'));
  } catch { return false; }
}

const revisionValue = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const sessionValue = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function baselineReceipt(observation, token, { sessionId, revision } = {}) {
  const proof = proofs.get(token);
  if (!proof || proof.restored || !allows(observation, token) || !sessionValue(sessionId) || !revisionValue(revision)) return null;
  return { sessionId, revision, scopes: [...proof.pending] };
}

function sourceMatches(field, scope, current, job) {
  const source = field?.source;
  return field?.target === 'name' && field.scope === scope && source?.kind === 'name'
    && source.field === 'magento_name_override.values.' + scope && source.productId === job.product_id
    && source.bindingRevisionId === job.binding_revision_id && source.definitionHash === current.identity.definitionHash
    && typeof source.routeKey === 'string' && source.routeKey.length > 0
    && typeof field.mappingHash === 'string' && /^[a-f0-9]{64}$/.test(field.mappingHash);
}
function emptyRemote(field) {
  return field?.remote?.known === true && field.remote.present === false && field.remote.value === '';
}
function beforeMatches(field, name) {
  return field?.before?.known === true && field.before.present === true && validName(field.before.value)
    && field.before.value === name && field.after === name;
}
function sameIdentityProduct(productId, current, history) {
  if (!Number.isSafeInteger(productId) || productId <= 0) return false;
  if (productId === current.identity.productId) return true;
  if (history?.productId !== current.identity.productId || history.complete !== true || history.identityChanged !== false
    || !Array.isArray(history.issues) || history.issues.length || !Array.isArray(history.products) || history.products.length > 30) return false;
  const ids = history.products.map(product => product.productId);
  return new Set(ids).size === ids.length && ids.includes(productId) && ids.includes(current.identity.productId)
    && history.products.every(product => Number.isSafeInteger(product.productId) && product.productId > 0
      && product.article === current.identity.sku);
}
function historicalNameSource(field, scope, current, history) {
  const source = field?.source;
  return field?.target === 'name' && field.scope === scope && source?.kind === 'name'
    && source.field === 'magento_name_override.values.' + scope && sameIdentityProduct(source.productId, current, history)
    && sessionValue(source.bindingRevisionId) && typeof source.definitionHash === 'string' && /^[a-f0-9]{64}$/.test(source.definitionHash)
    && typeof source.routeKey === 'string' && source.routeKey.length > 0 && source.routeKey.length <= 512
    && source.routeKey.trim() === source.routeKey && !/[\u0000-\u001f\u007f]/.test(source.routeKey)
    && typeof field.mappingHash === 'string' && /^[a-f0-9]{64}$/.test(field.mappingHash);
}
function terminalRecord(field) {
  const record = { ...field }; delete record.revision; delete record.recordedAt; return record;
}

// Reconstruct only a job's original initial-write authority from immutable local
// receipts. Current receipt states still decide whether a name may differ now.
function issueFromLedger({ observation, job, session, command, progress, history = null }) {
  try {
    const current = snapshot(observation), ref = job?.baseline?.firstSyncNames;
    if (!current || !jobEvidence(job, current) || !ref || !sessionValue(ref.sessionId) || !revisionValue(ref.revision)
      || !Array.isArray(ref.scopes) || !ref.scopes.length || ref.scopes.length > 2
      || new Set(ref.scopes).size !== ref.scopes.length || ref.scopes.some(scope => !scopes.includes(scope))
      || session?.id !== ref.sessionId || session.origin_hash !== current.identity.originHash
      || String(session.public_product_identity_id) !== current.identity.identityId
      || session.public_sku !== current.identity.sku || session.installation_key !== current.identity.installationKey
      || String(session.remote_product_id) !== String(current.identity.remoteId)
      || !sameIdentityProduct(session.initial_product_id, current, history) || session.initial_contract_version !== 'first-sync-v1'
      || !revisionValue(session.revision) || BigInt(session.revision) < BigInt(ref.revision)
      || progress?.session?.id !== session.id || progress.session.revision !== session.revision
      || hash(progress.session) !== hash(session) || !Array.isArray(progress.fields)
      || !command || typeof command.expectedRevision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(command.expectedRevision)
      || String(BigInt(command.expectedRevision) + 1n) !== ref.revision || command.readyForOutbound !== true
      || command.key?.originHash !== session.origin_hash || String(command.key?.publicIdentityId) !== String(session.public_product_identity_id)
      || command.identity?.installationKey !== session.installation_key || command.identity?.publicSku !== session.public_sku
      || String(command.identity?.remoteProductId) !== String(session.remote_product_id)
      || command.identity?.initialProductId !== session.initial_product_id
      || command.identity?.initialBindingRevisionId !== session.initial_binding_revision_id
      || command.identity?.contractVersion !== session.initial_contract_version
      || !Array.isArray(command.fields) || !Array.isArray(command.requiredScopes)) return null;
    const sent = names.intentNames(job.intent);
    if (!validPair(sent) || scopes.some(scope => sent[scope] !== current.amber[scope])) return null;
    const initialPending = command.fields.filter(field => field.target === 'name' && field.state === 'pending_outward_confirmation').map(field => field.scope);
    if (hash([...initialPending].sort()) !== hash([...ref.scopes].sort())) return null;
    const baselineNames = { all: job.baseline.raw.name, en: job.baseline.domainEvidence?.english?.fields?.name };
    for (const scope of scopes) {
      const initial = command.fields.filter(field => field.target === 'name' && field.scope === scope);
      const latest = progress.fields.filter(field => field.target === 'name' && field.scope === scope);
      if (initial.length !== 1 || latest.length !== 1
        || command.requiredScopes.filter(field => field.target === 'name' && field.scope === scope).length !== 1) return null;
      const first = initial[0], last = latest[0];
      if (ref.scopes.includes(scope)) {
        if (!sourceMatches(first, scope, current, job) || !sourceMatches(last, scope, current, job)
          || first.mappingHash !== last.mappingHash || first.source.routeKey !== last.source.routeKey
          || first.state !== 'pending_outward_confirmation' || !emptyRemote(first)
          || baselineNames[scope] !== '' || !beforeMatches(first, sent[scope])) return null;
      } else if (!TERMINAL.has(first.state) || !TERMINAL.has(last.state) || baselineNames[scope] !== sent[scope]
        || !historicalNameSource(first, scope, current, history) || !historicalNameSource(last, scope, current, history)
        || hash(terminalRecord(first)) !== hash(terminalRecord(last))) return null;
      if (TERMINAL.has(last.state)) {
        if (current.remote[scope] !== current.amber[scope]) return null;
      } else if (last.state !== 'pending_outward_confirmation' || !ref.scopes.includes(scope)
        || !emptyRemote(last) || !beforeMatches(last, sent[scope])
        || current.remote[scope] !== '' && current.remote[scope] !== current.amber[scope]) return null;
    }
    const token = Object.freeze({});
    proofs.set(token, { digest: current.digest, pending: [...ref.scopes], job: jobEvidence(job, current), restored: true });
    if (!baselineAllows(job, observation, token)) return null;
    return token;
  } catch { return null; }
}

module.exports = { issue, allows, baselineAllows, baselineObservationAllows, baselineReceipt, issueFromLedger };
