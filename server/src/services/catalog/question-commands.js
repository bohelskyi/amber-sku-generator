const { resolveNewQuestionKey } = require('./catalog-workflow');
const { normalizeNumericValidation } = require('../../utils/numbers');
const lifecycleGate = require('../full-product-cutover-gate');
const pool = require('../../db/pool');
const { writeAuditEvent } = require('../../audit/audit-events');
const { createMutationContext } = require('../../audit/mutation-context');
const { parseOptionalRule } = require('../../utils/rules');
const {
  normalizeInputType,
  normalizeEditableSkuSeparator,
  normalizeQuestionKey,
  getNormalizedQuestionNumbers,
} = require('./catalog-input');
const { buildQuestionChanges } = require('./catalog-audit');
const { rewriteQuestionKeyReferences } = require('./question-key-references');

async function createQuestion(payload, options = {}) {
  const normalizedInputType = normalizeInputType(payload.input_type);
  const numericValidation = normalizeNumericValidation(payload.numeric_validation);
  if (numericValidation && normalizedInputType !== 'text') {
    throw Object.assign(new Error('Числові правила дозволені для текстового поля.'), { statusCode: 400 });
  }

  const skuSeparator = normalizeEditableSkuSeparator(payload.sku_separator);
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
  const normalizedIncludeInSku =
    normalizedInputType === 'text'
      ? 0
      : payload.include_in_sku !== undefined
        ? Number(payload.include_in_sku)
        : 0;
  const { skuIndex, displayOrder } = getNormalizedQuestionNumbers(payload, normalizedIncludeInSku);

  const normalizedRequired = payload.required !== undefined ? Number(payload.required) : 1;
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN');
    const questionKey = await resolveNewQuestionKey(payload.key, client);
    await client.query('SELECT code FROM categories WHERE code=$1 FOR NO KEY UPDATE', [payload.category_code]);
    const result = await client.query(
      `INSERT INTO questions (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type, sku_separator, visible_if_json, numeric_validation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
       RETURNING id`,
      [
        payload.category_code,
        questionKey,
        payload.label,
        skuIndex,
        displayOrder,
        normalizedRequired,
        normalizedIncludeInSku,
        normalizedInputType,
        skuSeparator,
        visibleRule ? JSON.stringify(visibleRule) : null,
        numericValidation ? JSON.stringify(numericValidation) : null,
      ]
    );
    const questionId = result.rows[0].id;
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'catalog.question.created',
      subjectType: 'catalog_question',
      subjectId: questionId,
      details: {
        categoryCode: payload.category_code,
        key: questionKey,
        label: payload.label,
      },
    });
    await lifecycleGate.commit(client);
    return { id: questionId, key: questionKey };
  } catch (err) {
    await lifecycleGate.rollback(client);
    throw err;
  } finally {
    await lifecycleGate.release(client); client.release();
  }
}

