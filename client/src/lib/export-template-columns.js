import { at, editField, editMapping, mappingsForSource, resolveNode, sourceOf } from './export-template-presentation.js';

export const COLUMN_CONTRACT = 'magento-products-columns-v2';
export const requiredColumns = new Set(['sku', 'store_view_code', 'name', 'attribute_set_code', 'product_type', 'price']);
export function codeError(code, columns, previous) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code) || ['constructor', 'prototype', '__proto__'].includes(code)) return 'Код: мала латинська літера, далі латиниця, цифри або _, до 64 символів.';
  if (code !== previous && columns.includes(code)) return 'Колонка з таким кодом уже існує.';
  return '';
}
export function columnChange(definition, groupIndex, action, code, value) {
  if (definition.outputContract !== COLUMN_CONTRACT && !(definition.outputContract === 'magento-products-v1' && action === 'move')) throw new Error('Спочатку явно оновіть контракт колонок.');
  const next = structuredClone(definition); const g = next.groups[groupIndex];
  if (!g || (action === 'add' ? code != null && !g.columns.includes(code) : !g.columns.includes(code))) throw new Error('Колонку або позицію вже змінено. Відкрийте налаштування знову.');
  if (['remove', 'rename'].includes(action) && requiredColumns.has(code)) throw new Error('Захищена колонка full-product імпорту.');
  if (['add', 'duplicate', 'rename'].includes(action)) {
    const problem = codeError(value, g.columns, action === 'rename' ? code : undefined);
    if (problem) throw new Error(problem);
    if (action !== 'rename' && g.columns.length >= 64) throw new Error('Максимум 64 колонки.');
  }
  if (action === 'move') {
    const from = g.columns.indexOf(code); const to = Number(value);
    if (!Number.isInteger(to) || to < 0 || to >= g.columns.length) return definition;
    if (from === to) return definition;
    g.columns.splice(from, 1); g.columns.splice(to, 0, code);
  } else if (action === 'label') {
    if ((g.columnLabels?.[code] || '') === value) return definition;
    g.columnLabels = { ...g.columnLabels, [code]: value };
  } else if (action === 'remove') {
    g.columns = g.columns.filter((c) => c !== code);
    g.rows.forEach((r) => { delete r.cells[code]; });
    delete g.columnLabels?.[code];
    g.outputChecks = (g.outputChecks || []).map((c) => ({ ...c, columns: c.columns.filter((k) => k !== code) })).filter((c) => c.columns.length);
  } else if (action === 'add') {
    g.columns.splice(code == null ? g.columns.length : g.columns.indexOf(code), 0, value);
    // Explicit blank rules for BOTH rows, no inheritance or source guessing.
    g.rows.forEach((r) => { r.cells[value] = { op: 'literal', value: '' }; });
  } else if (action === 'rename') {
    if (code === value) return definition;
    // Copy only diagnostic-bearing binding paths; shared consumers keep their identity.
    const renamedRefs = new Map();
    const renameDiagnostic = (node) => {
      if (!node || typeof node !== 'object') return node;
      if (node.op === 'ref') {
        if (!renamedRefs.has(node.id)) {
          const binding = next.bindings.find((b) => b.id === node.id);
          if (!binding) throw new Error('Невідоме посилання.');
          const updated = renameDiagnostic(binding.value);
          let id = node.id;
          if (JSON.stringify(updated) !== JSON.stringify(binding.value)) {
            let i = 1; while (next.bindings.some((b) => b.id === node.id + '.rename' + i)) i++;
            id = node.id + '.rename' + i;
            next.bindings.push({ ...binding, id, value: updated });
          }
          renamedRefs.set(node.id, id);
        }
        return { ...node, id: renamedRefs.get(node.id) };
      }
      const result = Array.isArray(node) ? node.map(renameDiagnostic) : Object.fromEntries(Object.entries(node).map(([k, v]) => [k, renameDiagnostic(v)]));
      if (node.op === 'error' && node.field === code) result.field = value;
      return result;
    };
    g.columns = g.columns.map((c) => c === code ? value : c);
    g.rows.forEach((r) => { if (Object.hasOwn(r.cells, code)) { r.cells[value] = renameDiagnostic(r.cells[code]); delete r.cells[code]; } });
    if (g.columnLabels && Object.hasOwn(g.columnLabels, code)) { g.columnLabels[value] = g.columnLabels[code]; delete g.columnLabels[code]; }
    g.outputChecks = (g.outputChecks || []).map((c) => ({ ...c, columns: c.columns.map((k) => k === code ? value : k), rule: c.columns.includes(code) ? renameDiagnostic(c.rule) : c.rule }));
  } else if (action === 'duplicate') {
    const refs = new Map(); const tables = new Map();
    const unique = (base, has) => { let i = 1; while (has(base + '.column' + i)) i++; return base + '.column' + i; };
    const clone = (node) => {
      if (!node || typeof node !== 'object') return node;
      if (node.op === 'ref') {
        if (!refs.has(node.id)) {
          const b = next.bindings.find((b) => b.id === node.id);
          if (!b) throw new Error('Невідоме посилання.');
          const copied = clone(b.value);
          const id = unique(b.id, (id) => next.bindings.some((b) => b.id === id));
          next.bindings.push({ ...b, id, value: copied }); refs.set(node.id, id);
        }
        return { ...node, id: refs.get(node.id) };
      }
      const result = Array.isArray(node) ? node.map(clone) : Object.fromEntries(Object.entries(node).map(([k, v]) => [k, clone(v)]));
      if (node.op === 'lookup') {
        if (!tables.has(node.table)) { const id = unique(node.table, (id) => Object.hasOwn(next.tables, id)); next.tables[id] = structuredClone(next.tables[node.table]); tables.set(node.table, id); }
        result.table = tables.get(node.table);
      }
      if (node.op === 'error' && node.field === code) result.field = value;
      return result;
    };
    g.columns.splice(g.columns.indexOf(code) + 1, 0, value);
    g.rows.forEach((r) => { if (Object.hasOwn(r.cells, code)) r.cells[value] = clone(r.cells[code]); });
    g.outputChecks = [...(g.outputChecks || []), ...(g.outputChecks || []).filter((c) => c.columns.includes(code)).map((c) => ({ columns: [value], rule: clone(c.rule) }))];
    if (g.columnLabels?.[code]) g.columnLabels[value] = g.columnLabels[code];
  }
  return next;
}

