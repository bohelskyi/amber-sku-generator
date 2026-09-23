const pool = require('../db/pool');
const crypto = require('node:crypto');
const { getProductBySku } = require('./product/product-queries');
const { buildCsv } = require('../utils/csv');
const { toUahNumber } = require('../utils/money');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const { startPhase } = require('../observability/performance-metrics');
const bindingTools = require('./export-templates/snapshot-binding');
const published = require('./export-templates/published-capture');
const previewSigner = bindingTools.makeSigner(require('../config/env').sessionSecret);
const { assertActorStillAuthorized } = require('./access-admin-transaction');
const {
  buildMagentoPayload,
  loadMagentoCatalog,
} = require('./magento-products-v1');

async function getNonSkuQuestionMaps(categoryCodes, queryable = pool) {
  if (!categoryCodes || categoryCodes.length === 0) return new Map();

  const result = await queryable.query(
    `
      SELECT
        q.category_code,
        q.key,
        q.label AS q_label,
        q.sku_index,
        q.display_order,
        q.input_type,
        o.value_id,
        o.label AS o_label
      FROM questions q
      LEFT JOIN options o ON o.question_id = q.id
      WHERE q.category_code = ANY($1::text[])
        AND COALESCE(q.include_in_sku, 1) = 0
      ORDER BY q.category_code, COALESCE(q.display_order, q.sku_index), q.sku_index, q.id, o.value_id
    `,
    [categoryCodes]
  );

  const categoryMap = new Map();
  for (const row of result.rows) {
    if (!categoryMap.has(row.category_code)) categoryMap.set(row.category_code, new Map());
    const questionMap = categoryMap.get(row.category_code);
    if (!questionMap.has(row.key)) {
      questionMap.set(row.key, {
        key: row.key,
        label: row.q_label,
        input_type: row.input_type || 'options',
        optionLabels: new Map(),
      });
    }
    if (row.value_id !== null && row.value_id !== undefined) {
      questionMap.get(row.key).optionLabels.set(Number(row.value_id), row.o_label);
    }
  }

  return categoryMap;
}

function getExportTextValues(productRow, nonSkuQuestionMaps) {
  const categoryCode = String(productRow.category || '');
  const details = productRow.details && typeof productRow.details === 'object' ? productRow.details : {};
  const answers = details.answers && typeof details.answers === 'object' ? details.answers : {};
  const questionMap = nonSkuQuestionMaps.get(categoryCode);
  if (!questionMap || questionMap.size === 0) return {};

  const values = {};
  for (const question of questionMap.values()) {
    if (question.input_type !== 'text') continue;
    const rawValue = answers[question.key];
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    values[question.key] = String(rawValue);
  }
  return values;
}

function collectExportTextColumns(rows, nonSkuQuestionMaps) {
  const seen = new Set();
  const columns = [];

  for (const row of rows) {
    const categoryCode = String(row.category || '');
    const questionMap = nonSkuQuestionMaps.get(categoryCode);
    if (!questionMap || questionMap.size === 0) continue;

    for (const question of questionMap.values()) {
      if (question.input_type !== 'text') continue;
      if (seen.has(question.key)) continue;
      seen.add(question.key);
      columns.push({
        key: question.key,
        label: question.label || question.key,
      });
    }
  }

  return columns;
}

function getExportSizeValue(productRow, nonSkuQuestionMaps) {
  const categoryCode = String(productRow.category || '');
  if (!['BR', 'NM'].includes(categoryCode)) return '';

  const details = productRow.details && typeof productRow.details === 'object' ? productRow.details : {};
  const answers = details.answers && typeof details.answers === 'object' ? details.answers : {};
  const questionMap = nonSkuQuestionMaps.get(categoryCode);
  if (!questionMap || questionMap.size === 0) return '';

  const allQuestions = Array.from(questionMap.values());
  const sizeQuestions = allQuestions.filter(
    (question) =>
      /size/i.test(String(question.key || '')) ||
      /розмір/i.test(String(question.label || ''))
  );
  const targetQuestions = sizeQuestions.length > 0 ? sizeQuestions : allQuestions;

  const labels = [];
  for (const question of targetQuestions) {
    const rawValue = answers[question.key];
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const numericValue = Number(rawValue);
    const valueKey = Number.isNaN(numericValue) ? rawValue : numericValue;
    const optionLabel = question.optionLabels.get(valueKey);
    labels.push(optionLabel || String(rawValue));
  }

  return labels.join(' / ');
}

