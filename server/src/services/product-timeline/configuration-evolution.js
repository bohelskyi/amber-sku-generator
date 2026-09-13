const { decodeSkuAnswers } = require('../../utils/sku');
const {
  asObject,
  normalizeSnapshotFields,
  normalizeStoredChanges,
  nullableNumber,
  sameValue,
} = require('./historical-normalization');

const WARNING_MESSAGES = {
  AMBIGUOUS_CONFIGURATION_ORDER: 'Неможливо надійно впорядкувати історичні конфігурації.',
  CONFIGURATION_EVIDENCE_CONFLICT: 'Збережені джерела конфігурації містять суперечливі значення.',
  HISTORICAL_SCHEMA_MISSING: 'Історичну SKU-схему не знайдено; назви характеристик не можна підтвердити.',
  HISTORICAL_CONFIGURATION_UNAVAILABLE: 'Для однієї або кількох версій характеристики не записані.',
  LEGACY_CONFIGURATION_PARTIAL: 'Для старих версій показано лише характеристики, підтверджені SKU-схемою.',
};

function warning(code) {
  return { code, message: WARNING_MESSAGES[code] };
}

function uniqueWarnings(warnings) {
  return [...new Map(warnings.map((item) => [item.code, item])).values()];
}

function buildLinearChain(graph, products) {
  if (graph.roots.length !== 1 || graph.endpoints.length !== 1) return null;
  const productById = new Map(products.map((product) => [Number(product.id), product]));
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of graph.edgeMap.values()) {
    if (!productById.has(edge.sourceId) || !productById.has(edge.correctedId)) return null;
    if (!outgoing.has(edge.sourceId)) outgoing.set(edge.sourceId, []);
    if (!incoming.has(edge.correctedId)) incoming.set(edge.correctedId, []);
    outgoing.get(edge.sourceId).push(edge);
    incoming.get(edge.correctedId).push(edge);
  }
  if ([...outgoing.values()].some((edges) => edges.length > 1)) return null;
  if ([...incoming.values()].some((edges) => edges.length > 1)) return null;

  const orderedProducts = [];
  const orderedEdges = [];
  const visited = new Set();
  let current = graph.roots[0];
  while (current && !visited.has(Number(current.id))) {
    orderedProducts.push(current);
    visited.add(Number(current.id));
    const edge = (outgoing.get(Number(current.id)) || [])[0] || null;
    if (!edge) break;
    orderedEdges.push(edge);
    current = productById.get(edge.correctedId) || null;
  }
  if (orderedProducts.length !== products.length) return null;
  return { products: orderedProducts, edges: orderedEdges };
}

function getSchemaVersion(schemaVersions, value) {
  const id = nullableNumber(value);
  if (id === null) return null;
  return schemaVersions.get(id) || { id, version: null, marker: null };
}

function getEstablishingSchema(product, payload, schemas, schemaVersions) {
  const productId = nullableNumber(product?.sku_schema_version_id);
  const payloadId = nullableNumber(payload?.skuSchemaVersionId);
  const conflict = productId !== null && payloadId !== null && productId !== payloadId;
  const id = productId ?? payloadId;
  return {
    version: getSchemaVersion(schemaVersions, id),
    schema: conflict ? null : schemas.get(id) || null,
    conflict,
  };
}

function getProductAnswers(product) {
  const details = asObject(product?.details);
  if (!Object.hasOwn(details, 'answers')) return null;
  if (!details.answers || typeof details.answers !== 'object' || Array.isArray(details.answers)) {
    return null;
  }
  const answers = { ...details.answers };
  if (
    !Object.hasOwn(answers, 'is_calibrated')
    && details.isCalibrated !== null
    && details.isCalibrated !== undefined
    && details.isCalibrated !== ''
  ) {
    answers.is_calibrated = Number(details.isCalibrated);
  }
  return answers;
}

