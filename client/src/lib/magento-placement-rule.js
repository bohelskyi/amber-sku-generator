import { at } from './export-template-presentation.js';
import { replaceAt } from './export-template-editor.js';

export const hasControlCharacter = (value) => [...value].some((character) => character.charCodeAt(0) < 32);

const exact = (node, keys) => node && typeof node === 'object' && !Array.isArray(node)
  && Object.keys(node).length === keys.length && keys.every((key) => Object.hasOwn(node, key));
const categoryPath = (path) => typeof path === 'string' && path.includes('/')
  && path.split('/').every((part) => part.trim() && part === part.trim()) && !path.includes(',') && !hasControlCharacter(path);
const literal = (node) => exact(node, ['op', 'value']) && node.op === 'literal';
const placementJoin = (node) => exact(node, ['op', 'items', 'delimiter', 'omitEmpty']) && node.op === 'join'
  && Array.isArray(node.items) && node.delimiter === ',' && node.omitEmpty === true;

// Only exact local branches can be changed here. Never dereference shared rules
// or descend through conditions/guards whose meaning the simple editor cannot keep.
export function placementRules(definition, cellPath) {
  const expression = at(definition, cellPath);
  const snapshot = JSON.stringify(expression);
  const group = definition.groups[cellPath[1]];
  const rows = [];
  function visit(node, trail) {
    if (placementJoin(node)) { node.items.forEach((item, index) => visit(item, [...trail, 'items', index])); return; }
    if (literal(node) && node.value === '') return;
    const row = { key: JSON.stringify(trail), trail, snapshot, expression: node, supported: false };
    if (literal(node) && categoryPath(node.value)) Object.assign(row, { supported: true, path: node.value, scope: 'all' });
    if (exact(node, ['op', 'if', 'then', 'else']) && node.op === 'when'
      && literal(node.then) && categoryPath(node.then.value) && literal(node.else) && node.else.value === ''
      && exact(node.if, ['op', 'left', 'right']) && node.if.op === 'eq'
      && exact(node.if.left, ['op', 'input']) && node.if.left.op === 'semanticKey'
      && exact(node.if.left.input, ['op', 'id']) && node.if.left.input.op === 'source'
      && literal(node.if.right) && typeof node.if.right.value === 'string' && node.if.right.value !== '') {
      const sourceId = node.if.left.input.id;
      const source = definition.sources?.[sourceId];
      if (source?.kind === 'semantic' && source.category === group.route) Object.assign(row,
        { supported: true, path: node.then.value, scope: 'condition', sourceId, valueId: node.if.right.value });
    }
    rows.push(row);
  }
  if (expression) visit(expression, []);
  return rows;
}

function placement(definition, cellPath, path, sourceId, valueId) {
  if (!categoryPath(path)) throw new Error('Оберіть однозначний розділ магазину.');
  let addition = { op: 'literal', value: path };
  if (sourceId) {
    const source = definition.sources[sourceId];
    const group = definition.groups[cellPath[1]];
    if (source?.kind !== 'semantic' || source.category !== group.route || typeof valueId !== 'string' || !valueId) throw new Error('Оберіть характеристику та її значення.');
    addition = { op: 'when', if: { op: 'eq', left: { op: 'semanticKey', input: { op: 'source', id: sourceId } }, right: { op: 'literal', value: valueId } }, then: addition, else: { op: 'literal', value: '' } };
  }
  return addition;
}

export function appendPlacement(definition, cellPath, path, sourceId, valueId) {
  const existing = at(definition, cellPath);
  if (!existing) throw new Error('Правило розміщення недоступне. Відкрийте поле повторно.');
  return replaceAt(definition, cellPath, { op: 'join', items: [structuredClone(existing), placement(definition, cellPath, path, sourceId, valueId)], delimiter: ',', omitEmpty: true });
}

function currentRule(definition, cellPath, selected) {
  const current = placementRules(definition, cellPath).find((row) => row.key === selected?.key);
  if (!current?.supported || current.snapshot !== selected.snapshot) throw new Error('Правило змінилося. Виберіть розміщення повторно.');
  return current;
}

export function updatePlacement(definition, cellPath, selected, path, sourceId, valueId) {
  const current = currentRule(definition, cellPath, selected);
  return replaceAt(definition, [...cellPath, ...current.trail], placement(definition, cellPath, path, sourceId, valueId));
}

export function removePlacement(definition, cellPath, selected) {
  const current = currentRule(definition, cellPath, selected);
  if (!current.trail.length) return replaceAt(definition, cellPath, { op: 'literal', value: '' });
  const itemsPath = [...cellPath, ...current.trail.slice(0, -1)];
  const items = at(definition, itemsPath);
  return replaceAt(definition, itemsPath, items.filter((_, index) => index !== current.trail.at(-1)));
}
