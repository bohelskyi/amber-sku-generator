const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const runner = require('../scripts/first-sync-history-batch');
const c = require('../src/services/magento/binding-contract');
const batch = require('../src/services/magento/first-sync-batch-preflight');
const audit = require('../src/services/magento/binding-evidence-audit');

const binding = '11111111-1111-4111-8111-111111111111';
const definitionHash = 'a'.repeat(64);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const item = (id = 1) => ({ sku: 'NM' + id, productId: id, remoteProductId: 1000 + id });
const scope = (items = [item()]) => ({ bindingRevisionId: binding, expectedDefinitionHash: definitionHash, installationKey: 'amber', items });
const config = { configured: true, baseUrl: 'https://history.example.invalid' };
const parseLines = async file => (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);

async function fixture(t, count = 1) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-history-batch-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = scope(Array.from({ length: count }, (_, index) => item(index + 1)));
  const bytes = Buffer.from(JSON.stringify(input)), output = path.join(dir, 'journal.jsonl');
  const revision = { id: binding, state: 'published', installationKey: 'amber', definitionHash,
    originHash: c.originHash(config.baseUrl), schema: { storeCode: 'all' } };
  const scenarios = input.items.map(current => {
    const product = { id: current.productId, public_sku: current.sku, full_sku: current.sku, category: 'NM', status: 'active',
      public_product_identity_id: String(current.productId + 2000), weight: '12.400', total_price_uah: '1200.00',
      exclude_from_export: 0, corrected_to_product_id: null, details: { answers: { color: '1' } } };
    const observation = { amber: { product, revision: clone(revision), compiled: { hash: definitionHash } },
      raw: { id: current.remoteProductId, sku: current.sku } };
    const report = { mode: 'update', identity: { state: 'found', article: current.sku, observedMagentoId: current.remoteProductId },
      amberProduct: { publicSku: current.sku }, blockers: [], sendable: true };
    const previewToken = c.hash(current);
    const review = { mode: 'review', sku: current.sku, fields: [], readyForOutbound: false, complete: false,
      blockers: [{ code: 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED' }],
      historyReview: { scope: 'first_sync_review_only', sku: current.sku, remoteProductId: current.remoteProductId,
        previewToken, legacySnapshotFlag: true, doesNotAcknowledgeExport: true },
      historyReviewAssessment: { status: 'available', legacySnapshotFlag: true, code: 'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE' } };
    return { item: current, observation, report, review, admitted: false, root: String(3000 + current.productId),
      proofValid: true, guards: { protectedWork: false, otherOrigin: false } };
  });
  const messages = [], errors = [], calls = [], queries = [];
  const pool = {
    query: async sql => {
      queries.push(sql);
      assert.equal(sql, 'SELECT current_database() AS name');
      return { rows: [{ name: 'history_fixture_test' }] };
    },
    connect: async () => ({
      query: async (sql, params) => {
        queries.push(sql);
        if (sql.includes('FROM magento_binding_revisions')) {
          assert.deepEqual(params, ['amber']); return { rows: [{ id: revision.id }] };
        }
        assert.ok(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].includes(sql), sql);
        return { rows: [] };
      },
      release: () => {},
    }),
  };
  const f = { dir, input, bytes, output, scenarios, messages, errors, calls, queries, pool, revision };
  const runtime = { c, batch, audit, databaseSecrets: () => [],
    access: { assertActorStillAuthorized: async (_client, actor, permission, _error, options) => {
      assert.equal(actor, 7); assert.equal(permission, 'export_templates.publish'); assert.equal(options.readOnly, true);
      if (f.authorityFailure) throw f.authorityFailure;
    } },
    publication: { administrator: async (_client, actor) => { assert.equal(actor, 7); } },
    bindings: { readRevisionOnClient: async (_client, id) => { assert.equal(id, revision.id); return clone(revision); } },
    preview: async (_config, options) => {
      calls.push({ stage: 'preview', sku: options.sku });
      const s = scenarios.find(row => row.item.sku === options.sku);
      options.onObservation(s.observation);
      return s.report;
    },
    first: {
      review: async (_config, selection, options) => {
        assert.deepEqual(Object.keys(selection).sort(), ['bindingRevisionId', 'sku']);
        calls.push({ stage: 'review', sku: selection.sku });
        const s = scenarios.find(row => row.item.sku === selection.sku);
        if (f.beforeReview) await f.beforeReview(s, options);
        await options.preview(config, { ...selection, onObservation: () => {} });
        return s.admitted ? { ...clone(s.review), mode: 'first', historyReview: undefined } : clone(s.review);
      },
      apply: () => assert.fail('Field decisions are outside the history runner'),
    },
    admission: {
      apply: async (_config, command, options) => {
        calls.push({ stage: 'apply', sku: command.sku, command: clone(command) });
        assert.deepEqual(Object.keys(command).sort(), ['bindingRevisionId', 'previewToken', 'sku']);
        const s = scenarios.find(row => row.item.sku === command.sku);
        if (f.beforeApply) await f.beforeApply(s, options);
        await options.preview(config, { sku: command.sku, bindingRevisionId: command.bindingRevisionId, onObservation: () => {} });
        if (s.failure) throw s.failure;
        s.admitted = true;
        if (s.afterCommitFailure) throw s.afterCommitFailure;
        return s.result || { sku: command.sku, scope: 'first_sync_review_only', doesNotAcknowledgeExport: true,
          receipt: { auditEventId: s.root, alreadyApplied: false } };
      },
      allows: (observation, proof) => Boolean(proof?.valid && proof.productId === observation.amber.product.id),
      rootId: proof => proof?.root,
    },
    eligibility: { readFirstSyncEligibility: async (_client, _config, observation) => {
      calls.push({ stage: 'eligibility', sku: observation.raw.sku });
      const s = scenarios.find(row => row.item.productId === observation.amber.product.id);
      return { mode: s.eligibilityMode || 'first', admissionGuards: s.guards,
        historyAdmission: { root: s.root, valid: s.proofValid, productId: s.item.productId } };
    } },
  };
  f.runtime = runtime;
  f.dependencies = { runtime, config, pool, env: {}, read: async () => f.bytes,
    print: value => messages.push(JSON.parse(value)), printError: value => errors.push(JSON.parse(value)) };
  return f;
}
const args = (f, mode = 'apply', output = f.output) => ['--mode', mode, '--input', path.join(f.dir, 'input.json'),
  '--scope-sha256', hash(f.bytes), '--output', output, '--expected-database', 'history_fixture_test', '--actor-id', '7'];