async function updateQuestion(payload, options = {}) {
  const normalizedInputType = normalizeInputType(payload.input_type);
  const suppliedNumericValidation = payload.numeric_validation !== undefined;
  const numericValidation = normalizeNumericValidation(payload.numeric_validation);
  if (numericValidation && normalizedInputType !== 'text') {
    throw Object.assign(new Error('Числові правила дозволені для текстового поля.'), { statusCode: 400 });
  }
  const questionKey = normalizeQuestionKey(payload.key);
  const skuSeparator = normalizeEditableSkuSeparator(payload.sku_separator);
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
  const normalizedIncludeInSku =
    normalizedInputType === 'text'
      ? 0
      : payload.include_in_sku !== undefined
        ? Number(payload.include_in_sku)
        : 1;
  const { skuIndex, displayOrder } = getNormalizedQuestionNumbers(payload, normalizedIncludeInSku);
  const normalizedRequired = payload.required !== undefined ? Number(payload.required) : 1;
  const mutationContext = createMutationContext(options.mutationContext);

  const client = await pool.connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN');

    const currentResult = await client.query(
      `SELECT id, category_code, key, label, sku_index, display_order, required,
              include_in_sku, input_type, sku_separator, visible_if_json, numeric_validation
       FROM questions
       WHERE id = $1
       FOR UPDATE`,
      [Number(payload.id)]
    );
    if (currentResult.rows.length === 0) {
      const err = new Error('\u041f\u0438\u0442\u0430\u043d\u043d\u044f \u043d\u0435 \u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e');
      err.statusCode = 404;
      throw err;
    }

    const currentQuestion = currentResult.rows[0];
    const nextKey = questionKey || currentQuestion.key;
    const nextNumericValidation = suppliedNumericValidation ? numericValidation
      : normalizedInputType === 'text' ? currentQuestion.numeric_validation ?? null : null;
    const changes = buildQuestionChanges(currentQuestion, {
      nextKey,
      label: payload.label,
      skuIndex,
      displayOrder,
      required: normalizedRequired,
      includeInSku: normalizedIncludeInSku,
      inputType: normalizedInputType,
      skuSeparator,
      visibleRule,
      numericValidation: nextNumericValidation,
    });

    if (Object.keys(changes).length === 0) {
      await lifecycleGate.commit(client);
      return { key: nextKey };
    }

    if (nextKey !== currentQuestion.key) {
      const history = await client.query(`SELECT
        EXISTS(SELECT 1 FROM products WHERE category=$1 AND details #> ARRAY['answers',$2] IS NOT NULL)
        OR EXISTS(SELECT 1 FROM sku_schema_questions sq JOIN sku_schema_versions sv ON sv.id=sq.schema_version_id
          WHERE sv.category_code=$1 AND sq.question_key=$2)
        OR EXISTS(SELECT 1 FROM product_characteristic_versions cv WHERE cv.category_code=$1 AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(cv.snapshot->'questions') q WHERE q->>'key'=$2)) AS used`, [currentQuestion.category_code, currentQuestion.key]);
      if (history.rows[0]?.used) throw Object.assign(new Error('Ключ використаного питання незмінний. Архівуйте його і створіть нове питання.'), { statusCode: 409 });
      const duplicateResult = await client.query(
        'SELECT id FROM questions WHERE category_code = $1 AND key = $2 AND id <> $3',
        [currentQuestion.category_code, nextKey, Number(payload.id)]
      );
      if (duplicateResult.rows.length > 0) {
        const err = new Error(`\u041f\u0438\u0442\u0430\u043d\u043d\u044f \u0437 key ${nextKey} \u0432\u0436\u0435 \u0456\u0441\u043d\u0443\u0454 \u0432 \u0446\u0456\u0439 \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0456\u0457`);
        err.statusCode = 400;
        throw err;
      }

      await rewriteQuestionKeyReferences(client, {
        categoryCode: currentQuestion.category_code,
        oldKey: currentQuestion.key,
        newKey: nextKey,
      });
    }

    await client.query(
      `UPDATE questions
       SET key = $1, label = $2, sku_index = $3, display_order = $4, required = $5, include_in_sku = $6, input_type = $7, sku_separator = $8, visible_if_json = $9::jsonb, numeric_validation = $11::jsonb
       WHERE id = $10`,
      [
        nextKey,
        payload.label,
        skuIndex,
        displayOrder,
        normalizedRequired,
        normalizedIncludeInSku,
        normalizedInputType,
        skuSeparator,
        visibleRule ? JSON.stringify(visibleRule) : null,
        Number(payload.id),
        nextNumericValidation ? JSON.stringify(nextNumericValidation) : null,
      ]
    );

    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'catalog.question.updated',
      subjectType: 'catalog_question',
      subjectId: Number(payload.id),
      details: {
        categoryCode: currentQuestion.category_code,
        key: nextKey,
        ...(nextKey === currentQuestion.key ? {} : { previousKey: currentQuestion.key }),
        changes,
      },
    });

    await lifecycleGate.commit(client);
    return { key: nextKey };
  } catch (err) {
    await lifecycleGate.rollback(client);
    throw err;
  } finally {
    await lifecycleGate.release(client); client.release();
  }
}

module.exports = {
  createQuestion,
  updateQuestion,
};
