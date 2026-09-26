const { buildCorrectionExposureManifest } = require('./export-exposure/manifest');

// Deliberately not imported by business routes or startup. Callers supply the
// pool so importing the pure classifier cannot connect or run initialization.
async function loadCorrectionExposureManifest(databasePool, { expectedDatabase } = {}) {
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
    if (expectedDatabase && database !== expectedDatabase) throw new Error('Inventory database does not match expected name');
    const products = (await client.query(`SELECT id, full_sku, category, status, exclude_from_export,
      corrected_from_product_id, corrected_to_product_id, sku_schema_version_id,
      weight, total_price_uah, magento_name_subject_ua, magento_name_subject_en,
      details->'answers' AS stored_answers,
      to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at
      FROM products ORDER BY id`)).rows;
    const corrections = (await client.query(`SELECT id, source_product_id, corrected_product_id,
      source_sku, corrected_sku, old_payload, new_payload, reason, price_delta_uah,
      performed_by_user_id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at
      FROM product_corrections ORDER BY id`)).rows;
    const snapshots = (await client.query(`SELECT id, status, from_sku, to_sku, resolved_to_sku,
      exported_to_product_id, row_count, file_name, csv_content, reexport_revisions,
      to_char(generated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS generated_at,
      to_char(confirmed_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS confirmed_at
      FROM export_snapshots ORDER BY id`)).rows;
    const artifacts = (await client.query(`SELECT snapshot_id, profile_version, group_code,
      file_name, csv_content, product_count, row_count FROM magento_export_artifacts
      ORDER BY snapshot_id, group_code, profile_version`)).rows;
    const revisions = (await client.query(`SELECT product_id, revision, confirmed_revision,
      has_product_snapshot FROM product_export_revisions ORDER BY product_id`)).rows;
    const events = (await client.query(`SELECT id, from_sku, to_sku, resolved_to_sku,
      exported_to_product_id, row_count,
      to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at FROM export_events ORDER BY id`)).rows;
    const state = (await client.query(`SELECT singleton, exported_to_product_id, last_snapshot_id,
      to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at FROM export_state`)).rows;
    const manifest = buildCorrectionExposureManifest({ database, products, corrections, snapshots,
      artifacts, revisions, events, state });
    await client.query('COMMIT');
    return manifest;
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}

module.exports = { loadCorrectionExposureManifest };