const receipts = lines => lines.filter(line => line.type === 'receipt');

test('history scope accepts exactly bounded identities and rejects mutation fields, duplicate or incomplete candidates', () => {
  const runtime = { c, batch };
  assert.doesNotThrow(() => runner.validateInput(scope(), runtime));
  assert.doesNotThrow(() => runner.validateInput(scope(Array.from({ length: 50 }, (_, index) => item(index + 1))), runtime));
  const changes = [
    value => { value.items = []; },
    value => { value.items = Array.from({ length: 51 }, (_, index) => item(index + 1)); },
    value => { value.items = Array(1); },
    value => { value.items.push(clone(value.items[0])); },
    value => { value.items.push({ ...item(2), productId: 1 }); },
    value => { value.items.push({ ...item(2), remoteProductId: 1001 }); },
    value => { value.items[0].fields = []; },
    value => { value.items[0].choices = [{ target: 'price', scope: 'all', choice: 'keep_local' }]; },
    value => { value.items[0].previewToken = 'b'.repeat(64); },
    value => { value.items[0].sku = ' NM1'; },
    value => { value.items[0].productId = '1'; },
    value => { value.items[0].remoteProductId = null; },
    value => { value.items[0].remoteProductId = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.bindingRevisionId = 'not-a-revision'; },
    value => { value.expectedDefinitionHash = 'A'.repeat(64); },
    value => { value.installationKey = 'not an installation'; },
  ];
  for (const change of changes) {
    const value = scope(); change(value);
    assert.throws(() => runner.validateInput(value, runtime));
  }
});

