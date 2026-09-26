function product(id, sku = `P${id}`, overrides = {}) {
  return { id, full_sku: sku, category: 'SV', status: 'active', exclude_from_export: 0,
    corrected_from_product_id: null, corrected_to_product_id: null, ...overrides };
}
function correction(id, source, target, overrides = {}) {
  source.status = 'corrected'; source.exclude_from_export = 1;
  source.corrected_to_product_id = target.id;
  target.corrected_from_product_id = source.id; target.exclude_from_export = 1;
  return { id, source_product_id: source.id, corrected_product_id: target.id,
    source_sku: source.full_sku, corrected_sku: target.full_sku,
    old_payload: { answers: { weight: '1260,0' } }, new_payload: { answers: { weight: 1260 } }, ...overrides };
}
function snapshot(id, members, status = 'generated', overrides = {}) {
  return { id, status, from_sku: members[0]?.full_sku, to_sku: members.at(-1)?.full_sku,
    exported_to_product_id: Math.max(0, ...members.map((p) => p.id)), row_count: members.length,
    csv_content: `sku,price_uah\n${members.map((p) => `${p.full_sku},21700`).join('\n')}`,
    reexport_revisions: [], ...overrides };
}
function emptyEvidence(overrides = {}) {
  return { database: 'fixture_test', products: [], corrections: [], snapshots: [], artifacts: [],
    revisions: [], events: [], state: [{ singleton: true, exported_to_product_id: 0 }], ...overrides };
}
function reproducedCase() {
  const source = product(4502, 'SV23150003', { weight: '1260.000', total_price_uah: '21700.00', sku_schema_version_id: 6 });
  const successor = product(4848, 'SV23150004', { weight: '1260.000', total_price_uah: '21700.00', sku_schema_version_id: 6 });
  return emptyEvidence({ products: [source, successor], corrections: [correction(1436, source, successor)],
    state: [{ singleton: true, exported_to_product_id: 4063 }],
    events: [{ id: 27, from_sku: 'UNAVAILABLE-LEGACY-ANCHOR', exported_to_product_id: 3201 }] });
}

module.exports = { product, correction, snapshot, emptyEvidence, reproducedCase };
