import { at, resolveNode, sourceOf } from './export-template-presentation.js';
import { questionField } from './export-template-attributes.js';
import { computedPresence, conditionInput, exactExpression } from './export-template-conditions.js';

export const intentNames = {
  literal: 'Постійне значення', characteristic: 'Значення характеристики',
  text: 'Текст із характеристиками', condition: 'Значення залежить від умов',
  fallback: 'Перше доступне значення', complex: 'Складне правило',
};
const scalar = (value) => value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value);
const shape = (node, required, optional = []) => required.every((key) => Object.hasOwn(node, key)) && Object.keys(node).every((key) => [...required, ...optional].includes(key));

// Read-only presentation lens. No normalisation, compilation or evaluation.
export function expressionIntent(definition, expression, depth = 0) {
  if (depth > 30) return 'complex';
  if (expression?.op === 'ref') {
    if (!exactExpression(expression, ['op', 'id']) || expression.id === 'sku') return 'complex';
    return expressionIntent(definition, definition.bindings.find((binding) => binding.id === expression.id)?.value, depth + 1);
  }
  const { node, problem, trail } = resolveNode(definition, expression);
  if (problem || !node || trail.some((step) => step.ref === 'sku')) return 'complex';
  if (node.op === 'literal' && exactExpression(node, ['op', 'value']) && scalar(node.value)) return 'literal';
  if (node.op === 'require' && exactExpression(node, ['op', 'if', 'value', 'error'])) return expressionIntent(definition, node.value, depth + 1);
  if (node.op === 'when' && exactExpression(node, ['op', 'if', 'then', 'else'])) {
    return computedPresence(definition, node.if) ? expressionIntent(definition, node.then, depth + 1) : 'condition';
  }
  if (node.op === 'interpolate' && exactExpression(node, ['op', 'template', 'slots']) && typeof node.template === 'string'
    && node.slots && typeof node.slots === 'object' && !Array.isArray(node.slots)
    && Object.values(node.slots).every((slot) => slot?.op === 'ref' && slot.id === 'sku' && exactExpression(slot, ['op', 'id'])
      || ['literal', 'characteristic', 'fallback'].includes(expressionIntent(definition, slot, depth + 1)))) return 'text';
  if (node.op === 'firstPresent' && exactExpression(node, ['op', 'items', 'policy']) && node.policy === 'answer-v1' && Array.isArray(node.items)) return 'fallback';
  if (node.op === 'lookup' && exactExpression(node, ['op', 'input', 'table', 'otherwise']) && conditionInput(definition, node.input) && definition.tables[node.table]) return 'characteristic';
  if (node.op === 'source' && exactExpression(node, ['op', 'id']) && definition.sources[node.id]) return 'characteristic';
  if (['text', 'numberText', 'decimalText'].includes(node.op)
    && shape(node, ['op', 'input', 'format'], ['trim', 'onAbsent', 'error'])) {
    const formats = { text: ['scalar-v1', 'string-only-v1'], numberText: ['js-number-positive-v1'], decimalText: ['unsigned-comma-dot-v1'] };
    if (!formats[node.op].includes(node.format)) return 'complex';
    const input = expressionIntent(definition, node.input, depth + 1);
    return input === 'fallback' ? 'fallback' : input === 'characteristic' ? 'characteristic' : 'complex';
  }
  if (node.op === 'numericBand' && shape(node, ['op', 'input', 'bands', 'outside', 'format', 'onInvalid'])
    && ['first-comma-number-v1', 'number-v1'].includes(node.format) && ['input', 'error'].includes(node.onInvalid)
    && Array.isArray(node.bands) && node.bands.every((band) => band && shape(band, ['min', 'max', 'minInclusive', 'maxInclusive', 'value']))) return 'characteristic';
  return 'complex';
}

export function columnIntent(definition, path) {
  if (at(definition, path)?.op === 'ref' && !exactExpression(at(definition, path), ['op', 'id'])) return 'complex';
  return questionField(definition, path) ? 'characteristic' : at(definition, path) === undefined ? 'literal' : expressionIntent(definition, at(definition, path));
}

export function ruleSources(definition, expression) {
  const result = new Set(); const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    const source = sourceOf(definition, node);
    if (source && definition.sources[source]) result.add(source);
    if (node.op === 'questionValue') { const id = definition.questionContracts?.[node.question]?.source; if (id) result.add(id); }
    if (node.op === 'ref' && !seen.has(node.id)) { seen.add(node.id); visit(definition.bindings.find((binding) => binding.id === node.id)?.value); }
    Object.values(node).forEach(visit);
  };
  visit(expression); return [...result];
}
