const pool = require('../../db/pool');
const { createMutationContext } = require('../../audit/mutation-context');
const { writeAuditEvent } = require('../../audit/audit-events');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { compileDefinition } = require('../export-templates/definition');
const c = require('./binding-contract');
const bindingService = require('./binding.service');
const repository = require('./binding-repository');
const { entries } = require('./binding-review');
const { normalizeBindings, requirements, validateBindings } = require('./binding-validation');

const FORMAT = 'amber-magento-binding-reviewed-carry-forward-v1';
const EVENT = 'magento_binding.review_carried_forward';

function fail(code, message, details, status = 409) {
  throw c.error(status, code, message, details);
}

function stableAttributeKey(attribute) {
  return JSON.stringify([attribute.routeKey, attribute.rowId, attribute.target, attribute.strategy]);
}

function stableDecisionId(kind, attribute, suffix = '') {
  return `${kind}:${attribute.routeKey}/${attribute.rowId}/${attribute.target}${suffix ? `/${suffix}` : ''}`;
}

function entryStableId(entry) {
  if (entry.kind === 'route') return `route:${entry.routeKey}`;
  const attribute = { routeKey: entry.routeKey, rowId: entry.row, target: entry.target };
  if (entry.kind === 'attribute') return stableDecisionId('attribute', attribute);
  if (entry.kind === 'policy') return stableDecisionId('policy', attribute, entry.decision.storeCode);
  if (entry.kind === 'category') return stableDecisionId('category', attribute, entry.decision.normalizedPath);
  return stableDecisionId('option', attribute, entry.decision.sourceKind === 'semantic'
    ? `${entry.decision.amberGroup}.${entry.decision.questionKey}=value_id:${entry.decision.valueId}`
    : `evaluated:${entry.decision.outputKey}`);
}

function sortedStrings(values) {
  return [...(values || [])].map(String).sort((left, right) => left.localeCompare(right, 'en'));
}

function unsupportedSignature(decision) {
  return c.hash({ diagnosticCodes: sortedStrings(decision.evidence?.diagnosticCodes),
    candidateIds: sortedStrings(decision.evidence?.candidateIds) });
}

function sameRemoteAttribute(source, target, sourceSchema, targetSchema) {
  if (source.attributeCode !== target.attributeCode || source.transportTarget !== target.transportTarget) return false;
  if (source.attributeCode === null) return source.transportTarget === target.transportTarget;
  const sourceRemote = sourceSchema.attributes.find((row) => row.attribute_code === source.attributeCode);
  const targetRemote = targetSchema.attributes.find((row) => row.attribute_code === target.attributeCode);
  return Boolean(sourceRemote && targetRemote
    && sourceRemote.attribute_id === targetRemote.attribute_id
    && sourceRemote.attribute_code === targetRemote.attribute_code
    && sourceRemote.frontend_input === targetRemote.frontend_input);
}

function sameRemoteSet(setId, sourceSchema, targetSchema) {
  if (!Number.isSafeInteger(setId) || setId <= 0) return false;
  const source = sourceSchema.attributeSets.find((row) => row.attribute_set_id === setId);
  const target = targetSchema.attributeSets.find((row) => row.attribute_set_id === setId);
  return Boolean(source && target && source.attribute_set_name === target.attribute_set_name);
}

function sameRemoteStore(storeCode, sourceSchema, targetSchema) {
  if (storeCode === 'all') return true;
  const source = sourceSchema.storeTopology.storeViews.find((row) => row.code === storeCode);
  const target = targetSchema.storeTopology.storeViews.find((row) => row.code === storeCode);
  return Boolean(source && target && source.id === target.id && source.website_id === target.website_id
    && source.store_group_id === target.store_group_id);
}

