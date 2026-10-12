const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const runner = require('../scripts/first-sync-campaign-history');
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-history-campaign-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = scope(Array.from({ length: count }, (_, index) => item(index + 1)));
  const bytes = Buffer.from(JSON.stringify(input, null, 2) + '\n'), output = path.join(dir, 'campaign');
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
    query: async (sql, params) => {
      queries.push(sql);
      if (sql.includes('FROM audit_events')) {
        const s = scenarios.find(row => row.root === String(params[0]));
        if (!s || !s.admitted) return { rows: [] };
        const previewToken = s.review.historyReview.previewToken;
        const receipt = { id: s.root, event_key: 'product.magento_first_sync_cutover_reviewed',
          subject_type: 'magento_first_sync_cutover_admission', subject_id: previewToken,
          details: { previewToken, remoteWrites: 0, enqueued: false,
            admission: { format: 'magento-first-sync-cutover-admission-v1', scope: 'first_sync_review_only',
              doesNotAcknowledgeExport: true, rootAdmissionEventId: null,
              identity: { productId: s.item.productId, publicIdentityId: s.observation.amber.product.public_product_identity_id,
                sku: s.item.sku, remoteId: s.item.remoteProductId, originHash: revision.originHash,
                installationKey: revision.installationKey, bindingRevisionId: revision.id } } } };
        return { rows: f.auditRows ? f.auditRows(receipt) : [receipt] };
      }
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
  const journal = path.join(output, 'journal.jsonl');
  const f = { dir, input, bytes, output, journal, scenarios, messages, errors, calls, queries, pool, revision };
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
    implementationHash: () => c.hash('Synthetic campaign runtime fixture'),
    print: value => messages.push(JSON.parse(value)), printError: value => errors.push(JSON.parse(value)) };
  return f;
}
const args = (f, mode = 'apply', output = f.output) => ['--mode', mode, '--input', path.join(f.dir, 'input.json'),
  '--scope-sha256', hash(f.bytes), '--output', output, '--expected-database', 'history_fixture_test', '--actor-id', '7'];
const receipts = lines => lines.filter(line => line.type === 'receipt');

test('campaign scopes keep exact global identity uniqueness through 2000 items', () => {
  assert.equal(runner.MAX_ITEMS, 2000);
  const runtime = { c, batch }, many = scope(Array.from({ length: 2000 }, (_, index) => item(index + 1)));
  assert.doesNotThrow(() => runner.validateInput(many, runtime));
  assert.throws(() => runner.validateInput(scope([...many.items, item(2001)]), runtime));
  assert.throws(() => runner.validateInput(scope([]), runtime));
  for (const key of ['sku', 'productId', 'remoteProductId']) {
    const duplicate = clone(many); duplicate.items[100][key] = duplicate.items[0][key];
    assert.throws(() => runner.validateInput(duplicate, runtime), 'Duplicate ' + key + ' across batch boundaries');
  }
  for (const change of [
    value => { value.items[0].fields = []; },
    value => { value.items[0].previewToken = definitionHash; },
    value => { value.items[0].productId = '1'; },
    value => { value.items[0].sku = ' NM1'; },
    value => { value.items[0].remoteProductId = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.items = Array(1); },
  ]) {
    const value = scope(); change(value);
    assert.throws(() => runner.validateInput(value, runtime));
  }
});

test('campaign arguments require raw digest and support only explicit preview, apply or resume', () => {
  const valid = ['--mode', 'preview', '--input', 'scope.json', '--scope-sha256', definitionHash,
    '--output', 'campaign', '--expected-database', 'history_fixture_test', '--actor-id', '7'];
  for (const mode of ['preview', 'apply', 'resume'])
    assert.equal(runner.argumentsFor(valid.map(value => value === 'preview' ? mode : value)).mode, mode);
  for (const invalid of [[], valid.filter((_, index) => index !== 4 && index !== 5),
    [...valid, '--mode', 'apply'], valid.map(value => value === 'preview' ? 'retry' : value),
    [...valid, '--unknown', '1']]) assert.throws(() => runner.argumentsFor(invalid));
});

