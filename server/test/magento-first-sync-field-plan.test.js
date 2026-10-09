const test = require('node:test');
const assert = require('node:assert/strict');
const { planFirstSyncFields, normalizeDecimal, MAX_FIELDS, MAX_REVERSE_CANDIDATES } =
  require('../src/services/magento/first-sync-field-plan');
const present = (value, unit) => ({ known: true, present: true, value, ...(unit !== undefined ? { unit } : {}) });
const absent = () => ({ known: true, present: false });
const field = (patch = {}) => ({ target: 'decor_weight', scope: 'all', kind: 'scalar',
  type: 'decimal', scale: 3, required: true, mapping: { proven: true },
  local: absent(), remote: present('5'), ...patch });
const plan = (...fields) => planFirstSyncFields({ fields });
const first = value => plan(value).fields[0];
const name = (patch = {}) => field({ target: 'name', kind: 'name', type: 'text', scale: undefined,
  local: present('Manager name'), remote: present('Magento name'), ...patch });
const option = (patch = {}) => field({ target: 'faktura_namystyn', kind: 'option', type: 'option',
  scale: undefined, local: present(1), remote: present('401'),
  reverseCandidates: [{ value: 1, optionId: '401' }, { value: 4, optionId: '401' }], ...patch });
const invalid = value => assert.throws(() => planFirstSyncFields(value), { code: 'FIRST_SYNC_FIELD_INPUT_INVALID' });

