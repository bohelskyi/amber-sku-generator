const { getCatalogItemImpact } = require('./catalog-impact');
const lifecycleGate = require('../full-product-cutover-gate');
const pool = require('../../db/pool');
const { writeAuditEvent } = require('../../audit/audit-events');
const { createMutationContext } = require('../../audit/mutation-context');
const { normalizeCategoryCode } = require('./catalog-input');
const { lockOptionWithUsage } = require('./option-mutation-state');

async function setOptionArchived({ id, archived }, options = {}) {
  if (typeof archived !== 'boolean') throw Object.assign(new Error('Потрібен явний стан архіву.'), { statusCode: 400 });
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN');
    const currentOption = await lockOptionWithUsage(client, id);
    if (!currentOption) {
      const err = new Error('\u0412\u0430\u0440\u0456\u0430\u043d\u0442 \u043d\u0435 \u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e');
      err.statusCode = 404;
      throw err;
    }

    const nextArchived = Boolean(archived);
    if (Boolean(currentOption.archived) === nextArchived) {
      await lifecycleGate.commit(client);
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
    await lifecycleGate.commit(client);
  } catch (err) {
    await lifecycleGate.rollback(client);
    throw err;
  } finally {
    await lifecycleGate.release(client); client.release();
  }
}

async function setQuestionArchived({ id, archived }, options = {}) {
  if (typeof archived !== 'boolean') throw Object.assign(new Error('Потрібен явний стан архіву.'), { statusCode: 400 });
  const client = await pool.connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN');
    const result = await client.query('SELECT id, category_code, key, label, archived FROM questions WHERE id=$1 FOR UPDATE', [Number(id)]);
    const question = result.rows[0];
    if (!question) throw Object.assign(new Error('Питання не знайдено.'), { statusCode: 404 });
    if (Boolean(question.archived) !== archived) {
      await client.query('UPDATE questions SET archived=$1 WHERE id=$2', [archived, Number(id)]);
      await writeAuditEvent(client, { mutationContext: createMutationContext(options.mutationContext),
        eventKey: archived ? 'catalog.question.archived' : 'catalog.question.unarchived',
        subjectType: 'catalog_question', subjectId: Number(id),
        details: { categoryCode: question.category_code, key: question.key, label: question.label } });
    }
    await lifecycleGate.commit(client);
  } catch (error) { await lifecycleGate.rollback(client); throw error; }
  finally { await lifecycleGate.release(client); client.release(); }
}

async function updateQuestionsOrder({ category_code, questions }, options = {}) {
  const categoryCode = normalizeCategoryCode(category_code);
  if (!categoryCode || !Array.isArray(questions) || questions.length === 0) {
    const err = new Error('\u041f\u043e\u0442\u0440\u0456\u0431\u043d\u0430 \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0456\u044f \u0442\u0430 \u0441\u043f\u0438\u0441\u043e\u043a \u043f\u0438\u0442\u0430\u043d\u044c');
    err.statusCode = 400;
    throw err;
  }

  const normalizedQuestions = new Map();
  for (const question of questions) {
    const questionId = Number(question.id);
    const displayOrder = Number(question.display_order);
    if (!Number.isFinite(questionId) || !Number.isFinite(displayOrder)) {
      const err = new Error('\u041d\u0435\u043a\u043e\u0440\u0435\u043a\u0442\u043d\u0456 \u0434\u0430\u043d\u0456 \u043f\u043e\u0440\u044f\u0434\u043a\u0443 \u043f\u0438\u0442\u0430\u043d\u044c');
      err.statusCode = 400;
      throw err;
    }

    let skuIndex = null;
    if (question.sku_index !== undefined && question.sku_index !== null && question.sku_index !== '') {
      skuIndex = Number(question.sku_index);
      if (!Number.isFinite(skuIndex)) {
        const err = new Error('\u041d\u0435\u043a\u043e\u0440\u0435\u043a\u0442\u043d\u0438\u0439 SKU index');
        err.statusCode = 400;
        throw err;
      }
    }
    normalizedQuestions.set(questionId, { questionId, displayOrder, skuIndex });
  }

  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN');
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

    await lifecycleGate.commit(client);
    return { success: true };
  } catch (err) {
    await lifecycleGate.rollback(client);
    throw err;
  } finally {
    await lifecycleGate.release(client); client.release();
  }
}

async function deleteCatalogItem(type, id, options = {}) {
  const supportedTypes = new Set(['category', 'question', 'option', 'modifier', 'scenario']);
  if (!supportedTypes.has(type)) {
    const err = new Error('\u041d\u0435\u043a\u043e\u0440\u0435\u043a\u0442\u043d\u0438\u0439 \u0442\u0438\u043f');
    err.statusCode = 400;
    throw err;
  }

  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await lifecycleGate.begin(client, 'BEGIN');
    let event = null;
    if (['question', 'option'].includes(type)) {
      if (options.scope === 'both') throw Object.assign(new Error('Видалення в обох системах ще не підтримується.'), { statusCode: 501 });
      await client.query(type === 'question' ? 'SELECT id FROM questions WHERE id=$1 FOR UPDATE'
        : 'SELECT id FROM options WHERE id=$1 FOR UPDATE', [Number(id)]);
      const impact = await getCatalogItemImpact(type, id, client);
      if (!impact.canDeleteLocal) throw Object.assign(new Error(impact.reason), { statusCode: 409, impact });
      if (options.confirmation !== impact.confirmation || options.impactHash !== impact.impactHash) {
        throw Object.assign(new Error('Оновіть перегляд залежностей і підтвердьте саме цю дію.'), { statusCode: 409, impact });
      }
    }

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
      const option = await lockOptionWithUsage(client, id);
      if (option && Number(option.product_count) > 0) {
        const err = new Error(
          `\u0426\u0435\u0439 \u0432\u0430\u0440\u0456\u0430\u043d\u0442 \u0432\u0438\u043a\u043e\u0440\u0438\u0441\u0442\u043e\u0432\u0443\u0454\u0442\u044c\u0441\u044f \u0443 ${option.product_count} \u0442\u043e\u0432\u0430\u0440\u0430\u0445. \u0410\u0440\u0445\u0456\u0432\u0443\u0439\u0442\u0435 \u0439\u043e\u0433\u043e \u0437\u0430\u043c\u0456\u0441\u0442\u044c \u0432\u0438\u0434\u0430\u043b\u0435\u043d\u043d\u044f.`
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
    await lifecycleGate.commit(client);
  } catch (err) {
    await lifecycleGate.rollback(client);
    throw err;
  } finally {
    await lifecycleGate.release(client); client.release();
  }
}

module.exports = {
  setQuestionArchived,
  getCatalogItemImpact,
  setOptionArchived,
  updateQuestionsOrder,
  deleteCatalogItem,
};
