async function getProductBySku(queryable, fullSku) {
  return (await require('./public-identity').resolveProductLookup(queryable, fullSku)).product;
}

async function getRecentProducts(queryable) {
  const result = await queryable.query(
    `SELECT p.*, i.public_sku, COALESCE((to_jsonb(i)->>'is_test_product')::boolean,FALSE) AS is_test_product
     FROM products p
     JOIN public_product_identities i ON i.id=p.public_product_identity_id
     WHERE COALESCE(status, 'active') NOT IN ('archived','voided')
     ORDER BY p.created_at DESC
     LIMIT 15`,
    []
  );

  return result.rows;
}

const PRODUCT_REGISTER_LIFECYCLES = new Set(['current', 'archived', 'corrected', 'all']);

function productRegisterError(message = 'Некоректний курсор списку товарів.') {
  const error = new Error(message);
  error.statusCode = 422;
  error.publicCode = 'PRODUCT_REGISTER_QUERY_INVALID';
  return error;
}

function normalizeProductRegisterQuery(query = {}) {
  const search = String(query.search || '').trim().slice(0, 160);
  const category = String(query.category || '').trim().slice(0, 40);
  const requestedLifecycle = String(query.lifecycle || 'current').trim().toLowerCase();
  const lifecycle = PRODUCT_REGISTER_LIFECYCLES.has(requestedLifecycle)
    ? requestedLifecycle
    : 'current';
  const requestedLimit = query.limit === undefined || query.limit === null || query.limit === ''
    ? 50
    : Number(query.limit);
  if (!Number.isFinite(requestedLimit)) {
    throw productRegisterError('Некоректний розмір сторінки.');
  }
  const limit = Math.min(Math.max(Math.floor(requestedLimit), 1), 100);
  return { search, category, lifecycle, limit };
}

function escapeLikeFragment(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}

function getProductRegisterCursorFilters(filters) {
  return {
    search: filters.search,
    category: filters.category,
    lifecycle: filters.lifecycle,
  };
}

function encodeProductRegisterCursor(row, filters) {
  return Buffer.from(JSON.stringify({
    version: 1,
    id: Number(row.id),
    filters: getProductRegisterCursorFilters(filters),
  })).toString('base64url');
}

function decodeProductRegisterCursor(value, filters) {
  const cursor = String(value || '').trim();
  if (!cursor) return null;
  if (cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw productRegisterError();
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const expectedFilters = getProductRegisterCursorFilters(filters);
    if (parsed?.version !== 1
      || !Number.isSafeInteger(parsed.id) || parsed.id <= 0
      || JSON.stringify(parsed.filters) !== JSON.stringify(expectedFilters)) {
      throw productRegisterError();
    }
    return parsed;
  } catch (error) {
    if (error?.publicCode === 'PRODUCT_REGISTER_QUERY_INVALID') throw error;
    throw productRegisterError();
  }
}

async function getProductRegisterPage(queryable, query = {}) {
  const filters = normalizeProductRegisterQuery(query);
  const cursor = decodeProductRegisterCursor(query.cursor, filters);
  const values = [];
  const where = [];
  const add = (value) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.lifecycle === 'current') {
    where.push("COALESCE(p.status, 'active') = 'active' AND p.corrected_to_product_id IS NULL");
  } else if (filters.lifecycle === 'archived') {
    where.push("p.status = 'archived'");
  } else if (filters.lifecycle === 'corrected') {
    where.push("p.status = 'corrected'");
  } else {
    where.push("COALESCE(p.status, 'active') <> 'voided'");
  }
  if (filters.category) where.push(`p.category = ${add(filters.category)}`);
  if (filters.search) {
    const searchParam = add(`%${escapeLikeFragment(filters.search)}%`);
    where.push(`(identity.public_sku ILIKE ${searchParam} ESCAPE '\\'
      OR p.full_sku ILIKE ${searchParam} ESCAPE '\\')`);
  }
  if (cursor) {
    const idParam = add(cursor.id);
    where.push(`p.id < ${idParam}`);
  }
  const pageLimitParam = add(filters.limit + 1);

  const [itemsResult, categoriesResult] = await Promise.all([
    queryable.query(
      `SELECT p.id,
              identity.public_sku AS "publicSku",
              COALESCE((to_jsonb(identity)->>'is_test_product')::boolean,FALSE) AS "isTestProduct",
              p.full_sku AS "internalSku",
              p.category AS "categoryCode",
              category.name AS "categoryName",
              COALESCE(p.status, 'active') AS status,
              p.weight,
              p.total_price_uah AS "priceUah",
              p.created_at AS "createdAt"
       FROM products p
       JOIN public_product_identities identity ON identity.id = p.public_product_identity_id
       LEFT JOIN categories category ON category.code = p.category
       WHERE ${where.join(' AND ')}
       ORDER BY p.id DESC
       LIMIT ${pageLimitParam}`,
      values
    ),
    queryable.query(
      `SELECT DISTINCT p.category AS code, COALESCE(category.name, p.category) AS name
       FROM products p
       LEFT JOIN categories category ON category.code = p.category
       WHERE COALESCE(p.status, 'active') <> 'voided'
       ORDER BY name ASC, code ASC`
    ),
  ]);

  const hasMore = itemsResult.rows.length > filters.limit;
  const pageRows = hasMore ? itemsResult.rows.slice(0, filters.limit) : itemsResult.rows;
  const items = pageRows.map((row) => ({
    ...row,
    id: Number(row.id),
    ...(row.isTestProduct === true ? { testTargetStatus: 2 } : {}),
  }));
  return {
    items,
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeProductRegisterCursor(pageRows.at(-1), filters) : null,
    },
    filterOptions: {
      categories: categoriesResult.rows.map((row) => ({ code: row.code, name: row.name })),
    },
  };
}

module.exports = {
  getProductBySku,
  getProductRegisterPage,
  getRecentProducts,
  normalizeProductRegisterQuery,
};