async function getExportRows(fromSku, toSku, options = {}) {
  const queryable = options.queryable || pool;
  const lockProducts = Boolean(options.lockProducts);
  const normalizedFromSku = String(fromSku || '').trim().toUpperCase();
  const normalizedToSku = String(toSku || '').trim().toUpperCase();

  if (!normalizedFromSku) {
    throw new Error('Потрібно вказати артикул, з якого починати експорт');
  }

  const fromProduct = await getProductBySku(queryable, normalizedFromSku);
  if (!fromProduct) {
    throw new Error(`Артикул ${normalizedFromSku} не знайдено`);
  }

  let toProduct = null;
  if (normalizedToSku) {
    toProduct = await getProductBySku(queryable, normalizedToSku);
    if (!toProduct) {
      throw new Error(`Артикул ${normalizedToSku} не знайдено`);
    }
  }

  const idFrom = Number(fromProduct.id);
  const idTo = toProduct ? Number(toProduct.id) : null;
  const startId = idTo !== null ? Math.min(idFrom, idTo) : idFrom;
  const endId = idTo !== null ? Math.max(idFrom, idTo) : null;

  const params = [startId];
  const rangeClauses = ['p.id >= $1'];
  if (endId !== null) {
    params.push(endId);
    rangeClauses.push(`p.id <= $${params.length}`);
  }
  const inRequestedRangeSql = `(${rangeClauses.join(' AND ')})`;
  const result = await queryable.query(
    `
      SELECT p.id, p.full_sku, p.category, p.weight, p.total_price_uah,
             p.details, p.created_at, p.magento_name_subject_ua,
             p.magento_name_subject_en,
             ${options.templateInputs ? 'p.sku_schema_version_id, p.exclude_from_export,' : ''}
             ${inRequestedRangeSql} AS in_requested_range
      FROM products p
      WHERE COALESCE(p.exclude_from_export, 0) = 0
        AND ${inRequestedRangeSql}
      ORDER BY p.id ASC
      ${lockProducts ? 'FOR SHARE OF p' : ''}
    `,
    params
  );

  const finishShaping = startPhase('export.shaping');
  const categoryCodes = Array.from(
    new Set(result.rows.map((row) => String(row.category || '').trim()).filter((code) => code))
  );
  const nonSkuQuestionMaps = await getNonSkuQuestionMaps(categoryCodes, queryable);
  const textColumns = collectExportTextColumns(result.rows, nonSkuQuestionMaps);
  const rowsWithSize = result.rows.map((row) => ({
    ...row,
    export_size: getExportSizeValue(row, nonSkuQuestionMaps),
    export_text_values: getExportTextValues(row, nonSkuQuestionMaps),
  }));
  finishShaping();

  const requestedRangeRows = rowsWithSize.filter((row) => row.in_requested_range);
  const lastRequestedRangeRow = requestedRangeRows[requestedRangeRows.length - 1] || null;
  return {
    rows: rowsWithSize,
    textColumns,
    ...(options.templateInputs ? { internalCatalog: [...nonSkuQuestionMaps].map(([category, questions]) =>
      [category, [...questions].map(([key, question]) => [key, { ...question, optionLabels: [...question.optionLabels] }])]) } : {}),
    range: {
      fromSku: fromProduct.full_sku,
      toSku: toProduct ? toProduct.full_sku : null,
      resolvedToSku: lastRequestedRangeRow?.full_sku || fromProduct.full_sku,
      exportedToProductId: lastRequestedRangeRow ? Number(lastRequestedRangeRow.id) : 0,
    },
  };
}

