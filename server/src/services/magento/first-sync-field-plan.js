// Pure first-sync decision matrix. Callers supply server-owned mapping/read/receipt
// evidence, then persist accepted fields + receipts atomically after fresh CAS.
// No result authorizes a remote write; pending_outward_confirmation still needs
// the ordinary guarded delivery and verified readback.
// Each field: {target, scope, kind:'scalar'|'name'|'option'|'derived', type:
// 'text'|'decimal'|'boolean'|'option', required, mapping:{proven,reason?},
// local:{known,present?,value?,unit?,forwardOptionId?}, remote:{known,present?,value?,unit?},
// unit?,scale?,constraints?,receipt?:{received? or state:'imported'|'equal'|
// 'optional_empty'|'outward_verified'|'name_received'},reverseCandidates?:[{value,optionId}],
// prospective?:{verified,value?,reason?}}. An unknown read supplies no value.
// Name receipts are per-language: once received, ordinary reconciliation owns
// subsequent edits. complete requires persisted terminal receipts for every field;
// readyForOutbound is only first-sync readiness after any required local apply.
// Received fields delegate to ordinary reconciliation, which remains mandatory.
// Derived values are supplied by authoritative forward
// evaluation of prospective canonical inputs; this planner never reverses them.
const MAX_FIELDS = 500;
const MAX_REVERSE_CANDIDATES = 256;
const KINDS = new Set(['scalar', 'name', 'option', 'derived']);
const TYPES = new Set(['text', 'decimal', 'boolean', 'option']);
const STATUSES = ['imported', 'equal', 'optional_empty', 'pending_outward_confirmation',
  'conflict', 'unknown', 'review_required'];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const RECEIPTS = new Set(['imported', 'equal', 'optional_empty', 'outward_verified', 'name_received']);