function optionMeaning(option) {
  return option.sourceKind === 'semantic'
    ? { sourceKind: 'semantic', amberGroup: option.amberGroup, questionKey: option.questionKey,
      valueId: option.valueId, evaluatedOutput: option.evaluatedOutput }
    : { sourceKind: 'evaluated', outputKey: option.outputKey, evaluatedOutput: option.evaluatedOutput };
}

function optionBaseMeaning(option) {
  return option.sourceKind === 'semantic'
    ? { sourceKind: 'semantic', amberGroup: option.amberGroup, questionKey: option.questionKey,
      valueId: option.valueId }
    : { sourceKind: 'evaluated', outputKey: option.outputKey };
}

function sameOptionMeaning(source, target) {
  return c.hash(optionMeaning(source)) === c.hash(optionMeaning(target));
}

function sameOptionBaseMeaning(source, target) {
  return c.hash(optionBaseMeaning(source)) === c.hash(optionBaseMeaning(target));
}

function sameRemoteOption(source, target, sourceAttribute, targetAttribute, sourceSchema, targetSchema) {
  if (source.optionId === null || source.optionId !== target.optionId
    || sourceAttribute.attributeCode === null || sourceAttribute.attributeCode !== targetAttribute.attributeCode) return false;
  const sourceRemote = sourceSchema.attributes.find((row) => row.attribute_code === sourceAttribute.attributeCode)
    ?.options.find((row) => row.value === source.optionId);
  const targetRemote = targetSchema.attributes.find((row) => row.attribute_code === targetAttribute.attributeCode)
    ?.options.find((row) => row.value === target.optionId);
  return Boolean(sourceRemote && targetRemote && sourceRemote.label === targetRemote.label);
}

function markCarried(state, kind, id, sourceState, detail = {}) {
  state.carried.push({ kind, id, reviewState: sourceState, ...detail });
  state.carriedIds.add(id);
}

function blocker(state, code, kind, id, detail = {}) {
  state.blockers.push({ code, kind, id, ...detail });
}

function skipped(state, code, kind, id, detail = {}) {
  if (state.skippedIds.has(id)) return;
  state.skipped.push({ code, kind, id, ...detail });
  state.skippedIds.add(id);
}

function uniqueMatch(rows, predicate, state, kind, id, approved) {
  const matches = rows.filter(predicate);
  if (matches.length > 1) blocker(state, 'AMBIGUOUS_TARGET_MATCH', kind, id);
  else if (!matches.length && approved) blocker(state, 'APPROVED_TARGET_MISSING', kind, id);
  return matches.length === 1 ? matches[0] : null;
}

