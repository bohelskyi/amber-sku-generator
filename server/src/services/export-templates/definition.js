const { createHash } = require('node:crypto');
const { HEADERS } = require('./magento-v1-data');
const { PRODUCT_FIELDS, fail } = require('./input-projection');

const LIMITS = Object.freeze({ definitionBytes: 256 * 1024, sources: 256, bindings: 512,
  depth: 8, children: 16, tableEntries: 512, totalTableEntries: 4096,
  literalChars: 4096, work: 20000, cellBytes: 16 * 1024, outputBytes: 64 * 1024 * 1024 });
const compiledDefinitions = new WeakSet();
const check = (condition, message) => { if (!condition) fail('TEMPLATE_INVALID', message); };
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeKey = (s) => typeof s === 'string' && /^[A-Za-z0-9_]+$/.test(s)
  && !['__proto__', 'constructor', 'prototype'].includes(s);
const id = (s) => typeof s === 'string' && /^[A-Za-z0-9_.-]+$/.test(s)
  && !['__proto__', 'constructor', 'prototype'].includes(s);
function shape(value, required, optional = []) {
  check(record(value), 'Expected object');
  check(required.every((k) => Object.hasOwn(value, k)), `Required keys: ${required.join(',')}`);
  check(Object.keys(value).every((k) => required.includes(k) || optional.includes(k)), 'Unsupported property');
}
function list(value, max = LIMITS.children) {
  check(Array.isArray(value) && value.length <= max, `List limit ${max}`);
}
function preflight(value) {
  let bytes = 0;
  let count = 0;
  const ancestors = new Set();
  function visit(v, depth) {
    check(depth <= 32 && ++count <= 60000, 'Structural limit');
    if (v === null || ['boolean', 'number', 'string'].includes(typeof v)) {
      check(typeof v !== 'number' || Number.isFinite(v), 'Non-JSON number');
      check(typeof v !== 'string' || v.length <= LIMITS.literalChars, 'Literal limit');
      bytes += Buffer.byteLength(JSON.stringify(v));
    } else {
      check(record(v) || Array.isArray(v), 'JSON data required');
      check((Array.isArray(v) ? [Array.prototype] : [Object.prototype, null]).includes(Object.getPrototypeOf(v)), 'Plain JSON required');
      check(!ancestors.has(v), 'Cyclic JSON');
      ancestors.add(v);
      bytes += 2;
      let entries = 0;
      for (const key in v) {
        check(Object.hasOwn(v, key), 'Inherited property');
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        check(Object.hasOwn(descriptor, 'value'), 'Accessors forbidden');
        check(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe key');
        check(key.length <= LIMITS.literalChars, 'Key limit');
        if (entries++) bytes++;
        if (!Array.isArray(v)) bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        visit(descriptor.value, depth + 1);
      }
      check(Object.getOwnPropertyNames(v).length === entries + (Array.isArray(v) ? 1 : 0), 'Non-enumerable properties forbidden');
      if (Array.isArray(v)) check(entries === v.length, 'Dense arrays required');
      check(Object.getOwnPropertySymbols(v).length === 0, 'Symbols forbidden');
      ancestors.delete(v);
    }
    check(bytes <= LIMITS.definitionBytes, 'Definition byte limit');
  }
  visit(value, 0);
  return bytes;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function validateDefinition(d) {
  const definitionBytes = preflight(d);
  shape(d, ['formatVersion', 'evaluatorVersion', 'outputContract', 'sources', 'tables', 'questionContracts', 'bindings', 'groups']);
  check(d.formatVersion === 1 && d.evaluatorVersion === 'magento-declarative-1'
    && d.outputContract === 'magento-products-v1', 'Unsupported version/contract');
  check(record(d.sources) && Object.keys(d.sources).length <= LIMITS.sources, 'Source limit');
  for (const [name, s] of Object.entries(d.sources)) {
    check(id(name) && record(s), 'Source ID/descriptor');
    if (s.kind === 'product') {
      shape(s, ['kind', 'field', 'type']);
      check(PRODUCT_FIELDS.includes(s.field)
        && s.type === (['full_sku', 'category'].includes(s.field) ? 'text' : 'scalar'), 'Product source');
    } else {
      shape(s, ['kind', 'category', 'key', 'type', 'provenance', 'aliases']);
      check(['semantic', 'information'].includes(s.kind) && s.type === 'scalar', 'Answer kind/type');
      check(typeof s.category === 'string' && Object.hasOwn(HEADERS, s.category) && safeKey(s.key), 'Answer location');
      check(s.provenance === 'supplied-stored-answers-v1', 'Unsupported provenance');
      list(s.aliases);
      const keys = new Set([s.key]);
      for (const a of s.aliases) {
        shape(a, ['key', 'schemaId', 'evidence']);
        check(safeKey(a.key) && !keys.has(a.key), 'Duplicate alias');
        check(typeof a.schemaId === 'string' && /^[1-9][0-9]*$/.test(a.schemaId)
          && typeof a.evidence === 'string' && a.evidence.trim() !== '', 'Alias provenance required');
        keys.add(a.key);
      }
    }
  }
  check(record(d.tables), 'Tables');
  let tableEntries = 0;
  for (const [name, table] of Object.entries(d.tables)) {
    check(id(name) && record(table), 'Table shape');
    const entries = Object.entries(table);
    check(entries.length <= LIMITS.tableEntries, 'Table entry limit');
    tableEntries += entries.length;
    check(entries.every(([, v]) => typeof v === 'string'), 'Text table required');
  }
  check(tableEntries <= LIMITS.totalTableEntries, 'Total table entry limit');
  let membershipEntries = 0;
  function membership(count) {
    membershipEntries += count;
    check(tableEntries + membershipEntries <= LIMITS.totalTableEntries, 'Total lookup/membership entry limit');
  }
  check(record(d.questionContracts) && Object.keys(d.questionContracts).length <= LIMITS.sources, 'Question limit');
  function rule(r, category, depth = 1) {
    check(depth <= LIMITS.depth && record(r), 'Malformed catalog rule');
    check(Object.keys(r).length <= LIMITS.children, 'Catalog rule branches');
    for (const [key, v] of Object.entries(r)) {
      if (key === '$and' || key === '$or') {
        list(v);
        v.forEach((b) => rule(b, category, depth + 1));
      } else {
        check(Object.hasOwn(d.sources, key) && d.sources[key].category === category, 'Unresolved rule source');
        const values = Array.isArray(v) ? v : [v];
        list(values);
        check(values.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x)), 'Catalog rule scalar');
      }
    }
  }
  for (const [name, q] of Object.entries(d.questionContracts)) {
    shape(q, ['source', 'exists', 'required', 'rule', 'allowed']);
    check(id(name) && id(q.source) && Object.hasOwn(d.sources, q.source) && d.sources[q.source].kind !== 'product', 'Question source');
    check(typeof q.exists === 'boolean' && typeof q.required === 'boolean', 'Question flags');
    list(q.allowed, LIMITS.tableEntries);
    membership(q.allowed.length);
    check(q.allowed.every((v) => typeof v === 'string') && new Set(q.allowed).size === q.allowed.length, 'Question option IDs');
    rule(q.rule, d.sources[q.source].category);
  }
  const types = new Map();
  const scopes = new Map();
  function node(n, scope, depth = 1) {
    check(depth <= LIMITS.depth, 'Node nesting limit');
    check(record(n) && typeof n.op === 'string', 'Node required');
    const child = (v) => node(v, scope, depth + 1);
    const text = (v) => check(child(v) === 'text', 'Text node required');
    const bool = (v) => check(child(v) === 'boolean', 'Boolean node required');
    switch (n.op) {
      case 'literal':
        shape(n, ['op', 'value']);
        check(n.value === null || ['string', 'number', 'boolean'].includes(typeof n.value), 'Scalar literal');
        return typeof n.value === 'string' ? 'text' : typeof n.value === 'boolean' ? 'boolean' : 'scalar';
      case 'source':
        shape(n, ['op', 'id']);
        check(id(n.id) && Object.hasOwn(d.sources, n.id), 'Unknown source');
        check(d.sources[n.id].kind === 'product' || d.sources[n.id].category === scope, 'Source scope');
        return 'scalar';
      case 'ref':
        shape(n, ['op', 'id']);
        check(id(n.id) && types.has(n.id) && (scopes.get(n.id) === scope || scopes.get(n.id) === '*'), 'Unresolved/forward/cross-group reference');
        return types.get(n.id);
      case 'text':
        shape(n, ['op', 'input', 'trim', 'format', 'onAbsent']);
        child(n.input);
        check(typeof n.trim === 'boolean' && ['scalar-v1', 'string-only-v1'].includes(n.format) && n.onAbsent === 'empty', 'Text format');
        return 'text';
      case 'semanticKey':
        shape(n, ['op', 'input']); check(child(n.input) !== 'boolean', 'Semantic ID cannot be boolean'); return 'text';
      case 'present':
        shape(n, ['op', 'input', 'policy']); child(n.input);
        check(n.policy === 'answer-v1', 'Presence policy'); return 'boolean';
      case 'lookup':
        shape(n, ['op', 'input', 'table', 'otherwise']); text(n.input); text(n.otherwise);
        check(id(n.table) && Object.hasOwn(d.tables, n.table), 'Unknown table'); return 'text';
      case 'when': {
        shape(n, ['op', 'if', 'then', 'else']); bool(n.if);
        const type = child(n.then); check(child(n.else) === type, 'Branch type mismatch'); return type;
      }
      case 'firstPresent': {
        shape(n, ['op', 'items', 'policy']); list(n.items);
        check(n.items.length > 0 && n.policy === 'answer-v1', 'Fallback policy');
        const ts = n.items.map(child); check(ts.every((t) => t === ts[0]), 'Fallback types'); return ts[0];
      }
      case 'eq': {
        shape(n, ['op', 'left', 'right']);
        const left = child(n.left); const right = child(n.right);
        check(left === right || left === 'scalar' || right === 'scalar', 'Equality type mismatch'); return 'boolean';
      }
      case 'in':
        shape(n, ['op', 'input', 'values']); child(n.input); list(n.values, LIMITS.tableEntries);
        membership(n.values.length);
        check(n.values.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)), 'Membership values'); return 'boolean';
      case 'all': case 'any':
        shape(n, ['op', 'items']); list(n.items); n.items.forEach(bool); return 'boolean';
      case 'not':
        shape(n, ['op', 'input']); bool(n.input); return 'boolean';
      case 'catalogRule':
        shape(n, ['op', 'question']);
        check(id(n.question) && Object.hasOwn(d.questionContracts, n.question), 'Unknown question');
        check(d.sources[d.questionContracts[n.question].source].category === scope, 'Question scope'); return 'boolean';
      case 'questionValue':
        shape(n, ['op', 'question', 'value', 'missingQuestion', 'missingAnswer']);
        check(id(n.question) && Object.hasOwn(d.questionContracts, n.question), 'Unknown question');
        check(d.sources[d.questionContracts[n.question].source].category === scope, 'Question scope');
        text(n.value); text(n.missingQuestion); text(n.missingAnswer);
        check(n.missingQuestion.op === 'error' && n.missingAnswer.op === 'error', 'Question failures must emit diagnostics'); return 'text';
      case 'numberText': case 'decimalText':
        shape(n, ['op', 'input', 'format', 'error']);
        if (n.op === 'decimalText') text(n.input); else child(n.input);
        text(n.error);
        check(n.error.op === 'error', 'Numeric failure must emit a diagnostic');
        check(n.format === (n.op === 'numberText' ? 'js-number-positive-v1' : 'unsigned-comma-dot-v1'), 'Numeric format'); return 'text';
      case 'numericBand':
        shape(n, ['op', 'input', 'format', 'bands', 'onInvalid', 'outside']); text(n.input); text(n.outside);
        check(['number-v1', 'first-comma-number-v1'].includes(n.format), 'Band format');
        check(n.onInvalid === 'error' || (n.onInvalid === 'input' && scope === 'NM' && n.format === 'first-comma-number-v1'), 'Band invalid policy');
        list(n.bands);
        for (const b of n.bands) {
          shape(b, ['min', 'max', 'minInclusive', 'maxInclusive', 'value']);
          check([b.min, b.max].every((v) => v === null || typeof v === 'number')
            && (b.min === null || b.max === null || b.min <= b.max)
            && typeof b.minInclusive === 'boolean' && typeof b.maxInclusive === 'boolean' && typeof b.value === 'string', 'Band interval');
        }
        return 'text';
      case 'interpolate': {
        shape(n, ['op', 'template', 'slots']);
        check(typeof n.template === 'string' && record(n.slots), 'Interpolation');
        const names = [...n.template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
        check(!/[{}]/.test(n.template.replace(/\{[A-Za-z0-9_]+\}/g, '')), 'Interpolation syntax');
        check(Object.keys(n.slots).length <= LIMITS.children
          && names.every((k) => Object.hasOwn(n.slots, k)) && Object.keys(n.slots).every((k) => names.includes(k)), 'Interpolation slots');
        Object.values(n.slots).forEach(text); return 'text';
      }
      case 'join':
        shape(n, ['op', 'items', 'delimiter', 'omitEmpty']); list(n.items); n.items.forEach(text);
        check(typeof n.delimiter === 'string' && typeof n.omitEmpty === 'boolean', 'Join format'); return 'text';
      case 'require':
        shape(n, ['op', 'if', 'value', 'error']); bool(n.if); text(n.value); text(n.error);
        check(n.error.op === 'error', 'Constraint failure must emit a diagnostic'); return 'text';
      case 'error':
        shape(n, ['op', 'field', 'message'], ['code']);
        check(safeKey(n.field) && (n.code === undefined || typeof n.code === 'string'), 'Diagnostic'); text(n.message); return 'text';
      default: check(false, `Unsupported operation: ${n.op}`);
    }
  }
  list(d.bindings, LIMITS.bindings);
  for (const b of d.bindings) {
    shape(b, ['id', 'group', 'value']);
    check(id(b.id) && !types.has(b.id) && typeof b.group === 'string'
      && (b.group === '*' || Object.hasOwn(HEADERS, b.group)), 'Binding ID/scope');
    types.set(b.id, node(b.value, b.group)); scopes.set(b.id, b.group);
  }
  list(d.groups, 6); check(d.groups.length === 6, 'Six groups required');
  const routes = new Set();
  for (const g of d.groups) {
    shape(g, ['route', 'name', 'columns', 'evaluate', 'rows']);
    check(typeof g.route === 'string' && Object.hasOwn(HEADERS, g.route) && !routes.has(g.route)
      && typeof g.name === 'string' && g.name.trim() !== '', 'Group route');
    routes.add(g.route);
    list(g.columns, 64);
    check(g.columns.length === HEADERS[g.route].length && new Set(g.columns).size === g.columns.length
      && g.columns.every((c) => HEADERS[g.route].includes(c)), 'Approved output columns required');
    list(g.evaluate, LIMITS.bindings); g.evaluate.forEach((n) => node(n, g.route));
    list(g.rows, 2); check(g.rows.length === 2, 'Two rows required');
    g.rows.forEach((r, i) => {
      shape(r, ['id', 'default', 'cells']);
      check(r.id === ['base', 'english'][i] && r.default === '' && record(r.cells), 'Row contract');
      check(['sku', 'store_view_code', 'name', 'attribute_set_code', 'product_type'].every((k) => Object.hasOwn(r.cells, k)), 'Identity cells required');
      for (const [key, n] of Object.entries(r.cells)) {
        check(g.columns.includes(key) && node(n, g.route) === 'text', 'Output cell type/column');
      }
    });
  }
  return { definitionBytes, tableEntries, membershipEntries, sources: Object.keys(d.sources).length, bindings: d.bindings.length };
}

function compileDefinition(definition) {
  const metrics = validateDefinition(definition);
  const canonicalJson = canonical(definition);
  const result = freeze({ definition: JSON.parse(canonicalJson), metrics,
    hash: createHash('sha256').update(canonicalJson, 'utf8').digest('hex') });
  compiledDefinitions.add(result);
  return result;
}
function assertCompiled(value) { check(compiledDefinitions.has(value), 'Compile the definition first'); }

module.exports = { LIMITS, compileDefinition, validateDefinition, assertCompiled, validateJsonData: preflight };
