const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fingerprint, normalizeIntent, requestContract, makeSigner, assertCompleted,
  PURPOSE, TTL_SECONDS, MAX_TOKEN_BYTES } = require('../src/services/export-templates/snapshot-binding');
const secret = 'fixture-only-stable-signing-secret-0123456789';
const signer = makeSigner(secret);
const intent = normalizeIntent({ requestContract: 'template-v1', fromSku: ' br-a ', toSku: '' });
const binding = { intent, effective: { templateId: '11111111-1111-4111-8111-111111111111',
  versionId: '22222222-2222-4222-8222-222222222222', evaluatorVersion: 'future-unavailable',
  definitionHash: 'a'.repeat(64), outputContract: 'magento-products-v1', formatVersion: 1, activationGeneration: '9007199254740993' },
  inputFingerprint: fingerprint({ answers: { absent: undefined, zero: 0, nil: null, blank: '' } }),
  range: { fromSku: 'BR-A', toSku: null, resolvedToSku: 'BR-A', exportedToProductId: 1 }, cursor: null };

test('PR3 fingerprint preserves authoritative value distinctions and ordered identity', () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  const values = [{}, { a: undefined }, { a: null }, { a: '' }, { a: ' ' }, { a: 0 }, { a: '0' }, { a: false }];
  assert.equal(new Set(values.map(fingerprint)).size, values.length);
  assert.notEqual(fingerprint(['A', 'B']), fingerprint(['B', 'A']));
  assert.notEqual(fingerprint('9007199254740992'), fingerprint('9007199254740993'));
  assert.doesNotThrow(() => fingerprint(Array.from({ length: 10000 }, (_, i) => ({ id: String(i), answer: 'x'.repeat(100) }))));
});
test('PR3 discriminator, profile, selection and caller intent normalize without latest/reordered ranges', () => {
  assert.equal(requestContract({}), 'legacy');
  for (const value of ['legacy', 'future', null, 0]) assert.throws(() => requestContract({ requestContract: value }), { code: 'EXPORT_CONTRACT_INVALID' });
  assert.equal(intent.fromSku, 'BR-A'); assert.equal(intent.toSku, null);
  for (const selection of [{ templateId: 'x' }, { mode: 'explicit', templateId: 'x' }, { mode: 'active', versionId: 'x' }, null]) {
    assert.throws(() => normalizeIntent({ selection }), { code: 'EXPORT_SELECTION_INVALID' });
  }
  assert.throws(() => normalizeIntent({ profile: 'internal-legacy' }), { code: 'EXPORT_PROFILE_INVALID' });
  assert.notDeepEqual(normalizeIntent({ fromSku: 'B', toSku: 'A' }), normalizeIntent({ fromSku: 'A', toSku: 'B' }));
  assert.notDeepEqual(normalizeIntent({ mode: 'new' }), normalizeIntent({ mode: 'new', fromSku: 'A', toSku: 'B' }));
});
test('PR3 signed binding authenticates across process instances with exact deterministic expiry', () => {
  const now = 1000000;
  const token = signer.sign(binding, now);
  assert.deepEqual(signer.verify(token, { now }), binding);
  assert.deepEqual(signer.verify(token, { now: now + TTL_SECONDS * 1000 - 1 }), binding);
  assert.throws(() => signer.verify(token, { now: now + TTL_SECONDS * 1000 }), { code: 'EXPORT_PREVIEW_EXPIRED' });
  assert.deepEqual(signer.verify(token, { completed: true, now: 999999999999 }), binding);
  const source = `const b=require('./src/services/export-templates/snapshot-binding');
    process.stdout.write(JSON.stringify(b.makeSigner(${JSON.stringify(secret)}).verify(${JSON.stringify(token)}, {now:${now}})));`;
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['-e', source], { cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8' })), binding);
  assert.throws(() => makeSigner(''), /secret/);
});
test('PR3 token tampering, malformed/oversized/foreign-purpose and unkeyed draft tokens fail', () => {
  const token = signer.sign(binding, 1000000);
  for (const value of ['draft-hash', 'abc.def.ghi', token.slice(0, -5), `ep1.e30.${'a'.repeat(43)}`, 'x'.repeat(MAX_TOKEN_BYTES + 1), {}, 1]) {
    assert.throws(() => signer.verify(value), { code: 'EXPORT_PREVIEW_INVALID' });
  }
  assert.throws(() => signer.verify(undefined), { code: 'EXPORT_PREVIEW_REQUIRED' });
  assert.throws(() => makeSigner('another-test-only-secret-9876543210').verify(token), { code: 'EXPORT_PREVIEW_INVALID' });
  const payload = Buffer.from(JSON.stringify({ purpose: 'draft-preview', iat: 1000, exp: 1900, binding })).toString('base64url');
  const key = createHmac('sha256', secret).update(PURPOSE).digest();
  const signature = createHmac('sha256', key).update(`ep1.${payload}`).digest('base64url');
  assert.throws(() => signer.verify(`ep1.${payload}.${signature}`), { code: 'EXPORT_PREVIEW_INVALID' });
  for (const change of [{ range: {} }, { cursor: 0 }, { effective: { ...binding.effective, activationGeneration: 1 } },
    { intent: { ...intent, unexpected: 'field' } }, { inputFingerprint: 'bad' }]) {
    assert.throws(() => signer.verify(signer.sign({ ...binding, ...change }), { completed: true }), { code: 'EXPORT_PREVIEW_INVALID' });
  }
});
test('PR3 completed comparison ignores issue time but retains intent and substantive evidence', () => {
  const snapshot = { request_contract: 'template-v1', request_intent: intent, binding_evidence: binding };
  assert.equal(assertCompleted(snapshot, intent, signer.verify(signer.sign(binding, 1000), { completed: true })), snapshot);
  assert.equal(assertCompleted(snapshot, intent, null), snapshot);
  assert.throws(() => assertCompleted(snapshot, intent, { ...binding, inputFingerprint: 'f'.repeat(64) }), { code: 'EXPORT_IDEMPOTENCY_CONFLICT' });
  assert.throws(() => assertCompleted(snapshot, { ...intent, mode: 'new' }), { code: 'EXPORT_IDEMPOTENCY_CONFLICT' });
  assert.throws(() => assertCompleted({ ...snapshot, request_contract: 'legacy' }, intent), { code: 'EXPORT_IDEMPOTENCY_CONFLICT' });
});