test('campaign help has no runtime, filesystem input or database side effects', async () => {
  const printed = [], dependencies = { env: {}, print: value => printed.push(value),
    printError: () => assert.fail('Help failed'), read: () => assert.fail('Help read input') };
  for (const key of ['runtime', 'pool', 'config'])
    Object.defineProperty(dependencies, key, { get() { assert.fail('Help accessed ' + key); } });
  assert.equal(await runner.main(['--help'], dependencies), 0);
  assert.equal(printed.length, 1);
});

test('51-item preview preserves exact raw scope and performs no admissions', async t => {
  const f = await fixture(t, 51);
  assert.equal(await runner.main(args(f, 'preview'), f.dependencies), 0, JSON.stringify(f.errors));
  const lines = await parseLines(f.journal);
  assert.equal(lines[0].contract, 'first-sync-campaign-history-journal-v1');
  assert.equal(lines[0].mode, 'preview');
  assert.equal(lines[0].scopeSha256, hash(f.bytes));
  assert.equal(lines[0].total, 51);
  assert.equal(lines[0].actorUserId, 7);
  assert.equal(lines[0].database, 'history_fixture_test');
  assert.equal(lines[0].originHash, c.originHash(config.baseUrl));
  assert.deepEqual(await fs.readFile(path.join(f.output, 'scope.json')), f.bytes);
  assert.equal(receipts(lines).length, 51);
  assert.ok(receipts(lines).every(row => row.status === 'available'));
  assert.equal(f.calls.filter(call => call.stage === 'apply').length, 0);
  assert.ok(f.scenarios.every(s => !s.admitted));
  assert.ok(f.queries.every(sql => /^(SELECT|BEGIN|COMMIT|ROLLBACK)/.test(sql)));
});

test('101 exact items use canonical runItem sequentially with durable prepared and receipt checkpoints', async t => {
  const f = await fixture(t, 101), open = fs.open;
  let synced = [], next = 0;
  t.mock.method(fs, 'open', async (...params) => {
    const handle = await open(...params);
    if (params[0] === f.journal) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); synced = await parseLines(f.journal); };
    }
    return handle;
  });
  f.beforeReview = async s => {
    assert.equal(receipts(synced).length, next, 'The previous receipt must be synced before another review');
    assert.equal(s.item.sku, 'NM' + (next + 1));
  };
  f.beforeApply = async s => {
    const prepared = synced.at(-1);
    assert.equal(prepared.type, 'prepared', 'Admission requires a durable prepared record');
    assert.equal(prepared.sku, s.item.sku);
    assert.equal(prepared.command.previewToken, s.review.historyReview.previewToken);
    assert.equal(prepared.sourceHash, c.hash(batch.source(s.observation.amber.product)));
    next++;
  };
  assert.equal(await runner.main(args(f), f.dependencies), 0, JSON.stringify(f.errors));
  const rows = receipts(await parseLines(f.journal));
  assert.equal(rows.length, 101);
  assert.ok(rows.every(row => row.status === 'recorded'));
  assert.equal(new Set(rows.map(row => row.index)).size, 101);
  assert.deepEqual(rows.map(row => row.sku), f.input.items.map(row => row.sku));
  assert.deepEqual(f.calls.filter(call => call.stage === 'apply').map(row => row.sku), rows.map(row => row.sku));
  assert.equal(receipts(synced).length, 101);
  assert.equal((await fs.stat(f.journal)).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(f.output, 'run.lock')), { code: 'ENOENT' });
});

