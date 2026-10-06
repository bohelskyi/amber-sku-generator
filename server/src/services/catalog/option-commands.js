const { parseStrictDecimal } = require('../../utils/numbers');
const lifecycleGate = require('../full-product-cutover-gate');
const pool = require('../../db/pool');
const { writeAuditEvent } = require('../../audit/audit-events');
const { createMutationContext } = require('../../audit/mutation-context');
const { parseOptionalRule } = require('../../utils/rules');
const { buildOptionChanges } = require('./catalog-audit');
const { lockOptionWithUsage } = require('./option-mutation-state');
const { normalizeLabel } = require('./option-labels');

function normalizeSkuCode(payload) {
  if (payload.sku_code == null || payload.sku_code === '') return null;
  const skuCode = String(payload.sku_code).trim();
  if (!/^\d+$/.test(skuCode)) {
    const err = new Error('SKU-\u043a\u043e\u0434 \u0432\u0430\u0440\u0456\u0430\u043d\u0442\u0430 \u043c\u0430\u0454 \u0441\u043a\u043b\u0430\u0434\u0430\u0442\u0438\u0441\u044f \u043b\u0438\u0448\u0435 \u0437 \u0446\u0438\u0444\u0440.');
    err.statusCode = 400;
    throw err;
  }
  return skuCode;
}

async function createOption(payload, options = {}) {
  const label = normalizeLabel(payload.label);
  const labelEn = normalizeLabel(payload.label_en, { optional: true });
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
  const hiddenRule = parseOptionalRule(payload.hidden_if_json ?? payload.hidden_if);
  const skuCode = normalizeSkuCode(payload);
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['catalog_semantic_value_allocation']);
    // Seed/import rows may be installed after migration; establish the live floor
    // under the same permanent allocator lock before allocating a new semantic ID.
    await client.query(`SELECT setval('catalog_semantic_value_sequence', GREATEST(last_value,
      COALESCE((SELECT MAX(value_id)::bigint FROM options), 0),
      COALESCE((SELECT MAX(value_id)::bigint FROM sku_schema_options), 0),
      COALESCE((SELECT MAX(value_id)::bigint FROM magento_binding_options), 0),
      COALESCE((SELECT MAX(value_id)::bigint FROM catalog_semantic_values), 0)), true)
      FROM catalog_semantic_value_sequence`);
    const parent = await client.query('SELECT id, archived FROM questions WHERE id=$1 FOR UPDATE', [Number(payload.question_id)]);
    if (!parent.rows[0]) throw Object.assign(new Error('Питання не знайдено.'), { statusCode: 404 });
    if (parent.rows[0].archived) throw Object.assign(new Error('Спочатку відновіть архівне питання.'), { statusCode: 409 });
    const suppliedValue = payload.value_id !== undefined && payload.value_id !== null && payload.value_id !== '';
    const valueId = suppliedValue ? parseStrictDecimal(payload.value_id, { kind: 'integer', min: 0, max: 2147483647 }, 'Значення')
      : Number((await client.query("SELECT nextval('catalog_semantic_value_sequence') AS value_id")).rows[0].value_id);
    const reserved = await client.query('SELECT value_id FROM catalog_semantic_values WHERE question_id=$1 AND value_id=$2', [Number(payload.question_id), valueId]);
    if (reserved.rows.length) {
      const alias = await client.query('SELECT id FROM options WHERE question_id=$1 AND value_id=$2', [Number(payload.question_id), valueId]);
      if (!alias.rows.length) throw Object.assign(new Error('Це значення вже зарезервоване в історії та не може використовуватися повторно.'), { statusCode: 409 });
    }
    if (suppliedValue && valueId > 0) await client.query("SELECT setval('catalog_semantic_value_sequence', GREATEST($1::bigint, last_value), true) FROM catalog_semantic_value_sequence", [valueId]);
    const result = await client.query(
      `INSERT INTO options (question_id, value_id, sku_code, label, visible_if_json, hidden_if_json, archived, label_en)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
       RETURNING id`,
      [
        Number(payload.question_id),
        valueId,
        skuCode,
        label,
        visibleRule ? JSON.stringify(visibleRule) : null,
        hiddenRule ? JSON.stringify(hiddenRule) : null,
        Boolean(payload.archived),
        labelEn,
      ]
    );
    const optionId = result.rows[0].id;
    const questionResult = await client.query(
      'SELECT category_code, key FROM questions WHERE id = $1',
      [Number(payload.question_id)]
    );
    const question = questionResult.rows[0];
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'catalog.option.created',
      subjectType: 'catalog_option',
      subjectId: optionId,
      details: {
        categoryCode: question.category_code,
        questionId: Number(payload.question_id),
        questionKey: question.key,
        valueId: valueId,
        skuCode,
        label, labelEn,
      },
    });
    await lifecycleGate.commit(client);
    return { id: optionId, value_id: valueId };
  } catch (err) {
    await lifecycleGate.rollback(client);
    throw err;
  } finally {
    await lifecycleGate.release(client); client.release();
  }
}