// Picker descriptors derive only from authorized registry metadata. Server source
// proof remains mandatory; current SKU-only draft questions are deliberately absent.
export function availableSources(registry, group) {
  const result = (registry?.productFields || []).map((field) => ({ id: field, label: field, descriptor: { kind: 'product', field, type: ['full_sku', 'category'].includes(field) ? 'text' : 'scalar' } }));
  const questions = registry?.references?.questions || [];
  const historical = (registry?.references?.schemas || []).filter((s) => s.category_code === group).flatMap((s) => s.questions);
  const keys = new Set([...historical.map((q) => q.key), ...questions.filter((q) => q.category_code === group && Number(q.include_in_sku) === 0).map((q) => q.key)]);
  for (const key of keys) {
    const current = questions.filter((q) => q.category_code === group && q.key === key);
    if (current.length > 1) continue;
    result.push({ id: group + '.' + key, label: group + ' · ' + (current[0]?.label || key) + ' · ' + key + ' · ' + (current[0]?.input_type || 'historical SKU'),
      descriptor: { kind: current[0] && Number(current[0].include_in_sku) === 0 ? 'information' : 'semantic', category: group, key, type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] } });
  }
  return result;
}
// Preserve a stored descriptor/identity when it represents an authorized source.
// Presentation must not require the operator to replace generated local IDs.
export function columnSourceChoices(definition, registry, group, selectedId) {
  const choices = availableSources(registry, group);
  if (choices.some((choice) => choice.id === selectedId)) return choices;
  const stored = definition.sources[selectedId];
  if (!stored) return choices;
  const authorized = choices.find((choice) => ['kind', 'category', 'key', 'field', 'type'].every((key) => choice.descriptor[key] === stored[key]));
  return authorized ? choices.map((choice) => choice === authorized ? { ...choice, id: selectedId, descriptor: stored } : choice) : choices;
}
export function bindColumnSource(definition, gi, ri, code, selected, mode = 'text', existingTable) {
  const next = structuredClone(definition);
  if (requiredColumns.has(code) && ['sku', 'store_view_code', 'product_type'].includes(code)) throw new Error('Захищене правило.');
  let id = selected.id; let n = 1;
  while (next.sources[id] && JSON.stringify(next.sources[id]) !== JSON.stringify(selected.descriptor)) id = selected.id + '.column' + n++;
  next.sources[id] = selected.descriptor;
  const input = { op: 'source', id };
  const text = { op: 'text', input, trim: false, format: 'scalar-v1', onAbsent: 'empty' };
  const blank = { op: 'literal', value: '' };
  let rule = text;
  if (mode === 'lookup') {
    let table = existingTable;
    if (table && !mappingsForSource(definition, selected.id).includes(table)) throw new Error('Оберіть сумісну таблицю відповідностей.');
    if (!table) {
      table = code + '.mapping'; let i = 1;
      while (Object.hasOwn(next.tables, table)) table = code + '.mapping' + i++;
      next.tables[table] = {};
    }
    rule = { op: 'lookup', input: { op: 'semanticKey', input }, table, otherwise: blank };
  } else if (mode === 'interpolate') rule = { op: 'interpolate', template: '{value}', slots: { value: text } };
  else if (mode === 'firstPresent') rule = { op: 'firstPresent', policy: 'answer-v1', items: [text, blank] };
  else if (mode === 'when') rule = { op: 'when', if: { op: 'present', input, policy: 'answer-v1' }, then: text, else: blank };
  next.groups[gi].rows[ri].cells[code] = rule;
  if (ri === 0) next.groups[gi].outputChecks = (next.groups[gi].outputChecks || []).filter((check) => check.columns.length !== 1 || check.columns[0] !== code);
  return next;
}

