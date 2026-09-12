const pool = require('../db/pool');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const { parseOptionalRule } = require('../utils/rules');
const {
  normalizeInputType,
  normalizeEditableSkuSeparator,
  normalizeCategoryCode,
  normalizeQuestionKey,
  getNormalizedQuestionNumbers,
} = require('./catalog/catalog-input');
const {
  buildQuestionChanges,
  buildOptionChanges,
} = require('./catalog/catalog-audit');
const { getAppConfig } = require('./catalog/catalog-read-model');
const {
  createCategory,
  updateCategory,
} = require('./catalog/category-commands');
const {
  rewriteQuestionKeyReferences,
} = require('./catalog/question-key-references');

async function createQuestion(payload, options = {}) {
  const normalizedInputType = normalizeInputType(payload.input_type);
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
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO questions (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type, sku_separator, visible_if_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
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
    await client.query('COMMIT');
    return { id: questionId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateQuestion(payload, options = {}) {
  const normalizedInputType = normalizeInputType(payload.input_type);
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
    await client.query('BEGIN');

    const currentResult = await client.query(
      `SELECT id, category_code, key, label, sku_index, display_order, required,
              include_in_sku, input_type, sku_separator, visible_if_json
       FROM questions
       WHERE id = $1
       FOR UPDATE`,
      [Number(payload.id)]
    );
    if (currentResult.rows.length === 0) {
      const err = new Error('Питання не знайдено');
      err.statusCode = 404;
      throw err;
    }

    const currentQuestion = currentResult.rows[0];
    const nextKey = questionKey || currentQuestion.key;
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
    });

    if (Object.keys(changes).length === 0) {
      await client.query('COMMIT');
      return { key: nextKey };
    }

    if (nextKey !== currentQuestion.key) {
      const duplicateResult = await client.query(
        'SELECT id FROM questions WHERE category_code = $1 AND key = $2 AND id <> $3',
        [currentQuestion.category_code, nextKey, Number(payload.id)]
      );
      if (duplicateResult.rows.length > 0) {
        const err = new Error(`Питання з key ${nextKey} вже існує в цій категорії`);
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
       SET key = $1, label = $2, sku_index = $3, display_order = $4, required = $5, include_in_sku = $6, input_type = $7, sku_separator = $8, visible_if_json = $9::jsonb
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

    await client.query('COMMIT');
    return { key: nextKey };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createOption(payload, options = {}) {
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
  const hiddenRule = parseOptionalRule(payload.hidden_if_json ?? payload.hidden_if);
  const skuCode = String(payload.sku_code ?? payload.value_id ?? '').trim();
  if (!/^\d+$/.test(skuCode)) {
    const err = new Error('SKU-код варіанта має складатися лише з цифр.');
    err.statusCode = 400;
    throw err;
  }
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

async function getOptionForMutation(client, optionId) {
  const result = await client.query(
    `SELECT o.id, o.question_id, o.value_id, o.sku_code, o.label,
            o.visible_if_json, o.hidden_if_json, o.archived,
            q.key AS question_key, q.category_code,
            (
              SELECT COUNT(*)::int
              FROM products p
              WHERE p.category = q.category_code
                AND p.details #>> ARRAY['answers', q.key] = o.value_id::text
            ) AS product_count
     FROM options o
     JOIN questions q ON q.id = o.question_id
     WHERE o.id = $1
     FOR UPDATE OF o`,
    [Number(optionId)]
  );
  return result.rows[0] || null;
}

async function updateOption(payload, options = {}) {
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
  const hiddenRule = parseOptionalRule(payload.hidden_if_json ?? payload.hidden_if);
  const skuCode = String(payload.sku_code ?? payload.value_id ?? '').trim();
  if (!/^\d+$/.test(skuCode)) {
    const err = new Error('SKU-код варіанта має складатися лише з цифр.');
    err.statusCode = 400;
    throw err;
  }
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentOption = await getOptionForMutation(client, payload.id);
    if (!currentOption) {
      const err = new Error('Варіант не знайдено');
      err.statusCode = 404;
      throw err;
    }
    if (
      Number(currentOption.value_id) !== Number(payload.value_id)
      && Number(currentOption.product_count) > 0
    ) {
      const err = new Error(
        `Код цього варіанта використовується у ${currentOption.product_count} товарах і не може бути змінений.`
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

async function setOptionArchived({ id, archived }, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentOption = await getOptionForMutation(client, id);
    if (!currentOption) {
      const err = new Error('Варіант не знайдено');
      err.statusCode = 404;
      throw err;
    }

    const nextArchived = Boolean(archived);
    if (Boolean(currentOption.archived) === nextArchived) {
      await client.query('COMMIT');
      return;
    }

    await client.query('UPDATE options SET archived = $1 WHERE id = $2', [nextArchived, Number(id)]);
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: nextArchived ? 'catalog.option.archived' : 'catalog.option.unarchived',
      subjectType: 'catalog_option',
      subjectId: Number(id),
      details: {
        categoryCode: currentOption.category_code,
        questionId: Number(currentOption.question_id),
        questionKey: currentOption.question_key,
        valueId: Number(currentOption.value_id),
        label: currentOption.label,
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

async function updateQuestionsOrder({ category_code, questions }, options = {}) {
  const categoryCode = normalizeCategoryCode(category_code);
  if (!categoryCode || !Array.isArray(questions) || questions.length === 0) {
    const err = new Error('Потрібна категорія та список питань');
    err.statusCode = 400;
    throw err;
  }

  const normalizedQuestions = new Map();
  for (const question of questions) {
    const questionId = Number(question.id);
    const displayOrder = Number(question.display_order);
    if (!Number.isFinite(questionId) || !Number.isFinite(displayOrder)) {
      const err = new Error('Некоректні дані порядку питань');
      err.statusCode = 400;
      throw err;
    }

    let skuIndex = null;
    if (question.sku_index !== undefined && question.sku_index !== null && question.sku_index !== '') {
      skuIndex = Number(question.sku_index);
      if (!Number.isFinite(skuIndex)) {
        const err = new Error('Некоректний SKU index');
        err.statusCode = 400;
        throw err;
      }
    }
    normalizedQuestions.set(questionId, { questionId, displayOrder, skuIndex });
  }

  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT id, display_order, sku_index
       FROM questions
       WHERE category_code = $1 AND id = ANY($2::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [categoryCode, [...normalizedQuestions.keys()]]
    );
    const changedQuestionIds = [];
    for (const current of currentResult.rows) {
      const next = normalizedQuestions.get(Number(current.id));
      const displayChanged = Number(current.display_order) !== next.displayOrder;
      const skuChanged = next.skuIndex !== null && Number(current.sku_index) !== next.skuIndex;
      if (!displayChanged && !skuChanged) continue;

      await client.query(
        `UPDATE questions
         SET display_order = $1, sku_index = COALESCE($2, sku_index)
         WHERE id = $3`,
        [next.displayOrder, next.skuIndex, next.questionId]
      );
      changedQuestionIds.push(next.questionId);
    }

    if (changedQuestionIds.length > 0) {
      await writeAuditEvent(client, {
        mutationContext,
        eventKey: 'catalog.question.reordered',
        subjectType: 'catalog_category',
        subjectId: categoryCode,
        details: {
          categoryCode,
          changedQuestionIds,
          changedCount: changedQuestionIds.length,
        },
      });
    }

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function deleteCatalogItem(type, id, options = {}) {
  const supportedTypes = new Set(['category', 'question', 'option', 'modifier', 'scenario']);
  if (!supportedTypes.has(type)) {
    const err = new Error('Некоректний тип');
    err.statusCode = 400;
    throw err;
  }

  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let event = null;

    if (type === 'category') {
      const categoryResult = await client.query(
        'SELECT code, name FROM categories WHERE code = $1 FOR UPDATE',
        [id]
      );
      const category = categoryResult.rows[0];
      if (category) {
        const countsResult = await client.query(
          `SELECT
             (SELECT COUNT(*)::int FROM questions WHERE category_code = $1) AS questions,
             (SELECT COUNT(*)::int FROM options o JOIN questions q ON q.id = o.question_id WHERE q.category_code = $1) AS options,
             (SELECT COUNT(*)::int FROM price_scenarios WHERE category_code = $1) AS scenarios,
             (SELECT COUNT(*)::int FROM price_matrix pm JOIN price_scenarios ps ON ps.id = pm.scenario_id WHERE ps.category_code = $1) AS matrix_cells,
             (SELECT COUNT(*)::int FROM price_weight_bands wb JOIN price_scenarios ps ON ps.id = wb.scenario_id WHERE ps.category_code = $1) AS weight_bands,
             (SELECT COUNT(*)::int FROM price_modifiers WHERE category_code = $1) AS modifiers`,
          [id]
        );
        const counts = countsResult.rows[0];
        await client.query('DELETE FROM categories WHERE code = $1', [id]);
        event = {
          eventKey: 'catalog.category.deleted',
          subjectType: 'catalog_category',
          subjectId: category.code,
          details: {
            code: category.code,
            name: category.name,
            affectedCounts: {
              questions: Number(counts.questions),
              options: Number(counts.options),
              scenarios: Number(counts.scenarios),
              matrixCells: Number(counts.matrix_cells),
              weightBands: Number(counts.weight_bands),
              modifiers: Number(counts.modifiers),
            },
          },
        };
      }
    } else if (type === 'question') {
      const questionResult = await client.query(
        `SELECT q.id, q.category_code, q.key, q.label,
                (SELECT COUNT(*)::int FROM options o WHERE o.question_id = q.id) AS option_count
         FROM questions q
         WHERE q.id = $1
         FOR UPDATE OF q`,
        [Number(id)]
      );
      const question = questionResult.rows[0];
      if (question) {
        await client.query('DELETE FROM questions WHERE id = $1', [Number(id)]);
        event = {
          eventKey: 'catalog.question.deleted',
          subjectType: 'catalog_question',
          subjectId: Number(id),
          details: {
            categoryCode: question.category_code,
            key: question.key,
            label: question.label,
            affectedCounts: { options: Number(question.option_count) },
          },
        };
      }
    } else if (type === 'option') {
      const option = await getOptionForMutation(client, id);
      if (option && Number(option.product_count) > 0) {
        const err = new Error(
          `Цей варіант використовується у ${option.product_count} товарах. Архівуйте його замість видалення.`
        );
        err.statusCode = 409;
        throw err;
      }
      if (option) {
        await client.query('DELETE FROM options WHERE id = $1', [Number(id)]);
        event = {
          eventKey: 'catalog.option.deleted',
          subjectType: 'catalog_option',
          subjectId: Number(id),
          details: {
            categoryCode: option.category_code,
            questionId: Number(option.question_id),
            questionKey: option.question_key,
            valueId: Number(option.value_id),
            skuCode: option.sku_code,
            label: option.label,
            affectedCounts: { products: 0 },
          },
        };
      }
    } else if (type === 'modifier') {
      const modifierResult = await client.query(
        `SELECT id, category_code, trigger_key, trigger_val, factor
         FROM price_modifiers
         WHERE id = $1
         FOR UPDATE`,
        [Number(id)]
      );
      const modifier = modifierResult.rows[0];
      if (modifier) {
        await client.query('DELETE FROM price_modifiers WHERE id = $1', [Number(id)]);
        event = {
          eventKey: 'pricing.modifier.deleted',
          subjectType: 'pricing_modifier',
          subjectId: Number(id),
          details: {
            categoryCode: modifier.category_code,
            triggerKey: modifier.trigger_key,
            triggerValue: modifier.trigger_val === null ? null : Number(modifier.trigger_val),
            factor: Number(modifier.factor),
            affectedCounts: {},
          },
        };
      }
    } else if (type === 'scenario') {
      const scenarioResult = await client.query(
        `SELECT ps.id, ps.category_code, ps.name,
                (SELECT COUNT(*)::int FROM price_matrix pm WHERE pm.scenario_id = ps.id) AS matrix_cell_count,
                (SELECT COUNT(*)::int FROM price_weight_bands wb WHERE wb.scenario_id = ps.id) AS weight_band_count
         FROM price_scenarios ps
         WHERE ps.id = $1
         FOR UPDATE OF ps`,
        [Number(id)]
      );
      const scenario = scenarioResult.rows[0];
      if (scenario) {
        await client.query('DELETE FROM price_scenarios WHERE id = $1', [Number(id)]);
        event = {
          eventKey: 'pricing.scenario.deleted',
          subjectType: 'pricing_scenario',
          subjectId: Number(id),
          details: {
            categoryCode: scenario.category_code,
            name: scenario.name,
            affectedCounts: {
              matrixCells: Number(scenario.matrix_cell_count),
              weightBands: Number(scenario.weight_band_count),
            },
          },
        };
      }
    }

    if (event) await writeAuditEvent(client, { mutationContext, ...event });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getAppConfig,
  createCategory,
  updateCategory,
  createQuestion,
  updateQuestion,
  createOption,
  updateOption,
  setOptionArchived,
  updateQuestionsOrder,
  deleteCatalogItem,
};