test('known local blockers are durable results and do not prevent checking the exact remaining scope', async t => {
  for (const code of ['HISTORY_BATCH_ADMISSION_NOT_AVAILABLE', 'HISTORY_BATCH_EXISTING_ADMISSION_UNCONFIRMED',
    'HISTORY_BATCH_IDENTITY_CHANGED', 'HISTORY_BATCH_SOURCE_CHANGED', 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED']) {
    await t.test(code, async t => {
      const f = await fixture(t, 3);
      f.scenarios[1].failure = Object.assign(Error(code), { code, statusCode: 409 });
      await runner.main(args(f), f.dependencies);
      const rows = receipts(await parseLines(f.journal));
      assert.deepEqual(rows.map(row => row.status), ['recorded', 'blocked', 'recorded']);
      assert.equal(rows[1].code, code);
      assert.deepEqual(f.calls.filter(row => row.stage === 'review').map(row => row.sku), ['NM1', 'NM2', 'NM3']);
    });
  }
});

test('unknown blockers and global authority or publication failures stop before the tail', async t => {
  for (const code of ['UNRECOGNIZED_SAFETY_BLOCKER', 'ADMIN_PERMISSION_REVOKED', 'HISTORY_BATCH_PUBLICATION_CHANGED',
    'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED', 'ACTOR_NOT_ACTIVE', 'PERMISSION_DENIED']) {
    await t.test(code, async t => {
      const f = await fixture(t, 3);
      f.beforeReview = async s => { if (s.item.sku === 'NM2') throw Object.assign(Error(code), { code, statusCode: 409 }); };
      assert.notEqual(await runner.main(args(f), f.dependencies), 0);
      const rows = receipts(await parseLines(f.journal));
      assert.deepEqual(rows.map(row => row.status), ['recorded', 'blocked']);
      assert.equal(rows[1].code, code);
      assert.ok(!f.calls.some(row => row.sku === 'NM3'));
      assert.equal(f.calls.filter(row => row.stage === 'apply').length, 1);
    });
  }
});

test('a lost commit response stays unconfirmed and cannot be resumed into another admission', async t => {
  const f = await fixture(t, 3);
  f.scenarios[1].afterCommitFailure = Object.assign(Error('Private connection detail'), { code: 'ECONNRESET' });
  assert.notEqual(await runner.main(args(f), f.dependencies), 0);
  const before = await fs.readFile(f.journal), callCount = f.calls.length;
  assert.deepEqual(receipts(await parseLines(f.journal)).map(row => row.status), ['recorded', 'unconfirmed']);
  assert.equal(f.scenarios[1].admitted, true);
  assert.equal(f.scenarios[2].admitted, false);
  assert.notEqual(await runner.main(args(f, 'resume'), f.dependencies), 0);
  assert.equal(f.calls.length, callCount);
  assert.deepEqual(await fs.readFile(f.journal), before);
  assert.ok(!before.toString().includes('Private connection detail'));
});

async function interruptedFixture(t) {
  const f = await fixture(t, 5), print = f.dependencies.print;
  f.scenarios[1].admitted = true;
  f.scenarios[2].review.historyReviewAssessment.status = 'blocked';
  f.dependencies.print = value => {
    print(value);
    const row = JSON.parse(value);
    if (row.sku === 'NM3' && row.status) process.emit('SIGTERM');
  };
  assert.notEqual(await runner.main(args(f), f.dependencies), 0);
  f.dependencies.print = print;
  const rows = receipts(await parseLines(f.journal));
  assert.deepEqual(rows.map(row => row.status), ['recorded', 'already_admitted', 'blocked']);
  return f;
}

test('resume skips durable recorded, admitted and known-blocked rows without reviewing or mutating them again', async t => {
  const sigint = process.listenerCount('SIGINT'), sigterm = process.listenerCount('SIGTERM');
  const f = await interruptedFixture(t), calls = f.calls.length;
  f.beforeReview = async s => assert.ok(s.item.productId >= 4, 'A historical row must not be revisited');
  await runner.main(args(f, 'resume'), f.dependencies);
  assert.deepEqual(f.calls.slice(calls).filter(row => row.stage === 'review').map(row => row.sku), ['NM4', 'NM5']);
  assert.deepEqual(f.calls.slice(calls).filter(row => row.stage === 'apply').map(row => row.sku), ['NM4', 'NM5']);
  assert.deepEqual(receipts(await parseLines(f.journal)).map(row => row.sku), ['NM1', 'NM2', 'NM3', 'NM4', 'NM5']);
  assert.equal(process.listenerCount('SIGINT'), sigint);
  assert.equal(process.listenerCount('SIGTERM'), sigterm);
});

test('resume confirms historical audit identities without requiring a renewed session root to use the current binding', async t => {
  const f = await interruptedFixture(t), calls = f.calls.length;
  f.auditRows = receipt => {
    if (receipt.id === f.scenarios[1].root)
      receipt.details.admission.identity.bindingRevisionId = '22222222-2222-4222-8222-222222222222';
    return [receipt];
  };
  await runner.main(args(f, 'resume'), f.dependencies);
  assert.deepEqual(f.calls.slice(calls).filter(row => row.stage === 'apply').map(row => row.sku), ['NM4', 'NM5']);
  assert.ok(f.queries.some(sql => sql.includes('FROM audit_events')));
});

test('resume refuses missing or mismatched historical audit evidence without revisiting the scope', async t => {
  for (const kind of ['missing', 'remote_identity', 'scope', 'preview_token']) await t.test(kind, async t => {
    const f = await interruptedFixture(t), before = await fs.readFile(f.journal), calls = f.calls.length;
    f.auditRows = receipt => {
      if (kind === 'missing') return [];
      if (kind === 'remote_identity') receipt.details.admission.identity.remoteId++;
      if (kind === 'scope') receipt.details.admission.scope = 'ordinary_delivery';
      if (kind === 'preview_token') receipt.subject_id = 'd'.repeat(64);
      return [receipt];
    };
    assert.notEqual(await runner.main(args(f, 'resume'), f.dependencies), 0);
    assert.equal(f.calls.length, calls);
    assert.deepEqual(await fs.readFile(f.journal), before);
  });
});

test('resume rejects incomplete, truncated or unknown journal history without touching its bytes', async t => {
  for (const kind of ['truncated', 'unfinished_prepared', 'unknown_record', 'unknown_blocker']) await t.test(kind, async t => {
    const f = await interruptedFixture(t), rows = await parseLines(f.journal);
    let contents;
    if (kind === 'truncated') contents = (await fs.readFile(f.journal, 'utf8')) + '{"type":"receipt"';
    if (kind === 'unfinished_prepared') contents = rows.slice(0, rows.findIndex(row => row.type === 'prepared') + 1).map(JSON.stringify).join('\n') + '\n';
    if (kind === 'unknown_record') contents = rows.map(JSON.stringify).join('\n') + '\n{"type":"invented"}\n';
    if (kind === 'unknown_blocker') {
      rows.find(row => row.type === 'receipt' && row.status === 'blocked').code = 'UNRECOGNIZED_SAFETY_BLOCKER';
      contents = rows.map(JSON.stringify).join('\n') + '\n';
    }
    await fs.writeFile(f.journal, contents);
    const calls = f.calls.length;
    assert.notEqual(await runner.main(args(f, 'resume'), f.dependencies), 0);
    assert.equal(f.calls.length, calls);
    assert.equal(await fs.readFile(f.journal, 'utf8'), contents);
  });
});

test('resume refuses foreign actor, database, publication, implementation or saved raw scope', async t => {
  for (const kind of ['actor', 'database', 'scope_hash', 'binding', 'origin', 'implementation', 'saved_scope']) await t.test(kind, async t => {
    const f = await interruptedFixture(t), rows = await parseLines(f.journal);
    if (kind === 'actor') rows[0].actorUserId = 8;
    if (kind === 'database') rows[0].database = 'foreign_test';
    if (kind === 'scope_hash') rows[0].scopeSha256 = 'b'.repeat(64);
    if (kind === 'binding') rows[0].bindingRevisionId = '22222222-2222-4222-8222-222222222222';
    if (kind === 'origin') rows[0].originHash = 'b'.repeat(64);
    if (kind === 'implementation') rows[0].implementationSha256 = 'b'.repeat(64);
    if (kind === 'saved_scope') await fs.writeFile(path.join(f.output, 'scope.json'), JSON.stringify(f.input));
    else await fs.writeFile(f.journal, rows.map(JSON.stringify).join('\n') + '\n');
    const before = await fs.readFile(f.journal), calls = f.calls.length;
    assert.notEqual(await runner.main(args(f, 'resume'), f.dependencies), 0);
    assert.equal(f.calls.length, calls);
    assert.deepEqual(await fs.readFile(f.journal), before);
  });
});

test('resume never bypasses or removes an existing lock and cannot resume a preview directory', async t => {
  const f = await interruptedFixture(t), lock = path.join(f.output, 'run.lock');
  await fs.writeFile(lock, 'stale or active owner\n');
  const before = await fs.readFile(f.journal), calls = f.calls.length;
  assert.notEqual(await runner.main(args(f, 'resume'), f.dependencies), 0);
  assert.equal(await fs.readFile(lock, 'utf8'), 'stale or active owner\n');
  assert.equal(f.calls.length, calls);
  assert.deepEqual(await fs.readFile(f.journal), before);
  const preview = await fixture(t, 2);
  assert.equal(await runner.main(args(preview, 'preview'), preview.dependencies), 0);
  const reviewed = preview.calls.length;
  assert.notEqual(await runner.main(args(preview, 'resume'), preview.dependencies), 0);
  assert.equal(preview.calls.length, reviewed);
});

test('raw input tampering and database mismatch fail before a campaign directory is created', async t => {
  for (const kind of ['raw', 'database']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'raw') f.dependencies.read = async () => Buffer.from(JSON.stringify(f.input));
    else f.pool.query = async () => ({ rows: [{ name: 'foreign_test' }] });
    assert.notEqual(await runner.main(args(f), f.dependencies), 0);
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  });
});