test('empty canonical field accepts exact remote decimal as a plan and needs durable receipt', () => {
  const result = plan(field({ remote: present('005,2000') }));
  assert.equal(result.fields[0].status, 'imported');
  assert.equal(result.fields[0].importValue, '5.2');
  assert.equal(result.mode, 'plan_only');
  assert.equal(result.requiresLocalApply, true);
  assert.equal(result.readyForOutbound, true);
  assert.equal(result.complete, false);
  assert.equal(result.progress.receiptReady, 1);
  assert.equal(result.progress.received, 0);
});
test('filled differing business values remain conflict; remote authority is not broad overwrite', () => {
  const result = plan(field({ local: present('4'), remote: present('5') }));
  assert.equal(result.fields[0].status, 'conflict');
  assert.equal(result.fields[0].reason, 'POPULATED_VALUES_DIFFER');
  assert.equal(Object.hasOwn(result.fields[0], 'importValue'), false);
  assert.equal(result.readyForOutbound, false);
  assert.equal(result.complete, false);
});
test('decimal formatting, trailing zeroes and negative zero normalize exactly', () => {
  for (const [local, remote] of [['+005,2000', '5.2'], ['-0.000', 0], ['-05.250', '-5,25']]) {
    assert.equal(first(field({ local: present(local), remote: present(remote) })).status, 'equal');
  }
  assert.equal(normalizeDecimal('000.001200', 4), '0.0012');
});
test('there is no tolerance or rounding of unequal values', () => {
  assert.equal(first(field({ scale: 4, local: present('1.0001'), remote: present('1.0002') })).status, 'conflict');
  assert.equal(first(field({ remote: present('1.2345') })).reason, 'REMOTE_DECIMAL_INVALID_OR_SCALE_EXCEEDED');
  assert.equal(normalizeDecimal('1.2345', 3), null);
});
test('large string decimals compare exactly without Number coercion', () => {
  const value = '9007199254740993.125';
  assert.equal(first(field({ local: present(value), remote: present(value + '0') })).status, 'equal');
  assert.equal(first(field({ local: present(value), remote: present('9007199254740994.125') })).status, 'conflict');
});
test('scientific notation, mixed separators and unsafe numeric payloads are rejected', () => {
  for (const value of ['1e3', '1,234.5', 'NaN', 'Infinity', '12 g']) {
    assert.equal(first(field({ remote: present(value) })).reason, 'REMOTE_DECIMAL_INVALID_OR_SCALE_EXCEEDED');
  }
  invalid({ fields: [field({ remote: present(Number.MAX_SAFE_INTEGER + 1) })] });
});
test('zero is populated data, including numeric and string zero', () => {
  assert.equal(first(field({ remote: present(0) })).status, 'imported');
  assert.equal(first(field({ local: present(0), remote: present('0.000') })).status, 'equal');
  assert.equal(first(field({ local: present(0), remote: absent() })).status, 'pending_outward_confirmation');
});
test('false and native boolean zero are populated data, not emptiness', () => {
  const base = field({ target: 'custom_boolean', type: 'boolean', scale: undefined });
  assert.equal(first({ ...base, remote: present(false) }).importValue, false);
  assert.equal(first({ ...base, local: present(false), remote: present('0') }).status, 'equal');
  assert.equal(first({ ...base, local: present(false), remote: present(1) }).status, 'conflict');
  assert.equal(first({ ...base, remote: present('false') }).reason, 'REMOTE_BOOLEAN_INVALID');
});
test('both optional empty resolves the matrix only after its independent receipt', () => {
  const result = plan(field({ required: false, remote: absent() }));
  assert.equal(result.fields[0].status, 'optional_empty');
  assert.equal(result.readyForOutbound, true);
  assert.equal(result.complete, false);
  assert.equal(plan(field({ required: false, remote: absent(), receipt: { state: 'optional_empty' } })).complete, true);
});
test('missing required value has a precise target/scope and does not initialize', () => {
  const result = first(field({ target: 'price', scope: 'all', remote: absent() }));
  assert.deepEqual([result.target, result.scope, result.status, result.reason],
    ['price', 'all', 'review_required', 'REQUIRED_FIELD_EMPTY']);
  assert.equal(result.received, false);
});
test('local populated remote empty can proceed outward but waits for verified receipt', () => {
  const pending = plan(field({ local: present('5'), remote: absent() }));
  assert.equal(pending.fields[0].status, 'pending_outward_confirmation');
  assert.equal(pending.fields[0].outwardValue, '5');
  assert.equal(pending.fields[0].requiresGuardedOutward, true);
  assert.equal(pending.readyForOutbound, true);
  assert.equal(pending.complete, false);
  const verified = plan(field({ local: present('5'), remote: present('5'), receipt: { state: 'outward_verified' } }));
  assert.equal(verified.complete, true);
  assert.equal(verified.requiresOrdinaryReconciliation, true);
  assert.equal(Object.hasOwn(verified.fields[0], 'importValue'), false);
});
test('failed/unknown remote read never becomes empty or authorizes outward', () => {
  const result = plan(field({ local: present('5'), remote: { known: false } }));
  assert.equal(result.fields[0].status, 'unknown');
  assert.equal(result.fields[0].reason, 'REMOTE_READ_UNKNOWN');
  assert.equal(result.readyForOutbound, false);
  assert.equal(Object.hasOwn(result.fields[0], 'outwardValue'), false);
});
test('unknown local canonical value is not assumed empty', () => {
  assert.equal(first(field({ local: { known: false } })).reason, 'LOCAL_VALUE_UNKNOWN');
});
test('presence/value inconsistency is review, never implicit import or clear', () => {
  for (const state of [{ known: true, present: false, value: 0 }, present(null), present(' ')]) {
    assert.equal(first(field({ remote: state })).reason, 'REMOTE_PRESENCE_VALUE_MISMATCH');
  }
  assert.equal(first(field({ local: { known: true, present: false, value: 5 } })).reason,
    'LOCAL_PRESENCE_VALUE_MISMATCH');
});
test('unproven source mapping remains explicit review', () => {
  const result = first(field({ mapping: { proven: false, reason: 'firstPresent has two canonical sources' } }));
  assert.equal(result.reason, 'MAPPING_NOT_PROVEN');
  assert.equal(result.evidenceReason, 'firstPresent has two canonical sources');
});
test('same units accept formatting equivalence; unknown/different units do not convert', () => {
  const base = field({ unit: 'g', local: present('5.000', 'g') });
  assert.equal(first({ ...base, remote: present('5', 'g') }).status, 'equal');
  assert.equal(first({ ...base, remote: present('0.005', 'kg') }).reason, 'REMOTE_UNIT_MISMATCH');
  assert.equal(first({ ...base, remote: present('5') }).reason, 'REMOTE_UNIT_MISMATCH');
  assert.equal(first({ ...base, local: present('5', 'kg'), remote: present('5', 'g') }).reason, 'LOCAL_UNIT_MISMATCH');
});
test('positive price constraint rejects populated zero; generic zero remains data', () => {
  const result = first(field({ target: 'price', unit: 'UAH', scale: 2,
    constraints: { min: '0', minInclusive: false }, remote: present('0.00', 'UAH') }));
  assert.equal(result.reason, 'REMOTE_DECIMAL_OUT_OF_RANGE');
});
test('exact decimal bounds honor negative values and inclusive/exclusive limits', () => {
  const base = field({ constraints: { min: '-1.5', max: '0.5', minInclusive: false } });
  assert.equal(first({ ...base, remote: present('-1.50') }).reason, 'REMOTE_DECIMAL_OUT_OF_RANGE');
  assert.equal(first({ ...base, remote: present('-1.499') }).status, 'imported');
  assert.equal(first({ ...base, remote: present('0.50') }).status, 'imported');
  assert.equal(first({ ...base, remote: present('0.501') }).reason, 'REMOTE_DECIMAL_OUT_OF_RANGE');
});
test('each first populated remote name is authoritative independently of filled local text', () => {
  const result = first(name());
  assert.equal(result.status, 'imported');
  assert.equal(result.reason, 'FIRST_REMOTE_NAME_AUTHORITATIVE');
  assert.equal(result.importValue, 'Magento name');
});
test('equal names do not manufacture a received flag', () => {
  const result = plan(name({ remote: present('Manager name') }));
  assert.equal(result.fields[0].status, 'equal');
  assert.equal(result.complete, false);
  assert.equal(result.progress.receiptReady, 1);
});
test('received name receipt preserves later local edits on every retry', () => {
  const result = plan(name({ local: present('Later manager edit'), receipt: { state: 'name_received' } }));
  assert.equal(result.fields[0].status, 'review_required');
  assert.equal(result.fields[0].reason, 'NAME_ALREADY_RECEIVED_USE_ORDINARY_RECONCILIATION');
  assert.equal(result.requiresOrdinaryReconciliation, true);
  assert.equal(result.complete, true);
  assert.equal(result.requiresLocalApply, false);
  assert.equal(Object.hasOwn(result.fields[0], 'importValue'), false);
});
test('prior imported/equal field receipt never reimports a later cleared local value', () => {
  for (const state of ['imported', 'equal']) {
    const result = first(field({ local: absent(), remote: present('8'), receipt: { state } }));
    assert.equal(result.ordinaryReconciliation, true);
    assert.equal(result.received, true);
    assert.equal(Object.hasOwn(result, 'importValue'), false);
  }
});
test('one received name language never initializes an unknown or missing other language', () => {
  const result = plan(name({ scope: 'all', receipt: { state: 'name_received' } }),
    name({ scope: 'en', remote: { known: false } }));
  assert.equal(result.fields[0].received, true);
  assert.equal(result.fields[1].status, 'unknown');
  assert.equal(result.progress.received, 1);
  assert.equal(result.progress.unresolved, 1);
  assert.equal(result.readyForOutbound, false);
  assert.equal(result.complete, false);
});
test('empty remote language preserves local language for guarded outward, without broad name wipe', () => {
  const result = plan(name({ scope: 'all' }), name({ scope: 'en', remote: absent() }));
  assert.equal(result.fields[0].status, 'imported');
  assert.equal(result.fields[1].status, 'pending_outward_confirmation');
  assert.equal(Object.hasOwn(result.fields[1], 'importValue'), false);
  assert.equal(result.readyForOutbound, true);
  assert.equal(result.complete, false);
});
test('unsupported name scope and malformed remote names require precise review', () => {
  assert.equal(first(name({ scope: 'ua' })).reason, 'NAME_SCOPE_UNSUPPORTED');
  assert.equal(first(name({ remote: present('x'.repeat(1025)) })).reason, 'REMOTE_TEXT_INVALID');
});
test('populated local semantic option can prove equality in a many-to-one mapping', () => {
  const result = first(option({ local: { ...present(4), forwardOptionId: '401' } }));
  assert.equal(result.status, 'equal');
  assert.equal(result.reason, 'LOCAL_FORWARD_OPTION_EQUAL');
  assert.equal(Object.hasOwn(result, 'importValue'), false);
});
test('filled differing options conflict even when remote reverse mapping is unique', () => {
  const result = first(option({ local: { ...present(1), forwardOptionId: '402' } }));
  assert.equal(result.status, 'conflict');
  assert.equal(result.reason, 'POPULATED_OPTION_VALUES_DIFFER');
});
test('empty local option needs unique semantic reverse; many-to-one must not guess', () => {
  const ambiguous = first(option({ local: absent() }));
  assert.equal(ambiguous.status, 'review_required');
  assert.equal(ambiguous.reason, 'REVERSE_OPTION_AMBIGUOUS');
  assert.equal(ambiguous.candidateCount, 2);
  const unique = first(option({ local: absent(), remote: present('403'),
    reverseCandidates: [{ value: 0, optionId: '403' }] }));
  assert.equal(unique.status, 'imported');
  assert.equal(unique.importValue, '0');
});
test('duplicate evidence of the same semantic ID is not distinct ambiguity', () => {
  const result = first(option({ local: absent(), reverseCandidates: [
    { value: 0, optionId: '401' }, { value: '0', optionId: '401' }] }));
  assert.equal(result.status, 'imported');
  assert.equal(result.importValue, '0');
});
test('missing option proof and unknown remote option remain review', () => {
  assert.equal(first(option()).reason, 'LOCAL_FORWARD_OPTION_NOT_PROVEN');
  assert.equal(first(option({ local: absent(), remote: present('999') })).reason, 'REVERSE_OPTION_NOT_PROVEN');
});
test('derived output validates prospective canonical inputs and never reverse-imports', () => {
  const base = field({ kind: 'derived', target: 'fraction', type: 'text', scale: undefined,
    local: absent(), remote: present('20-50'), prospective: { verified: true, value: '20-50' } });
  assert.equal(first(base).status, 'equal');
  const mismatch = first({ ...base, prospective: { verified: true, value: '50-100' } });
  assert.equal(mismatch.reason, 'DERIVED_FORWARD_MISMATCH');
  assert.equal(Object.hasOwn(mismatch, 'importValue'), false);
  assert.equal(first({ ...base, prospective: { verified: false, reason: 'weight unresolved' } }).reason,
    'DERIVED_PROSPECTIVE_INPUTS_NOT_PROVEN');
  assert.equal(first({ ...base, prospective: { verified: true, value: '' } }).reason,
    'DERIVED_CANONICAL_SOURCE_EMPTY');
});
test('derived prospective result can fill empty remote only through ordinary guarded outward', () => {
  const result = first(field({ kind: 'derived', remote: absent(), prospective: { verified: true, value: '5.00' } }));
  assert.equal(result.status, 'pending_outward_confirmation');
  assert.equal(result.outwardValue, '5');
  assert.equal(result.requiresGuardedOutward, true);
});
test('receipts do not hide failed current read or clear a received language', () => {
  const result = plan(name({ receipt: { state: 'name_received' }, remote: { known: false } }));
  assert.equal(result.complete, true);
  assert.equal(result.fields[0].status, 'unknown');
  assert.equal(result.readyForOutbound, false);
  assert.equal(Object.hasOwn(result.fields[0], 'importValue'), false);
});
test('planner is deterministic and leaves nested input/evidence untouched', () => {
  const input = { fields: [option({ local: absent() }), name({ scope: 'en' })] };
  const before = structuredClone(input);
  assert.deepEqual(planFirstSyncFields(input), planFirstSyncFields(input));
  assert.deepEqual(input, before);
});
test('strict input shape rejects missing identifiers, unknown values and duplicate target/scope', () => {
  for (const item of [field({ target: undefined }), field({ target: '' }), field({ scope: 1 }),
    field({ extra: true }), field({ required: 1 }), field({ kind: 'other' }),
    field({ remote: { known: false, present: false, value: null } })]) invalid({ fields: [item] });
  invalid({ fields: [field(), field()] });
  invalid({ fields: [] });
});
test('input bounds reject sparse arrays, accessors and oversized lists without executing them', () => {
  invalid({ fields: Array(1) });
  invalid({ fields: Array.from({ length: MAX_FIELDS + 1 }, (_, index) => field({ target: 'field' + index })) });
  invalid({ fields: [option({ reverseCandidates: Array.from({ length: MAX_REVERSE_CANDIDATES + 1 },
    (_, value) => ({ value, optionId: '401' })) })] });
  let invoked = false;
  const accessor = {};
  Object.defineProperty(accessor, 'fields', { get() { invoked = true; return [field()]; } });
  invalid(accessor);
  assert.equal(invoked, false);
  const list = [field()];
  Object.defineProperty(list, 0, { get() { invoked = true; return field(); } });
  invalid({ fields: list });
  assert.equal(invoked, false);
});
test('invalid option semantics, constraints, scales and receipt evidence fail closed', () => {
  for (const item of [option({ reverseCandidates: [{ value: false, optionId: '401' }] }),
    option({ reverseCandidates: [{ value: '', optionId: '401' }] }),
    field({ constraints: { min: '2', max: '1' } }), field({ scale: 19 }),
    field({ receipt: { state: 'unknown' } }), field({ receipt: { state: 'imported', received: false } }),
    field({ receipt: { state: 'name_received' } })]) invalid({ fields: [item] });
});
test('one conflict blocks outbound even beside received or outward-pending fields', () => {
  const result = plan(field({ target: 'weight', local: present('5'), remote: absent() }),
    field({ target: 'price', local: present('10'), remote: present('12') }),
    name({ scope: 'en', receipt: { state: 'name_received' } }));
  assert.equal(result.readyForOutbound, false);
  assert.equal(result.complete, false);
  assert.equal(result.progress.pending_outward_confirmation, 1);
  assert.equal(result.progress.conflict, 1);
  assert.equal(result.progress.received, 1);
});

