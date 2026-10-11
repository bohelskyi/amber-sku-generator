const assert = require('node:assert/strict');
const test = require('node:test');
const service = require('../src/services/magento/first-sync-legacy-completion');

const proposal = () => ({
  sku: 'SV5111001',
  bindingRevisionId: '11111111-1111-4111-8111-111111111111',
  processingValueId: '1',
  attestation: 'processing_not_encoded_in_historical_sku',
  reason: 'Адміністратор підтвердив історичний факт обробки каменю.',
});
const applying = () => ({ ...proposal(), previewToken: 'a'.repeat(64) });
const invalid = error => error.statusCode === 422 && error.code === 'MAGENTO_BINDING_INVALID';

test('the command accepts only explicit historical attestation and bounded semantic identities', () => {
  for (const processingValueId of ['0', 0, '1', 1, '2147483647', 2147483647]) {
    assert.doesNotThrow(() => service.command({ ...proposal(), processingValueId }));
  }
  assert.doesNotThrow(() => service.command(applying(), true));
  assert.doesNotThrow(() => service.command({ ...proposal(), reason: 'x'.repeat(10) }));
  assert.doesNotThrow(() => service.command({ ...proposal(), reason: 'x'.repeat(500) }));
});

test('the completion command cannot smuggle prices, weight, encoded answers or caller authority', () => {
  const untrusted = {
    price: 1,
    total_price_uah: 1,
    pricingDecision: { mode: 'manual_uah', manualPrice: 1 },
    weight: 1,
    material: 2,
    color: 2,
    size: '9.5/3.5',
    answersPatch: { size: '9.5/3.5', stone_processing: '1', material: '2' },
    answers: { stone_processing: '1' },
    productId: 1359,
    publicIdentityId: '1234',
    bindingHash: 'a'.repeat(64),
    options: { actorUserId: 1, bypassHistory: true },
    actorUserId: 1,
    mutationContext: { actorUserId: 1 },
    apply: true,
    alreadyApplied: true,
    enqueue: true,
    remoteWrites: true,
    preserveReceipts: true,
    skipValidation: true,
    extra: null,
  };
  for (const [key, value] of Object.entries(untrusted)) {
    for (const [base, apply] of [[proposal(), false], [applying(), true]]) {
      assert.throws(() => service.command({ ...base, [key]: value }, apply), invalid, key);
    }
  }
  const prototypeKey = JSON.parse(JSON.stringify(proposal()).replace(/}$/, ',"__proto__":{"actorUserId":1}}'));
  assert.throws(() => service.command(prototypeKey), invalid);
  assert.throws(() => service.command({ ...proposal(), previewToken: 'a'.repeat(64) }), invalid,
    'a preview request cannot carry an apply proof');
});

test('semantic value IDs reject ambiguous coercion and values outside the database domain', () => {
  const malformed = [-1, '-1', 1.5, '1.5', true, false, null, undefined, [], ['1'], {},
    '', ' ', '01', '+1', '1e0', '1.0', ' 1', '1 ', '2147483648', 2147483648,
    Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '9'.repeat(100)];
  for (const processingValueId of malformed) {
    assert.throws(() => service.command({ ...proposal(), processingValueId }), invalid,
      `value ID ${String(processingValueId)}`);
  }
});

test('SKU, binding, explanation and attestation remain required and cannot be replaced by inferred facts', () => {
  const invalidProperties = [
    ['sku', undefined], ['sku', null], ['sku', false], ['sku', 1359], ['sku', []],
    ['sku', ''], ['sku', '   '], ['sku', 'S'.repeat(256)], ['sku', 'SV5111001\n'], ['sku', 'SV5111001\0'], ['sku', 'SV5111001\x7f'],
    ['bindingRevisionId', null], ['bindingRevisionId', 1], ['bindingRevisionId', 'current'],
    ['bindingRevisionId', '11111111-1111-4111-8111-111111111111\n'],
    ['attestation', true], ['attestation', null], ['attestation', 'polished'],
    ['attestation', 'infer_from_sku'], ['attestation', 'processing_not_encoded_in_historical_sku '],
    ['reason', null], ['reason', 1], ['reason', 'x'.repeat(9)], ['reason', 'x'.repeat(501)],
    ['reason', ' reason with padding '], ['reason', 'confirmed\nfact'], ['reason', 'confirmed\0fact'], ['reason', 'confirmed\x7ffact'],
  ];
  for (const [key, value] of invalidProperties) {
    assert.throws(() => service.command({ ...proposal(), [key]: value }), invalid, key);
  }
  for (const key of Object.keys(proposal())) {
    const input = proposal(); delete input[key];
    assert.throws(() => service.command(input), invalid, `missing ${key}`);
  }
  for (const input of [null, undefined, false, 'SV5111001', [], Object.create(proposal())]) {
    assert.throws(() => service.command(input), invalid);
  }
});

test('apply requires one exact opaque preview hash instead of caller flags or another proof format', () => {
  for (const previewToken of [undefined, null, false, 1, [], {}, '', 'a'.repeat(63), 'a'.repeat(65),
    'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64) + '\n', 'a'.repeat(32) + ' ' + 'a'.repeat(31)]) {
    assert.throws(() => service.command({ ...applying(), previewToken }, true), invalid);
  }
  assert.throws(() => service.command(proposal(), true), invalid);
});

test('actual preview and apply reject boundary smuggling before database connections or any network call', async t => {
  const calls = { connect: 0, query: 0, network: 0 };
  const databasePool = {
    async connect() { calls.connect++; throw new Error('unexpected connection'); },
    async query() { calls.query++; throw new Error('unexpected database query'); },
  };
  t.mock.method(globalThis, 'fetch', async () => { calls.network++; throw new Error('unexpected network read'); });
  const options = { databasePool, mutationContext: { actorUserId: 1, requestId: 'legacy-contract-test' } };
  for (const [operation, base] of [[service.review, proposal()], [service.apply, applying()]]) {
    const invalidCommands = [null, [], {}, { ...base, answersPatch: { stone_processing: '1' } },
      { ...base, actorUserId: 1 }, { ...base, options: { bypassHistory: true } },
      { ...base, attestation: true }, { ...base, processingValueId: '01' },
      { ...base, bindingRevisionId: 'old-binding' }, { ...base, sku: 'SV5111001\n' },
      { ...base, reason: 'x'.repeat(501) }];
    if (operation === service.apply) invalidCommands.push(proposal(), { ...base, previewToken: 'bad-proof' });
    for (const input of invalidCommands) await assert.rejects(operation({}, input, options), invalid);
  }
  assert.deepEqual(calls, { connect: 0, query: 0, network: 0 });
});