test('a new apply or preview never overwrites a previous campaign directory', async t => {
  const f = await fixture(t);
  assert.equal(await runner.main(args(f), f.dependencies), 0);
  const before = await fs.readFile(f.journal), calls = f.calls.length;
  for (const mode of ['apply', 'preview']) assert.notEqual(await runner.main(args(f, mode), f.dependencies), 0);
  assert.equal(f.calls.length, calls);
  assert.deepEqual(await fs.readFile(f.journal), before);
});

test('oversized raw scope and resume journal are rejected before domain operations', async t => {
  const largeScope = await fixture(t);
  largeScope.bytes = Buffer.concat([largeScope.bytes, Buffer.alloc(4 * 1024 * 1024, ' ')]);
  assert.notEqual(await runner.main(args(largeScope), largeScope.dependencies), 0);
  assert.equal(largeScope.calls.length, 0);
  await assert.rejects(fs.stat(largeScope.output), { code: 'ENOENT' });
  const f = await interruptedFixture(t), calls = f.calls.length;
  const existing = await fs.readFile(f.journal);
  await fs.writeFile(f.journal, Buffer.concat([existing, Buffer.alloc(32 * 1024 * 1024, ' ')]));
  const size = (await fs.stat(f.journal)).size;
  assert.notEqual(await runner.main(args(f, 'resume'), f.dependencies), 0);
  assert.equal(f.calls.length, calls);
  assert.equal((await fs.stat(f.journal)).size, size);
});

