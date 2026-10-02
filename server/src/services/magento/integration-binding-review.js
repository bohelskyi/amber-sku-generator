const c = require('./binding-contract');
const service = require('./binding.service');
const review = require('./binding-review');
const editor = require('./integration-editor.service');

async function get(config, id, options = {}) {
  const revision = await editor.read(options, (client) => editor.selected(client, config, id));
  return { revision, entries: review.review(revision), validation: await service.validateDraft(id, options) };
}
function choose(revision, input) {
  c.command(input, ['expectedRevision','binding','identity']);
  if (revision.state !== 'draft' || revision.revision !== c.counter(input.expectedRevision)) throw c.error(409, 'MAGENTO_BINDING_CONFLICT', 'Draft changed');
  const next = structuredClone(revision);
  const entry = review.entries(next).find((e) => e.id === input.binding);
  if (!entry || !['route','option','category'].includes(entry.kind)) c.invalid();
  const decision = entry.decision;
  if (entry.kind === 'route') {
    if (!revision.schema.attributeSets.some((s) => s.attribute_set_id === input.identity)) c.invalid();
    decision.setId = input.identity; decision.enabled = true;
  } else if (entry.kind === 'option') {
    const attribute = next.bindings.attributes.find((a) => a.bindingKey === decision.bindingKey);
    const remote = next.schema.attributes.find((a) => a.attribute_code === attribute.attributeCode);
    if (!remote?.options.some((o) => !o.isEmpty && o.value === input.identity) || decision.evaluatedOutput === null) c.invalid();
    decision.optionId = input.identity;
  } else {
    if (!decision.candidates.some((candidate) => candidate.categoryId === input.identity)) c.invalid();
    decision.categoryId = input.identity;
  }
  decision.reviewState = 'review_required';
  if (entry.kind !== 'category') decision.evidence = { ...decision.evidence, diagnosticCodes: ['EXPLICIT_CANDIDATE_SELECTION'], candidateIds: [String(input.identity)] };
  return next.bindings;
}
async function select(config, id, input, options = {}) {
  const { revision } = await get(config, id, options);
  return service.updateDraft(id, { expectedRevision: input.expectedRevision, bindings: choose(revision, input) }, options);
}
async function decide(config, id, input, options = {}) {
  c.command(input, ['expectedRevision','binding','action'], ['acceptReview','reason','policy','createValue']);
  if (input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.trim().length > 2000)) c.invalid();
  if (input.acceptReview !== undefined && typeof input.acceptReview !== 'boolean') c.invalid();
  const { revision } = await get(config, id, options);
  const change = review.decide(revision, input);
  return service.updateDraft(id, { expectedRevision: input.expectedRevision, bindings: change.bindings }, options);
}
module.exports = { get, choose, select, decide };
