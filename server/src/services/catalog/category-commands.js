const pool = require('../../db/pool');
const { writeAuditEvent } = require('../../audit/audit-events');
const { createMutationContext } = require('../../audit/mutation-context');
const { normalizeCategoryCode } = require('./catalog-input');
const { buildCategoryChanges } = require('./catalog-audit');

async function createCategory(
  { code, name, requires_weight, skip_hidden_sku_questions },
  options = {}
) {
  const normalizedCode = normalizeCategoryCode(code);
  const normalizedRequiresWeight = requires_weight !== undefined ? Number(requires_weight) : 1;
  const normalizedSkipHidden =
    skip_hidden_sku_questions !== undefined ? Number(skip_hidden_sku_questions) : 0;
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions) VALUES ($1, $2, $3, $4)',
      [normalizedCode, name, normalizedRequiresWeight, normalizedSkipHidden]
    );
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'catalog.category.created',
      subjectType: 'catalog_category',
      subjectId: normalizedCode,
      details: {
        code: normalizedCode,
        name,
        requiresWeight: normalizedRequiresWeight,
        skipHiddenSkuQuestions: normalizedSkipHidden,
      },
    });
    await client.query('COMMIT');
    return { id: normalizedCode, name };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateCategory(
  { code, next_code, name, requires_weight, skip_hidden_sku_questions },
  options = {}
) {
  const currentCode = normalizeCategoryCode(code);
  const nextCode = normalizeCategoryCode(next_code || code);
  const normalizedRequiresWeight = requires_weight !== undefined ? Number(requires_weight) : 1;
  const normalizedSkipHidden =
    skip_hidden_sku_questions !== undefined ? Number(skip_hidden_sku_questions) : 0;

  if (!currentCode || !nextCode) {
    const err = new Error('\u041f\u043e\u0442\u0440\u0456\u0431\u0435\u043d \u043a\u043e\u0434 \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0456\u0457');
    err.statusCode = 400;
    throw err;
  }

  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const currentResult = await client.query(
      'SELECT * FROM categories WHERE code = $1 FOR UPDATE',
      [currentCode]
    );
    if (currentResult.rows.length === 0) {
      if (currentCode === nextCode) {
        await client.query('COMMIT');
        return { code: nextCode };
      }
      const err = new Error('\u041a\u0430\u0442\u0435\u0433\u043e\u0440\u0456\u044e \u043d\u0435 \u0437\u043d\u0430\u0439\u0434\u0435\u043d\u043e');
      err.statusCode = 404;
      throw err;
    }

    const currentCategory = currentResult.rows[0];
    const changes = buildCategoryChanges(currentCategory, {
      nextCode,
      name,
      requiresWeight: normalizedRequiresWeight,
      skipHiddenSkuQuestions: normalizedSkipHidden,
    });

    if (Object.keys(changes).length === 0) {
      await client.query('COMMIT');
      return { code: nextCode };
    }

    if (currentCode === nextCode) {
      await client.query(
        'UPDATE categories SET name = $1, requires_weight = $2, skip_hidden_sku_questions = $3 WHERE code = $4',
        [name, normalizedRequiresWeight, normalizedSkipHidden, currentCode]
      );
      await writeAuditEvent(client, {
        mutationContext,
        eventKey: 'catalog.category.updated',
        subjectType: 'catalog_category',
        subjectId: nextCode,
        details: { code: nextCode, changes },
      });
      await client.query('COMMIT');
      return { code: nextCode };
    }

    const usageResult = await client.query(
      `SELECT
         EXISTS (SELECT 1 FROM products WHERE category = $1)
         OR EXISTS (
           SELECT 1
           FROM sku_registry sr
           LEFT JOIN products p ON p.id = sr.first_product_id
           WHERE p.category = $1 OR sr.full_sku LIKE $1 || '%'
         )
         OR EXISTS (
           SELECT 1
           FROM sku_schema_versions sv
           WHERE sv.category_code = $1 AND sv.published_at IS NOT NULL
         ) AS used`,
      [currentCode]
    );
    if (usageResult.rows[0]?.used) {
      const err = new Error(
        `\u041a\u043e\u0434 \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0456\u0457 ${currentCode} \u043d\u0435 \u043c\u043e\u0436\u043d\u0430 \u0437\u043c\u0456\u043d\u0438\u0442\u0438, \u043e\u0441\u043a\u0456\u043b\u044c\u043a\u0438 \u0432\u0456\u043d \u0443\u0436\u0435 \u0432\u0438\u043a\u043e\u0440\u0438\u0441\u0442\u0430\u043d\u0438\u0439 \u0443 SKU.`
      );
      err.statusCode = 409;
      throw err;
    }

    const duplicateResult = await client.query(
      'SELECT code FROM categories WHERE code = $1',
      [nextCode]
    );
    if (duplicateResult.rows.length > 0) {
      const err = new Error(`\u041a\u0430\u0442\u0435\u0433\u043e\u0440\u0456\u044f \u0437 \u043a\u043e\u0434\u043e\u043c ${nextCode} \u0432\u0436\u0435 \u0456\u0441\u043d\u0443\u0454`);
      err.statusCode = 400;
      throw err;
    }

    await client.query(
      'INSERT INTO categories (code, name, requires_weight, sku_separator, skip_hidden_sku_questions) SELECT $1, $2, $3, sku_separator, $4 FROM categories WHERE code = $5',
      [nextCode, name, normalizedRequiresWeight, normalizedSkipHidden, currentCode]
    );
    await client.query('UPDATE questions SET category_code = $1 WHERE category_code = $2', [nextCode, currentCode]);
    await client.query('UPDATE price_scenarios SET category_code = $1 WHERE category_code = $2', [nextCode, currentCode]);
    await client.query('UPDATE price_modifiers SET category_code = $1 WHERE category_code = $2', [nextCode, currentCode]);
    await client.query('UPDATE products SET category = $1 WHERE category = $2', [nextCode, currentCode]);
    await client.query('UPDATE sku_schema_versions SET category_code = $1 WHERE category_code = $2', [nextCode, currentCode]);
    await client.query('DELETE FROM categories WHERE code = $1', [currentCode]);

    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'catalog.category.updated',
      subjectType: 'catalog_category',
      subjectId: nextCode,
      details: { code: nextCode, previousCode: currentCode, changes },
    });

    await client.query('COMMIT');
    return { code: nextCode };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createCategory,
  updateCategory,
};
