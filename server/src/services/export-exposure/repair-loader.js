const lifecycleGate = require('../full-product-cutover-gate');
const { hash, stableJson } = require('./evidence');

// A single statement supplies a coherent view even to a READ COMMITTED writer
// after it has waited for product/lifecycle locks. No startup or migration import.
async function readRepairInput(client) {
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  const schema = (await client.query(`SELECT current_database() AS database,
    to_regclass('product_full_export_state') IS NOT NULL AS lifecycle_present,
    to_regclass('export_snapshot_products') IS NOT NULL AS members_present,
    to_regclass('full_product_export_activation') IS NOT NULL AS activation_present`)).rows[0];
  if (schema.lifecycle_present !== schema.members_present) throw new Error('Incomplete lifecycle schema');
  const lifecycle = schema.lifecycle_present;
  const { rows: [input] } = await client.query(`SELECT
    (SELECT COALESCE(jsonb_agg(p ORDER BY id),'[]') FROM products p) AS products,
    (SELECT COALESCE(jsonb_agg(c ORDER BY id),'[]') FROM product_corrections c) AS corrections,
    (SELECT COALESCE(jsonb_agg(s ORDER BY id),'[]') FROM export_snapshots s) AS snapshots,
    (SELECT COALESCE(jsonb_agg(a ORDER BY snapshot_id,group_code,profile_version),'[]') FROM magento_export_artifacts a) AS artifacts,
    (SELECT COALESCE(jsonb_agg(to_jsonb(r) || jsonb_build_object('revision',revision::text,'confirmed_revision',confirmed_revision::text) ORDER BY product_id),'[]') FROM product_export_revisions r) AS revisions,
    (SELECT COALESCE(jsonb_agg(e ORDER BY id),'[]') FROM export_events e) AS events,
    (SELECT COALESCE(jsonb_agg(s),'[]') FROM export_state s) AS state,
    (SELECT COALESCE(jsonb_agg(r ORDER BY full_sku),'[]') FROM sku_registry r) AS registry,
    (SELECT COALESCE(jsonb_agg(m ORDER BY name),'[]') FROM schema_migrations m) AS migrations,
    ${lifecycle ? "(SELECT COALESCE(jsonb_agg(to_jsonb(f) || jsonb_build_object('revision',revision::text,'confirmed_revision',confirmed_revision::text,'delivery_version',delivery_version::text) ORDER BY product_id),'[]') FROM product_full_export_state f)" : "'[]'::jsonb"} AS lifecycle,
    ${lifecycle ? "(SELECT COALESCE(jsonb_agg(to_jsonb(m) || jsonb_build_object('full_revision',full_revision::text,'delivery_version',delivery_version::text) ORDER BY snapshot_id,product_id),'[]') FROM export_snapshot_products m)" : "'[]'::jsonb"} AS members,
    ${schema.activation_present ? '(SELECT to_jsonb(a) FROM full_product_export_activation a WHERE singleton)' : 'NULL::jsonb'} AS activation`);
  input.lifecycle = input.lifecycle.map((s) => ({ ...s, ...(schema.activation_present ? {cutover_baseline_revision:String(s.cutover_baseline_revision)} : {}) }));
  // Bind the entire row (including price/details/actors), but do not duplicate
  // large pricing explanations in every Phase-0 pair and terminal projection.
  input.products = input.products.map(({ details, ...p }) => ({ ...p,
    stored_answers: details?.answers ?? null, product_state_hash: hash(stableJson({ ...p, details })) }));
  return { ...input, database: schema.database, lifecyclePresent: lifecycle };
}

async function loadRepairInput(databasePool, { expectedDatabase } = {}) {
  const client = await databasePool.connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const input = await readRepairInput(client);
    if (!expectedDatabase || input.database !== expectedDatabase) throw new Error('Repair inventory database does not match expected name');
    await lifecycleGate.commit(client);
    return input;
  } catch (error) { await lifecycleGate.rollback(client); throw error; }
  finally { await lifecycleGate.release(client); client.release(); }
}

module.exports = { readRepairInput, loadRepairInput };