test('prepared fsync failure prevents canonical admission and later rows', async t => {
  const f = await fixture(t, 2), open = fs.open;
  t.mock.method(fs, 'open', async (...params) => {
    const handle = await open(...params);
    if (params[0] === f.journal) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        const rows = await parseLines(f.journal);
        if (rows.at(-1).type === 'prepared') throw Object.assign(Error('Disk sync failed'), { code: 'EIO' });
        return sync();
      };
    }
    return handle;
  });
  assert.notEqual(await runner.main(args(f), f.dependencies), 0);
  assert.equal(f.calls.filter(row => row.stage === 'apply').length, 0);
  assert.ok(f.scenarios.every(s => !s.admitted));
  assert.ok(!f.calls.some(row => row.sku === 'NM2'));
});

test('receipt fsync failure after commit stops the tail without repeating the admission', async t => {
  const f = await fixture(t, 2), open = fs.open;
  let failed = false;
  t.mock.method(fs, 'open', async (...params) => {
    const handle = await open(...params);
    if (params[0] === f.journal) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if ((await parseLines(f.journal)).at(-1).type === 'receipt') {
          failed = true; throw Object.assign(Error('Disk sync failed'), { code: 'EIO' });
        }
        return sync();
      };
    }
    return handle;
  });
  assert.notEqual(await runner.main(args(f), f.dependencies), 0);
  assert.equal(failed, true);
  assert.equal(f.scenarios[0].admitted, true);
  assert.equal(f.scenarios[1].admitted, false);
  assert.equal(f.calls.filter(row => row.stage === 'apply').length, 1);
  assert.ok(!f.calls.some(row => row.sku === 'NM2'));
});