test('empty remote option emits proved native ID outward, never its semantic value', () => {
  const result = first(option({ local: { ...present(4), forwardOptionId: '401' }, remote: absent() }));
  assert.equal(result.status, 'pending_outward_confirmation');
  assert.equal(result.outwardValue, '401');
  assert.notEqual(result.outwardValue, '4');
  assert.equal(first(option({ remote: absent() })).reason, 'LOCAL_FORWARD_OPTION_NOT_PROVEN');
});
test('imports and verified outward receipts progress independently without global initialization', () => {
  const initial = plan(field({ target: 'weight' }), field({ target: 'price', local: present('10'), remote: absent() }));
  assert.equal(initial.readyForOutbound, true);
  assert.equal(initial.complete, false);
  assert.equal(initial.progress.received, 0);
  const accepted = plan(field({ target: 'weight', local: present('5'), receipt: { state: 'imported' } }),
    field({ target: 'price', local: present('10'), remote: absent() }));
  assert.equal(accepted.progress.received, 1);
  assert.equal(accepted.progress.unresolved, 1);
  assert.equal(accepted.readyForOutbound, true);
  assert.equal(accepted.complete, false);
  assert.equal(accepted.requiresOrdinaryReconciliation, true);
  assert.equal(accepted.requiresLocalApply, false);
});
test('malformed per-field input retains safe exact target and scope in its error', () => {
  assert.throws(() => plan(field({ target: 'price', scope: 'all', remote: present(Number.NaN) })),
    { code: 'FIRST_SYNC_FIELD_INPUT_INVALID',
      details: { target: 'price', scope: 'all', reason: 'FIELD_INPUT_INVALID' } });
});
test('normalization of supported text is exact, not casefolded or whitespace collapsed', () => {
  const result = first(field({ target: 'size', type: 'text', scale: undefined,
    local: present('10 x 20'), remote: present('10  x 20') }));
  assert.equal(result.status, 'conflict');
  assert.equal(first(name({ local: present('Name'), remote: present('name') })).status, 'imported');
});

