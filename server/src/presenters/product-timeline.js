const { toUahNumber } = require('../utils/money');
const { analyzeLineage } = require('../services/product-timeline/lineage-analysis');
const {
  asObject,
  buildSchemaMap,
  getPayloadSchema,
  normalizeStoredChanges,
  nullableNumber,
} = require('../services/product-timeline/historical-normalization');

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

function presentProductTimeline(querySku, data) {
  const {
    products,
    corrections,
    requests,
    repricingItems,
    audits: auditRows,
    schemaRows,
  } = data;
  const schemas = buildSchemaMap(schemaRows);
  const audits = mapAudits(auditRows);
  const productById = new Map(products.map((product) => [Number(product.id), product]));
  const graph = analyzeLineage(products, corrections);

  const requestsByCorrectedProduct = new Map();
  for (const request of requests) {
    if (request.corrected_product_id !== null) {
      requestsByCorrectedProduct.set(Number(request.corrected_product_id), request);
    }
  }
  const correctionAuditByCorrectionId = new Map();
  for (const audit of auditRows) {
    if (audit.event_key !== 'product.recounted') continue;
    const details = asObject(audit.details);
    if (details.productCorrectionId) {
      correctionAuditByCorrectionId.set(Number(details.productCorrectionId), { ...audit, details });
    }
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
    const lifecycleAudits = auditRows.filter((audit) => (
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
    if (
      request.status === 'in_progress'
      && request.claimed_at
      && !emitted.has('correction_request.claimed')
    ) {
      pushEvent({
        type: 'correction_request.claimed',
        ...eventTimestamp(request.claimed_at),
        actor: actorFromAudit(null, request.claimed_by_user_id),
        sku: request.source_sku,
        summary: 'Correction request claimed',
        details: {}, changes: [], sortOrder: 30,
      });
    }
    if (
      request.status === 'completed'
      && request.completed_at
      && !emitted.has('correction_request.completed')
    ) {
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
    if (
      request.status === 'rejected'
      && request.rejected_at
      && !emitted.has('correction_request.rejected')
    ) {
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
  presentProductTimeline,
};
