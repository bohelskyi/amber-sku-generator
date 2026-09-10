const pool = require('../db/pool');
const { getAnswerChanges } = require('../utils/answer-changes');
const { asRuleObject, isRuleMatched } = require('../utils/rules');
const { toUahNumber } = require('../utils/money');

const MAX_SKU_LENGTH = 256;
const CALIBRATION_STATES = new Map([
  [0, 'Некалібрована'],
  [1, 'Калібрована'],
  [2, 'Напівкалібрована'],
]);

function timelineError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeTimelineSku(value) {
  const sku = String(value || '').trim().toUpperCase();
  if (!sku || sku.length > MAX_SKU_LENGTH) {
    throw timelineError('Вкажіть коректний артикул.', 400, 'INVALID_SKU');
  }
  return sku;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameValue(first, second) {
  if (first === null || first === undefined || first === '') {
    return second === null || second === undefined || second === '';
  }
  if (second === null || second === undefined || second === '') return false;
  const firstNumber = Number(first);
  const secondNumber = Number(second);
  if (Number.isFinite(firstNumber) && Number.isFinite(secondNumber)) {
    return firstNumber === secondNumber;
  }
  return String(first) === String(second);
}

function buildSchemaMap(rows) {
  const schemas = new Map();
  for (const row of rows) {
    const schemaId = Number(row.schema_version_id);
    if (!schemas.has(schemaId)) schemas.set(schemaId, new Map());
    const questions = schemas.get(schemaId);
    if (!questions.has(row.question_key)) {
      questions.set(row.question_key, {
        key: row.question_key,
        label: row.question_label,
        options: [],
      });
    }
    if (row.option_id !== null && row.option_id !== undefined) {
      questions.get(row.question_key).options.push({
        value: row.value_id,
        label: row.option_label,
        visibleIf: row.visible_if_json,
        hiddenIf: row.hidden_if_json,
      });
    }
  }
  return schemas;
}

function findSchemaOption(question, value, answers) {
  if (!question) return null;
  const candidates = question.options.filter((option) => sameValue(option.value, value));
  return candidates.find((option) => (
    option.visibleIf
    && isRuleMatched(asRuleObject(option.visibleIf), answers)
    && !(option.hiddenIf && isRuleMatched(asRuleObject(option.hiddenIf), answers))
  )) || candidates.find((option) => !option.visibleIf && !option.hiddenIf) || candidates[0] || null;
}

function getDecodedAnswer(payload, key, value) {
  return (Array.isArray(payload?.decodedAnswers) ? payload.decodedAnswers : [])
    .find((answer) => answer.key === key && sameValue(answer.value_id, value)) || null;
}

function normalizeValue(value, payload, schema, key) {
  if (value === null || value === undefined || value === '') {
    return { value: null, label: null };
  }
  const historical = getDecodedAnswer(payload, key, value);
  if (historical?.value_label) {
    return { value, label: historical.value_label };
  }
  const answers = asObject(payload?.answers);
  const option = findSchemaOption(schema?.get(key), value, answers);
  if (option?.label) return { value, label: option.label };
  if (key === 'is_calibrated' && CALIBRATION_STATES.has(Number(value))) {
    return { value, label: CALIBRATION_STATES.get(Number(value)) };
  }
  if (Number(value) === 0) return { value, label: 'Не вказано' };
  return { value, label: null };
}

function getPayloadSchema(schemas, payload, fallbackSchemaId) {
  const payloadSchemaId = nullableNumber(payload?.skuSchemaVersionId);
  return schemas.get(payloadSchemaId) || schemas.get(nullableNumber(fallbackSchemaId));
}

function normalizeStoredChanges({
  oldPayload,
  newPayload,
  oldSchema,
  newSchema,
  storedChanges,
}) {
  const oldAnswers = asObject(oldPayload?.answers);
  const newAnswers = asObject(newPayload?.answers);
  const answerChanges = Array.isArray(storedChanges)
    ? storedChanges.filter((change) => change?.key && change.key !== 'weight')
    : getAnswerChanges(oldAnswers, newAnswers);
  const changes = answerChanges.map((change) => {
    const key = String(change.key);
    const historical = getDecodedAnswer(oldPayload, key, change.from);
    const question = oldSchema?.get(key) || newSchema?.get(key);
    const fieldLabel = question?.label || (key === 'is_calibrated' ? 'Калібрування' : null);
    return {
      kind: 'answer',
      fieldKey: key,
      fieldLabel: historical?.label || fieldLabel,
      before: normalizeValue(change.from, oldPayload, oldSchema, key),
      after: normalizeValue(change.to, newPayload, newSchema, key),
      labelStatus: historical?.label || question?.label
        ? 'historical_schema'
        : fieldLabel ? 'stable_domain' : 'not_recorded',
    };
  });
  const storedWeight = Array.isArray(storedChanges)
    ? storedChanges.find((change) => change?.key === 'weight')
    : null;
  const oldWeight = storedWeight ? storedWeight.from : oldPayload?.weight;
  const newWeight = storedWeight ? storedWeight.to : newPayload?.weight;
  if (storedWeight || !sameValue(oldWeight, newWeight)) {
    changes.push({
      kind: 'weight',
      fieldKey: 'weight',
      fieldLabel: null,
      before: { value: nullableNumber(oldWeight), label: null },
      after: { value: nullableNumber(newWeight), label: null },
      labelStatus: 'not_applicable',
    });
  }
  return changes;
}

function actorFromAudit(audit, fallbackActorId) {
  if (audit) {
    const snapshot = asObject(audit.actor_snapshot);
    return {
      status: 'recorded',
      displayName: snapshot.displayName || null,
      preferredUsername: snapshot.preferredUsername || null,
      source: 'audit_snapshot',
    };
  }
  if (fallbackActorId !== null && fallbackActorId !== undefined) {
    return {
      status: 'recorded_reference',
      displayName: null,
      preferredUsername: null,
      source: 'domain_reference',
    };
  }
  return {
    status: 'not_recorded',
    displayName: null,
    preferredUsername: null,
    source: 'none',
  };
}

function eventTimestamp(value) {
  return value
    ? { occurredAt: value, timestampStatus: 'recorded' }
    : { occurredAt: null, timestampStatus: 'not_recorded' };
}

function eventSort(first, second) {
  if (first.occurredAt && second.occurredAt) {
    const difference = new Date(first.occurredAt).getTime() - new Date(second.occurredAt).getTime();
    if (difference) return difference;
  } else if (first.occurredAt) {
    return -1;
  } else if (second.occurredAt) {
    return 1;
  }
  if (first.sortOrder !== second.sortOrder) return first.sortOrder - second.sortOrder;
  return first.sourceOrder - second.sourceOrder;
}

function addGraphEdge(edgeMap, sourceId, correctedId, evidence, correctionId = null) {
  if (!sourceId || !correctedId) return;
  const key = `${sourceId}:${correctedId}`;
  if (!edgeMap.has(key)) {
    edgeMap.set(key, {
      sourceId: Number(sourceId),
      correctedId: Number(correctedId),
      correctionId: correctionId === null ? null : Number(correctionId),
      evidence: new Set(),
    });
  }
  const edge = edgeMap.get(key);
  edge.evidence.add(evidence);
  if (edge.correctionId === null && correctionId !== null) edge.correctionId = Number(correctionId);
}

function analyzeLineage(products, corrections) {
  const productById = new Map(products.map((product) => [Number(product.id), product]));
  const productsBySku = new Map();
  for (const product of products) {
    if (!productsBySku.has(product.full_sku)) productsBySku.set(product.full_sku, []);
    productsBySku.get(product.full_sku).push(product);
  }
  const uniqueProductIdForSku = (sku) => {
    const matches = productsBySku.get(sku) || [];
    return matches.length === 1 ? Number(matches[0].id) : null;
  };
  const edgeMap = new Map();
  const warnings = [];
  for (const correction of corrections) {
    const sourceId = nullableNumber(correction.source_product_id)
      || uniqueProductIdForSku(correction.source_sku);
    const correctedId = nullableNumber(correction.corrected_product_id)
      || uniqueProductIdForSku(correction.corrected_sku);
    addGraphEdge(edgeMap, sourceId, correctedId, 'product_corrections', correction.id);
    const source = productById.get(sourceId);
    const corrected = productById.get(correctedId);
    if (source && correction.source_sku && source.full_sku !== correction.source_sku) {
      warnings.push({ code: 'CORRECTION_SOURCE_SKU_MISMATCH', message: 'SKU джерела у виправленні не збігається з товаром.' });
    }
    if (corrected && correction.corrected_sku && corrected.full_sku !== correction.corrected_sku) {
      warnings.push({ code: 'CORRECTION_TARGET_SKU_MISMATCH', message: 'Новий SKU у виправленні не збігається з товаром.' });
    }
  }
  for (const product of products) {
    addGraphEdge(edgeMap, product.id, product.corrected_to_product_id, 'products_links');
    addGraphEdge(edgeMap, product.corrected_from_product_id, product.id, 'products_links');
  }

  const incoming = new Map();
  const outgoing = new Map();
  for (const edge of edgeMap.values()) {
    if (!productById.has(edge.sourceId) || !productById.has(edge.correctedId)) continue;
    if (!incoming.has(edge.correctedId)) incoming.set(edge.correctedId, []);
    if (!outgoing.has(edge.sourceId)) outgoing.set(edge.sourceId, []);
    incoming.get(edge.correctedId).push(edge);
    outgoing.get(edge.sourceId).push(edge);
    if (!edge.evidence.has('product_corrections')) {
      warnings.push({ code: 'MISSING_CORRECTION_HISTORY', message: 'Посилання між товарами не має відповідного запису історії виправлення.' });
    }
    if (!edge.evidence.has('products_links')) {
      warnings.push({ code: 'MISSING_PRODUCT_LINK', message: 'Запис історії виправлення має неповні посилання між товарами.' });
    }
  }
  if ([...incoming.values()].some((edges) => edges.length > 1)) {
    warnings.push({ code: 'MULTIPLE_PREDECESSORS', message: 'Збережений ланцюжок має кілька попередників одного товару.' });
  }
  if ([...outgoing.values()].some((edges) => edges.length > 1)) {
    warnings.push({ code: 'MULTIPLE_SUCCESSORS', message: 'Збережений ланцюжок має кілька наступників одного товару.' });
  }

  const roots = products.filter((product) => !(incoming.get(Number(product.id)) || []).length);
  const endpoints = products.filter((product) => !(outgoing.get(Number(product.id)) || []).length);
  if (roots.length !== 1) warnings.push({ code: 'NON_LINEAR_ROOTS', message: 'Збережений ланцюжок не має одного однозначного початку.' });
  if (endpoints.length !== 1) warnings.push({ code: 'NON_LINEAR_ENDPOINTS', message: 'Збережений ланцюжок не має одного однозначного кінцевого товару.' });

  const uniqueWarnings = [...new Map(warnings.map((warning) => [warning.code, warning])).values()];
  let ordered = [];
  if (uniqueWarnings.length === 0 && roots.length === 1) {
    const visited = new Set();
    let current = roots[0];
    while (current && !visited.has(Number(current.id))) {
      ordered.push(current);
      visited.add(Number(current.id));
      const nextEdge = (outgoing.get(Number(current.id)) || [])[0];
      current = nextEdge ? productById.get(nextEdge.correctedId) : null;
    }
    if (ordered.length !== products.length) {
      uniqueWarnings.push({ code: 'LINEAGE_CYCLE', message: 'Збережений ланцюжок містить цикл або відокремлені свідчення.' });
    }
  }
  if (ordered.length !== products.length) {
    ordered = [...products].sort((first, second) => (
      new Date(first.created_at || 0).getTime() - new Date(second.created_at || 0).getTime()
      || Number(first.id) - Number(second.id)
    ));
  }

  return {
    edgeMap,
    ordered,
    roots,
    endpoints,
    warnings: uniqueWarnings,
  };
}

function auditKey(eventKey, subjectId) {
  return `${eventKey}:${subjectId}`;
}

function mapAudits(rows) {
  const result = new Map();
  for (const row of rows) {
    const key = auditKey(row.event_key, row.subject_id);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }
  return result;
}

function firstAudit(audits, eventKey, subjectId) {
  return (audits.get(auditKey(eventKey, String(subjectId))) || [])[0] || null;
}

async function getProductTimeline(skuValue) {
  const querySku = normalizeTimelineSku(skuValue);
  const seedResult = await pool.query(
    `SELECT id FROM products WHERE full_sku = $1 ORDER BY id`,
    [querySku]
  );
  if (seedResult.rows.length === 0) {
    throw timelineError('Товар з таким артикулом не знайдено.', 404, 'SKU_HISTORY_NOT_FOUND');
  }
  if (seedResult.rows.length > 1) {
    throw timelineError('Артикул відповідає кільком історичним товарам.', 409, 'AMBIGUOUS_HISTORICAL_SKU');
  }
  const seedId = Number(seedResult.rows[0].id);

  const lineageResult = await pool.query(
    `WITH RECURSIVE edges AS (
       SELECT COALESCE(pc.source_product_id, source_match.id) AS source_id,
              COALESCE(pc.corrected_product_id, corrected_match.id) AS corrected_id
       FROM product_corrections pc
       LEFT JOIN LATERAL (
         SELECT MIN(id)::integer AS id FROM products
         WHERE full_sku = pc.source_sku HAVING COUNT(*) = 1
       ) source_match ON TRUE
       LEFT JOIN LATERAL (
         SELECT MIN(id)::integer AS id FROM products
         WHERE full_sku = pc.corrected_sku HAVING COUNT(*) = 1
       ) corrected_match ON TRUE
       WHERE COALESCE(pc.source_product_id, source_match.id) IS NOT NULL
         AND COALESCE(pc.corrected_product_id, corrected_match.id) IS NOT NULL
       UNION
       SELECT id, corrected_to_product_id FROM products WHERE corrected_to_product_id IS NOT NULL
       UNION
       SELECT corrected_from_product_id, id FROM products WHERE corrected_from_product_id IS NOT NULL
     ), lineage(id) AS (
       SELECT $1::integer
       UNION
       SELECT CASE WHEN e.source_id = l.id THEN e.corrected_id ELSE e.source_id END
       FROM lineage l
       JOIN edges e ON e.source_id = l.id OR e.corrected_id = l.id
     )
     SELECT p.*
     FROM products p
     JOIN lineage l ON l.id = p.id`,
    [seedId]
  );
  const products = lineageResult.rows;
  const productIds = products.map((product) => Number(product.id));
  const productSkus = products.map((product) => product.full_sku);

  const [correctionResult, requestResult, repricingResult] = await Promise.all([
    pool.query(
      `SELECT * FROM product_corrections
       WHERE source_product_id = ANY($1::int[]) OR corrected_product_id = ANY($1::int[])
          OR source_sku = ANY($2::text[]) OR corrected_sku = ANY($2::text[])
       ORDER BY created_at, id`,
      [productIds, productSkus]
    ),
    pool.query(
      `SELECT * FROM correction_requests
       WHERE source_product_id = ANY($1::int[])
       ORDER BY created_at, id`,
      [productIds]
    ),
    pool.query(
      `SELECT ri.*, b.scope, b.scenario_name, b.status AS batch_status,
              b.applied_at, b.rolled_back_at, b.applied_by_user_id, b.rolled_back_by_user_id
       FROM repricing_items ri
       JOIN repricing_batches b ON b.id = ri.batch_id
       WHERE ri.product_id = ANY($1::int[])
       ORDER BY COALESCE(b.applied_at, ri.created_at), ri.id`,
      [productIds]
    ),
  ]);
  const corrections = correctionResult.rows;
  const requests = requestResult.rows;
  const repricingItems = repricingResult.rows;
  const requestIds = requests.map((request) => String(request.id));
  const batchIds = [...new Set(repricingItems.map((item) => String(item.batch_id)))];
  const productSubjectIds = productIds.map(String);
  const auditResult = await pool.query(
    `SELECT id, event_key, actor_user_id, actor_snapshot, subject_type, subject_id,
            details, occurred_at
     FROM audit_events
     WHERE (subject_type = 'product' AND subject_id = ANY($1::text[]))
        OR (subject_type = 'correction_request' AND subject_id = ANY($2::text[]))
        OR (subject_type = 'repricing_batch' AND subject_id = ANY($3::text[]))
     ORDER BY occurred_at, id`,
    [productSubjectIds, requestIds, batchIds]
  );
  const audits = mapAudits(auditResult.rows);

  const schemaIds = new Set(products.map((product) => nullableNumber(product.sku_schema_version_id)).filter(Boolean));
  for (const correction of corrections) {
    const oldSchemaId = nullableNumber(correction.old_payload?.skuSchemaVersionId);
    const newSchemaId = nullableNumber(correction.new_payload?.skuSchemaVersionId);
    if (oldSchemaId) schemaIds.add(oldSchemaId);
    if (newSchemaId) schemaIds.add(newSchemaId);
  }
  for (const request of requests) {
    const oldSchemaId = nullableNumber(request.old_payload?.skuSchemaVersionId);
    const newSchemaId = nullableNumber(request.proposed_payload?.skuSchemaVersionId);
    if (oldSchemaId) schemaIds.add(oldSchemaId);
    if (newSchemaId) schemaIds.add(newSchemaId);
  }
  const schemaResult = schemaIds.size === 0
    ? { rows: [] }
    : await pool.query(
      `SELECT q.schema_version_id, q.question_key, q.label AS question_label,
              o.id AS option_id, o.value_id, o.label AS option_label,
              o.visible_if_json, o.hidden_if_json
       FROM sku_schema_questions q
       LEFT JOIN sku_schema_options o ON o.schema_question_id = q.id
       WHERE q.schema_version_id = ANY($1::int[])
       ORDER BY q.schema_version_id, q.sku_index, o.id`,
      [[...schemaIds]]
    );
  const schemas = buildSchemaMap(schemaResult.rows);
  const productById = new Map(products.map((product) => [Number(product.id), product]));
  const graph = analyzeLineage(products, corrections);

  const requestsByCorrectedProduct = new Map();
  for (const request of requests) {
    if (request.corrected_product_id !== null) {
      requestsByCorrectedProduct.set(Number(request.corrected_product_id), request);
    }
  }
  const correctionAuditByCorrectionId = new Map();
  for (const audit of auditResult.rows) {
    if (audit.event_key !== 'product.recounted') continue;
    const details = asObject(audit.details);
    if (details.productCorrectionId) correctionAuditByCorrectionId.set(Number(details.productCorrectionId), { ...audit, details });
  }

  const events = [];
  const pushEvent = (event) => events.push({ ...event, sourceOrder: events.length + 1 });
  const rootProducts = graph.roots;
  for (const product of rootProducts) {
    const audit = firstAudit(audits, 'product.created', product.id);
    pushEvent({
      type: 'product.created',
      ...eventTimestamp(product.created_at),
      actor: actorFromAudit(audit, product.created_by_user_id),
      sku: product.full_sku,
      summary: 'Product created',
      details: { categoryCode: product.category },
      changes: [],
      sortOrder: 10,
    });
  }

  const requestEventNames = new Map([
    ['correction_request.created', 'Correction request created'],
    ['correction_request.claimed', 'Correction request claimed'],
    ['correction_request.released', 'Correction request released'],
    ['correction_request.force_released', 'Correction request force-released'],
    ['correction_request.rejected', 'Correction request rejected'],
    ['correction_request.reopened', 'Correction request reopened'],
    ['correction_request.completed', 'Correction request completed'],
  ]);
  const requestGroups = new Map();
  for (const request of requests) {
    const sourceProduct = productById.get(Number(request.source_product_id));
    const oldSchema = getPayloadSchema(
      schemas,
      request.old_payload,
      sourceProduct?.sku_schema_version_id
    );
    const newSchema = getPayloadSchema(schemas, request.proposed_payload, null);
    const latestProposal = {
      label: 'latest_stored_proposal',
      sourceSku: request.source_sku,
      proposedSku: request.proposed_sku,
      comment: request.comment || '',
      changes: normalizeStoredChanges({
        oldPayload: request.old_payload,
        newPayload: request.proposed_payload,
        oldSchema,
        newSchema,
        storedChanges: request.changes,
      }),
    };
    const lifecycleAudits = auditResult.rows.filter((audit) => (
      audit.subject_type === 'correction_request'
      && audit.subject_id === String(request.id)
      && requestEventNames.has(audit.event_key)
    ));
    const emitted = new Set();
    for (const audit of lifecycleAudits) {
      emitted.add(audit.event_key);
      const completionGroup = audit.event_key === 'correction_request.completed'
        ? `request:${request.id}:completion`
        : null;
      pushEvent({
        type: audit.event_key,
        ...eventTimestamp(audit.occurred_at),
        actor: actorFromAudit(audit, null),
        sku: request.source_sku,
        summary: requestEventNames.get(audit.event_key),
        details: audit.event_key === 'correction_request.created' ? { latestProposal } : {},
        changes: [],
        internalGroup: completionGroup,
        sortOrder: audit.event_key === 'correction_request.completed' ? 50 : 30,
      });
      if (completionGroup) requestGroups.set(Number(request.id), completionGroup);
    }
    if (!emitted.has('correction_request.created')) {
      pushEvent({
        type: 'correction_request.created',
        ...eventTimestamp(request.created_at),
        actor: actorFromAudit(null, request.created_by_user_id),
        sku: request.source_sku,
        summary: 'Correction request created',
        details: { latestProposal },
        changes: [],
        sortOrder: 20,
      });
    }
    if (request.status === 'in_progress' && request.claimed_at && !emitted.has('correction_request.claimed')) {
      pushEvent({
        type: 'correction_request.claimed',
        ...eventTimestamp(request.claimed_at),
        actor: actorFromAudit(null, request.claimed_by_user_id),
        sku: request.source_sku,
        summary: 'Correction request claimed',
        details: {}, changes: [], sortOrder: 30,
      });
    }
    if (request.status === 'completed' && request.completed_at && !emitted.has('correction_request.completed')) {
      const group = `request:${request.id}:completion`;
      requestGroups.set(Number(request.id), group);
      pushEvent({
        type: 'correction_request.completed',
        ...eventTimestamp(request.completed_at),
        actor: actorFromAudit(null, null),
        sku: request.source_sku,
        summary: 'Correction request completed',
        details: {}, changes: [], internalGroup: group, sortOrder: 50,
      });
    }
    if (request.status === 'rejected' && request.rejected_at && !emitted.has('correction_request.rejected')) {
      pushEvent({
        type: 'correction_request.rejected',
        ...eventTimestamp(request.rejected_at),
        actor: actorFromAudit(null, null),
        sku: request.source_sku,
        summary: 'Correction request rejected',
        details: {}, changes: [], sortOrder: 40,
      });
    }
  }

  for (const correction of corrections) {
    const source = productById.get(Number(correction.source_product_id));
    const corrected = productById.get(Number(correction.corrected_product_id));
    if (!source || !corrected) continue;
    const audit = correctionAuditByCorrectionId.get(Number(correction.id)) || null;
    const requestId = nullableNumber(audit?.details?.correctionRequestId)
      || nullableNumber(requestsByCorrectedProduct.get(Number(corrected.id))?.id);
    const request = requestId ? requests.find((item) => Number(item.id) === requestId) : null;
    const oldSchema = getPayloadSchema(schemas, correction.old_payload, source.sku_schema_version_id);
    const newSchema = getPayloadSchema(
      schemas,
      correction.new_payload,
      corrected.sku_schema_version_id
    );
    const oldPrice = toUahNumber(correction.old_payload?.totalPriceUah);
    const newPrice = toUahNumber(correction.new_payload?.totalPriceUah);
    pushEvent({
      type: 'product.corrected',
      ...eventTimestamp(correction.created_at),
      actor: actorFromAudit(audit, correction.performed_by_user_id),
      sku: source.full_sku,
      summary: request ? 'Correction request completed and product corrected' : 'Product corrected',
      details: {
        sourceSku: correction.source_sku,
        correctedSku: correction.corrected_sku,
        reason: correction.reason || '',
        applicationMode: request ? 'request' : (audit ? 'direct' : 'not_recorded'),
        price: {
          beforeUah: oldPrice,
          afterUah: newPrice,
          deltaUah: nullableNumber(correction.price_delta_uah),
          beforeMode: correction.old_payload?.pricing?.priceMode || null,
          afterMode: correction.new_payload?.priceMode || null,
        },
      },
      changes: normalizeStoredChanges({
        oldPayload: correction.old_payload,
        newPayload: correction.new_payload,
        oldSchema,
        newSchema,
      }),
      internalGroup: requestId ? requestGroups.get(requestId) || null : null,
      sortOrder: 60,
    });
  }

  for (const item of repricingItems) {
    const applyAudit = firstAudit(audits, 'repricing.applied', item.batch_id);
    const oldPayload = asObject(item.old_payload);
    const newPayload = asObject(item.new_payload);
    pushEvent({
      type: 'repricing.applied',
      ...eventTimestamp(item.applied_at || item.created_at),
      actor: actorFromAudit(applyAudit, item.applied_by_user_id),
      sku: item.sku,
      summary: 'Price changed by repricing',
      details: {
        scope: item.scope || 'scenario',
        scenarioName: item.scenario_name,
        price: {
          beforeUah: toUahNumber(oldPayload.totalPriceUah ?? item.old_price_uah),
          afterUah: toUahNumber(newPayload.totalPriceUah ?? item.new_price_uah),
          deltaUah: nullableNumber(item.price_delta_uah),
          beforeManualUah: nullableNumber(oldPayload.details?.manualPriceUah),
          afterManualUah: nullableNumber(newPayload.details?.manualPriceUah),
          afterAutomaticUah: nullableNumber(newPayload.details?.autoPriceUah),
        },
      },
      changes: [], sortOrder: 70,
    });
    if (item.batch_status === 'rolled_back' && item.rolled_back_at) {
      const rollbackAudit = firstAudit(audits, 'repricing.rolled_back', item.batch_id);
      pushEvent({
        type: 'repricing.rolled_back',
        ...eventTimestamp(item.rolled_back_at),
        actor: actorFromAudit(rollbackAudit, item.rolled_back_by_user_id),
        sku: item.sku,
        summary: 'Repricing rolled back',
        details: {
          scope: item.scope || 'scenario',
          scenarioName: item.scenario_name,
          price: {
            beforeUah: toUahNumber(newPayload.totalPriceUah ?? item.new_price_uah),
            afterUah: toUahNumber(oldPayload.totalPriceUah ?? item.old_price_uah),
            deltaUah: nullableNumber(item.old_price_uah) - nullableNumber(item.new_price_uah),
          },
        },
        changes: [], sortOrder: 80,
      });
    }
  }

  for (const product of products.filter((item) => item.status === 'archived')) {
    const audit = firstAudit(audits, 'product.archived', product.id);
    pushEvent({
      type: 'product.archived',
      ...eventTimestamp(audit?.occurred_at || null),
      actor: actorFromAudit(audit, product.archived_by_user_id),
      sku: product.full_sku,
      summary: 'Product archived',
      details: {}, changes: [], sortOrder: 90,
    });
  }

  events.sort(eventSort);
  const groupNames = new Map();
  let nextGroup = 1;
  for (const event of events) {
    if (event.internalGroup && !groupNames.has(event.internalGroup)) {
      groupNames.set(event.internalGroup, `business-action-${nextGroup++}`);
    }
  }
  const normalizedEvents = events.map((event, index) => {
    const { internalGroup, sortOrder, sourceOrder, ...publicEvent } = event;
    return {
      id: `timeline-${index + 1}`,
      ...publicEvent,
      groupKey: internalGroup ? groupNames.get(internalGroup) : null,
    };
  });

  const currentProduct = graph.endpoints.length === 1 ? graph.endpoints[0] : null;
  return {
    querySku,
    lineage: {
      integrity: graph.warnings.length ? 'warning' : 'ok',
      warnings: graph.warnings,
      rootSku: graph.roots.length === 1 ? graph.roots[0].full_sku : null,
      currentSku: currentProduct?.full_sku || null,
      products: graph.ordered.map((product) => ({
        sku: product.full_sku,
        categoryCode: product.category,
        status: product.status || 'active',
        createdAt: product.created_at,
      })),
    },
    events: normalizedEvents,
  };
}

module.exports = {
  analyzeLineage,
  buildSchemaMap,
  getPayloadSchema,
  getProductTimeline,
  normalizeStoredChanges,
  normalizeTimelineSku,
};
