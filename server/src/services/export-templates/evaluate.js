const { buildCsv, escapeCsvValue } = require('../../utils/csv');
const { LIMITS, assertCompiled } = require('./definition');
const { readSource, own, fail, scalar, identityText } = require('./input-projection');
const { sourceSupportChecker } = require('./source-support');

const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';
function budgets(options = {}) {
  const result = { work: LIMITS.work, cellBytes: LIMITS.cellBytes, outputBytes: LIMITS.outputBytes };
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(result, key) || !Number.isInteger(value) || value < 1 || value > result[key]) {
      fail('EVALUATION_LIMIT', 'Budgets may only lower fixed limits');
    }
    result[key] = value;
  }
  return result;
}

function runProduct(compiled, product, limits, observation) {
  try { return runSupportedProduct(compiled, product, limits, observation); }
  catch (cause) {
    if (cause.code !== 'SOURCE_SUPPORT_INVALID') throw cause;
    if (observation) observation.issues = [{ code: cause.code, field: 'sourceSupport', message: cause.message,
      target: observation.target || { kind: 'source', source: observation.source || null } }];
    return { work: 0, mapped: { group: product.category, sku: product.full_sku,
      errors: [{ code: cause.code, field: 'sourceSupport', message: cause.message }] } };
  }
}

