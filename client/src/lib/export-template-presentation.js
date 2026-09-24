// Lenses into the original definition, never a second evaluator/schema.
import { consumers, copyDefinition, fieldLabels, protectedCells, replaceAt } from './export-template-editor.js';

export const at = (value, path) => path.reduce((node, key) => node?.[key], value);
export const fieldSection = (column) => column.startsWith('meta_') ? 'SEO' : column === 'categories' ? 'Категорії'
  : ['name', 'sku', 'price', 'description', 'short_description', 'attribute_set_code', 'store_view_code', 'product_type'].includes(column) ? 'Основне' : 'Характеристики';
export function resolveNode(definition, node, trail = []) {
  const seen = new Set(trail.filter((step) => typeof step === 'object').map((step) => step.ref));
  while (node?.op === 'ref') {
    if (seen.has(node.id)) return { node, trail, problem: 'Циклічне посилання. Відкрийте розширені правила.' };
    seen.add(node.id);
    const binding = definition.bindings.find((b) => b.id === node.id);
    if (!binding) return { node, trail, problem: 'Правило не знайдено. Відкрийте розширені правила.' };
    trail = [...trail, { ref: node.id }]; node = binding.value;
  }
  return { node, trail };
}
export function outputNode(definition, node, trail = []) {
  const resolved = resolveNode(definition, node, trail);
  if (!resolved.problem && ['when', 'require', 'questionValue'].includes(resolved.node?.op)) {
    const key = resolved.node.op === 'when' ? 'then' : 'value';
    const child = outputNode(definition, resolved.node[key], [...resolved.trail, key]);
    return { ...child, guarded: true };
  }
  return resolved;
}
export function sourceOf(definition, node, seen = new Set()) {
  if (!node || typeof node !== 'object') return null;
  if (node.op === 'source') return node.id;
  if (node.op === 'ref') {
    if (seen.has(node.id)) return null;
    return sourceOf(definition, definition.bindings.find((b) => b.id === node.id)?.value, new Set([...seen, node.id]));
  }
  return sourceOf(definition, node.input, seen);
}
export function sourceLabel(definition, id, registry) {
  const source = definition.sources[id];
  if (!source) return id || 'Власне правило';
  const matches = registry?.references?.questions?.filter((q) => q.category_code === source.category && q.key === source.key) || [];
  return (matches.length === 1 && matches[0].label) || fieldLabels[source.field || source.key] || source.key || source.field;
}
export function summary(definition, value) {
  const { node } = outputNode(definition, value);
  if (!node) return 'Порожньо';
  if (node.op === 'literal') return node.value === '' ? 'Порожній текст' : node.value === null ? 'Відсутнє значення' : String(node.value);
  return ({ interpolate: 'Текст із характеристиками', lookup: 'Відповідності значень', firstPresent: 'Перше заповнене значення', numericBand: 'Числові діапазони', join: 'Складений текст', source: 'Характеристика товару', text: 'Характеристика товару' })[node.op] || 'Власне правило';
}
export function affectedFields(definition, cellPath, trail, table) {
  if (table) return consumers(definition, 'table', table);
  const reference = [...trail].reverse().find((step) => typeof step === 'object');
  if (reference) return consumers(definition, 'ref', reference.ref);
  const group = definition.groups[cellPath[1]];
  return [`${group.route} / ${group.rows[cellPath[3]].id === 'english' ? 'EN' : 'база'} / ${cellPath[5]}`];
}
// Walk/copy only the selected dependency path. Conditions, siblings, metadata and
// unrelated references remain byte-for-byte JSON-equivalent. Nothing runs on open.
export function editField(definition, cellPath, trail, scope, transform) {
  if (protectedCells.has(cellPath[5])) throw new Error('Ідентифікаційне поле захищено.');
  if (scope === 'shared' && affectedFields(definition, cellPath, trail).some((field) => protectedCells.has(field.split(' / ').at(-1)))) throw new Error('Спільне правило використовується в захищеному ідентифікаційному полі. Оберіть локальну зміну.');
  let next = definition;
  function visit(node, steps, seen = new Set()) {
    if (!steps.length) return transform(node);
    const [step, ...rest] = steps;
    if (typeof step === 'object') {
      if (node?.op !== 'ref' || node.id !== step.ref || seen.has(node.id) || node.id === 'sku') throw new Error('Це посилання захищене або не може бути безпечно відокремлене. Використайте розширені правила.');
      const index = next.bindings.findIndex((b) => b.id === node.id);
      if (index < 0) throw new Error('Правило не знайдено.');
      if (scope === 'local' && Object.keys(node).some((key) => !['op', 'id'].includes(key))) throw new Error('Посилання має додаткові властивості. Локальне копіювання недоступне; властивості збережено.');
      const edited = visit(next.bindings[index].value, rest, new Set([...seen, node.id]));
      if (scope === 'shared') { next = replaceAt(next, ['bindings', index, 'value'], edited); return node; }
      return copyDefinition(edited);
    }
    return replaceAt(node, [step], visit(node[step], rest, seen));
  }
  const cell = visit(at(definition, cellPath), trail);
  return replaceAt(next, cellPath, cell);
}
export function editMapping(definition, cellPath, trail, scope, transform) {
  let tables = definition.tables;
  const next = editField(definition, cellPath, trail, scope, (node) => {
    if (node.op !== 'lookup' || !tables[node.table]) throw new Error('Таблицю не знайдено.');
    if (scope === 'shared' && consumers(definition, 'table', node.table).some((field) => protectedCells.has(field.split(' / ').at(-1)))) throw new Error('Таблиця використовується в захищеному ідентифікаційному полі.');
    let id = node.table;
    if (scope === 'local') {
      // Count literal references too: unused shared bindings must stay unchanged.
      let count = 0;
      const countUses = (value) => { if (!value || typeof value !== 'object') return; if (value.op === 'lookup' && value.table === id) count++; Object.values(value).forEach(countUses); };
      countUses(definition);
      const refs = trail.some((step) => typeof step === 'object');
      if (count > 1 || refs) {
        let index = 1; while (Object.hasOwn(tables, `${id}.copy${index}`)) index++;
        id = `${id}.copy${index}`;
      }
    }
    tables = { ...tables, [id]: transform(copyDefinition(tables[node.table])) };
    return { ...node, table: id };
  });
  return { ...next, tables };
}
export function mappingsForSource(definition, sourceId) {
  const found = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.op === 'lookup' && sourceOf(definition, node.input) === sourceId && Object.hasOwn(definition.tables, node.table)
      && Object.values(definition.tables[node.table]).every((value) => typeof value === 'string')) found.add(node.table);
    Object.values(node).forEach(visit);
  };
  visit(definition.bindings); visit(definition.groups);
  return [...found];
}
export function insertCharacteristic(node, sourceId, table, selection) {
  const slots = node.slots;
  if (Object.keys(slots).length >= 16) throw new Error('Можна додати щонайбільше 16 характеристик.');
  const base = sourceId.split('.').at(-1).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 50) || 'value';
  let name = base; let index = 1;
  while (Object.hasOwn(slots, name) || ['constructor', 'prototype', '__proto__'].includes(name)) name = `${base}_${index++}`;
  const input = { op: 'source', id: sourceId };
  const expression = table ? { op: 'lookup', input: { op: 'semanticKey', input }, table, otherwise: { op: 'literal', value: '' } }
    : { op: 'text', input, trim: false, format: 'scalar-v1', onAbsent: 'empty' };
  const [start, end] = selection || [node.template.length, node.template.length];
  return { ...node, template: node.template.slice(0, start) + `{${name}}` + node.template.slice(end), slots: { ...slots, [name]: expression } };
}
