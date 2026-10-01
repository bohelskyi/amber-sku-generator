const path = require('node:path');
const { randomUUID } = require('node:crypto');
const c = require('../src/services/magento/binding-contract');
const { parseMagentoConfig } = require('../src/config/magento');
const { assertEvidenceSafe } = require('../src/services/magento/binding-evidence-audit');
const { databaseSecrets } = require('./magento-binding-evidence-audit');
const { review, saveDecision } = require('../src/services/magento/binding-review');

const HELP = `npm run magento:bindings -- COMMAND [options]
bootstrap --installation KEY --template-version system|UUID --actor-user-id ID [--group KL|--route ROUTE] [--sku SKU]
clone --revision PUBLISHED_UUID --expected-revision N --actor-user-id ID
extend --revision DRAFT_UUID --expected-revision N --actor-user-id ID (--group BR|--route ROUTE) [--sku SKU]
review --revision UUID [--group KL|--route ROUTE] [--row base|english] [--states proposed,review_required,blocked]
approve-exact --revision UUID --expected-revision N --actor-user-id ID (--group KL|--route ROUTE) [--row base|english] [--targets code,code]
approve --revision UUID --expected-revision N --actor-user-id ID --binding REVIEW_ID [--accept-review --reason TEXT] [--policy POLICY] [--create-value 2]
block --revision UUID --expected-revision N --actor-user-id ID --binding REVIEW_ID --reason TEXT
validate --revision UUID
publish --revision UUID --expected-revision N --expected-current none|UUID --actor-user-id ID
All commands accept --json. Bootstrap creates a NEW draft with no approvals.
Clone copies the CURRENT publication exactly into a new draft, with source audit evidence.
Extend adds candidates only to untouched disabled routes; schema drift is rejected.
System mode freezes a dedicated evaluator publication without changing export selection.
Bulk exact approval excludes ownership policies and review-required/drift candidates.
Mutation actors must be active local users with existing template manage/publish permissions.
Only Amber binding/template data is written. Magento remains GET-only; no apply command.`;
const FLAGS = { '--installation': 'installationKey', '--template-version': 'templateVersionId', '--actor-user-id': 'actorUserId',
  '--group': 'group', '--route': 'routeKey', '--sku': 'sku', '--revision': 'id', '--expected-revision': 'expectedRevision',
  '--expected-current': 'expectedCurrentId', '--row': 'row', '--states': 'states', '--targets': 'targets',
  '--binding': 'binding', '--reason': 'reason', '--policy': 'policy', '--create-value': 'createValue', '--json': 'json', '--accept-review': 'acceptReview' };
function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [action, ...rest] = args;
  const allowed = {
    bootstrap: ['installationKey', 'templateVersionId', 'actorUserId', 'group', 'routeKey', 'sku'],
    clone: ['id', 'expectedRevision', 'actorUserId'],
    extend: ['id', 'expectedRevision', 'actorUserId', 'group', 'routeKey', 'sku'],
    review: ['id', 'group', 'routeKey', 'row', 'states'],
    'approve-exact': ['id', 'expectedRevision', 'actorUserId', 'group', 'routeKey', 'row', 'targets'],
    approve: ['id', 'expectedRevision', 'actorUserId', 'binding', 'acceptReview', 'reason', 'policy', 'createValue'],
    block: ['id', 'expectedRevision', 'actorUserId', 'binding', 'reason'],
    validate: ['id'], publish: ['id', 'expectedRevision', 'expectedCurrentId', 'actorUserId'],
  };
  if (!Object.hasOwn(allowed, action)) c.invalid();
  const out = { action };
  for (let i = 0; i < rest.length; i++) {
    const key = FLAGS[rest[i]];
    if (!key || ![...allowed[action], 'json'].includes(key) || Object.hasOwn(out, key)) c.invalid();
    if (['json', 'acceptReview'].includes(key)) { out[key] = true; continue; }
    const value = rest[++i];
    if (!value || value.startsWith('--') || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value)) c.invalid();
    out[key] = value;
  }
  const required = action === 'bootstrap' ? ['installationKey', 'templateVersionId', 'actorUserId'] : ['id',
    ...(['clone', 'extend', 'approve', 'approve-exact', 'block', 'publish'].includes(action) ? ['expectedRevision', 'actorUserId'] : []),
    ...(['approve', 'block'].includes(action) ? ['binding'] : []), ...(action === 'publish' ? ['expectedCurrentId'] : [])];
  if (required.some((k) => !out[k]) || (out.group && out.routeKey)) c.invalid();
  if (out.id) c.identity(out.id);
  if (out.templateVersionId && out.templateVersionId !== 'system') c.identity(out.templateVersionId);
  if (out.installationKey) c.installation(out.installationKey);
  if (out.expectedRevision) c.counter(out.expectedRevision);
  if (out.expectedCurrentId) { if (out.expectedCurrentId === 'none') out.expectedCurrentId = null; else c.identity(out.expectedCurrentId); }
  if (out.actorUserId && (!/^[1-9][0-9]*$/.test(out.actorUserId) || !Number.isSafeInteger(Number(out.actorUserId)))) c.invalid();
  if (out.group && !['BR', 'NM', 'KL', 'CH', 'AR', 'SV'].includes(out.group)) c.invalid();
  if (out.row && !['base', 'english'].includes(out.row)) c.invalid();
  if (['approve-exact', 'extend'].includes(action) && !out.group && !out.routeKey) c.invalid();
  if (action === 'block' && !out.reason?.trim()) c.invalid();
  if (out.targets) { out.targets = out.targets.split(','); if (!out.targets.length || out.targets.some((v) => !c.code(v))) c.invalid(); }
  if (out.states) { out.states = out.states.split(','); if (out.states.some((s) => !['approved', 'proposed', 'review_required', 'blocked'].includes(s))) c.invalid(); }
  return out;
}
const receipt = (r) => ({ id: r.id, revision: r.revision, state: r.state, templateVersionId: r.templateVersionId,
  counts: Object.fromEntries(['proposed', 'review_required', 'approved', 'blocked'].map((s) => [s, review(r, { states: [s] }).length])) });
