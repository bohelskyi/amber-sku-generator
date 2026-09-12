const pool = require('../../db/pool');
const { writeAuditEvent } = require('../../audit/audit-events');
const { createMutationContext } = require('../../audit/mutation-context');
const { parseOptionalRule } = require('../../utils/rules');
const { buildOptionChanges } = require('./catalog-audit');
const { lockOptionWithUsage } = require('./option-mutation-state');

function normalizeSkuCode(payload) {
  const skuCode = String(payload.sku_code ?? payload.value_id ?? '').trim();
  if (!/^\d+$/.test(skuCode)) {
    const err = new Error('SKU-\u043a\u043e\u0434 \u0432\u0430\u0440\u0456\u0430\u043d\u0442\u0430 \u043c\u0430\u0454 \u0441\u043a\u043b\u0430\u0434\u0430\u0442\u0438\u0441\u044f \u043b\u0438\u0448\u0435 \u0437 \u0446\u0438\u0444\u0440.');
    err.statusCode = 400;
    throw err;
  }
  return skuCode;
}

async function createOption(payload, options = {}) {
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
  const hiddenRule = parseOptionalRule(payload.hidden_if_json ?? payload.hidden_if);
  const skuCode = normalizeSkuCode(payload);
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO options (question_id, value_id, sku_code, label, visible_if_json, hidden_if_json, archived)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING id`,
      [
        Number(payload.question_id),
        Number(payload.value_id),
        skuCode,
        payload.label,
        visibleRule ? JSON.stringify(visibleRule) : null,
        hiddenRule ? JSON.stringify(hiddenRule) : null,
        Boolean(payload.archived),
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
        valueId: Number(payload.value_id),
        skuCode,
        label: payload.label,
      },
    });
    await client.query('COMMIT');
    return { id: optionId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateOption(payload, options = {}) {
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
  const hiddenRule = parseOptionalRule(payload.hidden_if_json ?? payload.hidden_if);
  const skuCode = normalizeSkuCode(payload);
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentOption = await lockOptionWithUsage(client, payload.id);
    if (!currentOption) {
      const err = new Error('\u0412\u0430\u0440\u0456\u0430\u043d\u0442 \u043d\u0435 \u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e');
      err.statusCode = 404;
      throw err;
    }
    if (
      Number(currentOption.value_id) !== Number(payload.value_id)
      && Number(currentOption.product_count) > 0
    ) {
      const err = new Error(
        `\u041a\u043e\u0434 \u0446\u044c\u043e\u0433\u043e \u0432\u0430\u0440\u0456\u0430\u043d\u0442\u0430 \u0432\u0438\u043a\u043e\u0440\u0438\u0441\u0442\u043e\u0432\u0443\u0454\u0442\u044c\u0441\u044f \u0443 ${currentOption.product_count} \u0442\u043e\u0432\u0430\u0440\u0430\u0445 \u0456 \u043d\u0435 \u043c\u043e\u0436\u0435 \u0431\u0443\u0442\u0438 \u0437\u043c\u0456\u043d\u0435\u043d\u0438\u0439.`
      );
      err.statusCode = 409;
      throw err;
    }

    const nextArchived =
      payload.archived === undefined ? Boolean(currentOption.archived) : Boolean(payload.archived);
    const changes = buildOptionChanges(currentOption, {
      valueId: Number(payload.value_id),
      skuCode,
      label: payload.label,
      visibleRule,
      hiddenRule,
      archived: nextArchived,
    });

    if (Object.keys(changes).length === 0) {
      await client.query('COMMIT');
      return;
    }

    await client.query(
      `UPDATE options
       SET value_id = $1, sku_code = $2, label = $3, visible_if_json = $4::jsonb,
           hidden_if_json = $5::jsonb, archived = $6
       WHERE id = $7`,
      [
        Number(payload.value_id),
        skuCode,
        payload.label,
        visibleRule ? JSON.stringify(visibleRule) : null,
        hiddenRule ? JSON.stringify(hiddenRule) : null,
        nextArchived,
        Number(payload.id),
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
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createOption,
  updateOption,
};
