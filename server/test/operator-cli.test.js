'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createCommand, getOnly, readJson, readJsonLines } = require('../scripts/operator-cli');

const build = 'a'.repeat(64), target = 'b'.repeat(64), token = 'c'.repeat(64);
const base = ['--input', 'input.json', '--output', 'output.json', '--expected-database', 'amber_test', '--actor-id', '7'];
const definition = (extra = {}) => ({ name: 'operator-example', permissions: ['exports.create'], requiresMagento: true,
  preview: async input => ({ selection: input.selection, previewToken: token }), apply: async payload => ({ token: payload.previewToken }), ...extra });

async function fixture(t, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-operator-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = name => path.join(directory, name);
  await fs.writeFile(file('input.json'), JSON.stringify({ selection: [11, 12] }));
  const calls = [], lines = [], errors = [], signals = new EventEmitter();
  const settings = { database: 'amber_test', readOnly: 'on', denied: null, ...extra };
  const pool = {
    async query(sql) {
      calls.push(['query', sql]);
      if (sql.includes('current_database')) return { rows: [{ name: settings.database, username: 'test', address: '127.0.0.1', port: 5432 }] };
      if (sql.startsWith('SHOW')) return { rows: [{ default_transaction_read_only: settings.readOnly }] };
      throw new Error('Unexpected query');
    },
    async end() { calls.push(['end']); },
  };
  const authority = {
    async authorize(database, actorId, permissions) {
      assert.equal(database, pool); assert.equal(actorId, 7); assert.deepEqual(permissions, ['exports.create']);
      calls.push(['authorize']);
      if (settings.denied) throw Object.assign(Error('Never print this sensitive detail'), { code: settings.denied });
    },
    guardPool(database, actorId, permissions) {
      assert.equal(database, pool); assert.equal(actorId, 7); assert.deepEqual(permissions, ['exports.create']);
      calls.push(['guard']); return database;
    },
  };
  const dependencies = { pool, config: { configured: true, baseUrl: 'https://magento.example.invalid', accessToken: 'never-print-secret' },
    authority, signals, buildFingerprint: build, targetFingerprint: target,
    print: line => lines.push(JSON.parse(line)), printError: line => errors.push(JSON.parse(line)),
    fetchImpl: async () => { calls.push(['GET']); return {}; } };
  const args = (mode, output = mode + '.json', input = mode === 'preview' ? 'input.json' : 'preview.json', planHash) => [
    '--mode', mode, '--input', file(input), '--output', file(output), '--expected-database', 'amber_test', '--actor-id', '7',
    ...(planHash ? ['--plan-hash', planHash] : []),
  ];
  return { file, args, settings, pool, dependencies, calls, lines, errors, signals };
}

test('CLI arguments require explicit mode, target, actor and apply-only lowercase plan hash', () => {
  const command = createCommand(definition());
  assert.deepEqual(command.parseArguments(['--help']), { help: true });
  assert.equal(command.parseArguments(['--mode', 'preview', ...base]).actorId, 7);
  assert.equal(command.parseArguments(['--mode', 'apply', ...base, '--plan-hash', token]).planHash, token);
  const invalid = [[], ['--mode', 'apply', ...base], ['--mode', 'preview', ...base, '--plan-hash', token],
    ['--mode', 'apply', ...base, '--plan-hash', 'C'.repeat(64)], ['--mode', 'resume', ...base],
    ['--mode', 'preview', ...base, '--mode', 'preview'], ['--mode', 'preview', ...base, '--unknown', 'value'],
    ['--mode', 'preview', ...base, '--'], ['--help', ...base],
    ...['0', '-1', '1.1', '01', '9007199254740992', '7\n', ' 7'].map(actor => ['--mode', 'preview', ...base.slice(0, -1), actor]),
    ...['', ' ', '--other', 'line\nbreak'].map(value => ['--mode', 'preview', ...base.slice(0, 3), value, ...base.slice(4)])];
  for (const args of invalid) assert.throws(() => command.parseArguments(args), { code: 'OPERATOR_ARGUMENTS' });
});