async function establishProductSnapshotExposure(client, productRows) {
  const productIds = productRows.map((row) => Number(row.id)).sort((a, b) => a - b);
  if (productIds.length === 0) return [];
  await client.query(
    `INSERT INTO product_export_revisions
       (product_id, revision, confirmed_revision, changed_at, has_product_snapshot)
     SELECT product_id, 0, 0, CURRENT_TIMESTAMP, TRUE
     FROM unnest($1::int[]) AS product_id
     ON CONFLICT (product_id) DO NOTHING`,
    [productIds]
  );
  const revisions = await client.query(
    `SELECT product_id, revision, has_product_snapshot
     FROM product_export_revisions
     WHERE product_id = ANY($1::int[])
     ORDER BY product_id
     FOR UPDATE`,
    [productIds]
  );
  const captured = revisions.rows
    .filter((row) => row.has_product_snapshot === false && Number(row.revision) > 0)
    .map((row) => ({ productId: Number(row.product_id), revision: Number(row.revision) }));
  await client.query(
    `UPDATE product_export_revisions
     SET has_product_snapshot = TRUE
     WHERE product_id = ANY($1::int[])
       AND has_product_snapshot = FALSE`,
    [productIds]
  );
  return captured;
}

function buildExportCsv(exportData) {
  const finishCsv = startPhase('export.csv');
  const textHeaders = exportData.textColumns.map((column) => column.key);
  const csv = buildCsv([
    ['sku', 'price_uah', 'size', ...textHeaders],
    ...exportData.rows.map((row) => [
      row.full_sku,
      row.total_price_uah !== null && row.total_price_uah !== undefined
        ? toUahNumber(row.total_price_uah)
        : '',
      row.export_size || '',
      ...exportData.textColumns.map((column) => row.export_text_values?.[column.key] || ''),
    ]),
  ]);
  finishCsv();
  return csv;
}

function assertSnapshotMatchesRequest(snapshot, fromSku, toSku) {
  const normalizedFromSku = String(fromSku || '').trim().toUpperCase();
  const normalizedToSku = String(toSku || '').trim().toUpperCase() || null;
  const snapshotToSku = snapshot.to_sku ? String(snapshot.to_sku).trim().toUpperCase() : null;
  if (String(snapshot.from_sku || '').trim().toUpperCase() !== normalizedFromSku
      || snapshotToSku !== normalizedToSku) {
    const error = new Error(
      'Цей Idempotency-Key вже використано для іншого діапазону експорту.'
    );
    error.statusCode = 409;
    throw error;
  }
  return snapshot;
}

function staleNewRangeError() {
  const error = new Error('Список нових товарів змінився. Перевірте його ще раз.');
  error.statusCode = 409;
  error.publicCode = 'NEW_EXPORT_RANGE_STALE';
  return error;
}

async function getConfirmedExportCursor(queryable, lock = false) {
  const result = await queryable.query(
    `SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE
     ${lock ? 'FOR SHARE' : ''}`
  );
  return Number(result.rows[0]?.exported_to_product_id || 0);
}

async function resolveNewExportRange(queryable) {
  const cursor = await getConfirmedExportCursor(queryable);
  const result = await queryable.query(
    `SELECT MIN(id)::int AS first_id, MAX(id)::int AS last_id,
            count(*)::int AS product_count
     FROM products
     WHERE id > $1 AND COALESCE(exclude_from_export, 0) = 0`,
    [cursor]
  );
  const { first_id: firstId, last_id: lastId, product_count: productCount } = result.rows[0];
  if (!productCount) return { cursor, fromSku: null, toSku: null, productCount: 0 };
  const anchors = await queryable.query(
    'SELECT id, full_sku FROM products WHERE id = ANY($1::int[])',
    [[firstId, lastId]]
  );
  const byId = new Map(anchors.rows.map((row) => [Number(row.id), row.full_sku]));
  return { cursor, fromSku: byId.get(firstId), toSku: byId.get(lastId), productCount };
}