function carryReviewedBindings(source, target, targetDefinition) {
  const result = normalizeBindings(structuredClone(target.bindings));
  const sourceBindings = normalizeBindings(source.bindings);
  const state = { carried: [], skipped: [], blockers: [], carriedIds: new Set(), skippedIds: new Set() };
  const targetAttributes = new Map(result.attributes.map((row) => [stableAttributeKey(row), row]));

  for (const sourceRoute of sourceBindings.routes.filter((row) => ['approved', 'blocked'].includes(row.reviewState))) {
    const id = `route:${sourceRoute.routeKey}`;
    const targetRoute = uniqueMatch(result.routes, (row) => row.routeKey === sourceRoute.routeKey,
      state, 'route', id, sourceRoute.reviewState === 'approved');
    if (!targetRoute) {
      if (sourceRoute.reviewState === 'blocked') skipped(state, 'BLOCKED_TARGET_ABSENT', 'route', id);
      continue;
    }
    if (sourceRoute.reviewState === 'approved') {
      if (!sameRemoteSet(sourceRoute.setId, source.schema, target.schema)) {
        blocker(state, 'REMOTE_SET_IDENTITY_CHANGED', 'route', id, { setId: sourceRoute.setId });
        continue;
      }
      targetRoute.setId = sourceRoute.setId;
      targetRoute.enabled = sourceRoute.enabled;
      targetRoute.reviewState = 'approved';
      markCarried(state, 'route', id, 'approved', { setId: sourceRoute.setId });
    } else if (targetRoute.reviewState === 'blocked' && targetRoute.setId === sourceRoute.setId
      && unsupportedSignature(targetRoute) === unsupportedSignature(sourceRoute)) {
      targetRoute.enabled = sourceRoute.enabled;
      markCarried(state, 'route', id, 'blocked');
    } else skipped(state, 'BLOCKED_CASE_CHANGED', 'route', id);
  }

  for (const sourceAttribute of sourceBindings.attributes.filter((row) => ['approved', 'blocked'].includes(row.reviewState))) {
    const key = stableAttributeKey(sourceAttribute);
    const id = stableDecisionId('attribute', sourceAttribute);
    const targetAttribute = targetAttributes.get(key);
    if (!targetAttribute) {
      if (sourceAttribute.reviewState === 'approved') blocker(state, 'APPROVED_TARGET_MISSING', 'attribute', id);
      else skipped(state, 'BLOCKED_TARGET_ABSENT', 'attribute', id);
      continue;
    }
    const remoteSame = sameRemoteAttribute(sourceAttribute, targetAttribute, source.schema, target.schema);
    if (sourceAttribute.reviewState === 'approved') {
      if (!remoteSame) { blocker(state, 'REMOTE_ATTRIBUTE_IDENTITY_CHANGED', 'attribute', id); continue; }
      targetAttribute.reviewState = 'approved';
      markCarried(state, 'attribute', id, 'approved');
    } else if (targetAttribute.reviewState === 'blocked' && remoteSame
      && unsupportedSignature(targetAttribute) === unsupportedSignature(sourceAttribute)) {
      markCarried(state, 'attribute', id, 'blocked');
    } else skipped(state, 'BLOCKED_CASE_CHANGED', 'attribute', id);
  }

  for (const sourceOption of sourceBindings.options.filter((row) => ['approved', 'blocked'].includes(row.reviewState))) {
    const sourceAttribute = sourceBindings.attributes.find((row) => row.bindingKey === sourceOption.bindingKey);
    if (!sourceAttribute) continue;
    const targetAttribute = targetAttributes.get(stableAttributeKey(sourceAttribute));
    const meaning = optionMeaning(sourceOption);
    const id = stableDecisionId('option', sourceAttribute,
      sourceOption.sourceKind === 'semantic'
        ? `${sourceOption.amberGroup}.${sourceOption.questionKey}=value_id:${sourceOption.valueId}`
        : `evaluated:${sourceOption.outputKey}`);
    if (!targetAttribute) {
      if (sourceOption.reviewState === 'approved') blocker(state, 'APPROVED_TARGET_MISSING', 'option', id);
      else skipped(state, 'BLOCKED_TARGET_ABSENT', 'option', id);
      continue;
    }
    const candidates = result.options.filter((row) => row.bindingKey === targetAttribute.bindingKey);
    const targetOption = uniqueMatch(candidates, (row) => sameOptionMeaning(sourceOption, row), state,
      'option', id, sourceOption.reviewState === 'approved');
    if (!targetOption) {
      if (candidates.some((row) => sameOptionBaseMeaning(sourceOption, row))) {
        blocker(state, 'OPTION_SEMANTICS_CHANGED', 'option', id, { sourceMeaning: meaning });
      } else if (sourceOption.reviewState === 'blocked') skipped(state, 'BLOCKED_TARGET_ABSENT', 'option', id);
      continue;
    }
    if (sourceOption.reviewState === 'approved') {
      if (!sameRemoteOption(sourceOption, targetOption, sourceAttribute, targetAttribute,
        source.schema, target.schema)) {
        blocker(state, 'REMOTE_OPTION_IDENTITY_CHANGED', 'option', id, { optionId: sourceOption.optionId });
        continue;
      }
      targetOption.reviewState = 'approved';
      markCarried(state, 'option', id, 'approved', { optionId: sourceOption.optionId });
    } else if (targetOption.reviewState === 'blocked' && targetOption.optionId === sourceOption.optionId
      && unsupportedSignature(targetOption) === unsupportedSignature(sourceOption)) {
      markCarried(state, 'option', id, 'blocked');
    } else skipped(state, 'BLOCKED_CASE_CHANGED_OR_RESOLVED', 'option', id,
      { targetReviewState: targetOption.reviewState, targetOptionId: targetOption.optionId });
  }

  for (const sourceAttribute of sourceBindings.attributes) {
    const targetAttribute = targetAttributes.get(stableAttributeKey(sourceAttribute));
    for (const sourceCategory of (sourceAttribute.evidence?.categories || [])
      .filter((row) => ['approved', 'blocked'].includes(row.reviewState))) {
      const id = stableDecisionId('category', sourceAttribute, sourceCategory.normalizedPath);
      if (!targetAttribute) {
        if (sourceCategory.reviewState === 'approved') blocker(state, 'APPROVED_TARGET_MISSING', 'category', id);
        else skipped(state, 'BLOCKED_TARGET_ABSENT', 'category', id);
        continue;
      }
      const targets = targetAttribute.evidence?.categories || [];
      const targetCategory = uniqueMatch(targets, (row) => row.normalizedPath === sourceCategory.normalizedPath,
        state, 'category', id, sourceCategory.reviewState === 'approved');
      if (!targetCategory) {
        if (sourceCategory.reviewState === 'blocked') skipped(state, 'BLOCKED_TARGET_ABSENT', 'category', id);
        continue;
      }
      const sourceCandidate = sourceCategory.candidates.find((row) => row.categoryId === sourceCategory.categoryId);
      const targetCandidate = targetCategory.candidates.find((row) => row.categoryId === sourceCategory.categoryId);
      const sameIdentity = sourceCategory.categoryId === targetCategory.categoryId && sourceCandidate && targetCandidate
        && sourceCandidate.path === targetCandidate.path;
      if (sourceCategory.reviewState === 'approved') {
        if (!sameIdentity) { blocker(state, 'REMOTE_CATEGORY_IDENTITY_CHANGED', 'category', id); continue; }
        targetCategory.reviewState = 'approved';
        markCarried(state, 'category', id, 'approved', { categoryId: sourceCategory.categoryId });
      } else if (targetCategory.reviewState === 'blocked'
        && sourceCategory.categoryId === targetCategory.categoryId
        && c.hash(sourceCategory.candidates) === c.hash(targetCategory.candidates)) {
        markCarried(state, 'category', id, 'blocked');
      } else skipped(state, 'BLOCKED_CASE_CHANGED_OR_RESOLVED', 'category', id);
    }
  }

  for (const sourcePolicy of sourceBindings.policies.filter((row) => ['approved', 'blocked'].includes(row.reviewState))) {
    const sourceAttribute = sourceBindings.attributes.find((row) => row.bindingKey === sourcePolicy.bindingKey);
    if (!sourceAttribute) continue;
    const targetAttribute = targetAttributes.get(stableAttributeKey(sourceAttribute));
    const id = stableDecisionId('policy', sourceAttribute, sourcePolicy.storeCode);
    if (!targetAttribute) {
      if (sourcePolicy.reviewState === 'approved') blocker(state, 'APPROVED_TARGET_MISSING', 'policy', id);
      else skipped(state, 'BLOCKED_TARGET_ABSENT', 'policy', id);
      continue;
    }
    const targetPolicy = uniqueMatch(result.policies,
      (row) => row.bindingKey === targetAttribute.bindingKey && row.storeCode === sourcePolicy.storeCode,
      state, 'policy', id, sourcePolicy.reviewState === 'approved');
    if (!targetPolicy) {
      if (sourcePolicy.reviewState === 'blocked') skipped(state, 'BLOCKED_TARGET_ABSENT', 'policy', id);
      continue;
    }
    const stable = sameRemoteAttribute(sourceAttribute, targetAttribute, source.schema, target.schema)
      && sameRemoteStore(sourcePolicy.storeCode, source.schema, target.schema);
    if (sourcePolicy.reviewState === 'approved') {
      if (!stable) { blocker(state, 'POLICY_FIELD_OR_STORE_IDENTITY_CHANGED', 'policy', id); continue; }
      targetPolicy.policy = sourcePolicy.policy;
      targetPolicy.reviewState = 'approved';
      delete targetPolicy.evidence.createValue;
      if (sourcePolicy.evidence?.createValue !== undefined) {
        targetPolicy.evidence.createValue = sourcePolicy.evidence.createValue;
      }
      markCarried(state, 'policy', id, 'approved', { policy: sourcePolicy.policy });
    } else if (stable && targetPolicy.reviewState === 'blocked' && targetPolicy.policy === 'blocked'
      && unsupportedSignature(targetPolicy) === unsupportedSignature(sourcePolicy)) {
      markCarried(state, 'policy', id, 'blocked', { policy: 'blocked' });
    } else skipped(state, 'BLOCKED_CASE_CHANGED', 'policy', id);
  }

  const normalized = normalizeBindings(result);
  const validation = validateBindings(normalized, targetDefinition, target.schema);
  if (!validation.valid) blocker(state, 'RESULT_BINDING_INVALID', 'binding', target.id,
    { diagnostics: validation.diagnostics });
  for (const entry of entries({ ...target, bindings: normalizeBindings(target.bindings) })) {
    const id = entryStableId(entry);
    if (!state.carriedIds.has(id) && ['proposed', 'review_required', 'blocked'].includes(entry.decision.reviewState)) {
      skipped(state, 'TARGET_REMAINS_FOR_EXPLICIT_REVIEW', entry.kind, id,
        { reviewState: entry.decision.reviewState });
    }
  }
  const counts = Object.fromEntries(['proposed', 'review_required', 'approved', 'blocked'].map((reviewState) =>
    [reviewState, entries({ ...target, bindings: normalized }).filter((entry) => entry.decision.reviewState === reviewState).length]));
  const policyCounts = Object.fromEntries(['authoritative_create_update','initialize_create_only','magento_managed','blocked']
    .map((policy) => [policy, normalized.policies.filter((row) => row.reviewState === 'approved' && row.policy === policy).length]));
  const summary = {
    approvalsCarried: state.carried.filter((row) => row.reviewState === 'approved' && row.kind !== 'policy').length,
    blockedDecisionsCarried: state.carried.filter((row) => row.reviewState === 'blocked').length,
    policyDecisionsCarried: state.carried.filter((row) => row.kind === 'policy').length,
    intentionallySkippedOrNew: state.skipped.length,
    conflicts: state.blockers.length,
    resultReviewCounts: counts,
    resultApprovedPolicyCounts: policyCounts,
  };
  return { bindings: normalized, carried: state.carried, skipped: state.skipped,
    blockers: state.blockers, summary };
}