const CONTROL = /[\u0000-\u001f\u007f]/;
function invalid() {
  throw Object.assign(new Error('Invalid bounded first-sync field evidence'),
    { code: 'FIRST_SYNC_FIELD_INPUT_INVALID', statusCode: 422 });
}
function object(value, required, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (required.some(key => !Object.hasOwn(descriptors, key))
    || Object.keys(descriptors).some(key => ![...required, ...optional].includes(key)
      || !Object.hasOwn(descriptors[key], 'value'))) invalid();
}
function boundedText(value, maximum, empty = false) {
  return typeof value === 'string' && value.length <= maximum && (empty || value.trim() !== '')
    && !CONTROL.test(value);
}
function scalar(value) {
  return typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER || typeof value === 'string' && value.length <= 4096;
}
function denseArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some(key => key !== 'length'
    && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) invalid();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(descriptors, index) || !Object.hasOwn(descriptors[index], 'value')) invalid();
  }
}
function readState(state, local) {
  object(state, ['known'], ['present', 'value', 'unit', ...(local ? ['forwardOptionId'] : [])]);
  if (typeof state.known !== 'boolean') invalid();
  if (state.unit != null && !boundedText(state.unit, 32)) invalid();
  if (Object.hasOwn(state, 'forwardOptionId') && !boundedText(state.forwardOptionId, 128)) invalid();
  if (!state.known) {
    if (Object.hasOwn(state, 'value') || Object.hasOwn(state, 'present')
      && (typeof state.present !== 'boolean' || state.present)) invalid();
    return;
  }
  if (typeof state.present !== 'boolean') invalid();
  if (state.present && !Object.hasOwn(state, 'value')) invalid();
  if (Object.hasOwn(state, 'value') && state.value !== null && !scalar(state.value)) invalid();
}
function validateField(field) {
  object(field, ['target', 'scope', 'kind', 'type', 'required', 'mapping', 'local', 'remote'],
    ['unit', 'scale', 'constraints', 'receipt', 'reverseCandidates', 'prospective']);
  if (typeof field.target !== 'string' || typeof field.scope !== 'string'
    || !IDENTIFIER.test(field.target) || !IDENTIFIER.test(field.scope)
    || !KINDS.has(field.kind) || !TYPES.has(field.type) || typeof field.required !== 'boolean'
    || field.kind === 'name' && field.type !== 'text'
    || field.kind === 'option' && field.type !== 'option'
    || field.kind !== 'option' && field.type === 'option') invalid();
  if (field.unit != null && !boundedText(field.unit, 32)) invalid();
  if (field.scale !== undefined && (!Number.isInteger(field.scale) || field.scale < 0 || field.scale > 18
    || field.type !== 'decimal')) invalid();
  object(field.mapping, ['proven'], ['reason']);
  if (typeof field.mapping.proven !== 'boolean'
    || field.mapping.reason !== undefined && !boundedText(field.mapping.reason, 160)) invalid();
  readState(field.local, true); readState(field.remote, false);
  if (field.receipt !== undefined) {
    object(field.receipt, [], ['received', 'state']);
    if (!Object.keys(field.receipt).length
      || field.receipt.received !== undefined && typeof field.receipt.received !== 'boolean'
      || field.receipt.state !== undefined && !RECEIPTS.has(field.receipt.state)
      || field.receipt.state !== undefined && field.receipt.received === false
      || field.receipt.state === 'name_received' && field.kind !== 'name') invalid();
  }
  if (field.constraints !== undefined) {
    if (field.type !== 'decimal') invalid();
    object(field.constraints, [], ['min', 'max', 'minInclusive', 'maxInclusive']);
    for (const key of ['min', 'max']) if (Object.hasOwn(field.constraints, key)
      && normalizeDecimal(field.constraints[key]) === null) invalid();
    for (const key of ['minInclusive', 'maxInclusive']) if (Object.hasOwn(field.constraints, key)
      && typeof field.constraints[key] !== 'boolean') invalid();
    if (field.constraints.min !== undefined && field.constraints.max !== undefined
      && compareDecimals(normalizeDecimal(field.constraints.min), normalizeDecimal(field.constraints.max)) > 0) invalid();
  }
  if (field.reverseCandidates !== undefined) {
    if (field.kind !== 'option') invalid();
    denseArray(field.reverseCandidates, MAX_REVERSE_CANDIDATES);
    for (const candidate of field.reverseCandidates) {
      object(candidate, ['value', 'optionId']);
      const semantic = typeof candidate.value === 'number' ? String(candidate.value) : candidate.value;
      if (typeof semantic !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(semantic)
        || !Number.isSafeInteger(Number(semantic)) || Number(semantic) < -2147483648
        || Number(semantic) > 2147483647 || !boundedText(candidate.optionId, 128)) invalid();
    }
  }
  if (field.prospective !== undefined) {
    if (field.kind !== 'derived') invalid();
    object(field.prospective, ['verified'], ['value', 'reason']);
    if (typeof field.prospective.verified !== 'boolean'
      || field.prospective.value !== undefined && !scalar(field.prospective.value)
      || field.prospective.reason !== undefined && !boundedText(field.prospective.reason, 160)) invalid();
  }
}
function normalizeDecimal(value, scale = 18) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18
    || !['string', 'number'].includes(typeof value) || typeof value === 'number'
    && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null;
  const text = String(value).trim();
  if (text.length > 128 || !/^[+-]?\d+(?:[.,]\d+)?$/.test(text)) return null;
  const sign = text.startsWith('-') ? '-' : '';
  const [rawInteger, rawFraction = ''] = text.replace(/^[+-]/, '').replace(',', '.').split('.');
  const integer = rawInteger.replace(/^0+(?=\d)/, '');
  const fraction = rawFraction.replace(/0+$/, '');
  if (fraction.length > scale) return null;
  const zero = integer === '0' && fraction === '';
  return (zero ? '' : sign) + integer + (fraction ? '.' + fraction : '');
}
function compareDecimals(left, right) {
  const coefficient = value => {
    const [integer, fraction = ''] = value.split('.');
    return BigInt(integer + fraction.padEnd(18, '0'));
  };
  const a = coefficient(left), b = coefficient(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
function normalized(field, state) {
  if (state.present === false) {
    if (state.value != null && !(typeof state.value === 'string' && state.value.trim() === '')) {
      return { reason: 'PRESENCE_VALUE_MISMATCH' };
    }
    return { absent: true };
  }
  if (state.value == null || typeof state.value === 'string' && state.value.trim() === '') {
    return { reason: 'PRESENCE_VALUE_MISMATCH' };
  }
  if ((state.unit ?? null) !== (field.unit ?? null)) return { reason: 'UNIT_MISMATCH' };
  if (field.type === 'decimal') {
    const value = normalizeDecimal(state.value, field.scale ?? 18);
    if (value === null) return { reason: 'DECIMAL_INVALID_OR_SCALE_EXCEEDED' };
    const constraints = field.constraints || {};
    for (const bound of ['min', 'max']) if (constraints[bound] !== undefined) {
      const comparison = compareDecimals(value, normalizeDecimal(constraints[bound]));
      if (bound === 'min' ? comparison < 0 || comparison === 0 && constraints.minInclusive === false
        : comparison > 0 || comparison === 0 && constraints.maxInclusive === false) {
        return { reason: 'DECIMAL_OUT_OF_RANGE' };
      }
    }
    return { value };
  }
  if (field.type === 'boolean') {
    if ([false, 0, '0'].includes(state.value)) return { value: false };
    if ([true, 1, '1'].includes(state.value)) return { value: true };
    return { reason: 'BOOLEAN_INVALID' };
  }
  if (field.type === 'option') {
    if (typeof state.value === 'boolean' || !boundedText(String(state.value), 128)) return { reason: 'OPTION_INVALID' };
    return { value: String(state.value) };
  }
  return boundedText(state.value, field.kind === 'name' ? 1024 : 4096)
    ? { value: state.value } : { reason: 'TEXT_INVALID' };
}
function planField(field) {
  const received = field.receipt?.received === true || RECEIPTS.has(field.receipt?.state);
  const result = (status, reason, details = {}) => ({ target: field.target, scope: field.scope,
    kind: field.kind, status, reason, received, ...details });
  if (!field.remote.known) return result('unknown', 'REMOTE_READ_UNKNOWN');
  if (!field.local.known) return result('unknown', 'LOCAL_VALUE_UNKNOWN');
  if (received) {
    return result('review_required', field.kind === 'name'
      ? 'NAME_ALREADY_RECEIVED_USE_ORDINARY_RECONCILIATION'
      : 'FIELD_ALREADY_RECEIVED_USE_ORDINARY_RECONCILIATION', { ordinaryReconciliation: true });
  }
  if (!field.mapping.proven) return result('review_required', 'MAPPING_NOT_PROVEN',
    field.mapping.reason ? { evidenceReason: field.mapping.reason } : {});
  if (field.kind === 'name' && !['all', 'en'].includes(field.scope)) {
    return result('review_required', 'NAME_SCOPE_UNSUPPORTED');
  }
  const remote = normalized(field, field.remote);
  if (remote.reason) return result('review_required', 'REMOTE_' + remote.reason);
  let local;
  if (field.kind === 'derived') {
    if (!field.prospective?.verified || !Object.hasOwn(field.prospective, 'value')) {
      return result('review_required', 'DERIVED_PROSPECTIVE_INPUTS_NOT_PROVEN',
        field.prospective?.reason ? { evidenceReason: field.prospective.reason } : {});
    }
    local = normalized(field, { present: field.prospective.value !== ''
      && field.prospective.value != null, value: field.prospective.value, unit: field.unit });
  } else local = normalized(field, field.local);
  if (field.kind === 'name' && !remote.absent) {
    if (!local.reason && !local.absent && local.value === remote.value) {
      return result('equal', 'NORMALIZED_VALUES_EQUAL');
    }
    return result('imported', local.absent ? 'EMPTY_LOCAL_VALID_REMOTE' : 'FIRST_REMOTE_NAME_AUTHORITATIVE',
      { importValue: remote.value, before: { present: field.local.present,
        ...(Object.hasOwn(field.local, 'value') ? { value: field.local.value } : {}) } });
  }
  if (local.reason) return result('review_required', 'LOCAL_' + local.reason);
  if (local.absent && remote.absent) return field.required
    ? result('review_required', 'REQUIRED_FIELD_EMPTY') : result('optional_empty', 'BOTH_EMPTY_OPTIONAL');
  if (remote.absent) {
    if (field.kind === 'option' && !field.local.forwardOptionId) {
      return result('review_required', 'LOCAL_FORWARD_OPTION_NOT_PROVEN');
    }
    return result('pending_outward_confirmation', 'REMOTE_EMPTY_LOCAL_POPULATED',
      { outwardValue: field.kind === 'option' ? field.local.forwardOptionId : local.value,
        requiresGuardedOutward: true });
  }
  if (field.kind === 'derived') return local.absent
    ? result('review_required', 'DERIVED_CANONICAL_SOURCE_EMPTY')
    : local.value === remote.value ? result('equal', 'DERIVED_FORWARD_EQUAL')
      : result('review_required', 'DERIVED_FORWARD_MISMATCH');
  if (field.kind === 'option') {
    if (!local.absent) {
      if (!field.local.forwardOptionId) return result('review_required', 'LOCAL_FORWARD_OPTION_NOT_PROVEN');
      return field.local.forwardOptionId === remote.value
        ? result('equal', 'LOCAL_FORWARD_OPTION_EQUAL')
        : result('conflict', 'POPULATED_OPTION_VALUES_DIFFER');
    }
    const candidates = [...new Map((field.reverseCandidates || [])
      .filter(candidate => candidate.optionId === remote.value)
      .map(candidate => [String(candidate.value), candidate])).values()];
    if (candidates.length !== 1) return result('review_required',
      candidates.length ? 'REVERSE_OPTION_AMBIGUOUS' : 'REVERSE_OPTION_NOT_PROVEN',
      { candidateCount: candidates.length });
    return result('imported', 'EMPTY_LOCAL_UNIQUE_REMOTE_OPTION', { importValue: String(candidates[0].value) });
  }
  if (local.absent) return result('imported', 'EMPTY_LOCAL_VALID_REMOTE', { importValue: remote.value });
  if (local.value === remote.value) return result('equal', 'NORMALIZED_VALUES_EQUAL');
  return result('conflict', 'POPULATED_VALUES_DIFFER');
}
function planFirstSyncFields(input) {
  object(input, ['fields']);
  denseArray(input.fields, MAX_FIELDS);
  if (!input.fields.length) invalid();
  for (const field of input.fields) {
    try { validateField(field); } catch (error) {
      if (error.code === 'FIRST_SYNC_FIELD_INPUT_INVALID' && field && typeof field === 'object') {
        const target = Object.getOwnPropertyDescriptor(field, 'target')?.value;
        const scope = Object.getOwnPropertyDescriptor(field, 'scope')?.value;
        error.details = { reason: 'FIELD_INPUT_INVALID',
          ...(typeof target === 'string' && IDENTIFIER.test(target) ? { target } : {}),
          ...(typeof scope === 'string' && IDENTIFIER.test(scope) ? { scope } : {}) };
      }
      throw error;
    }
  }
  const keys = input.fields.map(field => field.scope + '/' + field.target);
  if (new Set(keys).size !== keys.length) invalid();
  const fields = input.fields.map(planField);
  const counts = Object.fromEntries(STATUSES.map(status => [status, fields.filter(field => field.status === status).length]));
  const receiptReady = field => ['imported', 'equal', 'optional_empty'].includes(field.status);
  const outwardReady = field => receiptReady(field) || field.status === 'pending_outward_confirmation'
    || field.ordinaryReconciliation === true;
  return { mode: 'plan_only', fields, progress: { total: fields.length, ...counts,
    received: fields.filter(field => field.received).length,
    receiptReady: fields.filter(receiptReady).length,
    unresolved: fields.filter(field => !field.received).length },
  complete: fields.every(field => field.received), readyForOutbound: fields.every(outwardReady),
  requiresLocalApply: fields.some(receiptReady),
  requiresOrdinaryReconciliation: fields.some(field => field.ordinaryReconciliation === true) };
}
module.exports = { planFirstSyncFields, normalizeDecimal, MAX_FIELDS, MAX_REVERSE_CANDIDATES };
