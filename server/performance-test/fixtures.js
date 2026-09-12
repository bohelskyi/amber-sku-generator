const crypto = require('node:crypto');

const FIXTURE_CATEGORY = 'PF';

async function createSyntheticFixtures(pool, options) {
  const productCount = Number(options.products);
  const correctionCount = Math.min(Number(options.corrections), productCount - 1);
  const lineageLength = Math.min(Number(options.lineage), productCount);
  const categoryCount = Math.max(1, Number(options.categories));

  const user = await pool.query(
    `INSERT INTO application_users
     (status, preferred_username, display_name, activated_at)
     VALUES ('active', 'phase7-fixture-user', 'Phase 7 Fixture User', CURRENT_TIMESTAMP)
     RETURNING id`
  );
  const userId = Number(user.rows[0].id);
  await pool.query(
    `INSERT INTO application_external_identities (application_user_id, issuer, subject)
     VALUES ($1, $2, $3)`,
    [userId, 'https://benchmark.invalid/issuer', 'phase7-fixture-subject']
  );
  await pool.query(
    `INSERT INTO user_role_assignments (application_user_id, role_id)
     SELECT $1, id FROM roles WHERE role_key = 'administrator'`,
    [userId]
  );

  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ($1, 'Phase 7 synthetic category', 0, 0)`,
    [FIXTURE_CATEGORY]
  );
  for (let index = 2; index <= categoryCount; index += 1) {
    const code = `P${String(index).padStart(2, '0')}`;
    await pool.query(
      `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
       VALUES ($1, $2, 0, 0)`,
      [code, `Phase 7 synthetic category ${index}`]
    );
    const extraQuestion = await pool.query(
      `INSERT INTO questions
       (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
       VALUES ($1, 'kind', 'Synthetic kind', 1, 1, 1, 1, 'options') RETURNING id`,
      [code]
    );
    await pool.query(
      `INSERT INTO options (question_id, value_id, sku_code, label)
       VALUES ($1, 1, '1', 'Synthetic one')`,
      [extraQuestion.rows[0].id]
    );
  }
  const question = await pool.query(
    `INSERT INTO questions
     (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
     VALUES ($1, 'kind', 'Synthetic kind', 1, 1, 1, 1, 'options') RETURNING id`,
    [FIXTURE_CATEGORY]
  );
  await pool.query(
    `INSERT INTO options (question_id, value_id, sku_code, label)
     VALUES ($1, 1, '1', 'Synthetic one'), ($1, 2, '2', 'Synthetic two')`,
    [question.rows[0].id]
  );
  await pool.query(
    `INSERT INTO questions
     (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
     VALUES ($1, 'note', 'Synthetic note', 2, 2, 0, 0, 'text')`,
    [FIXTURE_CATEGORY]
  );
  const schema = await pool.query(
    `INSERT INTO sku_schema_versions
     (category_code, version, marker, status, config_hash)
     VALUES ($1, 1, '', 'active', $2) RETURNING id`,
    [FIXTURE_CATEGORY, crypto.createHash('sha256').update('phase7-fixture-v1').digest('hex')]
  );
  const schemaId = Number(schema.rows[0].id);
  const schemaQuestion = await pool.query(
    `INSERT INTO sku_schema_questions
     (schema_version_id, question_key, label, sku_index, required, display_order)
     VALUES ($1, 'kind', 'Synthetic kind', 1, 1, 1) RETURNING id`,
    [schemaId]
  );
  await pool.query(
    `INSERT INTO sku_schema_options
     (schema_question_id, value_id, sku_code, label)
     VALUES ($1, 1, '1', 'Synthetic one'), ($1, 2, '2', 'Synthetic two')`,
    [schemaQuestion.rows[0].id]
  );
  const scenario = await pool.query(
    `INSERT INTO price_scenarios
     (category_code, name, match_json, axis_x_key, axis_y_key, priority, status, price_mode, apply_modifiers)
     VALUES ($1, 'Phase 7 fixed price', '{}'::jsonb, 'kind', NULL, 1, 'active', 'fixed_uah', FALSE)
     RETURNING id`,
    [FIXTURE_CATEGORY]
  );
  const scenarioId = Number(scenario.rows[0].id);
  await pool.query(
    `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
     VALUES ($1, 1, 0, 1200), ($1, 2, 0, 1400)`,
    [scenarioId]
  );

  await pool.query(
    `INSERT INTO products
     (full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah,
      price_per_gram, uah_rate, details, sku_schema_version_id, created_by_user_id)
     SELECT $1 || '1' || CASE WHEN series < 1000 THEN LPAD(series::text, 3, '0') ELSE series::text END,
            $1 || '1', series, $1, 0,
            25, 1000, 0, 40,
            jsonb_build_object('answers', jsonb_build_object('kind', 1, 'note', 'synthetic-' || series),
              'isCalibrated', NULL, 'calculatedPriceUah', 1000, 'autoPriceUah', 1000),
            $2, $3
     FROM generate_series(1, $4) AS series`,
    [FIXTURE_CATEGORY, schemaId, userId, productCount]
  );
  const changedProductCount = Math.min(productCount, Math.max(0, Number(options.repricingChanges)));
  if (changedProductCount < productCount) {
    await pool.query(
      `UPDATE products SET total_price = 30, total_price_uah = 1200
       WHERE category = $1 AND sequence_number > $2`,
      [FIXTURE_CATEGORY, changedProductCount]
    );
  }

  if (correctionCount > 0) {
    await pool.query(
      `INSERT INTO product_corrections
       (source_product_id, corrected_product_id, source_sku, corrected_sku,
        old_payload, new_payload, reason, price_delta_uah, performed_by_user_id)
       SELECT source.id, corrected.id, source.full_sku, corrected.full_sku,
              jsonb_build_object('answers', jsonb_build_object('kind', 1)),
              jsonb_build_object('answers', jsonb_build_object('kind', 2)),
              'synthetic correction', 200, $1
       FROM products source
       JOIN products corrected ON corrected.sequence_number = source.sequence_number + 1
       WHERE source.category = $2 AND source.sequence_number <= $3`,
      [userId, FIXTURE_CATEGORY, correctionCount]
    );
  }

  if (lineageLength > 1) {
    await pool.query(
      `UPDATE products current_product
       SET corrected_to_product_id = next_product.id, status = 'corrected'
       FROM products next_product
       WHERE current_product.category = $1
         AND next_product.category = $1
         AND next_product.sequence_number = current_product.sequence_number + 1
         AND current_product.sequence_number < $2`,
      [FIXTURE_CATEGORY, lineageLength]
    );
    await pool.query(
      `UPDATE products next_product
       SET corrected_from_product_id = previous_product.id
       FROM products previous_product
       WHERE next_product.category = $1
         AND previous_product.category = $1
         AND next_product.sequence_number = previous_product.sequence_number + 1
         AND previous_product.sequence_number < $2`,
      [FIXTURE_CATEGORY, lineageLength]
    );
  }

  for (let index = 0; index < Number(options.activeDrafts); index += 1) {
    const extraScenario = await pool.query(
      `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, priority, status, price_mode, apply_modifiers)
       VALUES ($1, $2, '{}'::jsonb, 'kind', $3, 'archived', 'fixed_uah', FALSE)
       RETURNING id`,
      [FIXTURE_CATEGORY, `Phase 7 draft scenario ${index}`, 10 + index]
    );
    await pool.query(
      `INSERT INTO repricing_drafts
       (scenario_id, category_code, scenario_name, scenario_snapshot,
        preview_fingerprint, preview_snapshot, created_by_user_id, last_modified_by_user_id)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, '{}'::jsonb, $5, $5)`,
      [extraScenario.rows[0].id, FIXTURE_CATEGORY, `Phase 7 draft scenario ${index}`, `fixture-${index}`, userId]
    );
  }

  await pool.query('ANALYZE');
  const range = await pool.query(
    `SELECT
       (SELECT full_sku FROM products WHERE category = $1 ORDER BY id ASC LIMIT 1) AS from_sku,
       (SELECT full_sku FROM products WHERE category = $1 ORDER BY id DESC LIMIT 1) AS to_sku,
       MIN(id) AS first_product_id, MAX(id) AS last_product_id
     FROM products WHERE category = $1`,
    [FIXTURE_CATEGORY]
  );
  return {
    userId,
    schemaId,
    scenarioId,
    categoryCode: FIXTURE_CATEGORY,
    exportToSku: (
      await pool.query(
        `SELECT full_sku FROM products WHERE category = $1 ORDER BY id
         OFFSET $2 LIMIT 1`,
        [FIXTURE_CATEGORY, Math.max(0, Math.min(productCount, Number(options.exportRange)) - 1)]
      )
    ).rows[0]?.full_sku,
    ...range.rows[0],
  };
}

async function createDatabaseSession(pool, fixture, { sessionId, csrfToken }) {
  const session = {
    cookie: { originalMaxAge: 28800000, expires: new Date(Date.now() + 28800000).toISOString(), httpOnly: true, path: '/api' },
    identity: {
      issuer: 'https://benchmark.invalid/issuer',
      sub: 'phase7-fixture-subject',
      authenticatedAt: new Date().toISOString(),
    },
    csrfToken,
  };
  await pool.query(
    `INSERT INTO session (sid, sess, expire)
     VALUES ($1, $2::json, CURRENT_TIMESTAMP + INTERVAL '8 hours')`,
    [sessionId, JSON.stringify(session)]
  );
}

module.exports = { createDatabaseSession, createSyntheticFixtures, FIXTURE_CATEGORY };