async function actorState(client, actorUserId) {
  return (await client.query(`SELECT u.status,
    EXISTS(SELECT 1 FROM user_role_assignments a
      JOIN roles r ON r.id=a.role_id AND r.status='active'
      JOIN role_permissions p ON p.role_id=r.id
      WHERE a.application_user_id=u.id AND a.revoked_at IS NULL
        AND p.permission_key='export_templates.manage') AS authorized
    FROM application_users u WHERE u.id=$1`, [actorUserId])).rows[0] || null;
}

async function templateDefinition(client, revision) {
  const row = (await client.query(`SELECT definition,definition_hash,evaluator_version,output_contract,format_version
    FROM export_template_versions WHERE id=$1`, [revision.templateVersionId])).rows[0];
  if (!row) fail('MAGENTO_BINDING_CARRY_TEMPLATE_MISSING', 'Binding template publication is missing');
  const compiled = compileDefinition(row.definition);
  if (compiled.hash !== row.definition_hash || compiled.hash !== revision.definitionHash
    || row.evaluator_version !== revision.evaluatorVersion || row.output_contract !== revision.outputContract
    || row.format_version !== revision.formatVersion) {
    fail('MAGENTO_BINDING_CARRY_TEMPLATE_INTEGRITY', 'Binding template identity is inconsistent');
  }
  return compiled.definition;
}

