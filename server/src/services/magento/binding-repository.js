// Internal repository: callers supply a transaction client. All dynamic identifiers
// below come exclusively from this closed schema specification, never command data.
const TABLES = Object.freeze({
  schema_sets: 'set_id bigint, name text',
  schema_attributes: 'code text, attribute_id bigint, metadata jsonb',
  schema_options: 'attribute_code text, option_id text, label text',
  schema_members: 'set_id bigint, attribute_code text',
  schema_stores: 'kind text, remote_id bigint, code text, metadata jsonb',
  routes: 'route_key text, amber_group text, predicates jsonb, evaluator_set_name text, enabled boolean, set_id bigint, review_state magento_binding_review, evidence jsonb',
  attributes: 'binding_key text, route_key text, row_id text, target text, strategy magento_binding_strategy, attribute_code text, transport_target text, unknown_output_policy text, review_state magento_binding_review, evidence jsonb',
  options: 'binding_key text, strategy magento_binding_strategy, attribute_code text, source_kind text, source_key text, amber_group text, question_key text, value_id integer, sku_code_evidence text, domain_key text, output_key text, evaluated_output text, option_id text, review_state magento_binding_review, evidence jsonb',
  field_policies: 'binding_key text, route_key text, field_target text, store_code text, store_id bigint, policy text, review_state magento_binding_review, evidence jsonb',
});
async function insertRows(client, id, table, rows) {
  if (!Object.hasOwn(TABLES, table)) throw new TypeError('Unsupported binding table');
  if (!rows.length) return;
  const columns = TABLES[table].split(', ').map((c) => c.split(' ')[0]).join(', ');
  await client.query(`INSERT INTO magento_binding_${table} (revision_id, ${columns})
    SELECT $1, ${columns} FROM jsonb_to_recordset($2::jsonb) AS r(${TABLES[table]})`, [id, JSON.stringify(rows)]);
}
async function insertSchema(client, id, schema) {
  await insertRows(client, id, 'schema_sets', schema.attributeSets.map((s) => ({ set_id: s.attribute_set_id, name: s.attribute_set_name })));
  await insertRows(client, id, 'schema_attributes', schema.attributes.map(({ options: _options, ...a }) =>
    ({ code: a.attribute_code, attribute_id: a.attribute_id, metadata: a })));
  await insertRows(client, id, 'schema_options', schema.attributes.flatMap((a) => a.options.map((o) =>
    ({ attribute_code: a.attribute_code, option_id: o.value, label: o.label }))));
  await insertRows(client, id, 'schema_members', schema.attributeSets.flatMap((s) => s.attributeCodes.map((c) => ({ set_id: s.attribute_set_id, attribute_code: c }))));
  await insertRows(client, id, 'schema_stores', Object.entries(schema.storeTopology).flatMap(([kind, rows]) =>
    rows.map((metadata) => ({ kind, remote_id: metadata.id, code: metadata.code, metadata }))));
}
// Copy stored decisions verbatim, including review evidence; never resolve labels again.
async function copyChildren(client, sourceId, id) {
  for (const [table, specification] of Object.entries(TABLES)) {
    const columns = specification.split(', ').map((column) => column.split(' ')[0]).join(', ');
    await client.query(`INSERT INTO magento_binding_${table} (revision_id, ${columns})
      SELECT $2, ${columns} FROM magento_binding_${table} WHERE revision_id=$1`, [sourceId, id]);
  }
}
async function replaceBindings(client, id, bindings, requirements) {
  for (const table of ['field_policies','options','attributes','routes']) {
    await client.query(`DELETE FROM magento_binding_${table} WHERE revision_id=$1`, [id]);
  }
  await insertRows(client, id, 'routes', bindings.routes.map((r) => {
    const plan = requirements.find((p) => p.routeKey === r.routeKey);
    return { route_key: r.routeKey, amber_group: plan.amberGroup, predicates: plan.predicates,
      evaluator_set_name: plan.evaluatorSetName, enabled: r.enabled, set_id: r.setId, review_state: r.reviewState, evidence: r.evidence };
  }));
  await insertRows(client, id, 'attributes', bindings.attributes.map((a) => ({ binding_key: a.bindingKey,
    route_key: a.routeKey, row_id: a.rowId, target: a.target, strategy: a.strategy, attribute_code: a.attributeCode,
    transport_target: a.transportTarget, unknown_output_policy: a.unknownOutputPolicy, review_state: a.reviewState, evidence: a.evidence })));
  await insertRows(client, id, 'options', bindings.options.map((o) => ({ binding_key: o.bindingKey, strategy: o.strategy,
    attribute_code: bindings.attributes.find((a) => a.bindingKey === o.bindingKey).attributeCode,
    source_kind: o.sourceKind, source_key: o.sourceKey, amber_group: o.amberGroup, question_key: o.questionKey,
    value_id: o.valueId, sku_code_evidence: o.skuCodeEvidence, domain_key: o.domainKey, output_key: o.outputKey,
    evaluated_output: o.evaluatedOutput, option_id: o.optionId, review_state: o.reviewState, evidence: o.evidence })));
  const stores = (await client.query("SELECT remote_id, code FROM magento_binding_schema_stores WHERE revision_id=$1 AND kind='storeViews'", [id])).rows;
  await insertRows(client, id, 'field_policies', bindings.policies.map((p) => {
    const a = bindings.attributes.find((a) => a.bindingKey === p.bindingKey);
    return { binding_key: p.bindingKey, route_key: a.routeKey, field_target: a.attributeCode || a.transportTarget || a.target,
      store_code: p.storeCode, store_id: p.storeCode === 'all' ? null : stores.find((s) => s.code === p.storeCode)?.remote_id,
      policy: p.policy, review_state: p.reviewState, evidence: p.evidence };
  }));
}
async function load(client, id, lock = false) {
  const row = (await client.query(`SELECT * FROM magento_binding_revisions WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
  if (!row) return null;
  const tables = {};
  for (const table of Object.keys(TABLES)) tables[table] = (await client.query(`SELECT * FROM magento_binding_${table}
    WHERE revision_id=$1 ORDER BY to_jsonb(magento_binding_${table})::text`, [id])).rows;
  const schema = { storeCode: row.observation_store_code,
    attributeSets: tables.schema_sets.map((s) => ({ attribute_set_id: Number(s.set_id), attribute_set_name: s.name,
      attributeCodes: tables.schema_members.filter((m) => m.set_id === s.set_id).map((m) => m.attribute_code).sort() })),
    attributes: tables.schema_attributes.map((a) => ({ ...a.metadata,
      options: tables.schema_options.filter((o) => o.attribute_code === a.code).map((o) => ({ value: o.option_id, label: o.label, isEmpty: o.option_id === '' })) })),
    storeTopology: Object.fromEntries(['websites','storeGroups','storeViews'].map((kind) => [kind,
      tables.schema_stores.filter((s) => s.kind === kind).map((s) => s.metadata)])) };
  const bindings = {
    routes: tables.routes.map((r) => ({ routeKey: r.route_key, evaluatorSetName: r.evaluator_set_name, enabled: r.enabled, setId: r.set_id === null ? null : Number(r.set_id), reviewState: r.review_state, evidence: r.evidence })),
    attributes: tables.attributes.map((a) => ({ routeKey: a.route_key, rowId: a.row_id, target: a.target,
      strategy: a.strategy, attributeCode: a.attribute_code, transportTarget: a.transport_target,
      unknownOutputPolicy: a.unknown_output_policy, reviewState: a.review_state, evidence: a.evidence })),
    options: tables.options.map((o) => ({ bindingKey: o.binding_key, sourceKind: o.source_kind, evaluatedOutput: o.evaluated_output,
      optionId: o.option_id, reviewState: o.review_state, evidence: o.evidence,
      ...(o.source_kind === 'semantic' ? { amberGroup: o.amber_group, questionKey: o.question_key, valueId: String(o.value_id),
        ...(o.sku_code_evidence === null ? {} : { skuCodeEvidence: o.sku_code_evidence }) }
        : { domainKey: o.domain_key, outputKey: o.output_key }) })),
    policies: tables.field_policies.map((p) => ({ bindingKey: p.binding_key, storeCode: p.store_code, policy: p.policy, reviewState: p.review_state, evidence: p.evidence })),
  };
  return { row, schema, bindings };
}
async function current(client, key) {
  return (await client.query(`SELECT * FROM magento_binding_revisions WHERE installation_key=$1 AND state='published'
    ORDER BY version_number DESC LIMIT 1`, [key])).rows[0] || null;
}
module.exports = { insertSchema, copyChildren, replaceBindings, load, current };