function getPayloadAnswers(payload) {
  if (!payload || !Object.hasOwn(payload, 'answers')) return null;
  return payload.answers && typeof payload.answers === 'object' && !Array.isArray(payload.answers)
    ? { ...payload.answers }
    : null;
}

function getConflictingKeys(primary, secondary) {
  if (!primary || !secondary) return [];
  return Object.keys(primary).filter((key) => (
    Object.hasOwn(secondary, key) && !sameValue(primary[key], secondary[key])
  ));
}

function hasUniqueSkuInterpretation(questions, encodedPart) {
  const interpretations = new Set();
  const configuredSeparators = questions.map((question) => question.sku_separator).filter(Boolean);
  const hasSeparators = configuredSeparators.some((separator) => encodedPart.includes(separator));

  function collect(remaining, index, values, separated) {
    if (interpretations.size > 1) return;
    if (index === questions.length) {
      if (!remaining) interpretations.add(JSON.stringify(values));
      return;
    }
    const question = questions[index];
    const separator = separated ? question.sku_separator : '';
    const hasZeroOption = question.options.some((option) => option.sku_code === '0');
    const options = new Map(question.options.map((option) => [
      `${option.sku_code}:${option.value_id}`, option,
    ]));
    if (separator) {
      if (!remaining.startsWith(separator)) return;
      const afterOpening = remaining.slice(separator.length);
      const closing = afterOpening.indexOf(separator);
      if (closing < 0) return;
      const token = afterOpening.slice(0, closing);
      const rest = afterOpening.slice(closing + separator.length);
      for (const option of options.values()) {
        if (option.sku_code === token) collect(rest, index + 1, [...values, option.value_id], separated);
      }
      if (!question.required && !hasZeroOption && token === '0') {
        collect(rest, index + 1, [...values, null], separated);
      }
      return;
    }
    for (const option of options.values()) {
      if (remaining.startsWith(option.sku_code)) {
        collect(remaining.slice(option.sku_code.length), index + 1,
          [...values, option.value_id], separated);
      }
    }
    if (!question.required) {
      if (!hasZeroOption && remaining.startsWith('0')) {
        collect(remaining.slice(1), index + 1, [...values, null], separated);
      }
      collect(remaining, index + 1, [...values, null], separated);
    }
  }

  if (hasSeparators) collect(encodedPart, 0, [], true);
  collect(encodedPart.replace(/[._/-]/g, ''), 0, [], false);
  return interpretations.size === 1;
}

function getAnswerEvidence(product, payload) {
  const productAnswers = getProductAnswers(product);
  const payloadAnswers = getPayloadAnswers(payload);
  const conflicts = getConflictingKeys(productAnswers, payloadAnswers);
  if (!productAnswers && !payloadAnswers) {
    return { answers: null, evidenceByKey: {}, conflicts };
  }
  const answers = { ...payloadAnswers, ...productAnswers };
  const evidenceByKey = Object.fromEntries([
    ...Object.keys(payloadAnswers || {}).map((key) => [key, 'correction_payload']),
    ...Object.keys(productAnswers || {}).map((key) => [key, 'product_details']),
  ]);
  for (const key of conflicts) {
    delete answers[key];
    delete evidenceByKey[key];
  }
  return { answers, evidenceByKey, conflicts };
}

function decodeProductAnswers(product, schema, schemaVersion) {
  if (!schema || !schemaVersion || !product?.base_sku) return null;
  const questions = [...schema.values()];
  if (questions.some((question) => question.visible_if_json)) return null;
  const prefix = `${product.category || ''}${schemaVersion.marker || ''}`;
  const baseSku = String(product.base_sku);
  if (!baseSku.startsWith(prefix)) return null;
  const encodedPart = baseSku.slice(prefix.length);
  if (!hasUniqueSkuInterpretation(questions, encodedPart)) return null;
  const decoded = decodeSkuAnswers(questions, encodedPart);
  if (!decoded) return null;
  return {
    answers: decoded.reduce((result, answer) => {
      result[answer.key] = answer.value_id;
      return result;
    }, {}),
    payload: { decodedAnswers: decoded },
  };
}

