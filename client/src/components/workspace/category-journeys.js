// Trace stored rules for presentation; never infer a relationship from similar
// labels, semantic values, SKU codes or target names.
function sourceIds(definition, node, seen = new Set(), found = new Set()) {
  if (!node || typeof node !== 'object') return found;
  // A characteristic used only to choose a branch is not the option value
  // delivered by that branch. Never turn a guard dependency into a mapping.
  if (node.op === 'when') {
    sourceIds(definition, node.then, seen, found); sourceIds(definition, node.else, seen, found); return found;
  }
  if (['require', 'questionValue'].includes(node.op)) return sourceIds(definition, node.value, seen, found);
  if (node.op === 'source') found.add(node.id);
  if (node.op === 'ref' && !seen.has(node.id)) {
    sourceIds(definition, definition.bindings?.find((item) => item.id === node.id)?.value, new Set([...seen, node.id]), found);
  }
  Object.values(node).forEach((child) => { if (typeof child === 'object') sourceIds(definition, child, seen, found); });
  return found;
}

export function questionTargets(definition, revision, categoryCode) {
  const result = {};
  const group = definition?.groups?.find((item) => item.route === categoryCode);
  for (const row of group?.rows || []) for (const [target, expression] of Object.entries(row.cells || {})) {
    const attributes = (revision?.bindings?.attributes || []).filter((item) =>
      item.routeKey?.split(/[.:]/)[0] === categoryCode && item.rowId === row.id && item.target === target);
    const fields = [...new Set([target, ...attributes.map((item) => item.attributeCode).filter(Boolean)])];
    for (const id of sourceIds(definition, expression)) {
      const source = definition.sources?.[id];
      if (source?.category !== categoryCode || !source.key || !['semantic', 'information'].includes(source.kind)) continue;
      result[source.key] = [...new Set([...(result[source.key] || []), ...fields])];
    }
  }
  return result;
}

export function placementRows(revision, categoryCode) {
  const rows = new Map();
  for (const item of revision?.bindings?.attributes || []) {
    if (item.target !== 'categories' || item.routeKey?.split(/[.:]/)[0] !== categoryCode) continue;
    for (const decision of item.evidence?.categories || []) {
      const path = decision.normalizedPath || decision.requestedPath;
      if (!path) continue;
      if (!rows.has(path)) rows.set(path, { path, decisions: [] });
      rows.get(path).decisions.push({ ...decision, routeKey: item.routeKey, bindingKey: item.bindingKey });
    }
  }
  return [...rows.values()];
}