async function runBindings({ args = [], env = process.env, databasePool, fetchImpl, print = console.log,
  printError = console.error, service, bootstrap } = {}) {
  let ownedPool;
  const json = args.includes('--json');
  try {
    const input = parseArguments(args);
    if (input.help) { print(HELP); return 0; }
    c.safeData(input, databaseSecrets(env));
    if (!databasePool) { ownedPool = require('../src/db/pool'); databasePool = ownedPool; }
    service ||= require('../src/services/magento/binding.service');
    const options = { databasePool, fetchImpl, sensitiveValues: databaseSecrets(env), bindingService: service,
      prepareReceipt: (r) => assertEvidenceSafe(receipt(r), {}, databaseSecrets(env)),
      mutationContext: { actorUserId: input.actorUserId, requestId: `magento-binding-cli-${randomUUID()}` } };
    let result; let successful = true;
    if (input.action === 'bootstrap') {
      const config = parseMagentoConfig(env);
      if (!config.configured) throw c.error(422, 'MAGENTO_NOT_CONFIGURED', 'Magento configuration required');
      const create = bootstrap || require('../src/services/magento/binding-bootstrap').bootstrap;
      result = receipt(await create(config, input, options));
    } else if (input.action === 'clone') {
      result = receipt(await service.clonePublished(input.id, { expectedRevision: input.expectedRevision }, options));
    } else if (input.action === 'extend') {
      const config = parseMagentoConfig(env);
      if (!config.configured) throw c.error(422, 'MAGENTO_NOT_CONFIGURED', 'Magento configuration required');
      result = receipt(await require('../src/services/magento/binding-bootstrap').extendDraft(config, input, options));
    } else if (input.action === 'review') {
      const r = await service.getRevision(input.id, options);
      result = { ...receipt(r), entries: review(r, { ...input, states: input.states || ['proposed', 'review_required', 'blocked'] }) };
    } else if (input.action === 'validate') {
      const r = await service.validateDraft(input.id, options);
      result = { id: r.id, revision: r.revision, valid: r.valid, diagnostics: r.diagnostics }; successful = r.valid;
    } else if (input.action === 'publish') {
      result = receipt(await service.publishDraft(input.id, { expectedRevision: input.expectedRevision,
        expectedCurrentId: input.expectedCurrentId }, options));
    } else {
      const changed = await saveDecision(input.id, input, options);
      result = { ...receipt(changed.revision), changed: changed.changed };
    }
    assertEvidenceSafe(result, {}, databaseSecrets(env));
    if (input.json) print(JSON.stringify({ ok: successful, ...result }));
    else {
      print(`Binding ${result.id}; revision ${result.revision}; ${result.state || (result.valid ? 'VALID' : 'NOT VALID')}`);
      if (result.templateVersionId) print(`Template: ${result.templateVersionId}; ${JSON.stringify(result.counts)}`);
      for (const e of result.entries || []) {
        print(`${e.reviewState} ${e.group} ${e.row || 'route'} ${e.target}: ${e.source || e.evaluated || ''} -> ${e.identity ?? 'unresolved'} / ${e.label ?? ''}\n  ${e.id}${e.evidence?.diagnosticCodes?.length ? ` [${e.evidence.diagnosticCodes.join(', ')}]` : ''}`);
        if (e.identity === null) print(`  Candidates: ${JSON.stringify(e.candidates || e.evidence?.candidateIds || [])}`);
      }
      if (result.changed) print(`Explicitly changed ${result.changed.length} decisions; ownership policies were not bulk-approved.`);
      for (const d of result.diagnostics || []) print(JSON.stringify(d));
      print('Magento writes: NONE');
    }
    return successful ? 0 : 2;
  } catch (cause) {
    let diagnostic = { code: typeof cause.code === 'string' && /^(MAGENTO|TEMPLATE|ADMIN|EXPORT|LIFECYCLE)_[A-Z0-9_]+$/.test(cause.code)
      ? cause.code : 'MAGENTO_BINDING_COMMAND_FAILED' };
    if (Array.isArray(cause.details?.diagnostics)) diagnostic.diagnostics = cause.details.diagnostics;
    try { assertEvidenceSafe(diagnostic, {}, [...databaseSecrets(env), ...Object.entries(env)
      .filter(([key]) => /^MAGENTO_(CONSUMER|ACCESS)_/.test(key)).map(([, value]) => value)]); }
    catch { diagnostic = { code: 'MAGENTO_BINDING_COMMAND_FAILED' }; }
    printError(JSON.stringify(diagnostic));
    if (json) print(JSON.stringify({ ok: false }));
    return 1;
  } finally { if (ownedPool) await ownedPool.end().catch(() => {}); }
}
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  runBindings({ args: process.argv.slice(2) }).then((code) => { process.exitCode = code; });
}
module.exports = { parseArguments, runBindings };
