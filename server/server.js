const express = require('express');
const cors = require('cors');
const https = require('https');
const { Pool } = require('pg');
const initialConfig = require('./data_config');

const app = express();
const PORT = Number(process.env.PORT || 5000);
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/amber';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const NBU_USD_URL =
  'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json';
let cachedUsdUahRate = null;
let cachedUsdUahDate = null;

app.use(cors());
app.use(express.json());

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message || err);
});

function getKyivDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`NBU HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

async function getUsdUahRate() {
  const today = getKyivDateString();
  if (cachedUsdUahRate && cachedUsdUahDate === today) return cachedUsdUahRate;

  const data = await fetchJson(NBU_USD_URL);
  const rate = data && data[0] && data[0].rate ? Number(data[0].rate) : null;
  if (!rate) throw new Error('NBU rate missing');

  cachedUsdUahRate = rate;
  cachedUsdUahDate = today;
  return rate;
}

function asRuleObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
}

function parseVariationSku(skuValue) {
  const normalizedSku = String(skuValue || '').trim().toUpperCase();
  const variationMatch = normalizedSku.match(/^(.*)-(\d{3})$/);
  if (!variationMatch) {
    return {
      normalizedSku,
      baseFullSku: normalizedSku,
      variationNumber: null,
    };
  }

  return {
    normalizedSku,
    baseFullSku: variationMatch[1],
    variationNumber: Number(variationMatch[2]),
  };
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function buildCsv(rows) {
  return rows
    .map((row) => row.map((value) => escapeCsvValue(value)).join(','))
    .join('\n');
}

async function getAllCategories() {
  const result = await pool.query(
    'SELECT code, name, requires_weight FROM categories ORDER BY LENGTH(code) DESC, code ASC'
  );
  return result.rows.map((row) => ({
    code: row.code,
    name: row.name,
    requires_weight: Number(row.requires_weight),
  }));
}

async function getQuestionsForCategory(categoryCode) {
  const result = await pool.query(
    `
      SELECT
        q.key,
        q.label AS q_label,
        q.sku_index,
        q.required,
        o.value_id,
        o.label AS o_label
      FROM questions q
      LEFT JOIN options o ON q.id = o.question_id
      WHERE q.category_code = $1
      ORDER BY q.sku_index, LENGTH(CAST(o.value_id AS TEXT)) DESC, o.value_id ASC
    `,
    [categoryCode]
  );

  const questions = [];
  let currentQuestion = null;

  for (const row of result.rows) {
    if (!currentQuestion || currentQuestion.key !== row.key) {
      currentQuestion = {
        key: row.key,
        label: row.q_label,
        sku_index: Number(row.sku_index),
        required: Number(row.required),
        options: [],
      };
      questions.push(currentQuestion);
    }

    if (row.value_id !== null && row.value_id !== undefined) {
      currentQuestion.options.push({
        id: Number(row.value_id),
        label: row.o_label,
      });
    }
  }

  return questions;
}

function decodeSkuAnswers(questions, encodedPart, index = 0, decodedAnswers = []) {
  if (index === questions.length) {
    return encodedPart.length === 0 ? decodedAnswers : null;
  }

  const question = questions[index];
  const options = [...question.options].sort(
    (a, b) => String(b.id).length - String(a.id).length || a.id - b.id
  );

  for (const option of options) {
    const optionCode = String(option.id);
    if (!encodedPart.startsWith(optionCode)) continue;

    const nextDecoded = decodeSkuAnswers(
      questions,
      encodedPart.slice(optionCode.length),
      index + 1,
      [
        ...decodedAnswers,
        {
          key: question.key,
          label: question.label,
          sku_index: question.sku_index,
          value_id: option.id,
          value_label: option.label,
          is_placeholder: false,
        },
      ]
    );

    if (nextDecoded) return nextDecoded;
  }

  const hasZeroOption = question.options.some((option) => Number(option.id) === 0);
  if (question.required !== 1 && !hasZeroOption && encodedPart.startsWith('0')) {
    return decodeSkuAnswers(questions, encodedPart.slice(1), index + 1, [
      ...decodedAnswers,
      {
        key: question.key,
        label: question.label,
        sku_index: question.sku_index,
        value_id: null,
        value_label: 'Не обрано',
        is_placeholder: true,
      },
    ]);
  }

  return null;
}

async function decodeSku(skuValue) {
  const { normalizedSku, baseFullSku, variationNumber } = parseVariationSku(skuValue);
  if (!normalizedSku) {
    throw new Error('Введіть артикул для розшифровки');
  }

  const categories = await getAllCategories();
  const category = categories.find((item) => baseFullSku.startsWith(item.code));
  if (!category) {
    throw new Error('Не вдалося визначити категорію за кодом артикула');
  }

  const questions = await getQuestionsForCategory(category.code);
  const skuWithoutCategory = baseFullSku.slice(category.code.length);
  const attempts = [];

  if (skuWithoutCategory.length >= 3) {
    attempts.push({
      encodedPart: skuWithoutCategory.slice(0, -3),
      suffixRaw: skuWithoutCategory.slice(-3),
      hasSuffix: true,
    });
  }

  attempts.push({
    encodedPart: skuWithoutCategory,
    suffixRaw: null,
    hasSuffix: false,
  });

  for (const attempt of attempts) {
    const decodedAnswers = decodeSkuAnswers(questions, attempt.encodedPart);
    if (!decodedAnswers) continue;

    const suffixValue =
      attempt.suffixRaw !== null && /^\d+$/.test(attempt.suffixRaw)
        ? Number(attempt.suffixRaw)
        : null;

    const productResult = await pool.query(
      'SELECT id, full_sku, base_sku, sequence_number, category, weight, total_price, created_at FROM products WHERE full_sku = $1 LIMIT 1',
      [normalizedSku]
    );

    return {
      sku: normalizedSku,
      category: {
        code: category.code,
        name: category.name,
        requires_weight: category.requires_weight,
      },
      baseSku: category.code + attempt.encodedPart,
      decodedAnswers,
      suffix: {
        raw: attempt.suffixRaw,
        type: attempt.hasSuffix
          ? category.requires_weight === 1
            ? 'weight'
            : 'sequence'
          : 'none',
        value: suffixValue,
      },
      variation: variationNumber !== null
        ? {
            number: variationNumber,
            suffix: `-${String(variationNumber).padStart(3, '0')}`,
          }
        : null,
      existsInDb: productResult.rows.length > 0,
      product: productResult.rows[0] || null,
    };
  }

  throw new Error('Артикул не відповідає поточній конфігурації категорії');
}

async function getNextVariationSku(skuValue) {
  const { baseFullSku } = parseVariationSku(skuValue);
  if (!baseFullSku) {
    throw new Error('Потрібен базовий артикул');
  }

  const result = await pool.query(
    'SELECT full_sku FROM products WHERE full_sku = $1 OR full_sku LIKE $2',
    [baseFullSku, `${baseFullSku}-%`]
  );

  let maxVariationNumber = 0;
  for (const row of result.rows) {
    const match = String(row.full_sku).match(new RegExp(`^${baseFullSku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\-(\\d{3})$`));
    if (!match) continue;
    maxVariationNumber = Math.max(maxVariationNumber, Number(match[1]));
  }

  const nextVariationNumber = maxVariationNumber + 1;
  if (nextVariationNumber > 999) {
    throw new Error('Досягнуто ліміт варіацій для цього артикула');
  }

  return {
    baseFullSku,
    variationNumber: nextVariationNumber,
    fullSku: `${baseFullSku}-${String(nextVariationNumber).padStart(3, '0')}`,
  };
}

async function getProductBySku(fullSku) {
  const result = await pool.query(
    'SELECT id, full_sku, created_at FROM products WHERE full_sku = $1 ORDER BY id ASC LIMIT 1',
    [String(fullSku || '').trim().toUpperCase()]
  );
  return result.rows[0] || null;
}

async function getExportRows(fromSku, toSku) {
  const normalizedFromSku = String(fromSku || '').trim().toUpperCase();
  const normalizedToSku = String(toSku || '').trim().toUpperCase();

  if (!normalizedFromSku) {
    throw new Error('Потрібно вказати артикул, з якого починати експорт');
  }

  const fromProduct = await getProductBySku(normalizedFromSku);
  if (!fromProduct) {
    throw new Error(`Артикул ${normalizedFromSku} не знайдено`);
  }

  let toProduct = null;
  if (normalizedToSku) {
    toProduct = await getProductBySku(normalizedToSku);
    if (!toProduct) {
      throw new Error(`Артикул ${normalizedToSku} не знайдено`);
    }
  }

  const idFrom = Number(fromProduct.id);
  const idTo = toProduct ? Number(toProduct.id) : null;
  const startId = idTo !== null ? Math.min(idFrom, idTo) : idFrom;
  const endId = idTo !== null ? Math.max(idFrom, idTo) : null;

  const params = [startId];
  const whereClauses = ['id >= $1'];
  if (endId !== null) {
    params.push(endId);
    whereClauses.push(`id <= $${params.length}`);
  }

  const result = await pool.query(
    `
      SELECT id, full_sku, total_price_uah, created_at
      FROM products
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY id ASC
    `,
    params
  );

  return {
    rows: result.rows,
    range: {
      fromSku: fromProduct.full_sku,
      toSku: toProduct ? toProduct.full_sku : null,
      resolvedToSku:
        result.rows.length > 0 ? result.rows[result.rows.length - 1].full_sku : fromProduct.full_sku,
    },
  };
}

async function calculatePricing(categoryCode, answers = {}, weight, isCalibrated) {
  const scenarios = await pool.query(
    'SELECT * FROM price_scenarios WHERE category_code = $1',
    [categoryCode]
  );

  let pricePerGram = 0;
  let logMessage = 'Ціна не знайдена';
  const normalizedCalibrated = Number(isCalibrated || 0);

  const activeScenario = scenarios.rows.find((scen) => {
    const rules = asRuleObject(scen.match_json);
    for (const [key, val] of Object.entries(rules)) {
      if (key === 'is_calibrated') {
        if (Number(val) !== normalizedCalibrated) return false;
      } else if (Number(answers[key] ?? -1) !== Number(val)) {
        return false;
      }
    }
    return true;
  });

  if (activeScenario) {
    const xVal = Number(answers[activeScenario.axis_x_key] || 0);
    const yVal = activeScenario.axis_y_key
      ? Number(answers[activeScenario.axis_y_key] || 0)
      : 0;

    const priceRow = await pool.query(
      `SELECT price
       FROM price_matrix
       WHERE scenario_id = $1 AND x_val = $2 AND y_val = $3`,
      [activeScenario.id, xVal, yVal]
    );

    if (priceRow.rows.length > 0) {
      pricePerGram = Number(priceRow.rows[0].price);
      logMessage = `${activeScenario.name} (Базова: $${pricePerGram})`;

      const mods = await pool.query(
        'SELECT * FROM price_modifiers WHERE category_code = $1',
        [categoryCode]
      );
      for (const mod of mods.rows) {
        if (Number(answers[mod.trigger_key] ?? -1) === Number(mod.trigger_val)) {
          pricePerGram *= Number(mod.factor);
          logMessage += ` + Модифікатор (${Math.round((Number(mod.factor) - 1) * 100)}%)`;
        }
      }
    } else {
      logMessage = `${activeScenario.name} (Нема ціни для комбінації)`;
    }
  } else {
    logMessage = 'Немає сценарію для цих параметрів';
  }

  const parsedWeight = Number.parseFloat(weight);
  const weightVal = Number.isFinite(parsedWeight) ? parsedWeight : 0;
  const totalPrice = (pricePerGram * weightVal).toFixed(2);

  let currencyPayload = { uahRate: null, pricePerGramUah: null, totalPriceUah: null };
  try {
    const uahRate = await getUsdUahRate();
    currencyPayload = {
      uahRate,
      pricePerGramUah: (pricePerGram * uahRate).toFixed(2),
      totalPriceUah: (Number(totalPrice) * uahRate).toFixed(2),
    };
  } catch (err) {
    console.error('NBU rate error:', err.message || err);
  }

  return {
    weightVal,
    pricePerGram,
    totalPrice,
    logMessage,
    currencyPayload,
  };
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      full_sku TEXT,
      base_sku TEXT,
      sequence_number INTEGER,
      category TEXT,
      weight REAL,
      total_price REAL,
      price_per_gram REAL,
      details JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS total_price_uah REAL
  `);

  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS uah_rate REAL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      code TEXT PRIMARY KEY,
      name TEXT,
      requires_weight INTEGER DEFAULT 1
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      category_code TEXT REFERENCES categories(code) ON DELETE CASCADE,
      key TEXT,
      label TEXT,
      sku_index INTEGER,
      required INTEGER DEFAULT 1
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS options (
      id SERIAL PRIMARY KEY,
      question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
      value_id INTEGER,
      label TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_scenarios (
      id SERIAL PRIMARY KEY,
      category_code TEXT REFERENCES categories(code) ON DELETE CASCADE,
      name TEXT,
      match_json JSONB,
      axis_x_key TEXT,
      axis_y_key TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_matrix (
      scenario_id INTEGER REFERENCES price_scenarios(id) ON DELETE CASCADE,
      x_val INTEGER NOT NULL,
      y_val INTEGER NOT NULL DEFAULT 0,
      price REAL,
      PRIMARY KEY (scenario_id, x_val, y_val)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_modifiers (
      id SERIAL PRIMARY KEY,
      category_code TEXT REFERENCES categories(code) ON DELETE CASCADE,
      trigger_key TEXT,
      trigger_val INTEGER,
      factor REAL
    )
  `);

  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS required INTEGER DEFAULT 1');
  await pool.query('UPDATE questions SET required = 1 WHERE required IS NULL');

  const { rows } = await pool.query('SELECT count(*)::int AS count FROM categories');
  if (rows[0].count === 0) {
    console.log('Empty DB. Migrating data & prices...');
    await migrateData();
  }

  await pool.query(
    "UPDATE categories SET requires_weight = 0 WHERE code = ANY($1::text[])",
    [['AR', 'DK', 'SK']]
  );
}

async function migrateData() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const [code, cat] of Object.entries(initialConfig.categories)) {
      const reqWeight = code === 'AR' || code === 'DK' || code === 'SK' ? 0 : 1;
      await client.query(
        'INSERT INTO categories (code, name, requires_weight) VALUES ($1, $2, $3)',
        [code, cat.name, reqWeight]
      );

      const questions = initialConfig.questions[code] || [];
      for (const q of questions) {
        const qInsert = await client.query(
          `INSERT INTO questions (category_code, key, label, sku_index, required)
           VALUES ($1, $2, $3, $4, 1)
           RETURNING id`,
          [code, q.id, q.label, q.sku_index]
        );
        const qId = qInsert.rows[0].id;

        for (const opt of q.options) {
          await client.query(
            'INSERT INTO options (question_id, value_id, label) VALUES ($1, $2, $3)',
            [qId, opt.id, opt.label]
          );
        }
      }
    }

    await migratePricesToDb(client);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function migratePricesToDb(client) {
  const { naturalCalibratedPrices, formedPrices } = initialConfig;

  for (const cat of ['CH', 'BR', 'NM', 'KL']) {
    const formedScenario = await client.query(
      `INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key)
       VALUES ($1, 'Формований', $2::jsonb, 'quality', NULL)
       RETURNING id`,
      [cat, JSON.stringify({ raw_type: 2 })]
    );
    const formedScenarioId = formedScenario.rows[0].id;

    for (const [qualityId, price] of Object.entries(formedPrices)) {
      await client.query(
        `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
         VALUES ($1, $2, 0, $3)`,
        [formedScenarioId, Number(qualityId), Number(price)]
      );
    }
  }

  for (const cat of ['CH', 'BR', 'NM', 'KL']) {
    const naturalScenario = await client.query(
      `INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key)
       VALUES ($1, 'Натур. Калібрований', $2::jsonb, 'size', 'texture')
       RETURNING id`,
      [cat, JSON.stringify({ raw_type: 1, is_calibrated: 1 })]
    );
    const naturalScenarioId = naturalScenario.rows[0].id;

    for (const [sizeId, textures] of Object.entries(naturalCalibratedPrices)) {
      for (const [textureId, price] of Object.entries(textures)) {
        await client.query(
          `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
           VALUES ($1, $2, $3, $4)`,
          [naturalScenarioId, Number(sizeId), Number(textureId), Number(price)]
        );
      }
    }

    await client.query(
      `INSERT INTO price_modifiers (category_code, trigger_key, trigger_val, factor)
       VALUES ($1, 'quality', 2, 0.7)`,
      [cat]
    );
  }

  console.log('Prices migrated to DB');
}

app.get('/api/config', async (req, res) => {
  try {
    const config = { categories: {}, questions: {}, extraConfig: initialConfig.extraConfig };

    const categories = await pool.query('SELECT * FROM categories');
    for (const row of categories.rows) {
      config.categories[row.code] = {
        name: row.name,
        code: row.code,
        requires_weight: row.requires_weight,
      };
    }

    const questions = await pool.query(`
      SELECT
        q.id AS q_db_id,
        q.category_code,
        q.key,
        q.label AS q_label,
        q.sku_index,
        q.required,
        o.id AS o_db_id,
        o.value_id,
        o.label AS o_label
      FROM questions q
      LEFT JOIN options o ON q.id = o.question_id
      ORDER BY q.category_code, q.sku_index, o.value_id
    `);

    const tempQuestions = {};
    for (const row of questions.rows) {
      if (!tempQuestions[row.q_db_id]) {
        tempQuestions[row.q_db_id] = {
          q_db_id: row.q_db_id,
          id: row.key,
          label: row.q_label,
          sku_index: row.sku_index,
          required: row.required,
          cat: row.category_code,
          options: [],
        };
      }

      if (row.o_db_id) {
        tempQuestions[row.q_db_id].options.push({
          db_id: row.o_db_id,
          id: row.value_id,
          label: row.o_label,
        });
      }
    }

    for (const q of Object.values(tempQuestions)) {
      if (!config.questions[q.cat]) config.questions[q.cat] = [];
      config.questions[q.cat].push(q);
    }

    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/prices/:catCode', async (req, res) => {
  try {
    const { catCode } = req.params;
    const scenariosResult = await pool.query(
      'SELECT * FROM price_scenarios WHERE category_code = $1 ORDER BY id',
      [catCode]
    );
    const modifiersResult = await pool.query(
      'SELECT * FROM price_modifiers WHERE category_code = $1 ORDER BY id',
      [catCode]
    );

    const scenarioIds = scenariosResult.rows.map((s) => s.id);
    let matrixRows = [];
    if (scenarioIds.length > 0) {
      const matrixResult = await pool.query(
        'SELECT * FROM price_matrix WHERE scenario_id = ANY($1::int[]) ORDER BY scenario_id, x_val, y_val',
        [scenarioIds]
      );
      matrixRows = matrixResult.rows;
    }

    const matrixByScenario = new Map();
    for (const row of matrixRows) {
      if (!matrixByScenario.has(row.scenario_id)) matrixByScenario.set(row.scenario_id, []);
      matrixByScenario.get(row.scenario_id).push(row);
    }

    const scenarios = scenariosResult.rows.map((s) => ({
      ...s,
      matrix: matrixByScenario.get(s.id) || [],
    }));

    res.json({ scenarios, modifiers: modifiersResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/price-cell', async (req, res) => {
  try {
    const { scenario_id, x_val, y_val, price } = req.body;
    await pool.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (scenario_id, x_val, y_val)
       DO UPDATE SET price = EXCLUDED.price`,
      [Number(scenario_id), Number(x_val), Number(y_val || 0), Number(price)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/scenario', async (req, res) => {
  try {
    const { category_code, name, match_json, axis_x_key, axis_y_key } = req.body;
    const payload = typeof match_json === 'string' ? JSON.parse(match_json) : match_json || {};

    const result = await pool.query(
      `INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id`,
      [category_code, name, JSON.stringify(payload), axis_x_key, axis_y_key]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/scenario', async (req, res) => {
  try {
    const { id, name, match_json, axis_x_key, axis_y_key } = req.body;
    if (!id || !name || !axis_x_key) {
      return res.status(400).json({ error: 'Потрібні id, назва та вісь X' });
    }

    const payload = typeof match_json === 'string' ? JSON.parse(match_json) : match_json || {};

    await pool.query(
      `UPDATE price_scenarios
       SET name = $1, match_json = $2::jsonb, axis_x_key = $3, axis_y_key = $4
       WHERE id = $5`,
      [name, JSON.stringify(payload), axis_x_key, axis_y_key || null, Number(id)]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/scenario/duplicate', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Потрібен id сценарію' });

    await client.query('BEGIN');

    const sourceScenario = await client.query(
      'SELECT * FROM price_scenarios WHERE id = $1 LIMIT 1',
      [Number(id)]
    );
    if (sourceScenario.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Сценарій не знайдено' });
    }

    const source = sourceScenario.rows[0];
    const duplicatedScenario = await client.query(
      `INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id`,
      [
        source.category_code,
        `${source.name} (копія)`,
        JSON.stringify(source.match_json || {}),
        source.axis_x_key,
        source.axis_y_key,
      ]
    );

    const newScenarioId = duplicatedScenario.rows[0].id;
    await client.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       SELECT $1, x_val, y_val, price
       FROM price_matrix
       WHERE scenario_id = $2`,
      [Number(newScenarioId), Number(id)]
    );

    await client.query('COMMIT');
    res.json({ success: true, id: newScenarioId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/admin/modifier', async (req, res) => {
  try {
    const { category_code, trigger_key, trigger_val, factor } = req.body;
    const result = await pool.query(
      `INSERT INTO price_modifiers (category_code, trigger_key, trigger_val, factor)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [category_code, trigger_key, Number(trigger_val), Number(factor)]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/modifier', async (req, res) => {
  try {
    const { id, factor } = req.body;
    await pool.query('UPDATE price_modifiers SET factor = $1 WHERE id = $2', [
      Number(factor),
      Number(id),
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/delete-item', async (req, res) => {
  try {
    const { type, id } = req.body;

    if (type === 'category') {
      await pool.query('DELETE FROM categories WHERE code = $1', [id]);
      return res.json({ success: true });
    }
    if (type === 'question') {
      await pool.query('DELETE FROM questions WHERE id = $1', [Number(id)]);
      return res.json({ success: true });
    }
    if (type === 'option') {
      await pool.query('DELETE FROM options WHERE id = $1', [Number(id)]);
      return res.json({ success: true });
    }
    if (type === 'modifier') {
      await pool.query('DELETE FROM price_modifiers WHERE id = $1', [Number(id)]);
      return res.json({ success: true });
    }
    if (type === 'scenario') {
      await pool.query('DELETE FROM price_scenarios WHERE id = $1', [Number(id)]);
      return res.json({ success: true });
    }

    res.status(400).json({ error: 'Некоректний тип' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/preview', async (req, res) => {
  try {
    const { categoryCode, answers = {}, weight, isCalibrated } = req.body;

    const qRows = await pool.query(
      'SELECT key, sku_index FROM questions WHERE category_code = $1 ORDER BY sku_index ASC',
      [categoryCode]
    );

    const skuParts = [categoryCode];
    for (const q of qRows.rows) {
      const val = answers[q.key];
      skuParts.push(val ? val : 0);
    }
    const baseSku = skuParts.join('');
    const pricing = await calculatePricing(categoryCode, answers, weight, isCalibrated);
    const { weightVal, pricePerGram, totalPrice, logMessage, currencyPayload } = pricing;

    const catResult = await pool.query(
      'SELECT requires_weight FROM categories WHERE code = $1',
      [categoryCode]
    );
    const requiresWeight =
      catResult.rows.length > 0 &&
      Number(catResult.rows[0].requires_weight) === 1 &&
      categoryCode !== 'SK';

    if (!requiresWeight) {
      const seqResult = await pool.query(
        `SELECT sequence_number
         FROM products
         WHERE base_sku = $1
         ORDER BY sequence_number DESC
         LIMIT 1`,
        [baseSku]
      );

      const lastSeq =
        seqResult.rows.length > 0 && seqResult.rows[0].sequence_number
          ? Number(seqResult.rows[0].sequence_number)
          : 0;
      const nextSeq = lastSeq + 1;
      const fullProposedSku = baseSku + String(nextSeq).padStart(3, '0');
      const prevFullSku =
        lastSeq > 0 ? baseSku + String(lastSeq).padStart(3, '0') : 'Немає';

      return res.json({
        mode: 'sequence',
        baseSku,
        nextSeq,
        fullProposedSku,
        prevFullSku,
        pricePerGram: pricePerGram.toFixed(2),
        totalPrice,
        logMessage,
        ...currencyPayload,
      });
    }

    const weightInt = Math.round(weightVal);
    const fullProposedSku = baseSku + String(weightInt).padStart(3, '0');
    const existsResult = await pool.query(
      'SELECT full_sku FROM products WHERE full_sku = $1 LIMIT 1',
      [fullProposedSku]
    );

    return res.json({
      mode: 'weight',
      baseSku,
      nextSeq: weightInt,
      fullProposedSku,
      existsInDb: existsResult.rows.length > 0,
      pricePerGram: pricePerGram.toFixed(2),
      totalPrice,
      logMessage,
      ...currencyPayload,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/price-preview', async (req, res) => {
  try {
    const { categoryCode, answers = {}, weight, isCalibrated } = req.body;
    const pricing = await calculatePricing(categoryCode, answers, weight, isCalibrated);
    res.json({
      pricePerGram: pricing.pricePerGram.toFixed(2),
      totalPrice: pricing.totalPrice,
      logMessage: pricing.logMessage,
      ...pricing.currencyPayload,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/decode', async (req, res) => {
  try {
    const { sku } = req.body;
    const decoded = await decodeSku(sku);
    res.json(decoded);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/variation', async (req, res) => {
  try {
    const { sku } = req.body;
    const variation = await getNextVariationSku(sku);
    res.json(variation);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/save', async (req, res) => {
  try {
    const {
      fullSku,
      baseSku,
      nextSeq,
      category,
      weight,
      totalPrice,
      totalPriceUah,
      pricePerGram,
      uahRate,
      details,
    } =
      req.body;
    const result = await pool.query(
      `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price, total_price_uah, price_per_gram, uah_rate, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       RETURNING id`,
      [
        fullSku,
        baseSku,
        Number(nextSeq),
        category,
        Number(weight || 0),
        Number(totalPrice || 0),
        totalPriceUah !== undefined && totalPriceUah !== null ? Number(totalPriceUah) : null,
        Number(pricePerGram || 0),
        uahRate !== undefined && uahRate !== null ? Number(uahRate) : null,
        JSON.stringify(details || {}),
      ]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/category', async (req, res) => {
  try {
    const { code, name, requires_weight } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'Потрібні код і назва' });

    await pool.query(
      'INSERT INTO categories (code, name, requires_weight) VALUES ($1, $2, $3)',
      [code, name, requires_weight !== undefined ? Number(requires_weight) : 1]
    );
    res.json({ id: code, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/category', async (req, res) => {
  try {
    const { code, name, requires_weight } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'Потрібні код і назва' });

    await pool.query(
      'UPDATE categories SET name = $1, requires_weight = $2 WHERE code = $3',
      [name, requires_weight !== undefined ? Number(requires_weight) : 1, code]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/question', async (req, res) => {
  try {
    const { category_code, key, label, sku_index, required } = req.body;
    const result = await pool.query(
      `INSERT INTO questions (category_code, key, label, sku_index, required)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [category_code, key, label, Number(sku_index), required !== undefined ? Number(required) : 1]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/question', async (req, res) => {
  try {
    const { id, label, sku_index, required } = req.body;
    if (!id || label === undefined) {
      return res.status(400).json({ error: 'Потрібні id та назва' });
    }

    await pool.query(
      'UPDATE questions SET label = $1, sku_index = $2, required = $3 WHERE id = $4',
      [label, Number(sku_index), required !== undefined ? Number(required) : 1, Number(id)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/question/update', async (req, res) => {
  try {
    const { id, label, sku_index, required } = req.body;
    if (!id || label === undefined) {
      return res.status(400).json({ error: 'Потрібні id та назва' });
    }

    await pool.query(
      'UPDATE questions SET label = $1, sku_index = $2, required = $3 WHERE id = $4',
      [label, Number(sku_index), required !== undefined ? Number(required) : 1, Number(id)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/option', async (req, res) => {
  try {
    const { question_id, value_id, label } = req.body;
    const result = await pool.query(
      'INSERT INTO options (question_id, value_id, label) VALUES ($1, $2, $3) RETURNING id',
      [Number(question_id), Number(value_id), label]
    );
    res.json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/delete', async (req, res) => {
  try {
    const { skuToDelete } = req.body;
    if (!skuToDelete || skuToDelete.length < 4) {
      return res.status(400).json({ error: 'Некоректний формат' });
    }

    const result = await pool.query('DELETE FROM products WHERE full_sku = $1', [skuToDelete]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Артикул не знайдено.' });
    }

    res.json({ success: true, message: `Артикул ${skuToDelete} успішно видалено.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM products ORDER BY created_at DESC LIMIT 15',
      []
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/csv', async (req, res) => {
  try {
    const { fromSku, toSku } = req.query;
    const exportData = await getExportRows(fromSku, toSku);

    const csv = buildCsv([
      ['sku', 'price_uah'],
      ...exportData.rows.map((row) => [
        row.full_sku,
        row.total_price_uah !== null && row.total_price_uah !== undefined
          ? Number(row.total_price_uah).toFixed(2)
          : '',
      ]),
    ]);

    const suffixPart = exportData.range.toSku
      ? `-${exportData.range.toSku}`
      : '-to-latest';
    const fileName = `amber-export-${exportData.range.fromSku}${suffixPart}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csv);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Server startup failed:', err.message || err);
  process.exit(1);
});