test('history transport firewall allows only bodyless GET including native Request objects', async () => {
  const calls = [], get = runner.getOnly(async (...params) => { calls.push(params); return 'read'; });
  assert.equal(await get('https://history.example.invalid'), 'read');
  assert.equal(await get('https://history.example.invalid', { method: 'get' }), 'read');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.throws(() => get('https://history.example.invalid', { method }));
    assert.throws(() => get(new Request('https://history.example.invalid', { method })));
  }
  assert.throws(() => get('https://history.example.invalid', { method: 'GET', body: 'payload' }));
  assert.equal(calls.length, 2);
});

test('history help does not load runtime, resolve credentials, read input or open a database', async () => {
  const lines = [], dependencies = { env: {}, print: line => lines.push(line), printError: () => assert.fail('Unexpected error'),
    read: () => assert.fail('Help read an input file') };
  for (const name of ['runtime', 'config', 'pool']) Object.defineProperty(dependencies, name, { get() { assert.fail('Help accessed ' + name); } });
  assert.equal(await runner.main(['--help'], dependencies), 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /history/i);
});

test('runtime delegates to the existing canonical review and cutover admission services', () => {
  const runtime = runner.createRuntime(path.join(__dirname, '..'));
  assert.equal(runtime.first, require('../src/services/magento/first-sync.service'));
  assert.equal(runtime.admission, require('../src/services/magento/first-sync-cutover-admission'));
  assert.equal(runtime.preview, require('../src/services/magento/sync-preview').previewProduct);
});

test('both modes require an explicit exact raw-byte scope digest and known mode', () => {
  const valid = ['--mode', 'preview', '--input', 'scope.json', '--scope-sha256', 'a'.repeat(64),
    '--output', 'new.jsonl', '--expected-database', 'fixture_test', '--actor-id', '7'];
  assert.doesNotThrow(() => runner.argumentsFor(valid));
  for (const invalid of [[], ['--help', '--mode', 'apply'], valid.filter((_, index) => index !== 4 && index !== 5),
    [...valid, '--resume', 'old.jsonl'], [...valid, '--mode', 'apply'], valid.map(value => value === 'preview' ? 'enqueue' : value)]) {
    assert.throws(() => runner.argumentsFor(invalid), { code: 'HISTORY_BATCH_ARGUMENTS' });
  }
});

test('preview checkpoints fresh proposals without calling admission or field apply', async t => {
  const f = await fixture(t, 2);
  assert.equal(await runner.main(args(f, 'preview'), f.dependencies), 0, JSON.stringify(f.errors));
  const lines = await parseLines(f.output);
  assert.deepEqual(lines.map(line => line.type), ['start', 'prepared', 'receipt', 'prepared', 'receipt', 'complete']);
  assert.ok(receipts(lines).every(row => row.status === 'available'));
  assert.equal(f.calls.filter(call => call.stage === 'apply').length, 0);
  assert.equal(lines[0].scopeHash, hash(f.bytes));
  assert.equal(lines[0].actorUserId, 7);
  assert.equal(lines[0].database, 'history_fixture_test');
  assert.equal(lines.at(-1).available, 2);
  assert.equal(lines.at(-1).directRemoteWrites, 0);
  assert.equal(lines.at(-1).directlyEnqueuedJobs, 0);
});

test('all 50 exact approved identities apply sequentially after prepared checkpoint and before the next receipt', async t => {
  const f = await fixture(t, 50);
  let next = 0;
  f.beforeReview = async s => {
    const lines = await parseLines(f.output);
    assert.equal(receipts(lines).length, next);
    assert.equal(s.item.sku, 'NM' + (next + 1));
  };
  f.beforeApply = async s => {
    const lines = await parseLines(f.output), latest = lines.at(-1);
    assert.equal(latest.type, 'prepared');
    assert.equal(latest.sku, s.item.sku);
    assert.equal(latest.command.previewToken, s.review.historyReview.previewToken);
    assert.equal(latest.sourceHash, c.hash(batch.source(s.observation.amber.product)));
    next++;
  };
  assert.equal(await runner.main(args(f), f.dependencies), 0, JSON.stringify(f.errors));
  const lines = await parseLines(f.output), summary = lines.at(-1);
  assert.equal(summary.complete, true);
  assert.equal(summary.recorded, 50);
  assert.equal(summary.notChecked, 0);
  assert.equal(summary.directRemoteWrites, 0);
  assert.equal(summary.directlyEnqueuedJobs, 0);
  assert.equal(lines.length, 102);
  assert.deepEqual(f.calls.filter(call => call.stage === 'apply').map(call => call.sku), f.input.items.map(row => row.sku));
  assert.equal(f.messages.filter(message => message.type !== 'complete').length, 50);
  assert.ok(f.queries.every(sql => /^(SELECT|BEGIN|COMMIT|ROLLBACK)/.test(sql)));
});