test('GET guard rejects Request bodies and original unsafe methods even when init attempts to override them', async () => {
  const calls = [], fetch = getOnly(async (...args) => { calls.push(args); return 'ok'; });
  assert.equal(await fetch('https://example.invalid'), 'ok');
  assert.equal(await fetch(new Request('https://example.invalid'), { method: 'get' }), 'ok');
  for (const args of [['https://example.invalid', { method: 'POST' }], ['https://example.invalid', { method: 'DELETE' }],
    ['https://example.invalid', { method: 'HEAD' }], ['https://example.invalid', { body: '' }],
    [new Request('https://example.invalid', { method: 'POST', body: 'x' }), { method: 'GET' }],
    [new Request('https://example.invalid', { method: 'DELETE' })]]) {
    assert.throws(() => fetch(...args), { code: 'OPERATOR_REMOTE_WRITE_DENIED' });
  }
  assert.equal(calls.length, 2);
  const abort = new AbortController(); abort.abort();
  assert.throws(() => getOnly(async () => {}, abort.signal)('https://example.invalid'), { code: 'OPERATOR_INTERRUPTED' });
});

test('bounded JSON and JSONL readers reject malformed and oversized files', async t => {
  const f = await fixture(t);
  assert.deepEqual(await readJson(f.file('input.json')), { selection: [11, 12] });
  await fs.writeFile(f.file('rows.jsonl'), '{"id":1}\r\n\n{"id":2}\n');
  assert.deepEqual(await readJsonLines(f.file('rows.jsonl')), [{ id: 1 }, { id: 2 }]);
  await assert.rejects(readJson(f.file('input.json'), 1), { code: 'OPERATOR_INPUT_LIMIT' });
  await fs.writeFile(f.file('bad.json'), '{');
  await assert.rejects(readJson(f.file('bad.json')), { code: 'OPERATOR_INPUT_INVALID' });
  await assert.rejects(readJsonLines(f.file('bad.json')), { code: 'OPERATOR_INPUT_INVALID' });
});