async function updateOption(payload, options = {}) {
  const label = normalizeLabel(payload.label);
  // Omission preserves metadata for compatibility callers; explicit null clears it.
  const suppliedEn = payload.label_en !== undefined;
  const checkedEn = normalizeLabel(payload.label_en, { optional: true });
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
  const hiddenRule = parseOptionalRule(payload.hidden_if_json ?? payload.hidden_if);
  const checkedSkuCode = normalizeSkuCode(payload);
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN');
    const currentOption = await lockOptionWithUsage(client, payload.id);
    if (!currentOption) {
      const err = new Error('\u0412\u0430\u0440\u0456\u0430\u043d\u0442 \u043d\u0435 \u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e');
      err.statusCode = 404;
      throw err;
    }
    if (
      Number(currentOption.value_id) !== Number(payload.value_id)
      && (Number(currentOption.product_count) > 0 || Number(currentOption.schema_count) > 0 || Number(currentOption.characteristic_count) > 0)
    ) {
      const err = new Error(
        `\u041a\u043e\u0434 \u0446\u044c\u043e\u0433\u043e \u0432\u0430\u0440\u0456\u0430\u043d\u0442\u0430 \u0432\u0438\u043a\u043e\u0440\u0438\u0441\u0442\u043e\u0432\u0443\u0454\u0442\u044c\u0441\u044f \u0443 ${currentOption.product_count} \u0442\u043e\u0432\u0430\u0440\u0430\u0445 \u0456 \u043d\u0435 \u043c\u043e\u0436\u0435 \u0431\u0443\u0442\u0438 \u0437\u043c\u0456\u043d\u0435\u043d\u0438\u0439.`
      );
      err.statusCode = 409;
      throw err;
    }

    const nextValueId = parseStrictDecimal(payload.value_id, { kind: 'integer', min: 0, max: 2147483647 }, 'Значення');
    if (Number(currentOption.value_id) !== nextValueId) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['catalog_semantic_value_allocation']);
      const reserved = await client.query('SELECT value_id FROM catalog_semantic_values WHERE question_id=$1 AND value_id=$2', [Number(currentOption.question_id), nextValueId]);
      if (reserved.rows.length) throw Object.assign(new Error('Значення вже зарезервоване. Відновіть початковий варіант.'), { statusCode: 409 });
      if (nextValueId > 0) await client.query("SELECT setval('catalog_semantic_value_sequence', GREATEST($1::bigint, last_value), true) FROM catalog_semantic_value_sequence", [nextValueId]);
    }
    const skuCode = payload.sku_code === undefined ? currentOption.sku_code : checkedSkuCode;
    const labelEn = suppliedEn ? checkedEn : currentOption.label_en ?? null;
    const nextArchived =
      payload.archived === undefined ? Boolean(currentOption.archived) : Boolean(payload.archived);
    const changes = buildOptionChanges(currentOption, {
      valueId: Number(payload.value_id),
      skuCode,
      label, labelEn,
      visibleRule,
      hiddenRule,
      archived: nextArchived,
    });

    if (Object.keys(changes).length === 0) {
      await lifecycleGate.commit(client);
      return;
    }

    await client.query(
      `UPDATE options
       SET value_id = $1, sku_code = $2, label = $3, visible_if_json = $4::jsonb,
           hidden_if_json = $5::jsonb, archived = $6, label_en = $8
       WHERE id = $7`,
      [
        Number(payload.value_id),
        skuCode,
        label,
        visibleRule ? JSON.stringify(visibleRule) : null,
        hiddenRule ? JSON.stringify(hiddenRule) : null,
        nextArchived,
        Number(payload.id),
        labelEn,
      ]
    );
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'catalog.option.updated',
      subjectType: 'catalog_option',
      subjectId: Number(payload.id),
      details: {
        categoryCode: currentOption.category_code,
        questionId: Number(currentOption.question_id),
        questionKey: currentOption.question_key,
        valueId: Number(payload.value_id),
        changes,
      },
    });
    await lifecycleGate.commit(client);
  } catch (err) {
    await lifecycleGate.rollback(client);
    throw err;
  } finally {
    await lifecycleGate.release(client); client.release();
  }
}

module.exports = {
  createOption,
  updateOption,
};