function runSupportedProduct(compiled, product, limits, observation) {
  const d = compiled.definition;
  const rawGroup = checkCell(identityText(own(product, 'category'), 'category'));
  const group = rawGroup === undefined || rawGroup === null ? '' : String(rawGroup);
  const profile = d.groups.find((g) => g.route === group);
  if (!profile) return { mapped: { group, sku: checkCell(identityText(own(product, 'full_sku'), 'full_sku')), errors: [
    { field: 'attribute_set_code', message: 'Немає Magento-профілю для категорії.' },
  ] }, work: 0 };
  const bindings = new Map(d.bindings.map((b) => [b.id, b.value]));
  const memo = new Map();
  const errors = [];
  let work = 0;
  function tick() { if (++work > limits.work) fail('EVALUATION_LIMIT', 'Work per product exceeded'); }
  function checkCell(value) {
    if (typeof value === 'string' && (value.length > limits.cellBytes || Buffer.byteLength(value, 'utf8') > limits.cellBytes)) {
      fail('EVALUATION_LIMIT', 'Cell/intermediate UTF-8 limit exceeded');
    }
    return value;
  }
  const sourceMemo = new Map();
  const checkSupport = sourceSupportChecker(d, product);
  function source(id) {
    if (!sourceMemo.has(id)) {
      if (observation) observation.source = id;
      const value = checkCell(readSource(d.sources[id], product));
      checkSupport(d.sources[id], value);
      sourceMemo.set(id, value);
    }
    return sourceMemo.get(id);
  }
  function rule(r) {
    tick();
    // Same scalar normalization as rules.isRuleMatched, with closed own-property sources.
    const normalize = (v) => v == null ? v : Number.isNaN(Number(v)) ? String(v) : Number(v);
    for (const [key, expected] of Object.entries(r)) {
      tick();
      if (key === '$and') { if (!expected.every(rule)) return false; }
      else if (key === '$or') { if (!expected.some(rule)) return false; }
      else {
        const actual = normalize(source(key));
        if (Array.isArray(expected)) {
          if (!expected.map(normalize).includes(actual)) return false;
        } else if (actual !== normalize(expected)) return false;
      }
    }
    return true;
  }
  function evaluate(n) {
    tick();
    return checkCell(operation(n));
  }
  function operation(n) {
    switch (n.op) {
      case 'literal': return n.value;
      case 'source': return source(n.id);
      case 'ref':
        if (!memo.has(n.id)) memo.set(n.id, evaluate(bindings.get(n.id)));
        return memo.get(n.id);
      case 'text': {
        const v = evaluate(n.input);
        const text = v == null || (n.format === 'string-only-v1' && typeof v !== 'string') ? '' : String(v);
        return n.trim ? text.trim() : text;
      }
      case 'semanticKey': {
        const v = evaluate(n.input);
        if (v == null) return '';
        if (typeof v === 'boolean' || (typeof v === 'number' && !Number.isFinite(v))) {
          fail('INPUT_INVALID', 'semanticKey requires string or finite number');
        }
        return String(v);
      }
      case 'present': return present(evaluate(n.input));
      case 'lookup': {
        const key = evaluate(n.input);
        return Object.hasOwn(d.tables[n.table], key) ? d.tables[n.table][key] : evaluate(n.otherwise);
      }
      case 'when': return evaluate(evaluate(n.if) ? n.then : n.else);
      case 'firstPresent':
        for (const item of n.items) { const v = evaluate(item); if (present(v)) return v; }
        return '';
      case 'eq': {
        const left = evaluate(n.left); const right = evaluate(n.right);
        return left !== undefined && left === right;
      }
      case 'in': return n.values.includes(evaluate(n.input));
      case 'all': return n.items.every((item) => evaluate(item));
      case 'any': return n.items.some((item) => evaluate(item));
      case 'not': return !evaluate(n.input);
      case 'catalogRule': return rule(d.questionContracts[n.question].rule);
      case 'questionValue': {
        const q = d.questionContracts[n.question];
        if (!q.exists) return evaluate(n.missingQuestion);
        if (!rule(q.rule)) return '';
        if (!present(source(q.source))) return q.required ? evaluate(n.missingAnswer) : '';
        return evaluate(n.value);
      }
      case 'numberText': {
        const number = Number(evaluate(n.input));
        return Number.isFinite(number) && number > 0 ? String(number) : evaluate(n.error);
      }
      case 'decimalText': {
        const v = evaluate(n.input);
        if (v === '') return '';
        return /^\d+(?:[.,]\d+)?$/.test(v) && Number.isFinite(Number(v.replace(',', '.')))
          ? v.replace(',', '.') : evaluate(n.error);
      }
      case 'numericBand': {
        const input = evaluate(n.input);
        if (input === '') return '';
        const number = Number(n.format === 'first-comma-number-v1' ? input.replace(',', '.') : input);
        if (!Number.isFinite(number)) {
          if (n.onInvalid === 'input') return input;
          fail('INPUT_INVALID', 'numericBand requires a finite number');
        }
        const band = n.bands.find((b) => (b.min === null || (b.minInclusive ? number >= b.min : number > b.min))
          && (b.max === null || (b.maxInclusive ? number <= b.max : number < b.max)));
        return band ? band.value : evaluate(n.outside);
      }
      case 'interpolate': {
        const slots = Object.fromEntries(Object.entries(n.slots).map(([k, v]) => [k, evaluate(v)]));
        let size = Buffer.byteLength(n.template);
        for (const match of n.template.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
          size += Buffer.byteLength(slots[match[1]]) - Buffer.byteLength(match[0]);
        }
        if (size > limits.cellBytes) fail('EVALUATION_LIMIT', 'Interpolation UTF-8 limit exceeded');
        return n.template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => slots[key]);
      }
      case 'join': {
        const values = n.items.map(evaluate);
        const selected = n.omitEmpty ? values.filter((v) => v !== '') : values;
        const size = selected.reduce((sum, v) => sum + Buffer.byteLength(v), 0)
          + Math.max(0, selected.length - 1) * Buffer.byteLength(n.delimiter);
        if (size > limits.cellBytes) fail('EVALUATION_LIMIT', 'Join UTF-8 limit exceeded');
        return selected.join(n.delimiter);
      }
      case 'require':
        if (!evaluate(n.if)) evaluate(n.error);
        return evaluate(n.value);
      case 'error': {
        const diagnostic = { field: n.field, message: evaluate(n.message) };
        if (Object.hasOwn(n, 'code')) diagnostic.code = n.code;
        errors.push(diagnostic);
        if (observation) observation.issues.push({ ...diagnostic, ...(observation.target ? { target: { ...observation.target } } : {}) });
        return '';
      }
      default: fail('TEMPLATE_INVALID', 'Unknown compiled operation');
    }
  }
  profile.evaluate.forEach(evaluate);
  (profile.outputChecks || []).forEach((entry) => {
    if (observation) observation.target = { kind: 'columns', columns: entry.columns };
    evaluate(entry.rule);
  });
  if (observation) observation.target = null;
  const rows = profile.rows.map((r, index) => Object.fromEntries(Object.entries(r.cells).map(([k, v]) => {
    if (observation) observation.target = { kind: 'cell', column: k, language: index ? 'en' : 'main' };
    const value = evaluate(v);
    if (observation) observation.rows[index ? 'english' : 'base'][k] = value;
    return [k, value];
  })));
  if (observation) observation.target = null;
  if (d.outputContract === 'magento-products-columns-v2') {
    if (rows[0].sku !== identityText(own(product, 'full_sku'), 'full_sku') || rows[1].sku !== rows[0].sku
      || rows[0].store_view_code !== '' || rows[1].store_view_code !== 'en'
      || rows.some((row) => row.product_type !== 'simple' || !present(row.name) || !present(row.attribute_set_code))
      || !Number.isFinite(Number(rows[0].price)) || Number(rows[0].price) <= 0) {
      errors.push({ field: 'sku', message: 'Порушено захищений full-product контракт: SKU, base/EN, назва, набір атрибутів, simple або додатна ціна.' });
      if (observation) observation.issues.push({ ...errors[errors.length - 1], target: { kind: 'row' } });
    }
  }
  return { mapped: { group, sku: rows[0].sku, errors, base: rows[0], english: rows[1] }, work };
}

