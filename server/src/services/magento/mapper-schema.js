const { materializeMagentoV1 } = require('../export-templates/magento-v1-definition');

// CSV routing/inventory fields are not claims that an EAV attribute exists.
const CSV_FIELDS = new Set(['store_view_code', 'categories', 'attribute_set_code',
  'product_type', 'product_websites', 'product_online', 'qty', 'is_in_stock']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = (items) => [...new Set(items)].sort(compare);

function describeMapper(definition = materializeMagentoV1(new Map())) {
  // The default inspects code-backed syntax without claiming live Amber membership.
  // Evidence audits may supply a definition captured from their read-only snapshot.
  const bindings = new Map(definition.bindings.map((b) => [b.id, b.value]));
  function sources(node, seen = new Set()) {
    if (!node || typeof node !== 'object') return [];
    if (node.op === 'source') return [node.id];
    if (node.op === 'ref') {
      if (seen.has(node.id)) return [];
      return sources(bindings.get(node.id), new Set([...seen, node.id]));
    }
    return sorted(Object.values(node).flatMap((v) => sources(v, seen)));
  }
  function outputs(node, seen = new Set()) {
    if (!node) return { values: [], dynamic: false };
    const merge = (...nodes) => {
      const results = nodes.map((n) => outputs(n, seen));
      return { values: results.flatMap((r) => r.values), dynamic: results.some((r) => r.dynamic) };
    };
    switch (node.op) {
      case 'ref':
        if (seen.has(node.id)) throw new Error('Cyclic mapper reference');
        return outputs(bindings.get(node.id), new Set([...seen, node.id]));
      case 'literal': return { values: [{ label: String(node.value), kind: 'literal' }], dynamic: false };
      case 'error': return { values: [], dynamic: false };
      case 'when': return merge(node.then, node.else);
      case 'questionValue': case 'require': return outputs(node.value, seen);
      case 'lookup': {
        const fallback = outputs(node.otherwise, seen);
        return { values: [...Object.entries(definition.tables[node.table]).map(([key, value]) => ({
          label: String(value), kind: 'dictionary', table: node.table,
          amberValueId: key, sourceIds: sources(node.input),
        })), ...fallback.values], dynamic: fallback.dynamic };
      }
      case 'numericBand': {
        const outside = outputs(node.outside, seen);
        return { values: [...node.bands.map((b) => ({ label: b.value, kind: 'numeric_band' })), ...outside.values],
          dynamic: outside.dynamic || node.onInvalid === 'input' };
      }
      default: return { values: [], dynamic: true };
    }
  }
  const targets = new Map();
  const attributeSets = [];
  for (const group of definition.groups) {
    const setNames = sorted(outputs(group.rows[0].cells.attribute_set_code).values.map((v) => v.label));
    for (const name of setNames) attributeSets.push({ amberGroup: group.route, attribute_set_code: name });
    for (const field of group.columns) {
      if (!targets.has(field)) targets.set(field, { target: field,
        kind: CSV_FIELDS.has(field) ? 'csv_control' : 'product_attribute', usages: [] });
      for (const row of group.rows) {
        const node = row.cells[field];
        if (!node) continue;
        const evidence = outputs(node);
        targets.get(field).usages.push({ amberGroup: group.route, row: row.id,
          expectedAttributeSetNames: setNames, sourceIds: sources(node),
          values: evidence.values.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
          dynamicOutput: evidence.dynamic });
      }
    }
  }
  return { source: 'code-backed-magento-products-v1',
    sources: Object.entries(definition.sources).sort(([a], [b]) => compare(a, b))
      .map(([id, source]) => ({ id, kind: source.kind, ...(source.category ? { amberGroup: source.category, questionKey: source.key } : { field: source.field }) })),
    attributeSets: attributeSets.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))),
    targets: [...targets.values()].sort((a, b) => compare(a.target, b.target)) };
}

module.exports = { describeMapper, compare, sorted, CSV_FIELDS };
