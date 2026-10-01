// Conservative syntax analysis only. Actual values always come from evaluateProduct.
// Unknown conditions stay possible; they are never asserted to be populated.
function routeTools(definition) {
  const bindings = new Map(definition.bindings.map((b) => [b.id, b.value]));
  function dereference(node) {
    while (node?.op === 'ref') node = bindings.get(node.id);
    return node;
  }
  function comparison(node) {
    node = dereference(node);
    if (node?.op !== 'eq') return null;
    const left = dereference(node.left);
    const right = dereference(node.right);
    const input = left?.op === 'semanticKey' ? dereference(left.input) : null;
    if (input?.op !== 'source' || right?.op !== 'literal' || typeof right.value !== 'string') return null;
    const source = definition.sources[input.id];
    return source?.category ? { sourceId: input.id, key: source.key, value: right.value } : null;
  }
  const plans = [];
  for (const group of definition.groups) {
    function visit(node, predicates = []) {
      node = dereference(node);
      if (node?.op === 'literal' && typeof node.value === 'string' && node.value) {
        plans.push({ id: `${group.route}:${plans.length}`, amberGroup: group.route,
          attributeSetName: node.value, predicates });
      } else if (node?.op === 'when' && comparison(node.if)) {
        const condition = comparison(node.if);
        visit(node.then, [...predicates, { ...condition, equal: true }]);
        visit(node.else, [...predicates, { ...condition, equal: false }]);
      } else {
        plans.push({ id: `${group.route}:${plans.length}`, amberGroup: group.route,
          attributeSetName: null, predicates, analysis: 'runtime_evaluation_required' });
      }
    }
    visit(group.rows[0].cells.attribute_set_code);
  }
  const normalize = (v) => v == null ? v : Number.isNaN(Number(v)) ? String(v) : Number(v);
  const all = (values) => values.includes(false) ? false : values.includes(null) ? null : true;
  const any = (values) => values.includes(true) ? true : values.includes(null) ? null : false;
  function rule(raw, predicates) {
    return all(Object.entries(raw).map(([key, value]) => {
      if (key === '$and') return all(value.map((r) => rule(r, predicates)));
      if (key === '$or') return any(value.map((r) => rule(r, predicates)));
      const expected = (Array.isArray(value) ? value : [value]).map(normalize);
      const known = predicates.find((p) => p.sourceId === key && p.equal);
      if (known) return expected.includes(normalize(known.value));
      const excluded = predicates.filter((p) => p.sourceId === key && !p.equal).map((p) => normalize(p.value));
      return expected.every((v) => excluded.includes(v)) ? false : null;
    }));
  }
  function condition(node, predicates) {
    node = dereference(node);
    if (node?.op === 'literal' && typeof node.value === 'boolean') return node.value;
    if (node?.op === 'catalogRule') return rule(definition.questionContracts[node.question].rule, predicates);
    if (node?.op === 'all') return all(node.items.map((n) => condition(n, predicates)));
    if (node?.op === 'any') return any(node.items.map((n) => condition(n, predicates)));
    if (node?.op === 'not') { const v = condition(node.input, predicates); return v === null ? null : !v; }
    if (node?.op === 'in') {
      const input = dereference(node.input);
      const source = input?.op === 'semanticKey' ? dereference(input.input) : null;
      const known = predicates.find((p) => p.sourceId === source?.id && p.equal);
      if (known) return node.values.includes(known.value);
    }
    const c = comparison(node);
    if (c) {
      const known = predicates.find((p) => p.sourceId === c.sourceId && p.equal);
      if (known) return known.value === c.value;
      if (predicates.some((p) => p.sourceId === c.sourceId && !p.equal && p.value === c.value)) return false;
    }
    return null;
  }
  function possible(node, predicates) {
    node = dereference(node);
    if (!node || node.op === 'error') return false;
    if (node.op === 'literal') return node.value !== '' && node.value !== null;
    if (node.op === 'questionValue') {
      const q = definition.questionContracts[node.question];
      return q.exists && rule(q.rule, predicates) !== false && possible(node.value, predicates);
    }
    if (node.op === 'when') {
      const c = condition(node.if, predicates);
      return (c !== false && possible(node.then, predicates)) || (c !== true && possible(node.else, predicates));
    }
    if (node.op === 'require') return possible(node.value, predicates);
    if (node.op === 'lookup') {
      const input = dereference(node.input);
      const source = input?.op === 'semanticKey' ? dereference(input.input) : null;
      const known = predicates.find((p) => p.sourceId === source?.id && p.equal);
      if (known) return Object.hasOwn(definition.tables[node.table], known.value)
        ? definition.tables[node.table][known.value] !== '' : possible(node.otherwise, predicates);
    }
    return true;
  }
  return { plans, possible };
}

module.exports = { routeTools };
