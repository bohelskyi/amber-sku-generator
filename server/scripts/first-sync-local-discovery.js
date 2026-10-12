// Standalone read-only adapter for the services shipped in PR 68. No app startup.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 2000;
const POLICIES = { price: 'manager_price', decor_weight: 'manager_weight_rounding',
  vaha_vyrobu: 'manager_weight_rounding', meta_title: 'amber_seo', meta_description: 'amber_seo' };
const HELP = 'node first-sync-local-discovery.js --server-root /path/to/server --input candidates.json '
  + '--output-dir NEW_DIRECTORY --expected-database NAME --actor-id ID --installation-key KEY '
  + '[--offset 0] [--limit 10]\n'
  + 'Read-only exact SKU discovery. Default 10 candidates, maximum 2000 per invocation. '
  + 'Writes fsynced per-SKU checkpoints, packets of at most 10, and a completion manifest. '
  + 'Packets require the existing first-sync-local-batch.js --mode preview. No apply or enqueue mode.';
const fail = code => { throw Object.assign(Error(code), { code }); };
const safeCode = e => e?.code === 'EEXIST' ? 'DISCOVERY_OUTPUT_EXISTS'
  : typeof e?.code === 'string' && /^[A-Z0-9_]{1,160}$/.test(e.code) ? e.code : 'DISCOVERY_FAILED';
const exactKeys = (value, required, optional = []) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || required.some(k => !Object.hasOwn(value, k))
    || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) fail('DISCOVERY_INPUT_INVALID');
};
const skuValid = sku => typeof sku === 'string' && sku.length > 0 && sku.length <= 256
  && sku.trim() === sku && !/[\u0000-\u001f\u007f]/.test(sku);