test('ordinary category blockers are retained in audit-only results without blocking explicitly approved history admission', async t => {
  const f = await fixture(t);
  f.scenarios[0].report.sendable = false;
  f.scenarios[0].report.blockers = [{ code: 'CATEGORY_IDENTITIES_REVIEW_REQUIRED', unrelated: 'not copied' }];
  assert.equal(await runner.main(args(f), f.dependencies), 0);
  const result = receipts(await parseLines(f.output))[0];
  assert.equal(result.status, 'recorded');
  assert.deepEqual(result.ordinaryBlockers, [{ code: 'CATEGORY_IDENTITIES_REVIEW_REQUIRED' }]);
  assert.equal(result.doesNotAcknowledgeExport, true);
  assert.equal(result.scope, 'first_sync_review_only');
});

test('changed raw input bytes fail before any pool or runtime access even when parsed JSON is equal', async t => {
  const f = await fixture(t), originalArgs = args(f);
  f.dependencies.read = async () => Buffer.from(JSON.stringify(f.input, null, 2));
  Object.defineProperty(f.dependencies, 'runtime', { get() { assert.fail('Runtime accessed before raw scope verification'); } });
  Object.defineProperty(f.dependencies, 'pool', { get() { assert.fail('Pool accessed before raw scope verification'); } });
  assert.equal(await runner.main(originalArgs, f.dependencies), 1);
  assert.equal(f.errors[0].code, 'HISTORY_BATCH_SCOPE_HASH_MISMATCH');
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});

test('real database mismatch aborts before creating a journal or calling review', async t => {
  const f = await fixture(t); f.pool.query = async () => ({ rows: [{ name: 'other_test' }] });
  assert.equal(await runner.main(args(f), f.dependencies), 1);
  assert.equal(f.errors[0].code, 'HISTORY_BATCH_DATABASE_MISMATCH');
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});

test('journal is private and exclusive and never overwrites an earlier run', async t => {
  const f = await fixture(t);
  assert.equal(await runner.main(args(f, 'preview'), f.dependencies), 0);
  const before = await fs.readFile(f.output, 'utf8'), callCount = f.calls.length;
  assert.equal((await fs.stat(f.output)).mode & 0o777, 0o600);
  assert.equal(await runner.main(args(f), f.dependencies), 1);
  assert.equal(f.errors.at(-1).code, 'HISTORY_BATCH_OUTPUT_EXISTS');
  assert.equal(f.calls.length, callCount);
  assert.equal(await fs.readFile(f.output, 'utf8'), before);
});

test('exact identity and publication mismatches prevent even preparing an admission', async t => {
  const changes = [
    ['local product', s => { s.observation.amber.product.id = 99; }, 'HISTORY_BATCH_IDENTITY_CHANGED'],
    ['local SKU', s => { s.observation.amber.product.public_sku = 'OTHER'; }, 'HISTORY_BATCH_IDENTITY_CHANGED'],
    ['reported article', s => { s.report.identity.article = 'OTHER'; }, 'HISTORY_BATCH_IDENTITY_CHANGED'],
    ['reported remote ID', s => { s.report.identity.observedMagentoId = 99; }, 'HISTORY_BATCH_IDENTITY_CHANGED'],
    ['observed remote ID', s => { s.observation.raw.id = 99; }, 'HISTORY_BATCH_IDENTITY_CHANGED'],
    ['observed remote SKU', s => { s.observation.raw.sku = 'OTHER'; }, 'HISTORY_BATCH_IDENTITY_CHANGED'],
    ['reported local SKU', s => { s.report.amberProduct.publicSku = 'OTHER'; }, 'HISTORY_BATCH_IDENTITY_CHANGED'],
    ['missing remote', s => { s.report.identity.state = 'missing'; }, 'HISTORY_BATCH_IDENTITY_CHANGED'],
    ['create report', s => { s.report.mode = 'create'; }, 'HISTORY_BATCH_IDENTITY_CHANGED'],
    ['binding', s => { s.observation.amber.revision.id = '22222222-2222-4222-8222-222222222222'; }, 'HISTORY_BATCH_PUBLICATION_CHANGED'],
    ['compiled definition', s => { s.observation.amber.compiled.hash = 'b'.repeat(64); }, 'HISTORY_BATCH_PUBLICATION_CHANGED'],
  ];
  for (const [name, change, code] of changes) await t.test(name, async t => {
    const f = await fixture(t, 2); change(f.scenarios[0]);
    assert.equal(await runner.main(args(f), f.dependencies), 2);
    const lines = await parseLines(f.output);
    assert.equal(receipts(lines)[0].code, code);
    assert.equal(lines.filter(line => line.type === 'prepared').length, 0);
    assert.equal(f.calls.filter(call => call.stage === 'apply').length, 0);
    assert.equal(lines.at(-1).notChecked, 1);
  });
});