async function inspectClient(client, input) {
  c.identity(input.sourceId); c.identity(input.targetId);
  const sourceRevision = c.counter(input.sourceRevision); const targetRevision = c.counter(input.targetRevision);
  if (typeof input.expectedDatabase !== 'string' || !/^[A-Za-z0-9_-]{1,63}$/.test(input.expectedDatabase)
    || !Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0 || input.sourceId === input.targetId) c.invalid();
  const database = (await client.query('SELECT current_database() AS name')).rows[0].name;
  if (database !== input.expectedDatabase) fail('MAGENTO_BINDING_CARRY_DATABASE_MISMATCH', 'Target database differs');
  const source = await bindingService.readRevisionOnClient(client, input.sourceId);
  const target = await bindingService.readRevisionOnClient(client, input.targetId);
  await templateDefinition(client, source);
  const targetDefinition = await templateDefinition(client, target);
  const current = (await client.query(`SELECT id FROM magento_binding_revisions
    WHERE installation_key=$1 AND state='published' ORDER BY version_number DESC LIMIT 1`,
  [source.installationKey])).rows[0] || null;
  const actor = await actorState(client, input.actorUserId);
  const blockers = [];
  if (source.state !== 'published' || source.revision !== sourceRevision || current?.id !== source.id) {
    blockers.push({ code: 'SOURCE_NOT_CURRENT_PUBLICATION' });
  }
  if (target.state !== 'draft' || target.revision !== targetRevision) blockers.push({ code: 'TARGET_NOT_EXPECTED_DRAFT' });
  if (source.installationKey !== target.installationKey || source.originHash !== target.originHash) {
    blockers.push({ code: 'SOURCE_TARGET_INSTALLATION_MISMATCH' });
  }
  if (target.evaluatorVersion !== 'magento-declarative-3'
    || targetDefinition.sourceContractVersion !== 'public-product-identity-v1'
    || !Object.values(targetDefinition.sources).some((row) => row.kind === 'product' && row.field === 'public_sku')) {
    blockers.push({ code: 'TARGET_PUBLIC_SKU_CONTRACT_REQUIRED' });
  }
  if (!actor || actor.status !== 'active' || !actor.authorized) blockers.push({ code: 'ACTOR_UNAUTHORIZED' });
  const carry = carryReviewedBindings(source, target, targetDefinition);
  blockers.push(...carry.blockers);
  const plan = {
    format: FORMAT,
    database,
    actorUserId: input.actorUserId,
    installationKey: target.installationKey,
    source: { id: source.id, revision: source.revision, versionNumber: source.versionNumber,
      bindingHash: c.hash(source.bindings), templateVersionId: source.templateVersionId,
      definitionHash: source.definitionHash, schemaFingerprint: source.schemaFingerprint },
    target: { id: target.id, revision: target.revision, bindingHash: c.hash(target.bindings),
      templateVersionId: target.templateVersionId, definitionHash: target.definitionHash,
      evaluatorVersion: target.evaluatorVersion, sourceContractVersion: targetDefinition.sourceContractVersion,
      schemaFingerprint: target.schemaFingerprint },
    resultBindingHash: c.hash(carry.bindings),
    carried: carry.carried,
    skipped: carry.skipped,
    summary: carry.summary,
  };
  return { plan, blockers, resultBindings: carry.bindings };
}

