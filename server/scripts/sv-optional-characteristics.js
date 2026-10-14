'use strict';
// Publishes one reviewed SV template change: kolir, typy_obrobky_burshtynu and
// rozmir_suveniriv are emitted only when Amber has the answer. An absent answer
// becomes an empty cell, which the planner omits, so Magento keeps its own value.
// Products that have the answer produce exactly the same output as before.
// Approved by the catalog owner on 2026-10-14. decor_weight is not changed.
//
// preview: read-only. Builds the change from the current published SV template,
//   evaluates every active SV product with both definitions and refuses if any
//   populated output would change.
// apply: repeats preview, then clones the published version into the family draft,
//   saves the changed definition and publishes a new template version through the
//   existing template service (actor, permission, CAS and audit boundaries).
//   It does not touch the Magento binding: prepare the successor and run the H3b
//   publication review in Settings -> Magento afterwards.
const path = require('node:path');
const { createRequire } = require('node:module');

const HELP = 'node sv-optional-characteristics.js --mode preview|apply --expected-database NAME --actor-id ID '
  + '--binding-revision UUID --expected-definition-hash SHA256 [--server-root SERVER]';
const FIELDS = [['SV.kolir', 'SV.color'], ['SV.typy_obrobky_burshtynu', 'SV.material']];
const fail = (code, details) => { throw Object.assign(Error(code), { code, ...(details ? { details } : {}) }); };
const present = id => ({ op: 'present', input: { op: 'source', id }, policy: 'answer-v1' });
const empty = () => ({ op: 'literal', value: '' });

function argumentsFor(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const flags = { '--mode': 'mode', '--expected-database': 'database', '--actor-id': 'actor', '--server-root': 'serverRoot',
    '--binding-revision': 'bindingRevisionId', '--expected-definition-hash': 'definitionHash' }, out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = flags[args[i]], value = args[i + 1];
    if (!key || Object.hasOwn(out, key) || typeof value !== 'string' || !value || value.startsWith('--')) fail('SV_OPTIONAL_ARGUMENTS');
    out[key] = value;
  }
  if (!['preview', 'apply'].includes(out.mode) || !out.database || !/^[1-9][0-9]{0,17}$/.test(out.actor || '')
    || !/^[0-9a-f-]{36}$/.test(out.bindingRevisionId || '') || !/^[a-f0-9]{64}$/.test(out.definitionHash || '')) fail('SV_OPTIONAL_ARGUMENTS');
  out.actor = Number(out.actor);
  out.serverRoot = path.resolve(out.serverRoot || path.join(__dirname, '..'));
  return out;
}

// Pure transformation with exact shape checks; anything unexpected refuses.
function patchDefinition(definition) {
  const next = structuredClone(definition);
  const bindings = new Map(next.bindings.map(binding => [binding.id, binding]));
  for (const [bindingId, sourceId] of FIELDS) {
    const binding = bindings.get(bindingId), value = binding?.value;
    if (value?.op !== 'questionValue' || value.missingAnswer?.op !== 'error' || !next.sources[sourceId]) fail('SV_OPTIONAL_UNEXPECTED_SHAPE', { bindingId });
    binding.value = { op: 'when', if: present(sourceId), then: value, else: empty() };
  }
  // The size rule is a when-chain (the keychain branch may precede it) ending in the missing-size error.
  let node = bindings.get('SV.rozmir_suveniriv')?.value;
  if (node?.op !== 'when') fail('SV_OPTIONAL_UNEXPECTED_SHAPE', { bindingId: 'SV.rozmir_suveniriv' });
  while (node.else?.op === 'when') node = node.else;
  if (node.else?.op !== 'error' || node.else.field !== 'rozmir_suveniriv') fail('SV_OPTIONAL_UNEXPECTED_SHAPE', { bindingId: 'SV.rozmir_suveniriv' });
  node.else = empty();
  return next;
}

function compare(runtime, publishedCompiled, patchedCompiled, products) {
  const result = { products: products.length, unchangedOutputs: 0, changedOutputs: [], newlyReady: 0, stillBlocked: 0,
    removedErrors: {}, remainingErrors: {} };
  for (const product of products) {
    const before = runtime.evaluateProduct(publishedCompiled, product), after = runtime.evaluateProduct(patchedCompiled, product);
    const changed = [];
    for (const row of ['base', 'english']) {
      for (const key of new Set([...Object.keys(before[row] || {}), ...Object.keys(after[row] || {})])) {
        const a = (before[row] || {})[key], b = (after[row] || {})[key];
        // Only an error-produced empty cell may stay empty; any other difference refuses.
        if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(row + '.' + key);
      }
    }
    if (changed.length) result.changedOutputs.push({ sku: product.public_sku, fields: changed });
    else result.unchangedOutputs++;
    const beforeFields = new Set(before.errors.map(e => e.field)), afterFields = new Set(after.errors.map(e => e.field));
    for (const field of beforeFields) if (!afterFields.has(field)) result.removedErrors[field] = (result.removedErrors[field] || 0) + 1;
    for (const field of afterFields) result.remainingErrors[field] = (result.remainingErrors[field] || 0) + 1;
    if (after.errors.length === 0 && before.errors.length > 0) result.newlyReady++;
    if (after.errors.length) result.stillBlocked++;
  }
  return result;
}