async function createExportSnapshot(input, options = {}) {
  let { fromSku, toSku } = input;
  const { idempotencyKey, profile, mode } = input;
  const contract = bindingTools.requestContract(input);
  const template = contract === 'template-v1';
  const intent = template ? bindingTools.normalizeIntent(input, { allowInternalProfile: true }) : null;
  const database = options.databasePool || pool;
  const mutationContext = createMutationContext(options.mutationContext);
  const requestedProfile = profile || 'magento-products-v1';
  if (!['magento-products-v1', 'internal-legacy'].includes(requestedProfile)) {
    const error = new Error('Невідомий профіль експорту.');
    error.statusCode = 422;
    throw error;
  }
  if (!template && mode && mode !== 'new') {
    const error = new Error('Невідомий режим вибору товарів для експорту.');
    error.statusCode = 422;
    throw error;
  }
  if (!template && mode === 'new' && (requestedProfile !== 'magento-products-v1' || !fromSku || !toSku)) {
    const error = new Error('Спочатку перевірте нові товари для Magento.');
    error.statusCode = 422;
    throw error;
  }
  const key = String(idempotencyKey || '').trim();
  if (!key || key.length > 200) {
    const error = new Error('Потрібен коректний Idempotency-Key для створення export snapshot.');
    error.statusCode = 400;
    throw error;
  }
  if (template) await assertActorStillAuthorized(database, mutationContext.actorUserId, 'exports.create', bindingTools.error);
  // Authenticity applies to completed retries too, but freshness applies only to new work.
  const suppliedBinding = template && input.previewToken !== undefined
    ? previewSigner.verify(input.previewToken, { completed: true }) : null;
  async function match(snapshot, queryable = database) {
    if (template) return bindingTools.assertCompleted(snapshot, intent, suppliedBinding);
    if (snapshot.request_contract === 'template-v1') throw bindingTools.conflict();
    assertSnapshotMatchesRequest(snapshot, fromSku, toSku);
    await assertSnapshotProfile(snapshot, requestedProfile, queryable);
    return snapshot;
  }
  const lookup = async (queryable) => (await queryable.query(
    'SELECT * FROM export_snapshots WHERE idempotency_key = $1', [key]
  )).rows[0];
  const existing = await database.query(
    'SELECT * FROM export_snapshots WHERE idempotency_key = $1',
    [key]
  );
  if (existing.rows[0]) {
    return match(existing.rows[0]);
  }
  if (template && requestedProfile !== 'magento-products-v1') {
    throw bindingTools.error(422, 'EXPORT_PROFILE_INVALID', 'Template exports require magento-products-v1');
  }

  const client = await database.connect();
  let authorityProtected = false;
  try {
    if (template) {
      await published.protectAuthority(client, mutationContext.actorUserId, 'exports.create');
      authorityProtected = true;
    }
    await client.query(template ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
    let resolved = null;
    let binding = null;
    if (template) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['amber:export-snapshot:v1', key]);
      const second = await lookup(client);
      if (second) {
        const found = await match(second, client);
        await client.query('COMMIT');
        return found;
      }
      previewSigner.verify(input.previewToken);
      if (bindingTools.fingerprint(suppliedBinding.intent) !== bindingTools.fingerprint(intent)) throw bindingTools.stale();
      resolved = await published.resolvePublished(client, intent, mutationContext.actorUserId,
        { lock: true, expected: suppliedBinding.effective });
    }
    let newRange = null;
    if (mode === 'new') {
      newRange = await resolveNewExportRange(client);
      if (template) {
        // Caller intent remains unchanged; server-resolved anchors belong to capture.
        if ((intent.fromSku && intent.fromSku !== newRange.fromSku)
          || (intent.toSku && intent.toSku !== newRange.toSku)) throw bindingTools.stale();
        fromSku = newRange.fromSku;
        toSku = newRange.toSku;
      }
      if (!newRange.productCount
          || newRange.fromSku !== String(fromSku).trim().toUpperCase()
          || newRange.toSku !== String(toSku).trim().toUpperCase()) {
        throw staleNewRangeError();
      }
    }
    let exportData;
    try {
      exportData = await getExportRows(fromSku, toSku, {
        queryable: client, lockProducts: true, templateInputs: template,
      });
    } catch (cause) {
      if (template && !cause.code && !cause.statusCode) throw bindingTools.stale();
      throw cause;
    }
    if (newRange && exportData.rows.length !== newRange.productCount) {
      throw staleNewRangeError();
    }
    const catalog = !template && requestedProfile === 'magento-products-v1'
      ? await loadMagentoCatalog(client) : null;
    let magento = catalog
      ? buildMagentoPayload(exportData.rows, catalog) : { errors: [], artifacts: [] };
    if (template) {
      ({ binding, magento } = await published.capturePublished(client, intent, resolved, exportData, newRange));
      if (bindingTools.fingerprint(binding) !== bindingTools.fingerprint(suppliedBinding)) throw bindingTools.stale();
    }
    if (requestedProfile === 'magento-products-v1' && exportData.rows.length === 0) {
      const error = new Error('У діапазоні немає товарів для Magento.');
      error.statusCode = 422;
      throw error;
    }
    if (magento.errors.length) {
      const error = new Error('У діапазоні є товари, не готові до Magento.');
      error.statusCode = 422;
      error.publicCode = 'MAGENTO_NOT_READY';
      error.details = magento.errors;
      throw error;
    }
    const exposureRevisions = await establishProductSnapshotExposure(client, exportData.rows);
    if (newRange && await getConfirmedExportCursor(client, true) !== newRange.cursor) {
      throw staleNewRangeError();
    }
    const suffixPart = exportData.range.toSku ? `-${exportData.range.toSku}` : '-to-latest';
    const fileName = `amber-export-${exportData.range.fromSku}${suffixPart}.csv`;
    const exportedToProductId = exportData.range.exportedToProductId;
    const result = await client.query(
      `INSERT INTO export_snapshots
       (id, idempotency_key, from_sku, to_sku, resolved_to_sku,
        exported_to_product_id, row_count, file_name, csv_content, created_by_user_id,
        reexport_revisions, request_contract, template_id, template_version_id,
        template_definition_hash, template_evaluator_version, template_output_contract,
        template_format_version, request_intent, input_fingerprint, binding_evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
         $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21::jsonb)
       RETURNING *`,
      [
        crypto.randomUUID(),
        key,
        exportData.range.fromSku,
        exportData.range.toSku,
        exportData.range.resolvedToSku,
        exportedToProductId,
        exportData.rows.length,
        fileName,
        buildExportCsv(exportData),
        mutationContext.actorUserId,
        JSON.stringify(exposureRevisions),
        contract, binding?.effective.templateId || null, binding?.effective.versionId || null,
        binding?.effective.definitionHash || null, binding?.effective.evaluatorVersion || null,
        binding?.effective.outputContract || null, binding?.effective.formatVersion || null,
        intent ? JSON.stringify(intent) : null, binding?.inputFingerprint || null,
        binding ? JSON.stringify(binding) : null,
      ]
    );
    const snapshot = result.rows[0];
    for (const artifact of magento.artifacts) {
      await client.query(
        `INSERT INTO magento_export_artifacts
         (snapshot_id, profile_version, group_code, file_name, csv_content,
          product_count, row_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [snapshot.id, artifact.profileVersion, artifact.groupCode,
          artifact.fileName, artifact.csvContent, artifact.productCount, artifact.rowCount]
      );
    }
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'export_snapshot.created',
      subjectType: 'export_snapshot',
      subjectId: snapshot.id,
      details: {
        fromSku: snapshot.from_sku,
        toSku: snapshot.to_sku,
        rowCount: Number(snapshot.row_count),
        ...(template ? { requestContract: contract, templateId: binding.effective.templateId,
          templateVersionId: binding.effective.versionId } : {}),
      },
    });
    await client.query('COMMIT');
    return snapshot;
  } catch (error) {
    await client.query('ROLLBACK');
    const keyConflict = error?.code === '23505' && error.constraint === 'export_snapshots_idempotency_key_key';
    if (keyConflict || (template && (error.code === '40001'
      || ['EXPORT_PREVIEW_STALE', 'EXPORT_PREVIEW_EXPIRED', 'EXPORT_PREVIEW_REQUIRED', 'TEMPLATE_SOURCE_INVALID'].includes(error.code)
      || error.publicCode === 'NEW_EXPORT_RANGE_STALE'))) {
      // This connection is now outside its aborted/old RR transaction. A new
      // statement sees a committed winner even when the advisory wait did not.
      const winner = await lookup(client);
      if (winner) return await match(winner, client);
    }
    if (template && (error.code === '40001' || error.publicCode === 'NEW_EXPORT_RANGE_STALE')) throw bindingTools.stale();
    throw error;
  } finally {
    try { if (authorityProtected) await published.releaseAuthority(client); }
    finally { client.release(); }
  }
}

async function assertSnapshotProfile(snapshot, requestedProfile, queryable = pool) {
  const artifacts = await queryable.query('SELECT 1 FROM magento_export_artifacts WHERE snapshot_id = $1 LIMIT 1', [snapshot.id]);
  const hasMagento = artifacts.rows.length > 0;
  if (hasMagento !== (requestedProfile === 'magento-products-v1')) {
    const error = new Error('Цей Idempotency-Key належить іншому профілю знімка.');
    error.statusCode = 409;
    throw error;
  }
}

async function previewExport(input, options = {}) {
  const { fromSku, toSku, mode } = input;
  const template = bindingTools.requestContract(input) === 'template-v1';
  const intent = template ? bindingTools.normalizeIntent(input) : null;
  const actor = template ? createMutationContext(options.mutationContext).actorUserId : null;
  const client = await (options.databasePool || pool).connect();
  let authorityProtected = false;
  try {
    if (template) {
      await published.protectAuthority(client, actor, 'exports.view');
      authorityProtected = true;
    }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (!template && mode && mode !== 'new') {
      const error = new Error('Невідомий режим вибору товарів для експорту.');
      error.statusCode = 422;
      throw error;
    }
    const resolved = template ? await published.resolvePublished(client, intent, actor) : null;
    const newRange = mode === 'new' ? await resolveNewExportRange(client) : null;
    if (newRange && !newRange.productCount) {
      await client.query('COMMIT');
      return { mode: 'new', range: null, representedCount: 0,
        readyCount: 0, errors: [], artifacts: [],
        ...(template ? { requestContract: 'template-v1', intent, template: resolved.effective, previewToken: null } : {}) };
    }
    if (template && newRange && ((intent.fromSku && intent.fromSku !== newRange.fromSku)
      || (intent.toSku && intent.toSku !== newRange.toSku))) throw bindingTools.stale();
    const exportData = await getExportRows(
      newRange?.fromSku || fromSku,
      newRange?.toSku || toSku,
      { queryable: client, templateInputs: template }
    );
    const captured = template ? await published.capturePublished(client, intent, resolved, exportData, newRange) : null;
    const magento = captured ? captured.magento : buildMagentoPayload(exportData.rows, await loadMagentoCatalog(client));
    await client.query('COMMIT');
    return {
      mode: mode || 'manual',
      range: exportData.range,
      representedCount: magento.representedCount,
      readyCount: magento.readyCount,
      errors: magento.errors,
      ...(template ? { requestContract: 'template-v1', intent, template: resolved.effective,
        previewToken: magento.errors.length || !magento.representedCount ? null : previewSigner.sign(captured.binding),
        represented: magento.represented } : {}),
      artifacts: (magento.provisionalArtifacts || magento.artifacts).map((item) => ({
        groupCode: item.groupCode,
        groupName: item.groupName,
        profileVersion: item.profileVersion,
        fileName: item.fileName,
        productCount: item.productCount,
        rowCount: item.rowCount,
      })),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    try { if (authorityProtected) await published.releaseAuthority(client); }
    finally { client.release(); }
  }
}

async function getMagentoArtifacts(snapshotId) {
  await getExportSnapshot(snapshotId);
  const result = await pool.query(
    `SELECT snapshot_id, profile_version, group_code, file_name,
            product_count, row_count
     FROM magento_export_artifacts WHERE snapshot_id = $1
     ORDER BY CASE group_code WHEN 'BR' THEN 1 WHEN 'NM' THEN 2
       WHEN 'KL' THEN 3 WHEN 'CH' THEN 4 WHEN 'AR' THEN 5 ELSE 6 END`,
    [snapshotId]
  );
  return result.rows.map((row) => ({
    groupCode: row.group_code,
    profileVersion: row.profile_version,
    fileName: row.file_name,
    productCount: Number(row.product_count),
    rowCount: Number(row.row_count),
  }));
}

async function getMagentoArtifact(snapshotId, groupCode) {
  const group = String(groupCode || '').toUpperCase();
  if (!['BR', 'NM', 'KL', 'CH', 'AR', 'SV'].includes(group)) {
    const error = new Error('Невідома Magento-група.');
    error.statusCode = 404;
    throw error;
  }
  const result = await pool.query(
    `SELECT * FROM magento_export_artifacts
     WHERE snapshot_id = $1 AND group_code = $2
       AND profile_version = 'magento-products-v1'`,
    [snapshotId, group]
  );
  if (!result.rows[0]) {
    const error = new Error('Magento artifact не знайдено.');
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

async function getExportSnapshot(snapshotId) {
  const result = await pool.query('SELECT * FROM export_snapshots WHERE id = $1', [snapshotId]);
  if (!result.rows[0]) {
    const error = new Error('Export snapshot не знайдено.');
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

async function confirmExportSnapshot(snapshotId, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await (options.databasePool || pool).connect();
  try {
    await client.query('BEGIN');
    const snapshotResult = await client.query(
      'SELECT * FROM export_snapshots WHERE id = $1 FOR UPDATE',
      [snapshotId]
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) {
      const error = new Error('Export snapshot не знайдено.');
      error.statusCode = 404;
      throw error;
    }
    if (snapshot.status !== 'confirmed') {
      await client.query(
        `UPDATE export_snapshots
         SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP,
             confirmed_by_user_id = $2
         WHERE id = $1`,
        [snapshotId, mutationContext.actorUserId]
      );
      await writeAuditEvent(client, {
        mutationContext,
        eventKey: 'export_snapshot.confirmed',
        subjectType: 'export_snapshot',
        subjectId: snapshotId,
        details: { exportedToProductId: Number(snapshot.exported_to_product_id) },
      });
    }
    const representedReexports = Array.isArray(snapshot.reexport_revisions)
      ? snapshot.reexport_revisions
        .map((item) => ({
          productId: Number(item?.productId),
          revision: Number(item?.revision),
        }))
        .filter((item) => Number.isSafeInteger(item.productId) && item.productId > 0
          && Number.isSafeInteger(item.revision) && item.revision > 0)
        .sort((first, second) => first.productId - second.productId)
      : [];
    if (representedReexports.length > 0) {
      const productIds = representedReexports.map((item) => item.productId);
      await client.query(
        `SELECT product_id
         FROM product_export_revisions
         WHERE product_id = ANY($1::int[])
         ORDER BY product_id
         FOR UPDATE`,
        [productIds]
      );
      await client.query(
        `UPDATE product_export_revisions revisions
         SET confirmed_revision = GREATEST(
               revisions.confirmed_revision,
               represented.revision
             )
         FROM jsonb_to_recordset($1::jsonb)
           AS represented("productId" integer, revision bigint)
         WHERE revisions.product_id = represented."productId"
           AND represented.revision <= revisions.revision`,
        [JSON.stringify(representedReexports)]
      );
    }
    await client.query(
      `INSERT INTO export_state
       (singleton, exported_to_product_id, last_snapshot_id, updated_at)
       VALUES (TRUE, $1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (singleton) DO UPDATE
       SET exported_to_product_id = GREATEST(
             export_state.exported_to_product_id,
             EXCLUDED.exported_to_product_id
           ),
           last_snapshot_id = CASE
             WHEN EXCLUDED.exported_to_product_id >= export_state.exported_to_product_id
             THEN EXCLUDED.last_snapshot_id
             ELSE export_state.last_snapshot_id
           END,
           updated_at = CURRENT_TIMESTAMP`,
      [Number(snapshot.exported_to_product_id), snapshotId]
    );
    await client.query('COMMIT');
    return { success: true, snapshotId, status: 'confirmed' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getExportStatus() {
  const lastExportResult = await pool.query(
    `
      SELECT COALESCE(s.id, 'legacy-' || e.id::text) AS id,
             COALESCE(s.from_sku, e.from_sku) AS from_sku,
             COALESCE(s.to_sku, e.to_sku) AS to_sku,
             COALESCE(s.resolved_to_sku, e.resolved_to_sku) AS resolved_to_sku,
             st.exported_to_product_id,
             COALESCE(s.row_count, e.row_count, 0) AS row_count,
             COALESCE(s.confirmed_at, e.created_at) AS created_at
      FROM export_state st
      LEFT JOIN export_snapshots s ON s.id = st.last_snapshot_id
      LEFT JOIN LATERAL (
        SELECT * FROM export_events
        WHERE exported_to_product_id <= st.exported_to_product_id
        ORDER BY exported_to_product_id DESC, id DESC
        LIMIT 1
      ) e ON TRUE
      WHERE st.singleton = TRUE AND st.exported_to_product_id > 0
      LIMIT 1
    `
  );
  const totalsResult = await pool.query(
    `SELECT
       count(*)::int AS total_count,
       COALESCE(MAX(id), 0)::int AS max_id,
       count(*) FILTER (WHERE COALESCE(exclude_from_export, 0) = 0)::int AS exportable_count,
       COALESCE(MAX(id) FILTER (WHERE COALESCE(exclude_from_export, 0) = 0), 0)::int AS exportable_max_id
     FROM products`
  );

  const totalCount = Number(totalsResult.rows[0]?.total_count || 0);
  const latestProductId = Number(totalsResult.rows[0]?.max_id || 0);
  const exportableCount = Number(totalsResult.rows[0]?.exportable_count || 0);
  const latestExportableProductId = Number(totalsResult.rows[0]?.exportable_max_id || 0);
  if (lastExportResult.rows.length === 0) {
    return {
      hasExport: false,
      totalProducts: totalCount,
      exportableProducts: exportableCount,
      countSinceLastExport: exportableCount,
      latestProductId,
      latestExportableProductId,
      lastExport: null,
    };
  }

  const lastExport = lastExportResult.rows[0];
  const exportedToId = Number(lastExport.exported_to_product_id || 0);
  const sinceResult = await pool.query(
    'SELECT count(*)::int AS count FROM products WHERE id > $1 AND COALESCE(exclude_from_export, 0) = 0',
    [exportedToId]
  );

  return {
    hasExport: true,
    totalProducts: totalCount,
    exportableProducts: exportableCount,
    countSinceLastExport: Number(sinceResult.rows[0]?.count || 0),
    latestProductId,
    latestExportableProductId,
    lastExport: {
      id: String(lastExport.id),
      fromSku: lastExport.from_sku,
      toSku: lastExport.to_sku,
      resolvedToSku: lastExport.resolved_to_sku,
      exportedToProductId: exportedToId,
      rowCount: Number(lastExport.row_count || 0),
      createdAt: lastExport.created_at,
    },
  };
}

async function recordExportEvent(exportData) {
  const exportedToProductId =
    exportData.rows.length > 0 ? Number(exportData.rows[exportData.rows.length - 1].id) : 0;

  await pool.query(
    `
      INSERT INTO export_events (from_sku, to_sku, resolved_to_sku, exported_to_product_id, row_count)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [
      exportData.range.fromSku,
      exportData.range.toSku,
      exportData.range.resolvedToSku,
      exportedToProductId,
      exportData.rows.length,
    ]
  );
}

module.exports = {
  buildExportCsv,
  confirmExportSnapshot,
  createExportSnapshot,
  getExportSnapshot,
  getExportRows,
  getExportStatus,
  getMagentoArtifact,
  getMagentoArtifacts,
  previewExport,
  recordExportEvent,
};
