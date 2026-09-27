const c = require('./binding-contract');

function entries(revision) {
  const b = revision.bindings;
  const context = (a) => ({ routeKey: a.routeKey, group: a.routeKey.split(/[.:]/)[0], row: a.rowId, target: a.target });
  const result = b.routes.map((r) => ({ id: `route:${r.routeKey}`, kind: 'route', routeKey: r.routeKey,
    group: r.routeKey.split(/[.:]/)[0], target: 'attribute_set_code', decision: r,
    identity: r.setId, label: revision.schema.attributeSets.find((s) => s.attribute_set_id === r.setId)?.attribute_set_name ?? null }));
  for (const a of b.attributes) {
    const attr = revision.schema.attributes.find((v) => v.attribute_code === (a.attributeCode || a.target));
    result.push({ id: `attribute:${a.bindingKey}`, kind: 'attribute', ...context(a), decision: a,
      identity: a.transportTarget || attr?.attribute_id || null, label: a.attributeCode || a.target });
    for (const o of b.options.filter((v) => v.bindingKey === a.bindingKey)) result.push({
      id: `option:${a.bindingKey}:${c.hash(o.sourceKey)}`, kind: 'option', ...context(a), decision: o,
      identity: o.optionId, source: o.sourceKey, evaluated: o.evaluatedOutput,
      label: attr?.options.find((v) => v.value === o.optionId)?.label ?? null });
    for (const p of b.policies.filter((v) => v.bindingKey === a.bindingKey)) result.push({
      id: `policy:${a.bindingKey}:${p.storeCode}`, kind: 'policy', ...context(a), decision: p,
      identity: p.policy, label: p.storeCode });
    for (const category of a.evidence.categories || []) result.push({
      id: `category:${a.bindingKey}:${c.hash(category.normalizedPath)}`, kind: 'category', ...context(a), decision: category,
      identity: category.categoryId, label: category.requestedPath });
  }
  return result;
}
function exact(entry, revision) {
  const d = entry.decision;
  if (d.reviewState !== 'proposed') return false;
  const codes = d.evidence?.diagnosticCodes || [];
  if (entry.kind === 'route') return codes.includes('EXACT_SET_NAME') && revision.schema.attributeSets.filter((s) =>
    s.attribute_set_name === entry.label).length === 1;
  if (entry.kind === 'attribute') return codes.some((v) => ['EXACT_ATTRIBUTE_CODE', 'NATIVE_CONTROL'].includes(v));
  if (entry.kind === 'option') {
    const a = revision.bindings.attributes.find((a) => a.bindingKey === d.bindingKey);
    const attr = revision.schema.attributes.find((v) => v.attribute_code === a.attributeCode);
    return codes.includes('EXACT_OPTION_LABEL') && attr.options.filter((o) => !o.isEmpty && o.label === d.evaluatedOutput).length === 1
      && entry.label === d.evaluatedOutput;
  }
  return entry.kind === 'category' && d.candidates.length === 1 && d.categoryId === d.candidates[0].categoryId;
}
function filtered(revision, { group, routeKey, row, targets, states } = {}) {
  return entries(revision).filter((e) => (!group || e.group === group) && (!routeKey || e.routeKey === routeKey)
    && (!row || !e.row || e.row === row) && (!targets || targets.includes(e.target))
    && (!states || states.includes(e.decision.reviewState)));
}
function review(revision, scope = {}) {
  return filtered(revision, scope).map(({ decision, ...e }) => ({ ...e, reviewState: decision.reviewState,
    exact: exact({ ...e, decision }, revision), evidence: decision.evidence || null,
    ...(e.kind === 'category' ? { candidates: decision.candidates, note: decision.note || null } : {}) }));
}
function decide(revision, input) {
  if (revision.state !== 'draft' || revision.revision !== c.counter(input.expectedRevision)) {
    throw c.error(409, 'MAGENTO_BINDING_CONFLICT', 'Review revision changed');
  }
  const copy = structuredClone(revision);
  let chosen;
  if (input.action === 'approve-exact') {
    if ((!input.group && !input.routeKey) || (input.group && input.routeKey) || input.policy) c.invalid();
    chosen = filtered(copy, input).filter((e) => e.kind !== 'policy' && exact(e, copy));
  } else {
    chosen = entries(copy).filter((e) => e.id === input.binding);
    if (chosen.length !== 1 || !['approve', 'block'].includes(input.action)) c.invalid();
  }
  if (!chosen.length || chosen.length > 1000) throw c.error(422, 'MAGENTO_BINDING_SELECTION_EMPTY', 'No eligible bindings in bounded selection');
  if (input.createValue !== undefined && (input.action !== 'approve' || input.createValue !== '2'
    || input.policy !== 'initialize_create_only' || chosen.length !== 1
    || chosen[0].kind !== 'policy' || chosen[0].target !== 'product_online' || chosen[0].row !== 'base')) c.invalid();
  for (const e of chosen) {
    const d = e.decision;
    if (input.action === 'block') {
      if (!input.reason?.trim()) c.invalid();
      d.reviewState = 'blocked';
      if (e.kind === 'policy') d.policy = 'blocked';
    } else {
      if (e.identity === null) throw c.error(422, 'MAGENTO_BINDING_UNRESOLVED', 'No unique candidate identity to approve');
      if (!exact(e, copy) && (!input.acceptReview || !input.reason?.trim())) {
        throw c.error(422, 'MAGENTO_BINDING_REVIEW_ACK_REQUIRED', 'Explicit review acknowledgment and reason required');
      }
      if (e.kind === 'policy') {
        if (!['authoritative_create_update', 'initialize_create_only', 'magento_managed'].includes(input.policy)) c.invalid();
        d.policy = input.policy;
        // The existing 041 evidence document holds this narrowly typed native policy.
        // It is not an arbitrary evaluator override or a new option mapping.
        delete d.evidence.createValue;
        if (input.createValue !== undefined) d.evidence.createValue = Number(input.createValue);
      } else if (input.policy) c.invalid();
      d.reviewState = 'approved';
      if (e.kind === 'route') d.enabled = true;
    }
    if (input.reason) {
      if (e.kind === 'category') d.note = input.reason;
      else d.evidence = { ...d.evidence, note: input.reason };
    }
  }
  return { bindings: copy.bindings, changed: chosen.map((e) => e.id) };
}
async function saveDecision(id, input, options = {}) {
  const service = options.bindingService || require('./binding.service');
  const current = await service.getRevision(id, options);
  const change = decide(current, input);
  const revision = await service.updateDraft(id, { expectedRevision: input.expectedRevision, bindings: change.bindings }, options);
  return { revision, changed: change.changed };
}
module.exports = { entries, review, decide, saveDecision };