function evaluateProduct(compiled, product, options) {
  assertCompiled(compiled);
  return runProduct(compiled, product, budgets(options)).mapped;
}

function evaluateBatch(compiled, products, options, { review = false } = {}) {
  assertCompiled(compiled);
  if (!Array.isArray(products)) fail('INPUT_INVALID', 'Products must be an array');
  const limits = budgets(options);
  const collector = review ? require('../../presenters/export-review').reviewCollector(compiled.definition.outputContract, limits.outputBytes) : null;
  const byGroup = new Map();
  const errors = [];
  const represented = [];
  let bytes = 0;
  let diagnosticBytes = 0;
  let maxProductWork = 0;
  function account(row, separator) {
    let rowBytes = separator ? 1 : 0;
    for (let i = 0; i < row.length; i++) {
      rowBytes += (i ? 1 : 0) + Buffer.byteLength(escapeCsvValue(row[i]), 'utf8');
      if (bytes + rowBytes > limits.outputBytes) fail('EVALUATION_LIMIT', 'Escaped CSV UTF-8 limit exceeded');
    }
    bytes += rowBytes;
  }
  for (const product of products) {
    const observation = review ? { rows: { base: {}, english: {} }, issues: [] } : null;
    const { mapped, work } = runProduct(compiled, product, limits, observation);
    const reviewProfile = compiled.definition.groups.find((g) => g.route === mapped.group);
    // Sparse EN intentionally omits cells; after a completed evaluation those are valid blanks.
    if (observation && mapped.base) {
      for (const side of ['base', 'english']) for (const column of reviewProfile.columns) {
        if (!Object.hasOwn(observation.rows[side], column)) observation.rows[side][column] = '';
      }
    }
    if (observation && !observation.issues.length && mapped.errors.length) observation.issues = mapped.errors;
    collector?.add(product, represented.length + 1, mapped, reviewProfile?.columns || [], reviewProfile?.name, observation);
    const productId = Number(scalar(own(product, 'id'), 'id'));
    represented.push({ productId, group: mapped.group, sku: mapped.sku,
      status: mapped.errors.length ? 'failed' : 'ready', artifactRows: mapped.errors.length ? 0 : 2 });
    maxProductWork = Math.max(maxProductWork, work);
    if (mapped.errors.length) {
      diagnosticBytes += Buffer.byteLength(JSON.stringify(mapped.errors));
      if (diagnosticBytes > limits.outputBytes) fail('EVALUATION_LIMIT', 'Diagnostic UTF-8 limit exceeded');
      errors.push({ productId, sku: mapped.sku, group: mapped.group, fields: mapped.errors });
      // Bound failing ranges too: no unbounded diagnostic/result allocation.
      if (errors.length > 20000) fail('EVALUATION_LIMIT', 'Failed product count exceeded');
      continue;
    }
    const profile = compiled.definition.groups.find((g) => g.route === mapped.group);
    if (!byGroup.has(mapped.group)) {
      account(profile.columns, false);
      byGroup.set(mapped.group, { profile, rows: [profile.columns], count: 0 });
    }
    const entry = byGroup.get(mapped.group);
    for (const side of ['base', 'english']) {
      const row = profile.columns.map((column) => mapped[side][column] ?? '');
      account(row, true);
      entry.rows.push(row);
    }
    entry.count++;
  }
  const artifacts = [...byGroup].map(([group, entry]) => ({ groupCode: group,
    groupName: entry.profile.name, profileVersion: compiled.definition.outputContract,
    productCount: entry.count, rowCount: entry.count * 2,
    fileName: `amber-magento-${group}-${compiled.definition.outputContract}.csv`, csvContent: buildCsv(entry.rows) }));
  return { status: errors.length ? 'not-ready' : 'ready', representedCount: products.length,
    readyCount: products.length - errors.length, failedCount: errors.length, represented, errors,
    // Failed products never make this a complete export; these are explicitly previews.
    provisionalArtifacts: artifacts, artifacts: errors.length ? [] : artifacts,
    ...(collector ? { review: collector.result() } : {}),
    metrics: { outputBytes: bytes, maxProductWork } };
}

// Pure legacy preview shape; never use this projection as a snapshot success signal.
function legacyPreview(result) {
  return { representedCount: result.representedCount, readyCount: result.readyCount,
    errors: result.errors, artifacts: result.provisionalArtifacts };
}

module.exports = { evaluateProduct, evaluateBatch, legacyPreview };
