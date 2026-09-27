import { resolveNode } from './export-template-presentation.js';

export const exactExpression = (node, keys) => node && typeof node === 'object' && !Array.isArray(node)
  && keys.every((key) => Object.hasOwn(node, key)) && Object.keys(node).every((key) => keys.includes(key));
const scalar = (value) => value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value);

// Lenses only: no product evaluation, coercion, or mutation on inspection.
function resolved(definition, node, trail = []) {
  const seen = new Set();
  while (node?.op === 'ref') {
    if (!exactExpression(node, ['op', 'id']) || seen.has(node.id)) return null;
    seen.add(node.id); trail = [...trail, { ref: node.id }];
    node = definition.bindings.find((binding) => binding.id === node.id)?.value;
  }
  return node ? { node, trail } : null;
}

export function conditionInput(definition, expression) {
  let input = resolved(definition, expression)?.node;
  const semantic = input?.op === 'semanticKey' && exactExpression(input, ['op', 'input']);
  if (semantic) input = resolved(definition, input.input)?.node;
  if (!exactExpression(input, ['op', 'id']) || input.op !== 'source' || !definition.sources[input.id]) return null;
  return { source: input.id, semantic: Boolean(semantic), input: expression };
}

export function conditionPredicate(definition, expression) {
  const node = resolved(definition, expression)?.node;
  if (!node) return null;
  let input, operator, value, values;
  if (node.op === 'eq' && exactExpression(node, ['op', 'left', 'right']) && node.right?.op === 'literal' && exactExpression(node.right, ['op', 'value'])) {
    input = node.left; operator = 'eq'; value = node.right.value;
  } else if (node.op === 'in' && exactExpression(node, ['op', 'input', 'values']) && Array.isArray(node.values)) {
    input = node.input; operator = 'in'; values = node.values;
  } else {
    const presence = node.op === 'not' && exactExpression(node, ['op', 'input']) ? resolved(definition, node.input)?.node : node;
    if (presence?.op !== 'present' || !exactExpression(presence, ['op', 'input', 'policy']) || presence.policy !== 'answer-v1') return null;
    input = presence.input; operator = node.op === 'not' ? 'absent' : 'present';
  }
  const source = conditionInput(definition, input);
  if (operator === 'eq' && !scalar(value) || operator === 'in' && !values.every(scalar)) return null;
  if (!source || (source.semantic && (operator === 'eq' ? typeof value !== 'string' : operator === 'in' && values.some((v) => typeof v !== 'string')))) return null;
  // Raw semantic comparisons retain their number/string distinctions in Advanced.
  if (definition.sources[source.source].kind === 'semantic' && !source.semantic && ['eq', 'in'].includes(operator)) return null;
  return { ...source, operator, value, values };
}

export function buildConditionPredicate(form) {
  if (!['eq', 'in', 'present', 'absent'].includes(form.operator)) throw new Error('Цю перевірку можна змінити в розширених правилах.');
  const input = structuredClone(form.input);
  if (form.operator === 'eq') return { op: 'eq', left: input, right: { op: 'literal', value: form.value } };
  if (form.operator === 'in') return { op: 'in', input, values: [...form.values] };
  const presence = { op: 'present', input, policy: 'answer-v1' };
  return form.operator === 'absent' ? { op: 'not', input: presence } : presence;
}

export function conditionChain(definition, expression, trail = []) {
  const rows = []; let current = expression; let path = trail;
  const visited = new Set();
  while (true) {
    const value = resolved(definition, current, path);
    if (!value || visited.has(value.node)) return null;
    if (value.node.op !== 'when' || !exactExpression(value.node, ['op', 'if', 'then', 'else'])) break;
    visited.add(value.node);
    rows.push({ node: value.node, trail: value.trail });
    current = value.node.else; path = [...value.trail, 'else'];
  }
  return rows.length ? { rows, fallback: current, fallbackTrail: path } : null;
}

// Called only by explicit add/remove/move. Preserve each predicate/result node,
// including references and opaque custom children, and the final lazy fallback.
export function assembleConditions(rows, fallback) {
  return rows.reduceRight((otherwise, row) => ({ ...row.node, else: otherwise }), fallback);
}

export function computedPresence(definition, expression) {
  const node = resolveNode(definition, expression).node;
  if (node?.op !== 'present' || !exactExpression(node, ['op', 'input', 'policy']) || node.policy !== 'answer-v1') return null;
  const input = resolved(definition, node.input)?.node;
  if (input?.op !== 'lookup' || !exactExpression(input, ['op', 'input', 'table', 'otherwise'])) return null;
  const source = conditionInput(definition, input.input);
  return source ? { source: source.source } : null;
}