// Only whole, unguarded common expressions may be replaced by the simple form.
// Everything else stays with the lossless question/field adapters.
export function directColumn(definition, path) {
  const { node, trail, problem } = resolveNode(definition, at(definition, path));
  if (problem) return null;
  const exact = (value, keys) => value && Object.keys(value).every((key) => keys.includes(key));
  if (!node) return { mode: 'literal', text: '', trail };
  if (node.op === 'literal' && typeof node.value === 'string' && exact(node, ['op', 'value'])) return { mode: 'literal', text: node.value, trail };
  const source = sourceOf(definition, node);
  if (node.op === 'text' && node.trim === false && node.format === 'scalar-v1' && node.onAbsent === 'empty'
    && exact(node, ['op', 'input', 'trim', 'format', 'onAbsent']) && node.input?.op === 'source' && exact(node.input, ['op', 'id'])) return { mode: 'source', source, output: 'raw', trail };
  if (node.op === 'lookup' && exact(node, ['op', 'input', 'table', 'otherwise']) && node.input?.op === 'semanticKey'
    && exact(node.input, ['op', 'input']) && node.input.input?.op === 'source' && exact(node.input.input, ['op', 'id'])
    && node.otherwise?.op === 'literal' && node.otherwise.value === '' && exact(node.otherwise, ['op', 'value'])) return { mode: 'source', source, output: 'mapping', table: node.table, trail };
  return null;
}

export function applyDirectColumn(definition, gi, ri, code, form, registry) {
  const path = ['groups', gi, 'rows', ri, 'cells', code];
  if (!definition.groups[gi]?.columns.includes(code)) throw new Error('Колонку вже змінено.');
  const lens = directColumn(definition, path);
  if (!lens) throw new Error('Складне правило: скористайтеся наявним редактором правил.');
  if (form.mode === 'literal') return editField(definition, path, lens.trail, 'local', () => ({ op: 'literal', value: form.text }));
  if (form.output === 'mapping' && form.source === lens.source && form.table === lens.table && form.mappingEntries !== undefined) {
    return editMapping(definition, path, lens.trail, 'local', () => structuredClone(form.mappingEntries));
  }
  const selected = columnSourceChoices(definition, registry, definition.groups[gi].route, form.source).find((s) => s.id === form.source);
  if (!selected) throw new Error('Оберіть перевірену характеристику.');
  if (!['raw', 'mapping'].includes(form.output)) throw new Error('Оберіть, як записувати значення.');
  if (form.output === 'mapping' && form.mappingEntries === undefined && !mappingsForSource(definition, selected.id).includes(form.table)) throw new Error('Оберіть сумісну таблицю відповідностей.');
  // Reuse the expression builder, but keep checks and detach only the selected
  // dependency path via the existing adapter, rather than retiring output checks.
  const built = bindColumnSource(definition, gi, ri, code, selected, form.output === 'raw' ? 'text' : 'lookup', form.mappingEntries === undefined ? form.table : undefined);
  const rule = built.groups[gi].rows[ri].cells[code];
  if (form.output === 'mapping' && form.mappingEntries !== undefined) built.tables[rule.table] = structuredClone(form.mappingEntries);
  return editField({ ...definition, sources: built.sources, tables: built.tables }, path, lens.trail, 'local', () => rule);
}

export function createColumn(definition, gi, ri, before, form, registry) {
  let next = columnChange(definition, gi, 'add', before, form.code);
  next = columnChange(next, gi, 'label', form.code, form.name);
  return applyDirectColumn(next, gi, ri, form.code, form, registry);
}

export function literalColumn(definition, gi, ri, code) {
  if (['sku', 'store_view_code', 'product_type'].includes(code)) throw new Error('Захищене правило.');
  const next = structuredClone(definition);
  next.groups[gi].rows[ri].cells[code] = { op: 'literal', value: '' };
  if (ri === 0) next.groups[gi].outputChecks = (next.groups[gi].outputChecks || []).filter((check) => check.columns.length !== 1 || check.columns[0] !== code);
  return next;
}