function reconstructSnapshot({ product, payload, schema, schemaVersion, schemaConflict, changes }) {
  const answerEvidence = getAnswerEvidence(product, payload);
  let { answers, evidenceByKey } = answerEvidence;
  let evidence = getProductAnswers(product) ? 'product_details' : 'correction_payload';
  let labelPayload = schemaConflict ? {} : payload || {};
  let completeness = 'complete';
  const warnings = [];

  if (answerEvidence.conflicts.length || schemaConflict) {
    completeness = 'partial';
    warnings.push(warning('CONFIGURATION_EVIDENCE_CONFLICT'));
  }
  if (!schema && !schemaConflict) {
    completeness = 'partial';
    warnings.push(warning('HISTORICAL_SCHEMA_MISSING'));
  }
  if (!answers) {
    const decoded = decodeProductAnswers(product, schema, schemaVersion);
    if (decoded) {
      answers = decoded.answers;
      evidenceByKey = {};
      labelPayload = decoded.payload;
      evidence = 'sku_decode';
      completeness = 'partial';
      warnings.push(warning('LEGACY_CONFIGURATION_PARTIAL'));
    }
  }
  if (!answers) {
    answers = {};
    evidence = 'not_recorded';
    completeness = 'unavailable';
    warnings.push(warning('HISTORICAL_CONFIGURATION_UNAVAILABLE'));
  }

  const fields = normalizeSnapshotFields({
    answers,
    payload: labelPayload,
    schema,
    evidence,
    evidenceByKey,
    changes,
  });
  if (fields.some((field) => field.labelStatus === 'not_recorded')) {
    completeness = completeness === 'unavailable' ? completeness : 'partial';
  }
  return { completeness, fields, warnings };
}

function correctionSource(correction, requests, audits) {
  const request = requests.find((item) => (
    item.status === 'completed'
    && Number(item.corrected_product_id) === Number(correction.corrected_product_id)
  ));
  if (request) return 'correction_request';
  const audit = audits.find((item) => {
    if (item.event_key !== 'product.recounted') return false;
    const details = asObject(item.details);
    return Number(details.productCorrectionId) === Number(correction.id);
  });
  if (nullableNumber(asObject(audit?.details).correctionRequestId) !== null) {
    return 'correction_request';
  }
  return 'direct_recount';
}