test('valid first remote name replaces invalid known local legacy text and binds exact before', () => {
  for (const value of ['x'.repeat(1500), 'legacy\nname', 123]) {
    const result = first(name({ local: present(value) }));
    assert.equal(result.status, 'imported');
    assert.equal(result.importValue, 'Magento name');
    assert.deepEqual(result.before, { present: true, value });
  }
});
test('unknown local name stays unknown; empty remote cannot send invalid local name', () => {
  assert.equal(first(name({ local: { known: false } })).status, 'unknown');
  const result = first(name({ local: present('x'.repeat(1500)), remote: absent() }));
  assert.equal(result.reason, 'LOCAL_TEXT_INVALID');
  assert.equal(Object.hasOwn(result, 'outwardValue'), false);
});
test('remote name controls remain invalid and cannot replace any local text', () => {
  const result = first(name({ remote: present('remote\nname') }));
  assert.equal(result.reason, 'REMOTE_TEXT_INVALID');
  assert.equal(Object.hasOwn(result, 'importValue'), false);
});
test('receipt always preserves a later invalid local name rather than repeating remote authority', () => {
  const result = first(name({ local: present('x'.repeat(1500)), receipt: { state: 'name_received' } }));
  assert.equal(result.ordinaryReconciliation, true);
  assert.equal(Object.hasOwn(result, 'importValue'), false);
});

test('unknown read metadata is bounded before deferring to unknown', () => {
  invalid({ fields: [field({ remote: { known: false, unit: 'x'.repeat(33) } })] });
  invalid({ fields: [option({ local: { known: false, forwardOptionId: 'x'.repeat(129) } })] });
  assert.equal(first(field({ remote: { known: false, unit: 'g' } })).status, 'unknown');
});
