export const deliveryPolicies = {
  authoritative_create_update: 'Оновлюється з менеджера',
  initialize_create_only: 'Заповнюється лише при створенні',
  magento_managed: 'Редагується в Magento',
};

export function rulesIdentity(value) {
  const stable = (item) => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])])) : item;
  return JSON.stringify(stable(value));
}

export function routeLabel(route, questions) {
  const match = route.routeKey.match(/^[A-Z][A-Z0-9_]*\.([^=!]+)(!?=)value_id:(-?\d+)$/);
  if (!match) return route.setName;
  const question = questions.find((q) => q.id === match[1]);
  const option = question?.options.find((o) => String(o.id) === match[3]);
  return `${route.setName} · ${question?.label || match[1]} ${match[2] === '!=' ? 'крім' : '—'} ${option?.label || match[3]}`;
}

export function changedFields(before, next, categoryCode) {
  const a = before?.groups.find((g) => g.route === categoryCode);
  const b = next?.groups.find((g) => g.route === categoryCode);
  if (!a || !b) return [];
  const result = [];
  const value = (definition, node, seen = new Set()) => {
    if (!node || typeof node !== 'object') return node;
    if (node.op === 'ref' && !seen.has(node.id)) return value(definition, definition.bindings.find((item) => item.id === node.id)?.value, new Set([...seen, node.id]));
    const resolved = Array.isArray(node) ? node.map((item) => value(definition, item, seen)) : Object.fromEntries(Object.entries(node).map(([key, item]) => [key, value(definition, item, seen)]));
    if (node.op === 'lookup') resolved.tableEntries = definition.tables[node.table];
    if (node.op === 'source') resolved.descriptor = definition.sources[node.id];
    return resolved;
  };
  for (const row of b.rows) for (const field of new Set([...a.columns, ...b.columns])) {
    if (rulesIdentity(value(before, a.rows.find((r) => r.id === row.id)?.cells[field])) !== rulesIdentity(value(next, row.cells[field]))) result.push({ field, rowId: row.id });
  }
  return result;
}

export const decisionKey = (entry) => JSON.stringify([entry.routeKey, entry.row, entry.target, entry.kind, entry.source || entry.label || '']);

export function assertCategoryScope(before, next, categoryCode, rowId) {
  const message = 'На цьому екрані зміни стосуються лише вибраної категорії та мови. Спільне правило потрібно відокремити.';
  if (before.evaluatorVersion !== next.evaluatorVersion || before.outputContract !== next.outputContract
    || before.groups.length !== next.groups.length) throw new Error(message);
  for (const group of before.groups) {
    const other = next.groups.find((g) => g.route === group.route);
    if (!other || group.route !== categoryCode && rulesIdentity(group) !== rulesIdentity(other)
      || changedFields(before, next, group.route).some((change) => group.route !== categoryCode || change.rowId !== rowId)) throw new Error(message);
  }
}

export function uniqueOptionSuggestions(entries, options) {
  return entries.filter((entry) => entry.kind === 'option' && entry.reviewState !== 'approved').flatMap((entry) => {
    const matches = options.filter((option) => !option.isEmpty && option.label === entry.evaluated);
    return matches.length === 1 ? [{ entry, option: matches[0] }] : [];
  });
}
