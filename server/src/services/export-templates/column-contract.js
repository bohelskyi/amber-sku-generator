const CONTRACT = 'magento-products-columns-v2';
const REQUIRED = Object.freeze(['sku', 'store_view_code', 'name', 'attribute_set_code', 'product_type', 'price']);
const validCode = (code) => typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code)
  && !['__proto__', 'constructor', 'prototype'].includes(code);

// Explicit lossless conversion: only eager-check ownership and contract identity
// change. Unknown checks remain global. No sources, bindings or tables are pruned.
function upgradeColumns(definition) {
  const { compileDefinition } = require('./definition');
  compileDefinition(definition);
  if (definition.outputContract === CONTRACT) return structuredClone(definition);
  const next = structuredClone(definition);
  const bindings = new Map(next.bindings.map((b) => [b.id, b.value]));
  function fields(node, seen = new Set()) {
    if (!node || typeof node !== 'object') return [];
    if (node.op === 'ref') return seen.has(node.id) ? [] : fields(bindings.get(node.id), new Set([...seen, node.id]));
    return [...(node.op === 'error' ? [node.field] : []), ...Object.values(node).flatMap((v) => fields(v, seen))];
  }
  next.outputContract = CONTRACT;
  for (const group of next.groups) {
    group.columnLabels = {};
    group.outputChecks = [];
    group.evaluate = group.evaluate.filter((rule) => {
      const owners = [...new Set(fields(rule))];
      if (!owners.length || owners.some((c) => !group.columns.includes(c))) return true;
      group.outputChecks.push({ columns: owners, rule });
      return false;
    });
  }
  compileDefinition(next);
  return next;
}
module.exports = { CONTRACT, REQUIRED, validCode, upgradeColumns };