async function preflight(input, options = {}) {
  const client = await (options.databasePool || pool).connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const inspected = await inspectClient(client, input);
    await client.query('COMMIT');
    return { artifactVersion: 1, kind: 'amber-magento-binding-reviewed-carry-forward-preflight',
      checkedAt: new Date().toISOString(), plan: inspected.plan, planHash: c.hash(inspected.plan), blockers: inspected.blockers };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

async function completedReceipt(client, targetId, planHash) {
  const rows = (await client.query(`SELECT details FROM audit_events WHERE event_key=$1
    AND subject_type='magento_binding' AND subject_id=$2 AND details->>'planHash'=$3 ORDER BY id`,
  [EVENT, targetId, planHash])).rows;
  if (rows.length > 1) fail('MAGENTO_BINDING_CARRY_RECEIPT_CONFLICT', 'Multiple carry-forward receipts exist');
  return rows[0]?.details?.receipt || null;
}

async function apply(input, options = {}) {
  if (!input.plan || input.plan.format !== FORMAT || input.plan.database !== input.expectedDatabase
    || input.plan.actorUserId !== input.actorUserId || input.planHash !== c.hash(input.plan)
    || !/^[a-f0-9]{64}$/.test(input.planHash || '')) c.invalid();
  const context = createMutationContext(options.mutationContext || { actorUserId: input.actorUserId });
  return runAccessAdminMutation({ databasePool: options.databasePool || pool, actorUserId: context.actorUserId,
    requiredPermission: 'export_templates.manage', createError: c.error, operation: async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
        [`amber_magento_binding:${input.plan.installationKey}`]);
      const previous = await completedReceipt(client, input.plan.target.id, input.planHash);
      if (previous) return { ...previous, alreadyApplied: true };
      await client.query(`SELECT id FROM magento_binding_revisions WHERE id=ANY($1::text[])
        ORDER BY id FOR UPDATE`, [[input.plan.source.id, input.plan.target.id]]);
      const inspected = await inspectClient(client, { expectedDatabase: input.expectedDatabase,
        actorUserId: input.actorUserId, sourceId: input.plan.source.id, sourceRevision: input.plan.source.revision,
        targetId: input.plan.target.id, targetRevision: input.plan.target.revision });
      if (inspected.blockers.length || c.hash(inspected.plan) !== input.planHash
        || c.hash(inspected.resultBindings) !== input.plan.resultBindingHash) {
        fail('MAGENTO_BINDING_CARRY_PREFLIGHT_STALE', 'Binding carry-forward preflight changed',
          { blockers: inspected.blockers });
      }
      const targetDefinition = await templateDefinition(client,
        await bindingService.readRevisionOnClient(client, input.plan.target.id));
      await repository.replaceBindings(client, input.plan.target.id, inspected.resultBindings,
        requirements(targetDefinition, (await bindingService.readRevisionOnClient(client, input.plan.target.id)).schema));
      const updated = (await client.query(`UPDATE magento_binding_revisions SET revision=revision+1,
        modified_by_user_id=$2,modified_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING revision`,
      [input.plan.target.id, context.actorUserId])).rows[0];
      const receipt = { planHash: input.planHash, sourceRevisionId: input.plan.source.id,
        sourceRevision: input.plan.source.revision, targetRevisionId: input.plan.target.id,
        targetRevisionBefore: input.plan.target.revision, targetRevisionAfter: updated.revision,
        resultBindingHash: input.plan.resultBindingHash, summary: input.plan.summary,
        carried: input.plan.carried, skipped: input.plan.skipped, conflicts: [] };
      await writeAuditEvent(client, { mutationContext: context, eventKey: EVENT,
        subjectType: 'magento_binding', subjectId: input.plan.target.id,
        details: { planHash: input.planHash, receipt } });
      return { ...receipt, alreadyApplied: false };
    } });
}

module.exports = { FORMAT, EVENT, carryReviewedBindings, inspectClient, preflight, apply };
