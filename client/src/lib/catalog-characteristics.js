export const catalogTextFields = new Set(['name', 'description', 'short_description', 'meta_title', 'meta_description', 'meta_keyword']);

// Presentation only. Resolve references without changing the saved expression,
// and distinguish a value sent to an attribute from a condition that uses it.
export function characteristicUses(definition, categoryCode, questions) {
  const result = new Map(questions.map((question) => [question.id, []]));
  const group = definition?.groups?.find((item) => item.route === categoryCode);
  for (const row of group?.rows || []) for (const [target, expression] of Object.entries(row.cells || {})) {
    const add = (id, condition) => {
      const source = definition.sources?.[id];
      if (source?.category !== categoryCode || !['semantic', 'information'].includes(source.kind) || !result.has(source.key)) return;
      const kind = condition ? 'condition' : target === 'categories' ? 'placement' : catalogTextFields.has(target) ? 'text' : 'attribute';
      const uses = result.get(source.key);
      if (!uses.some((use) => use.target === target && use.rowId === row.id && use.kind === kind)) uses.push({ target, rowId: row.id, kind });
    };
    const visit = (node, condition = false, seen = new Set()) => {
      if (!node || typeof node !== 'object') return;
      if (node.op === 'source') add(node.id, condition);
      if (node.op === 'questionValue') add(definition.questionContracts?.[node.question]?.source, true);
      if (node.op === 'ref') {
        if (!seen.has(node.id)) visit(definition.bindings?.find((item) => item.id === node.id)?.value, condition, new Set([...seen, node.id]));
        return;
      }
      Object.entries(node).forEach(([key, value]) => visit(value, condition || ['if', 'condition', 'test'].includes(key) || ['require', 'questionValue'].includes(node.op) && key !== 'value', seen));
    };
    visit(expression);
  }
  return result;
}