function buildConfigurationEvolution({
  graph,
  products,
  corrections,
  requests,
  audits,
  schemas,
  schemaVersions,
}) {
  const chain = buildLinearChain(graph, products);
  if (!chain) {
    return {
      status: 'unavailable',
      warnings: [warning('AMBIGUOUS_CONFIGURATION_ORDER')],
      snapshots: [],
    };
  }

  const correctionsById = new Map(corrections.map((item) => [Number(item.id), item]));
  const snapshots = [];
  const warnings = [];
  const root = chain.products[0];
  const firstEdge = chain.edges[0] || null;
  const firstCorrection = firstEdge ? correctionsById.get(Number(firstEdge.correctionId)) : null;
  const rootPayload = firstCorrection?.old_payload || null;
  const rootEstablishment = getEstablishingSchema(root, rootPayload, schemas, schemaVersions);
  const rootState = reconstructSnapshot({
    product: root,
    payload: rootPayload,
    schema: rootEstablishment.schema,
    schemaVersion: rootEstablishment.version,
    schemaConflict: rootEstablishment.conflict,
    changes: [],
  });
  warnings.push(...rootState.warnings);
  snapshots.push({
    id: 'configuration-1',
    ordinal: 1,
    isInitial: true,
    isCurrent: false,
    productStatus: root.status || 'active',
    establishingSku: root.full_sku,
    establishingSchemaVersion: rootEstablishment.version,
    currentSku: null,
    currentSchemaVersion: null,
    occurredAt: root.created_at || null,
    timestampStatus: root.created_at ? 'recorded' : 'not_recorded',
    source: 'product_created',
    completeness: rootState.completeness,
    fields: rootState.fields,
    changes: [],
  });

  for (let index = 0; index < chain.edges.length; index += 1) {
    const edge = chain.edges[index];
    const correction = correctionsById.get(Number(edge.correctionId));
    if (!correction) {
      warnings.push(warning('HISTORICAL_CONFIGURATION_UNAVAILABLE'));
      continue;
    }
    const sourceProduct = chain.products[index];
    const targetProduct = chain.products[index + 1];
    const oldEstablishment = getEstablishingSchema(
      sourceProduct, correction.old_payload, schemas, schemaVersions
    );
    const newEstablishment = getEstablishingSchema(
      targetProduct, correction.new_payload, schemas, schemaVersions
    );
    const oldEvidence = getAnswerEvidence(sourceProduct, correction.old_payload);
    const newEvidence = getAnswerEvidence(targetProduct, correction.new_payload);
    if (!oldEvidence.answers || !newEvidence.answers) {
      warnings.push(warning('HISTORICAL_CONFIGURATION_UNAVAILABLE'));
      continue;
    }
    const changes = normalizeStoredChanges({
      oldPayload: { ...asObject(correction.old_payload), answers: oldEvidence.answers },
      newPayload: { ...asObject(correction.new_payload), answers: newEvidence.answers },
      oldSchema: oldEstablishment.schema,
      newSchema: newEstablishment.schema,
    }).filter((change) => change.kind === 'answer'
      && !oldEvidence.conflicts.includes(change.fieldKey)
      && !newEvidence.conflicts.includes(change.fieldKey));
    if (oldEvidence.conflicts.length || newEvidence.conflicts.length
        || oldEstablishment.conflict || newEstablishment.conflict) {
      warnings.push(warning('CONFIGURATION_EVIDENCE_CONFLICT'));
    }
    if (changes.length === 0) continue;

    const state = reconstructSnapshot({
      product: targetProduct,
      payload: correction.new_payload,
      schema: newEstablishment.schema,
      schemaVersion: newEstablishment.version,
      schemaConflict: newEstablishment.conflict,
      changes,
    });
    warnings.push(...state.warnings);
    snapshots.push({
      id: `configuration-${snapshots.length + 1}`,
      ordinal: snapshots.length + 1,
      isInitial: false,
      isCurrent: false,
      productStatus: targetProduct.status || 'active',
      establishingSku: targetProduct.full_sku,
      establishingSchemaVersion: newEstablishment.version,
      currentSku: null,
      currentSchemaVersion: null,
      occurredAt: correction.created_at || targetProduct.created_at || null,
      timestampStatus: correction.created_at || targetProduct.created_at ? 'recorded' : 'not_recorded',
      source: correctionSource(correction, requests, audits),
      completeness: state.completeness,
      fields: state.fields,
      changes,
    });
  }

  const endpoint = chain.products[chain.products.length - 1];
  const current = snapshots[snapshots.length - 1];
  current.isCurrent = true;
  current.productStatus = endpoint.status || 'active';
  current.currentSku = endpoint.full_sku;
  current.currentSchemaVersion = getSchemaVersion(schemaVersions, endpoint.sku_schema_version_id);
  const normalizedWarnings = uniqueWarnings(warnings);
  const hasUnavailable = snapshots.some((snapshot) => snapshot.completeness === 'unavailable');
  const hasPartial = snapshots.some((snapshot) => snapshot.completeness === 'partial');
  return {
    status: snapshots.every((snapshot) => snapshot.completeness === 'unavailable')
      ? 'unavailable'
      : hasUnavailable || hasPartial || normalizedWarnings.length ? 'partial' : 'complete',
    warnings: normalizedWarnings,
    snapshots,
  };
}

module.exports = {
  buildConfigurationEvolution,
};