test('fresh source or identity drift between review and canonical apply stops the tail', async t => {
  for (const [name, change, code] of [
    ['source', s => { s.observation.amber.product.weight = '12.500'; }, 'HISTORY_BATCH_SOURCE_CHANGED'],
    ['identity', s => { s.observation.raw.id = 9999; }, 'HISTORY_BATCH_IDENTITY_CHANGED'],
  ]) await t.test(name, async t => {
    const f = await fixture(t, 3);
    f.beforeApply = async s => { if (s.item.sku === 'NM2') change(s); };
    assert.equal(await runner.main(args(f), f.dependencies), 2);
    const lines = await parseLines(f.output), rows = receipts(lines);
    assert.equal(rows[0].status, 'recorded');
    assert.equal(rows[1].status, 'blocked');
    assert.equal(rows[1].code, code);
    assert.equal(lines.at(-1).notChecked, 1);
    assert.deepEqual(f.calls.filter(call => call.stage === 'review').map(call => call.sku), ['NM1', 'NM2']);
  });
});

test('first-sync state without exact flag-only scoped available proposal cannot gain admission', async t => {
  const changes = [
    s => { s.review.mode = 'ordinary'; },
    s => { s.review.blockers.push({ code: 'OTHER_HISTORY_BLOCKER' }); },
    s => { s.review.historyReviewAssessment.status = 'blocked'; },
    s => { s.review.historyReviewAssessment.legacySnapshotFlag = false; },
    s => { s.review.historyReview.scope = 'ordinary_delivery'; },
    s => { s.review.historyReview.doesNotAcknowledgeExport = false; },
    s => { s.review.historyReview.remoteProductId = 99; },
    s => { s.review.historyReview.previewToken = 'bad'; },
  ];
  for (const [index, change] of changes.entries()) await t.test(String(index), async t => {
    const f = await fixture(t); change(f.scenarios[0]);
    assert.equal(await runner.main(args(f), f.dependencies), 2);
    assert.equal(receipts(await parseLines(f.output))[0].code, 'HISTORY_BATCH_ADMISSION_NOT_AVAILABLE');
    assert.equal(f.calls.filter(call => call.stage === 'apply').length, 0);
  });
});