const positiveId = n => Number.isSafeInteger(n) && n > 0;
function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const names = { '--server-root': 'serverRoot', '--input': 'input', '--output-dir': 'output',
    '--expected-database': 'database', '--actor-id': 'actor', '--installation-key': 'installation',
    '--offset': 'offset', '--limit': 'limit' }, out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]], value = args[i + 1];
    if (!key || Object.hasOwn(out, key) || typeof value !== 'string' || !value.trim()
      || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) fail('DISCOVERY_ARGUMENTS');
    out[key] = value;
  }
  if (!out.input || !out.output || !out.database || !out.installation
    || !/^[1-9][0-9]*$/.test(out.actor || '') || !positiveId(Number(out.actor))
    || out.offset !== undefined && !/^(0|[1-9][0-9]*)$/.test(out.offset)
    || out.limit !== undefined && !/^[1-9][0-9]*$/.test(out.limit)) fail('DISCOVERY_ARGUMENTS');
  out.actor = Number(out.actor); out.offset = Number(out.offset || 0); out.limit = Number(out.limit || 10);
  if (!Number.isSafeInteger(out.offset) || out.offset >= MAX_ITEMS || out.limit > MAX_ITEMS) fail('DISCOVERY_ARGUMENTS');
  out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..'));
  return out;
}
function validateInput(input, runtime) {
  exactKeys(input, ['items'], ['bindingRevisionId', 'expectedDefinitionHash']);
  if ((input.bindingRevisionId === undefined) !== (input.expectedDefinitionHash === undefined)) fail('DISCOVERY_INPUT_INVALID');
  if (input.bindingRevisionId !== undefined) {
    runtime.c.identity(input.bindingRevisionId);
    if (!/^[a-f0-9]{64}$/.test(input.expectedDefinitionHash)) fail('DISCOVERY_INPUT_INVALID');
  }
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > MAX_ITEMS
    || Object.keys(input.items).length !== input.items.length) fail('DISCOVERY_INPUT_INVALID');
  for (const item of input.items) {
    exactKeys(item, ['sku', 'productId', 'category', 'remoteProductId', 'fields'], ['expectedProduct']);
    if (!skuValid(item.sku) || !positiveId(item.productId) || typeof item.category !== 'string'
      || !/^[A-Za-z0-9_-]{1,64}$/.test(item.category)
      || item.remoteProductId !== null && !positiveId(item.remoteProductId)
      || !Array.isArray(item.fields) || !item.fields.length || item.fields.length > 8
      || Object.keys(item.fields).length !== item.fields.length) fail('DISCOVERY_INPUT_INVALID');
    for (const field of item.fields) {
      exactKeys(field, ['target', 'scope', 'local', 'remote'], ['policy']);
      if (!Object.hasOwn(POLICIES, field.target) || !['all', 'en'].includes(field.scope)
        || !field.target.startsWith('meta_') && field.scope !== 'all'
        || field.policy !== undefined && field.policy !== POLICIES[field.target]) fail('DISCOVERY_FIELD_POLICY_INVALID');
      for (const value of [field.local, field.remote]) if (value !== null
        && !(typeof value === 'string' && value.length <= 4096)
        && !(typeof value === 'number' && Number.isFinite(value))) fail('DISCOVERY_INPUT_INVALID');
    }
    if (new Set(item.fields.map(f => f.scope + '/' + f.target)).size !== item.fields.length) fail('DISCOVERY_INPUT_INVALID');
    if (item.expectedProduct !== undefined) exactKeys(item.expectedProduct, Object.keys(runtime.batch.source({})));
  }
  if (new Set(input.items.map(i => i.sku)).size !== input.items.length
    || new Set(input.items.map(i => i.productId)).size !== input.items.length) fail('DISCOVERY_DUPLICATE_CANDIDATE');
}
function getOnly(fetchImpl) {
  return (url, init = {}) => {
    const method = init.method || (typeof url === 'object' && url?.method) || 'GET';
    if (typeof method !== 'string' || method.toUpperCase() !== 'GET' || init.body != null) fail('DISCOVERY_REMOTE_WRITE_DENIED');
    return fetchImpl(url, init);
  };
}
function createRuntime(serverRoot) {
  const local = createRequire(path.join(serverRoot, 'package.json'));
  const service = name => local('./src/services/' + name);
  return { c: service('magento/binding-contract'), batch: service('magento/first-sync-batch-preflight'),
    first: service('magento/first-sync.service'), preview: service('magento/sync-preview').previewProduct,
    readSnapshot: service('magento/sync-preview-db').readPreviewProduct,
    normalize: service('magento/first-sync-field-plan').normalizeDecimal,
    access: service('access-admin-transaction'), gate: service('full-product-cutover-gate'),
    bindings: service('magento/binding.service'), publication: service('magento/binding-publication'),
    audit: service('magento/binding-evidence-audit'),
    pool: local('./scripts/magento-binding-evidence-audit'),
    config: local('./src/config/magento') };
}
async function readAuthority(runtime, config, options) {
  const { databasePool, actorUserId, installation } = options;
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await runtime.access.assertActorStillAuthorized(client, actorUserId, 'export_templates.publish', runtime.c.error, { readOnly: true });
    await runtime.publication.administrator(client, actorUserId);
    const gate = await runtime.gate.readGate(client);
    if (gate.phase === 'preparing') fail('EXPORT_CUTOVER_PREPARING');
    const row = (await client.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1
      AND state='published' ORDER BY version_number DESC LIMIT 1`, [installation])).rows[0];
    if (!row) fail('DISCOVERY_CURRENT_PUBLICATION_REQUIRED');
    const revision = await runtime.bindings.readRevisionOnClient(client, row.id);
    if (revision.state !== 'published' || revision.installationKey !== installation
      || revision.originHash !== runtime.c.originHash(config.baseUrl) || revision.schema.storeCode !== 'all') fail('DISCOVERY_PUBLICATION_MISMATCH');
    const authority = { bindingRevisionId: revision.id, expectedDefinitionHash: revision.definitionHash,
      publicationHash: runtime.c.hash(revision) };
    await client.query('COMMIT'); return authority;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}
const samePublication = (a, b) => a.bindingRevisionId === b.bindingRevisionId
  && a.expectedDefinitionHash === b.expectedDefinitionHash && a.publicationHash === b.publicationHash;
function sameValue(runtime, target, a, b) {
  if (target.startsWith('meta_')) return typeof a === 'string' && a === b;
  const x = runtime.normalize(a, target === 'price' ? 2 : 3);
  return x !== null && x === runtime.normalize(b, target === 'price' ? 2 : 3);
}
function brief(blocker) {
  return Object.fromEntries(['code', 'target', 'scope', 'reason'].filter(k => typeof blocker[k] === 'string')
    .map(k => [k, blocker[k]]));
}
async function inspectCandidate(runtime, config, item, publication, options) {
  let observation;
  // Direct ordinary preview is GET-only and does not adopt fields or use prospective historical state.
  const report = await runtime.preview(config, { databasePool: options.databasePool, fetchImpl: options.fetchImpl,
    sensitiveValues: options.sensitiveValues, sku: item.sku, bindingRevisionId: publication.bindingRevisionId,
    onObservation: value => { observation = value; } });
  const p = observation?.amber?.product, identity = report.identity;
  const blockers = [], changes = [];
  const block = (code, field) => blockers.push({ code, ...(field ? { target: field.target, scope: field.scope } : {}) });
  const result = { sku: item.sku, productId: item.productId, category: item.category,
    status: 'blocked', observedAt: report.generatedAt, remoteProductId: identity?.observedMagentoId ?? null,
    blockers, changes, ordinaryBlockers: (report.blockers || []).map(brief), requiresLocalBatchPreview: true };
  if (!p || identity?.state !== 'found' || report.mode !== 'update' || !positiveId(identity?.observedMagentoId)
    || identity.article !== item.sku || report.amberProduct?.publicSku !== item.sku || p.public_sku !== item.sku
    || observation.raw?.sku !== item.sku || observation.raw?.id !== identity.observedMagentoId
    || p.id !== item.productId || p.category !== item.category
    || item.remoteProductId !== null && item.remoteProductId !== identity.observedMagentoId) {
    block('DISCOVERY_EXACT_IDENTITY_REQUIRED'); return result;
  }
  if (observation.amber.revision?.id !== publication.bindingRevisionId
    || observation.amber.compiled?.hash !== publication.expectedDefinitionHash) {
    fail('DISCOVERY_PUBLICATION_CHANGED');
  }
  const source = runtime.batch.source(p);
  result.sourceSnapshot = source;
  if (item.expectedProduct && runtime.c.hash(item.expectedProduct) !== runtime.c.hash(source)) block('DISCOVERY_FROZEN_SOURCE_CHANGED');
  if (p.status !== 'active' || p.corrected_to_product_id != null || p.is_test_product === true
    || Number(p.exclude_from_export) !== 0 || p.exportState?.route !== 'normal'
    || p.exportState.business_exclusion_state !== 'none' || p.exportState.recount_compatibility_excluded
    || p.exportState.independentExclusion === true) block('DISCOVERY_LIFECYCLE_NOT_NORMAL');
  if (report.evaluation?.ready !== true || report.syncEligibility?.eligible !== true || report.sendable !== true)
    block('DISCOVERY_ORDINARY_PAYLOAD_NOT_READY');
  const base = await runtime.first.inspect(config, observation, options);
  result.mode = base.mode;
  result.firstSyncBlockers = (base.blockers || []).map(brief);
  if (base.historyReview) result.historyReview = base.historyReview;
  if (base.historyReviewAssessment) result.historyReviewAssessment = base.historyReviewAssessment;
  if (base.mode !== 'first') {
    block(base.mode === 'ordinary' ? 'DISCOVERY_ORDINARY_WORKFLOW_REQUIRED' : 'DISCOVERY_FIRST_SYNC_REVIEW_REQUIRED');
    return result;
  }
  const fields = [], choices = [];
  for (const wanted of item.fields) {
    const matches = f => f.target === wanted.target && f.scope === wanted.scope;
    const row = base.fields.find(matches), meta = base.projection.projection.find(matches);
    if (!row || !row.local.known || !row.remote.known) { block('DISCOVERY_FIELD_UNKNOWN', wanted); continue; }
    if (!sameValue(runtime, wanted.target, wanted.local, row.local.value)
      || !sameValue(runtime, wanted.target, wanted.remote, row.remote.value)) {
      block('DISCOVERY_FROZEN_FIELD_CHANGED', wanted);
      changes.push({ target: wanted.target, scope: wanted.scope,
        frozen: { local: wanted.local, remote: wanted.remote },
        fresh: { local: row.local.value ?? null, remote: row.remote.value ?? null } });
      continue;
    }
    const weight = ['decor_weight', 'vaha_vyrobu'].includes(wanted.target);
    if (row.local.present !== true || row.remote.present !== true) { block('DISCOVERY_EMPTY_FIELD_REVIEW_REQUIRED', wanted); continue; }
    if (weight && meta?.persistence !== 'weight') { block('DISCOVERY_PHYSICAL_WEIGHT_NOT_PROVEN', wanted); continue; }
    const pendingSeo = wanted.target.startsWith('meta_') && base.first.progress?.fields.some(f => matches(f) && f.state === 'seo_pending_initial_readback');
    if (!pendingSeo && sameValue(runtime, wanted.target, row.local.value, row.remote.value)) continue;
    if (weight && !runtime.batch.roundedWeight(row.local.value, row.remote.value)) { block('DISCOVERY_WEIGHT_NOT_ROUNDING_ONLY', wanted); continue; }
    if (row.canKeepLocal !== true) { block('DISCOVERY_LOCAL_CHOICE_UNAVAILABLE', wanted); continue; }
    // Keep exact fresh JSON types only after comparison; frozen facts remain in the input and its digest.
    fields.push({ target: wanted.target, scope: wanted.scope, local: row.local.value, remote: row.remote.value });
    choices.push({ target: wanted.target, scope: wanted.scope, choice: 'keep_local' });
  }
  if (choices.length && !blockers.length) {
    const planned = await runtime.first.prepareDecision(config, base, choices, options);
    result.remainingBlockers = (planned.prepared.blockers || []).map(brief);
    result.initialImports = planned.prepared.rows.filter(r => !r.received && ['imported', 'name_received'].includes(r.record.state))
      .map(r => ({ target: r.target, scope: r.scope, before: r.local, after: r.record.after }));
    for (const choice of choices) {
      const row = planned.prepared.rows.find(r => r.target === choice.target && r.scope === choice.scope);
      if (!row || row.received || row.record.state !== 'pending_outward_confirmation') block('DISCOVERY_LOCAL_CHOICE_UNAVAILABLE', choice);
    }
    // Do not turn other discrepancies into an implicit authority decision.
    for (const b of result.remainingBlockers) blockers.push(b);
  } else if (!choices.length) {
    for (const b of result.firstSyncBlockers) blockers.push(b);
  }
  const fresh = await runtime.readSnapshot(options.databasePool, { sku: item.sku, bindingRevisionId: publication.bindingRevisionId });
  if (runtime.c.hash(runtime.batch.source(fresh.product)) !== runtime.c.hash(source)
    || runtime.c.hash(fresh.product.exportState) !== runtime.c.hash(p.exportState)
    || fresh.product.is_test_product !== p.is_test_product) block('DISCOVERY_SOURCE_CHANGED_DURING_READ');
  if (!blockers.length && fields.length) {
    result.status = 'candidate';
    result.packetItem = { sku: item.sku, expectedProduct: source, remoteProductId: identity.observedMagentoId, fields };
  } else if (!blockers.length) result.status = 'no_selected_change';
  return result;
}
async function readJson(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) fail('DISCOVERY_INPUT_LIMIT');
    const buffer = Buffer.alloc(MAX_BYTES + 1); let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break; size += read.bytesRead;
    }
    if (size > MAX_BYTES) fail('DISCOVERY_INPUT_LIMIT');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally { await handle.close(); }
}
async function writeRecord(handle, value, runtime, config, secrets) {
  runtime.audit.assertEvidenceSafe(value, config, secrets);
  const buffer = Buffer.from(JSON.stringify(value) + '\n');
  if (buffer.length > MAX_BYTES) fail('DISCOVERY_OUTPUT_LIMIT');
  for (let offset = 0; offset < buffer.length;) {
    const written = (await handle.write(buffer, offset, buffer.length - offset)).bytesWritten;
    if (!written) fail('DISCOVERY_OUTPUT_WRITE_FAILED'); offset += written;
  }
  await handle.sync();
}
async function writeNew(file, value, runtime, config, secrets) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await writeRecord(handle, value, runtime, config, secrets); } finally { await handle.close(); }
}
async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let owned, journal;
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const runtime = dependencies.runtime || createRuntime(cli.serverRoot);
    const input = await readJson(cli.input); validateInput(input, runtime);
    if (cli.offset >= input.items.length) fail('DISCOVERY_OFFSET_OUT_OF_RANGE');
    runtime.c.installation(cli.installation);
    const config = dependencies.config || runtime.config.parseMagentoConfig(env);
    if (!config.configured) fail('MAGENTO_NOT_CONFIGURED');
    const pool = dependencies.pool || (owned = runtime.pool.createReadOnlyPool(env));
    if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('DISCOVERY_DATABASE_MISMATCH');
    if ((await pool.query('SHOW default_transaction_read_only')).rows[0]?.default_transaction_read_only !== 'on') fail('DISCOVERY_READ_ONLY_DATABASE_REQUIRED');
    const options = { databasePool: pool, actorUserId: cli.actor, installation: cli.installation,
      sensitiveValues: runtime.pool.databaseSecrets(env), fetchImpl: getOnly(dependencies.fetchImpl || globalThis.fetch) };
    const authority = async () => {
      try { return await (dependencies.readAuthority || readAuthority)(runtime, config, options); }
      catch (e) { e.discoveryAuthorityFailure = true; throw e; }
    };
    const publication = await authority();
    if (input.bindingRevisionId && (input.bindingRevisionId !== publication.bindingRevisionId
      || input.expectedDefinitionHash !== publication.expectedDefinitionHash)) fail('DISCOVERY_FROZEN_PUBLICATION_CHANGED');
    await fs.mkdir(cli.output, { mode: 0o700 });
    journal = await fs.open(path.join(cli.output, 'results.jsonl'), 'wx', 0o600);
    const selected = input.items.slice(cli.offset, cli.offset + cli.limit), results = [];
    const header = { contract: 'first-sync-local-discovery-v1', readOnly: true, database: cli.database,
      actorUserId: cli.actor, installationKey: cli.installation, inputSha256: runtime.c.hash(input), publication,
      offset: cli.offset, selected: selected.length, total: input.items.length, startedAt: new Date().toISOString(),
      requiresLocalBatchPreview: true, directRemoteWrites: 0, directlyEnqueuedJobs: 0 };
    await writeRecord(journal, { kind: 'start', ...header }, runtime, config, options.sensitiveValues);
    let globalFailure = null;
    for (const [index, item] of selected.entries()) {
      let result;
      try {
        if (!samePublication(publication, await authority())) fail('DISCOVERY_PUBLICATION_CHANGED');
        result = await inspectCandidate(runtime, config, item, publication, options);
        if (!samePublication(publication, await authority())) fail('DISCOVERY_PUBLICATION_CHANGED');
      } catch (e) {
        const code = safeCode(e);
        result = { sku: item.sku, productId: item.productId, category: item.category, status: 'blocked', blockers: [{ code }] };
        // Authority failures invalidate the whole run; all other failed reads remain per-SKU blockers.
        if (e.discoveryAuthorityFailure || [401, 403].includes(e.statusCode)
          || /PUBLICATION|PERMISSION|ACTOR|ADMINISTRATOR|CUTOVER|LIFECYCLE_WRITER/.test(code)) globalFailure = code;
      }
      result.inputIndex = cli.offset + index; results.push(result);
      await writeRecord(journal, { kind: 'result', ...result }, runtime, config, options.sensitiveValues);
      print(JSON.stringify({ stage: 'discovery', checked: results.length, selected: selected.length,
        sku: item.sku, status: result.status, blockers: result.blockers.length, nextOffset: result.inputIndex + 1 }));
      if (globalFailure) break;
    }
    if (!globalFailure) {
      try { if (!samePublication(publication, await authority())) fail('DISCOVERY_PUBLICATION_CHANGED'); }
      catch (e) { globalFailure = safeCode(e); }
    }
    const packets = [], candidates = globalFailure ? [] : results.filter(r => r.status === 'candidate');
    const packetLimit = Math.min(10, runtime.batch.MAX_PRODUCTS);
    if (!positiveId(packetLimit)) fail('DISCOVERY_BATCH_CONTRACT_UNSUPPORTED');
    for (let offset = 0; offset < candidates.length; offset += packetLimit) {
      const packet = { bindingRevisionId: publication.bindingRevisionId, expectedDefinitionHash: publication.expectedDefinitionHash,
        items: candidates.slice(offset, offset + packetLimit).map(r => r.packetItem) };
      runtime.batch.command(packet);
      const file = 'packet-' + String(packets.length + 1).padStart(4, '0') + '.json';
      await writeNew(path.join(cli.output, file), packet, runtime, config, options.sensitiveValues);
      packets.push({ file, sha256: runtime.c.hash(packet), count: packet.items.length });
    }
    const manifest = { ...header, complete: !globalFailure && results.length === selected.length,
      globalFailure, finishedAt: new Date().toISOString(), packets, checked: results.length,
      candidates: candidates.length, blocked: results.filter(r => r.status === 'blocked').length,
      invalidatedCandidates: globalFailure ? results.filter(r => r.status === 'candidate').length : 0,
      noSelectedChange: results.filter(r => r.status === 'no_selected_change').length,
      notChecked: selected.length - results.length, nextOffset: cli.offset + results.length,
      remainingInput: input.items.length - cli.offset - results.length };
    await writeNew(path.join(cli.output, 'manifest.json'), manifest, runtime, config, options.sensitiveValues);
    await writeRecord(journal, { kind: 'complete', ...manifest }, runtime, config, options.sensitiveValues);
    print(JSON.stringify({ stage: 'complete', output: cli.output, ...manifest }));
    return globalFailure || manifest.blocked || manifest.notChecked ? 2 : 0;
  } catch (e) { printError(JSON.stringify({ ok: false, code: safeCode(e), complete: false,
    directRemoteWrites: 0, directlyEnqueuedJobs: 0 })); return 1; }
  finally { if (journal) await journal.close().catch(() => {}); if (owned) await owned.end().catch(() => {}); }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, validateInput, getOnly, createRuntime, readAuthority, inspectCandidate, main, MAX_ITEMS };
