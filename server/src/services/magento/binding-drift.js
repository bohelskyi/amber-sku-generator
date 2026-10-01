const { auditMagentoSchema } = require('./schema-audit');
const { normalizeSchema, hash, originHash, error } = require('./binding-contract');

function compareSchema(revision, observation) {
  const current = normalizeSchema(observation);
  const previous = normalizeSchema(revision.schema);
  const diagnostics = [];
  const add = (code, context = {}) => diagnostics.push({ code, severity: 'review', ...context });
  if (current.storeCode !== previous.storeCode) throw error(422, 'MAGENTO_BINDING_SCOPE_MISMATCH', 'Schema observation scope differs');
  if (hash(current) !== revision.schemaFingerprint) add('SCHEMA_FINGERPRINT_CHANGED');
  if (hash(current.storeTopology) !== revision.topologyFingerprint) add('STORE_TOPOLOGY_CHANGED');
  for (const route of revision.bindings.routes) {
    if (route.setId === null) continue;
    const set = current.attributeSets.find((s) => s.attribute_set_id === route.setId);
    const old = previous.attributeSets.find((s) => s.attribute_set_id === route.setId);
    const context = { routeKey: route.routeKey, attributeSetId: route.setId };
    if (!set) add('ATTRIBUTE_SET_MISSING', { ...context, severity: 'missing_identity' });
    else if (old?.attribute_set_name !== set.attribute_set_name) add('ATTRIBUTE_SET_LABEL_CHANGED', { ...context, identityUnchanged: true });
  }
  for (const binding of revision.bindings.attributes) {
    if (binding.strategy === 'transport_control' || !binding.attributeCode) continue;
    const context = { bindingKey: binding.bindingKey, attributeCode: binding.attributeCode };
    const attr = current.attributes.find((a) => a.attribute_code === binding.attributeCode);
    const old = previous.attributes.find((a) => a.attribute_code === binding.attributeCode);
    if (!attr) { add('ATTRIBUTE_MISSING', { ...context, severity: 'missing_identity' }); continue; }
    if (attr.attribute_id !== old?.attribute_id) {
      add('ATTRIBUTE_ID_CHANGED', { ...context, severity: 'missing_identity',
        approvedAttributeId: old?.attribute_id ?? null, observedAttributeId: attr.attribute_id });
      continue; // Its options belong to a different attribute identity, even if numbers coincide.
    }
    if (attr.default_frontend_label !== old?.default_frontend_label) add('ATTRIBUTE_LABEL_CHANGED', { ...context, attributeId: attr.attribute_id, identityUnchanged: true });
    if (attr.frontend_input !== old?.frontend_input || attr.backend_type !== old?.backend_type || attr.scope !== old?.scope) add('ATTRIBUTE_METADATA_CHANGED', context);
    const route = revision.bindings.routes.find((r) => r.routeKey === binding.routeKey);
    const set = current.attributeSets.find((s) => s.attribute_set_id === route?.setId);
    if (set && !set.attributeCodes.includes(binding.attributeCode)) add('ATTRIBUTE_NOT_IN_EXPECTED_SET', { ...context, attributeSetId: route.setId });
    for (const o of revision.bindings.options.filter((o) => o.bindingKey === binding.bindingKey && o.optionId !== null)) {
      const found = attr.options.find((v) => v.value === o.optionId);
      const oldOption = old?.options.find((v) => v.value === o.optionId);
      if (!found) add('OPTION_ID_MISSING', { ...context, optionId: o.optionId, severity: 'missing_identity' });
      else if (found.label !== oldOption?.label) add('OPTION_ID_LABEL_CHANGED', { ...context, optionId: o.optionId,
        identityUnchanged: true, observedLabel: found.label, approvedObservationLabel: oldOption?.label ?? null });
    }
  }
  return { revisionId: revision.id, revision: revision.revision, schemaFingerprint: hash(current),
    topologyFingerprint: hash(current.storeTopology), diagnostics, drifted: diagnostics.length > 0 };
}
async function compareRevision(id, config, options = {}) {
  const { getRevision } = require('./binding.service');
  const revision = await getRevision(id, options);
  if (originHash(config.baseUrl) !== revision.originHash) throw error(422, 'MAGENTO_BINDING_INSTALLATION_MISMATCH', 'Magento installation differs');
  // Reuses the closed GET-only client, with no product requests or persistence.
  const schema = await auditMagentoSchema(config, { fetchImpl: options.fetchImpl, storeCode: revision.schema.storeCode });
  return compareSchema(revision, schema);
}
module.exports = { compareSchema, compareRevision };