test('help and argument refusals do not create pools or install persistent signal listeners', async () => {
  const signals = new EventEmitter(), command = createCommand(definition());
  let pools = 0;
  const deps = { signals, print() {}, printError() {}, createPool() { pools++; throw new Error('No pool expected'); } };
  assert.equal(await command.main(['--help'], deps), 0);
  assert.equal(await command.main([], deps), 1);
  assert.equal(pools, 0); assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('preview binds context and apply uses stored consent with fsynced prepared journal before the mutation', async t => {
  const f = await fixture(t); let previews = 0, applies = 0;
  const command = createCommand(definition({
    async preview(input, ctx) {
      previews++; assert.equal(ctx.inputFile, f.file('input.json')); assert.equal(ctx.databasePool, f.pool);
      assert.deepEqual(ctx.options.mutationContext, { actorUserId: 7 });
      assert.equal(ctx.options.fetchImpl, ctx.fetchImpl); assert.equal(ctx.options.config, ctx.config);
      return { selection: input.selection, previewToken: token };
    },
    async apply(payload, ctx, journal) {
      applies++;
      const records = await readJsonLines(f.file('apply.json'));
      assert.equal(records[0].type, 'prepared'); assert.equal(records[0].planHash, review.planHash);
      assert.equal(payload.previewToken, token); assert.equal(ctx.actorId, 7);
      await journal.append({ type: 'item', productId: payload.selection[0], status: 'recorded' });
      return { productIds: payload.selection };
    },
  }));
  assert.equal(await command.main(f.args('preview'), f.dependencies), 0);
  const review = await readJson(f.file('preview.json'));
  assert.equal(review.command, 'operator-example'); assert.equal(review.actorId, 7);
  assert.equal(review.database, 'amber_test'); assert.equal(review.implementationHash, build);
  assert.equal(review.targetFingerprint, target); assert.equal(review.origin, 'https://magento.example.invalid');
  assert.match(review.planHash, /^[a-f0-9]{64}$/);
  assert.equal(await command.main(f.args('apply', undefined, undefined, review.planHash), f.dependencies), 0);
  assert.deepEqual((await readJsonLines(f.file('apply.json'))).map(row => row.type), ['prepared', 'item', 'complete']);
  assert.equal(previews, 1); assert.equal(applies, 1);
  assert.equal(f.calls.filter(row => row[0] === 'guard').length, 1);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('existing preview or apply output is never overwritten and prevents database/service work', async t => {
  const f = await fixture(t); let applies = 0;
  const command = createCommand(definition({ apply: async () => { applies++; } }));
  assert.equal(await command.main(f.args('preview'), f.dependencies), 0);
  const bytes = await fs.readFile(f.file('preview.json')), review = JSON.parse(bytes);
  f.calls.length = 0;
  assert.equal(await command.main(f.args('preview'), f.dependencies), 1);
  assert.deepEqual(await fs.readFile(f.file('preview.json')), bytes); assert.equal(f.calls.length, 0);
  await fs.writeFile(f.file('apply.json'), 'preserved journal\n');
  assert.equal(await command.main(f.args('apply', undefined, undefined, review.planHash), f.dependencies), 1);
  assert.equal(await fs.readFile(f.file('apply.json'), 'utf8'), 'preserved journal\n');
  assert.equal(applies, 0); assert.equal(f.calls.length, 0); assert.equal(f.errors.at(-1).code, 'OPERATOR_OUTPUT_EXISTS');
});

test('database, read-only, configuration and current authority refusals occur before preview work', async t => {
  for (const [settings, code] of [[{ database: 'other_test' }, 'OPERATOR_DATABASE_MISMATCH'],
    [{ readOnly: 'off' }, 'OPERATOR_READ_ONLY_REQUIRED'], [{ denied: 'ADMIN_PERMISSION_REVOKED' }, 'ADMIN_PERMISSION_REVOKED'],
    [{ denied: 'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED' }, 'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED']]) {
    await t.test(code, async t => {
      const f = await fixture(t, settings); let previews = 0;
      const command = createCommand(definition({ preview: async () => { previews++; } }));
      assert.equal(await command.main(f.args('preview'), f.dependencies), 1);
      assert.equal(previews, 0); assert.equal(f.errors[0].code, code);
      assert.equal(JSON.stringify(f.errors).includes('sensitive'), false);
      assert.equal(f.signals.listenerCount('SIGINT'), 0);
    });
  }
  const f = await fixture(t);
  assert.equal(await createCommand(definition()).main(f.args('preview'), { ...f.dependencies, config: { configured: false } }), 1);
  assert.equal(f.errors[0].code, 'MAGENTO_NOT_CONFIGURED'); assert.equal(f.calls.length, 0);
});

test('tampered input, actor, command, hash, build, target and origin cannot reach apply', async t => {
  const cases = [
    ['payload', review => { review.payload.selection.push(13); }, {}, 'OPERATOR_PLAN_HASH_MISMATCH'],
    ['actor', review => { review.actorId = 8; }, {}, 'OPERATOR_PLAN_INVALID'],
    ['command', review => { review.command = 'other-command'; }, {}, 'OPERATOR_PLAN_INVALID'],
    ['hash', review => { review.planHash = 'd'.repeat(64); }, {}, 'OPERATOR_PLAN_HASH_MISMATCH'],
    ['extra', review => { review.extra = true; }, {}, 'OPERATOR_PLAN_INVALID'],
    ['build', () => {}, { buildFingerprint: 'd'.repeat(64) }, 'OPERATOR_CONTEXT_CHANGED'],
    ['target', () => {}, { targetFingerprint: 'd'.repeat(64) }, 'OPERATOR_CONTEXT_CHANGED'],
    ['origin', () => {}, { config: { configured: true, baseUrl: 'https://different.example.invalid' } }, 'OPERATOR_CONTEXT_CHANGED'],
  ];
  for (const [name, mutate, overrides, code] of cases) await t.test(name, async t => {
    const f = await fixture(t); let applies = 0;
    const command = createCommand(definition({ apply: async () => { applies++; } }));
    assert.equal(await command.main(f.args('preview'), f.dependencies), 0);
    const review = await readJson(f.file('preview.json')), originalHash = review.planHash;
    mutate(review); await fs.writeFile(f.file('preview.json'), JSON.stringify(review));
    assert.equal(await command.main(f.args('apply', undefined, undefined, originalHash), { ...f.dependencies, ...overrides }), 1);
    assert.equal(applies, 0); assert.equal(f.errors[0].code, code);
  });
});

test('scope artifact apply remains read-only, ignores Magento configuration and creates one exclusive JSON result', async t => {
  const f = await fixture(t);
  const command = createCommand(definition({ requiresMagento: false, readOnlyApply: true, artifactApply: true,
    preview: async input => ({ items: input.selection.map(productId => ({ productId, sku: 'SV' + productId })) }),
    apply: async (payload, ctx) => { assert.equal(ctx.config.configured, false); return { items: payload.items }; },
  }));
  assert.equal(await command.main(f.args('preview'), { ...f.dependencies, config: { configured: true, baseUrl: 'not-a-url' } }), 0);
  const review = await readJson(f.file('preview.json')); assert.equal(review.origin, null);
  assert.equal(await command.main(f.args('apply', undefined, undefined, review.planHash), f.dependencies), 0);
  const result = await readJson(f.file('apply.json'));
  assert.deepEqual(result.items, review.payload.items); assert.equal(result.journal.status, 'complete');
  assert.equal(result.journal.planHash, review.planHash); assert.equal(f.calls.some(row => row[0] === 'guard'), false);
  assert.equal(f.calls.filter(row => row[0] === 'query' && row[1].startsWith('SHOW')).length, 2);
});

test('journal prepared sync failure prevents mutation and does not reuse the reserved output', async t => {
  const f = await fixture(t); let applies = 0;
  const command = createCommand(definition({ apply: async () => { applies++; } }));
  assert.equal(await command.main(f.args('preview'), f.dependencies), 0);
  const review = await readJson(f.file('preview.json'));
  const io = { async open(file, flags, mode) {
    const handle = await fs.open(file, flags, mode);
    return flags !== 'wx' ? handle : { write: (...args) => handle.write(...args), close: () => handle.close(),
      sync: async () => { throw Object.assign(Error('secret connection details'), { code: 'EIO' }); } };
  } };
  assert.equal(await command.main(f.args('apply', undefined, undefined, review.planHash), { ...f.dependencies, io }), 1);
  assert.equal(applies, 0); assert.equal(f.errors[0].code, 'EIO');
  assert.equal(await command.main(f.args('apply', undefined, undefined, review.planHash), f.dependencies), 1);
  assert.equal(applies, 0); assert.equal(f.errors.at(-1).code, 'OPERATOR_OUTPUT_EXISTS');
});

test('partial journal writes are completed before apply; a zero-byte write refuses apply', async t => {
  for (const zero of [false, true]) await t.test(zero ? 'zero-byte refusal' : 'partial writes', async t => {
    const f = await fixture(t); let applies = 0;
    const command = createCommand(definition({ apply: async () => { applies++; return { saved: true }; } }));
    assert.equal(await command.main(f.args('preview'), f.dependencies), 0);
    const review = await readJson(f.file('preview.json'));
    const io = { async open(file, flags, mode) {
      const handle = await fs.open(file, flags, mode);
      return flags !== 'wx' ? handle : { close: () => handle.close(), sync: () => handle.sync(),
        write: (bytes, offset, length, position) => zero ? { bytesWritten: 0 }
          : handle.write(bytes, offset, Math.min(length, 7), position) };
    } };
    assert.equal(await command.main(f.args('apply', undefined, undefined, review.planHash), { ...f.dependencies, io }), zero ? 1 : 0);
    assert.equal(applies, zero ? 0 : 1);
    if (zero) assert.equal(f.errors[0].code, 'OPERATOR_JOURNAL_WRITE_FAILED');
    else assert.deepEqual((await readJsonLines(f.file('apply.json'))).map(row => row.type), ['prepared', 'complete']);
  });
});

test('authority revoked between items stops later mutations and journals the terminal failure', async t => {
  const f = await fixture(t), applied = [];
  const command = createCommand(definition({ async apply(payload, ctx, journal) {
    for (const productId of payload.selection) {
      await ctx.authority(); applied.push(productId);
      await journal.append({ type: 'item', productId });
      f.settings.denied = 'ADMIN_PERMISSION_REVOKED';
    }
  } }));
  assert.equal(await command.main(f.args('preview'), f.dependencies), 0);
  const review = await readJson(f.file('preview.json'));
  assert.equal(await command.main(f.args('apply', undefined, undefined, review.planHash), f.dependencies), 1);
  assert.deepEqual(applied, [11]); assert.equal(f.errors[0].code, 'ADMIN_PERMISSION_REVOKED');
  assert.equal((await readJsonLines(f.file('apply.json'))).at(-1).code, 'ADMIN_PERMISSION_REVOKED');
});

test('owned idle pool errors abort the run without exposing raw errors', async t => {
  const f = await fixture(t), events = new EventEmitter();
  f.pool.on = events.on.bind(events); f.pool.removeListener = events.removeListener.bind(events);
  const command = createCommand(definition({ async preview() {
    events.emit('error', Error('postgres://secret-user:secret-password@private-server'));
    return { selection: [11], previewToken: token };
  } }));
  assert.equal(await command.main(f.args('preview'), { ...f.dependencies, pool: undefined, createPool: () => f.pool }), 1);
  assert.equal(f.errors[0].code, 'OPERATOR_DATABASE_FAILED');
  assert.equal(JSON.stringify(f.errors).includes('secret'), false);
  assert.equal(events.listenerCount('error'), 0); assert.equal(f.calls.filter(row => row[0] === 'end').length, 1);
});

test('signal aborts GET, stops the next item and removes listeners while retaining a terminal journal', async t => {
  const f = await fixture(t); let secondItem = false;
  const command = createCommand(definition({ async apply(_payload, ctx, journal) {
    let requestSignal;
    f.dependencies.fetchImpl = undefined;
    await ctx.fetchImpl('https://magento.example.invalid');
    await journal.append({ type: 'item', status: 'recorded', productId: 11 });
    requestSignal = f.requestSignal;
    f.signals.emit('SIGTERM'); assert.equal(requestSignal.aborted, true);
    ctx.checkStopped(); secondItem = true;
  } }));
  f.dependencies.fetchImpl = async (_url, init) => { f.requestSignal = init.signal; return {}; };
  assert.equal(await command.main(f.args('preview'), f.dependencies), 0);
  const review = await readJson(f.file('preview.json'));
  assert.equal(await command.main(f.args('apply', undefined, undefined, review.planHash), f.dependencies), 1);
  assert.equal(secondItem, false); assert.equal(f.errors[0].code, 'OPERATOR_INTERRUPTED');
  assert.equal((await readJsonLines(f.file('apply.json'))).at(-1).status, 'unconfirmed');
  assert.equal(f.signals.listenerCount('SIGTERM'), 0); assert.equal(f.signals.listenerCount('SIGINT'), 0);
});

test('owned pool closes after refusal and after success, injected pools remain caller-owned', async t => {
  const f = await fixture(t), command = createCommand(definition());
  const dependencies = { ...f.dependencies, pool: undefined, createPool(_env, readOnly) {
    assert.equal(readOnly, true); return f.pool;
  } };
  assert.equal(await command.main(f.args('preview'), dependencies), 0);
  assert.equal(f.calls.filter(row => row[0] === 'end').length, 1);
  f.settings.database = 'other_test';
  assert.equal(await command.main(f.args('preview', 'denied.json'), dependencies), 1);
  assert.equal(f.calls.filter(row => row[0] === 'end').length, 2);
  f.settings.database = 'amber_test';
  assert.equal(await command.main(f.args('preview', 'injected.json'), f.dependencies), 0);
  assert.equal(f.calls.filter(row => row[0] === 'end').length, 2);
});

test('default fingerprints work without git and distinguish same-named database targets without exposing credentials', async t => {
  require('./setup-env');
  const f = await fixture(t); let applies = 0;
  const command = createCommand(definition({ apply: async () => { applies++; return { saved: true }; } }));
  const env = { ...process.env, DATABASE_URL: 'postgresql://operator:private-password@db-one.invalid:55432/amber_test' };
  const dependencies = { ...f.dependencies, env, buildFingerprint: undefined, targetFingerprint: undefined };
  assert.equal(await command.main(f.args('preview'), dependencies), 0);
  const text = await fs.readFile(f.file('preview.json'), 'utf8'), review = JSON.parse(text);
  assert.match(review.implementationHash, /^[a-f0-9]{64}$/); assert.match(review.targetFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(text.includes('private-password'), false); assert.equal(text.includes('never-print-secret'), false);
  assert.equal(text.includes('postgresql://'), false);
  assert.equal(await command.main(f.args('apply', 'wrong-target.jsonl', undefined, review.planHash), {
    ...dependencies, env: { ...env, DATABASE_URL: 'postgresql://operator:private-password@db-two.invalid:55432/amber_test' },
  }), 1);
  assert.equal(f.errors.at(-1).code, 'OPERATOR_CONTEXT_CHANGED'); assert.equal(applies, 0);
  // Credential rotation alone does not change the identity of the reviewed target.
  assert.equal(await command.main(f.args('apply', undefined, undefined, review.planHash), {
    ...dependencies, env: { ...env, DATABASE_URL: 'postgresql://operator:rotated-password@db-one.invalid:55432/amber_test' },
  }), 0);
  assert.equal(applies, 1);
});