async function readState(runtime, db, cli) {
  const binding = (await db.query(`SELECT b.id,b.state,b.template_version_id,v.template_id,v.definition,v.definition_hash
    FROM magento_binding_revisions b JOIN export_template_versions v ON v.id=b.template_version_id WHERE b.id=$1`,
  [cli.bindingRevisionId])).rows[0];
  if (!binding || binding.state !== 'published') fail('SV_OPTIONAL_PUBLISHED_BINDING_REQUIRED');
  const latest = (await db.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=(SELECT installation_key
    FROM magento_binding_revisions WHERE id=$1) AND state='published' ORDER BY version_number DESC LIMIT 1`, [binding.id])).rows[0];
  if (latest?.id !== binding.id) fail('SV_OPTIONAL_BINDING_NOT_CURRENT');
  if (binding.definition_hash !== cli.definitionHash) fail('SV_OPTIONAL_DEFINITION_CHANGED');
  const published = runtime.compileDefinition(binding.definition);
  if (published.hash !== cli.definitionHash) fail('SV_OPTIONAL_DEFINITION_CHANGED');
  const patched = runtime.compileDefinition(patchDefinition(published.definition));
  const products = (await db.query(`SELECT p.*,i.public_sku FROM products p JOIN public_product_identities i
    ON i.id=p.public_product_identity_id WHERE p.category='SV' AND p.status='active' AND p.corrected_to_product_id IS NULL
    ORDER BY p.id`)).rows;
  return { binding, published, patched, comparison: compare(runtime, published, patched, products) };
}

function createRuntime(serverRoot) {
  const local = createRequire(path.join(serverRoot, 'package.json'));
  return { compileDefinition: local('./src/services/export-templates/definition').compileDefinition,
    evaluateProduct: local('./src/services/export-templates/evaluate').evaluateProduct,
    templates: local('./src/services/export-templates/template.service'), env: local('./src/config/env'), pg: local('pg') };
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const { env = process.env, print = console.log, printError = console.error } = dependencies;
  let pool;
  try {
    const cli = argumentsFor(args); if (cli.help) { print(HELP); return 0; }
    const runtime = dependencies.runtime || createRuntime(cli.serverRoot);
    if (!dependencies.pool) {
      const configuration = runtime.env.loadConfig(env);
      pool = new runtime.pg.Pool({ ...configuration.databaseOptions, max: 2,
        ssl: configuration.useSsl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: configuration.pgConnectTimeoutMs, statement_timeout: configuration.pgStatementTimeoutMs,
        ...(cli.mode === 'preview' ? { options: '-c default_transaction_read_only=on' } : {}) });
    }
    const db = dependencies.pool || pool;
    if ((await db.query('SELECT current_database() AS name')).rows[0]?.name !== cli.database) fail('SV_OPTIONAL_DATABASE_MISMATCH');
    const state = await readState(runtime, db, cli);
    const summary = { kind: 'preview', templateId: state.binding.template_id, publishedVersionId: state.binding.template_version_id,
      publishedHash: state.published.hash, patchedHash: state.patched.hash, ...state.comparison,
      changedOutputs: state.comparison.changedOutputs.slice(0, 20) };
    print(JSON.stringify(summary));
    if (state.comparison.changedOutputs.length) fail('SV_OPTIONAL_POPULATED_OUTPUT_CHANGED');
    if (cli.mode === 'preview') return 0;

    const options = { databasePool: db, mutationContext: { actorUserId: cli.actor } };
    const templateId = state.binding.template_id;
    let family = await runtime.templates.getTemplate(templateId, options);
    const draftHash = family.draft.definitionHash;
    // Never overwrite unrelated unpublished work in the family draft.
    if (![state.published.hash, state.patched.hash].includes(draftHash)) fail('SV_OPTIONAL_DRAFT_HAS_OTHER_CHANGES');
    let draft = family.draft;
    if (draftHash !== state.patched.hash) {
      draft = await runtime.templates.cloneDraft(templateId, { expectedRevision: String(draft.revision), versionId: state.binding.template_version_id }, options);
      draft = await runtime.templates.saveDraft(templateId, { expectedRevision: String(draft.revision), definition: state.patched.definition }, options);
    }
    if (draft.definitionHash !== state.patched.hash) fail('SV_OPTIONAL_DRAFT_HASH_MISMATCH');
    const version = await runtime.templates.publishTemplate(templateId,
      { expectedRevision: String(draft.revision), expectedDefinitionHash: state.patched.hash }, options);
    print(JSON.stringify({ kind: 'published', templateId, templateVersionId: version.id, version: version.versionNumber,
      definitionHash: state.patched.hash, bindingChanged: false,
      next: 'Settings -> Magento: prepare a successor from the current publication with this template version, review, then H3b publication.' }));
    return 0;
  } catch (error) {
    printError(JSON.stringify({ ok: false, code: error.code || 'SV_OPTIONAL_FAILED', ...(error.details ? { details: error.details } : {}) }));
    return 1;
  } finally { if (pool) await pool.end().catch(() => {}); }
}
if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { argumentsFor, patchDefinition, compare, main };