test('canonical stale-token rejection is blocked, receipt uncertainty is unconfirmed, and neither retries nor advances', async t => {
  for (const [failure, status, code] of [
    [Object.assign(Error('Stale'), { statusCode: 409, code: 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED' }), 'blocked', 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED'],
    [Object.assign(Error('Private connection detail'), { code: 'ECONNRESET' }), 'unconfirmed', 'ECONNRESET'],
    [Object.assign(Error('Service failed'), { statusCode: 503, code: 'SERVICE_FAILED' }), 'unconfirmed', 'SERVICE_FAILED'],
  ]) await t.test(status + ' ' + code, async t => {
    const f = await fixture(t, 3); f.scenarios[1].failure = failure;
    assert.equal(await runner.main(args(f), f.dependencies), 2);
    const lines = await parseLines(f.output), rows = receipts(lines);
    assert.equal(rows[0].status, 'recorded');
    assert.equal(rows[1].status, status);
    assert.equal(rows[1].code, code);
    assert.equal(lines.at(-1).notChecked, 1);
    assert.equal(lines.at(-1).complete, false);
    assert.equal(f.calls.filter(call => call.stage === 'apply').length, 2);
    assert.ok(!JSON.stringify(lines).includes('Private connection detail'));
  });
});

test('malformed canonical receipt stays unconfirmed and prevents the next product', async t => {
  const f = await fixture(t, 2);
  f.scenarios[0].result = { sku: 'NM1', scope: 'first_sync_review_only', doesNotAcknowledgeExport: true,
    receipt: { auditEventId: '3001', alreadyApplied: 'false' } };
  assert.equal(await runner.main(args(f), f.dependencies), 2);
  const lines = await parseLines(f.output);
  assert.equal(receipts(lines)[0].status, 'unconfirmed');
  assert.equal(lines.at(-1).notChecked, 1);
  assert.equal(f.calls.filter(call => call.stage === 'apply').length, 1);
});

test('a lost commit response requires an explicit new journal and fresh opaque proof rather than automatic retry', async t => {
  const f = await fixture(t, 2);
  f.scenarios[0].afterCommitFailure = Object.assign(Error('Lost response'), { code: 'ECONNRESET' });
  assert.equal(await runner.main(args(f), f.dependencies), 2);
  assert.equal(f.scenarios[0].admitted, true);
  assert.equal(f.calls.filter(call => call.stage === 'apply').length, 1);
  const retryOutput = path.join(f.dir, 'explicit-recheck.jsonl');
  assert.equal(await runner.main(args(f, 'apply', retryOutput), f.dependencies), 0);
  const lines = await parseLines(retryOutput), rows = receipts(lines);
  assert.equal(rows[0].status, 'already_admitted');
  assert.deepEqual(rows[0].existing, { rootAuditEventId: '3001', verifiedCurrentAdmission: true });
  assert.equal(rows[0].receipt, undefined, 'A validated root is not presented as a newly recorded admission receipt');
  assert.equal(rows[1].status, 'recorded');
  assert.equal(f.calls.filter(call => call.stage === 'apply' && call.sku === 'NM1').length, 1);
  assert.equal(f.calls.filter(call => call.stage === 'eligibility' && call.sku === 'NM1').length, 1);
  assert.equal(lines.at(-1).already_admitted, 1);
});

test('already admitted products require live proof, exact root identity and clear current admission guards', async t => {
  const changes = [
    s => { s.proofValid = false; },
    s => { s.root = null; },
    s => { s.guards.protectedWork = true; },
    s => { s.guards.otherOrigin = true; },
    s => { s.eligibilityMode = 'review'; },
  ];
  for (const [index, change] of changes.entries()) await t.test(String(index), async t => {
    const f = await fixture(t, 2); f.scenarios[0].admitted = true; change(f.scenarios[0]);
    assert.equal(await runner.main(args(f), f.dependencies), 2);
    const lines = await parseLines(f.output);
    assert.equal(receipts(lines)[0].code, 'HISTORY_BATCH_EXISTING_ADMISSION_UNCONFIRMED');
    assert.equal(lines.at(-1).notChecked, 1);
    assert.equal(f.calls.filter(call => call.stage === 'apply').length, 0);
  });
});

test('authority revocation or publication change after preparation prevents admission and stops the tail', async t => {
  for (const code of ['ADMIN_PERMISSION_REVOKED', 'HISTORY_BATCH_PUBLICATION_CHANGED']) await t.test(code, async t => {
    const f = await fixture(t, 2);
    const original = f.runtime.first.review;
    f.runtime.first.review = async (...params) => {
      const result = await original(...params);
      if (code === 'ADMIN_PERMISSION_REVOKED') f.authorityFailure = Object.assign(Error('Revoked'), { code, statusCode: 403 });
      else f.revision.definitionHash = 'b'.repeat(64);
      return result;
    };
    assert.equal(await runner.main(args(f), f.dependencies), 2);
    const lines = await parseLines(f.output);
    assert.equal(lines[1].type, 'prepared');
    assert.equal(receipts(lines)[0].code, code);
    assert.equal(lines.at(-1).notChecked, 1);
    assert.equal(f.calls.filter(call => call.stage === 'apply').length, 0);
  });
});

test('an interruption after prepared evidence prevents any admission and removes temporary signal handlers', async t => {
  const f = await fixture(t, 2), original = f.runtime.first.review;
  const sigint = process.listenerCount('SIGINT'), sigterm = process.listenerCount('SIGTERM');
  f.runtime.first.review = async (...params) => {
    const result = await original(...params); process.emit('SIGINT'); return result;
  };
  assert.equal(await runner.main(args(f), f.dependencies), 2);
  const lines = await parseLines(f.output);
  assert.equal(receipts(lines)[0].code, 'HISTORY_BATCH_INTERRUPTED');
  assert.equal(f.calls.filter(call => call.stage === 'apply').length, 0);
  assert.equal(lines.at(-1).notChecked, 1);
  assert.equal(process.listenerCount('SIGINT'), sigint);
  assert.equal(process.listenerCount('SIGTERM'), sigterm);
});

test('failed prepared journal checkpoint propagates before canonical apply and never becomes a retry', async t => {
  const f = await fixture(t);
  const failure = Object.assign(Error('Disk full'), { code: 'ENOSPC' });
  await assert.rejects(runner.runItem(f.runtime, config, f.input.items[0], f.input,
    { databasePool: f.pool, actorUserId: 7, sensitiveValues: [] },
    { mode: 'apply', append: async value => { assert.equal(value.type, 'prepared'); throw failure; } }), { code: 'ENOSPC' });
  assert.equal(failure.journalFailure, true);
  assert.equal(f.calls.filter(call => call.stage === 'apply').length, 0);
  assert.equal(f.scenarios[0].admitted, false);
});

test('failed receipt checkpoint after canonical commit reports uncertainty and never starts the next SKU', async t => {
  const f = await fixture(t, 2), open = fs.open;
  t.mock.method(fs, 'open', async (...params) => {
    const handle = await open(...params);
    if (params[0] === f.output) {
      const write = handle.write.bind(handle);
      handle.write = async (buffer, ...rest) => {
        if (buffer.toString('utf8').includes('"type":"receipt"')) throw Object.assign(Error('Disk full'), { code: 'ENOSPC' });
        return write(buffer, ...rest);
      };
    }
    return handle;
  });
  assert.equal(await runner.main(args(f), f.dependencies), 1);
  assert.equal(f.errors[0].code, 'ENOSPC');
  assert.equal(f.errors[0].localResultUnconfirmed, true);
  assert.deepEqual((await parseLines(f.output)).map(row => row.type), ['start', 'prepared']);
  assert.equal(f.calls.filter(call => call.stage === 'apply').length, 1);
  assert.equal(f.scenarios[0].admitted, true);
  assert.equal(f.scenarios[1].admitted, false);
});

test('normal CLI input reads verify the actual file bytes rather than a parsed reserialization', async t => {
  const f = await fixture(t);
  const inputPath = path.join(f.dir, 'input.json');
  await fs.writeFile(inputPath, f.bytes);
  delete f.dependencies.read;
  assert.equal(await runner.main(args(f, 'preview'), f.dependencies), 0);
  assert.equal((await parseLines(f.output))[0].scopeHash, hash(await fs.readFile(inputPath)));
});

test('zero-byte prepared write fails immediately before admission without retrying the stalled writer', async t => {
  const f = await fixture(t, 2), open = fs.open;
  let stalledWrites = 0;
  t.mock.method(fs, 'open', async (...params) => {
    const handle = await open(...params);
    if (params[0] === f.output) {
      const write = handle.write.bind(handle);
      handle.write = async (buffer, ...rest) => {
        if (buffer.toString('utf8').includes('"type":"prepared"')) {
          if (++stalledWrites > 1) throw Object.assign(Error('Unexpected write retry'), { code: 'ZERO_WRITE_RETRIED' });
          return { bytesWritten: 0, buffer };
        }
        return write(buffer, ...rest);
      };
    }
    return handle;
  });
  assert.equal(await runner.main(args(f), f.dependencies), 1);
  assert.equal(f.errors[0].code, 'HISTORY_BATCH_JOURNAL_WRITE_FAILED');
  assert.equal(stalledWrites, 1);
  assert.equal(f.calls.filter(call => call.stage === 'apply').length, 0);
  assert.deepEqual((await parseLines(f.output)).map(row => row.type), ['start']);
  assert.ok(f.scenarios.every(s => !s.admitted));
});

test('journal directory is synced once after exclusive creation and before domain authorization', async t => {
  const f = await fixture(t), open = fs.open, authorize = f.runtime.access.assertActorStillAuthorized;
  let directorySyncs = 0, directoryCloses = 0;
  t.mock.method(fs, 'open', async (...params) => {
    const handle = await open(...params);
    if (params[0] === f.dir) {
      const sync = handle.sync.bind(handle), close = handle.close.bind(handle);
      handle.sync = async () => {
        assert.equal((await fs.stat(f.output)).size, 0);
        assert.equal(f.calls.length, 0);
        directorySyncs++; return sync();
      };
      handle.close = async () => { directoryCloses++; return close(); };
    }
    return handle;
  });
  f.runtime.access.assertActorStillAuthorized = async (...params) => {
    assert.equal(directorySyncs, 1);
    assert.equal(directoryCloses, 1);
    return authorize(...params);
  };
  assert.equal(await runner.main(args(f), f.dependencies), 0);
  assert.equal(directorySyncs, 1);
  assert.equal(directoryCloses, 1);
});

test('directory sync failure closes its handle and aborts before any domain call', async t => {
  const f = await fixture(t), open = fs.open;
  let directoryCloses = 0, authorizations = 0;
  t.mock.method(fs, 'open', async (...params) => {
    const handle = await open(...params);
    if (params[0] === f.dir) {
      const close = handle.close.bind(handle);
      handle.sync = async () => { throw Object.assign(Error('Directory sync failed'), { code: 'EIO' }); };
      handle.close = async () => { directoryCloses++; return close(); };
    }
    return handle;
  });
  f.runtime.access.assertActorStillAuthorized = async () => { authorizations++; };
  assert.equal(await runner.main(args(f), f.dependencies), 1);
  assert.equal(f.errors[0].code, 'EIO');
  assert.equal(directoryCloses, 1);
  assert.equal(authorizations, 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await fs.stat(f.output)).size, 0);
});

test('--preview-all reports later items after an item-level blocker; apply never continues', async t => {
  for (const all of [false, true]) {
    const f = await fixture(t, 3);
    f.scenarios[1].review.blockers = [{ code: 'FIRST_SYNC_IDENTITY_CHANGED' }];
    const code = await runner.main([...args(f, 'preview'), ...(all ? ['--preview-all'] : [])], f.dependencies);
    assert.equal(code, 2, JSON.stringify(f.errors));
    const lines = await parseLines(f.output), rows = receipts(lines);
    assert.deepEqual(rows.map(row => row.status), all ? ['available', 'blocked', 'available'] : ['available', 'blocked']);
    assert.equal(lines.at(-1).notChecked, all ? 0 : 1);
    assert.equal(f.calls.filter(call => call.stage === 'apply').length, 0);
  }
  assert.throws(() => runner.argumentsFor(['--mode', 'apply', '--input', 'x', '--scope-sha256', 'a'.repeat(64), '--output', 'y',
    '--expected-database', 'd', '--actor-id', '7', '--preview-all']), /HISTORY_BATCH_ARGUMENTS/);
  for (const seconds of ['-1', '601', '1.5', 'x']) assert.throws(() => runner.argumentsFor(['--mode', 'preview', '--input', 'x',
    '--scope-sha256', 'a'.repeat(64), '--output', 'y', '--expected-database', 'd', '--actor-id', '7', '--schema-cache-seconds', seconds]), /HISTORY_BATCH_ARGUMENTS/);
  assert.equal(runner.argumentsFor(['--mode', 'preview', '--input', 'x', '--scope-sha256', 'a'.repeat(64), '--output', 'y',
    '--expected-database', 'd', '--actor-id', '7', '--schema-cache-seconds', '120']).schemaCacheSeconds, 120);
});
