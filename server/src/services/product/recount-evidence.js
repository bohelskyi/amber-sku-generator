const { hashPayload } = require('../pricing/pricing-context-fingerprint');
const { getRecountStateSignature } = require('./product-signatures');
const { inheritRecountNames } = require('./recount-name-inheritance');
const { getSchemaVersionById } = require('../sku-schema.service');
const { readLineageExposure } = require('../full-product-export-exposure');
const { readFullProductStates } = require('../full-product-export.service');

const RECOUNT_EVIDENCE_VERSION = 2;

function refreshRequired() {
  return Object.assign(new Error('Товар, назви або стан доставки змінилися. Оновіть запит або preview переобліку.'),
    { statusCode: 409, publicCode: 'RECOUNT_REFRESH_REQUIRED',
      details: { type: 'stale_correction_request', refreshRequired: true } });
}

// All callers use this derivation. A write caller already owns the source product
// and any existing request/SKU locks before acquiring ascending lifecycle locks.
async function buildRecountEvidence(client, source, target, decodedAnswers, { lock = false } = {}) {
  let disposition = await readLineageExposure(client, Number(source.id), source);
  const states = await readFullProductStates(client, disposition.productIds, { lock });
  // Confirmation never locks products. Re-read its exposure after the lifecycle
  // lock wait, so completion cannot apply evidence from before that confirmation.
  if (lock) disposition = await readLineageExposure(client, Number(source.id), source);
  const schema = await getSchemaVersionById(target.skuSchemaVersionId, client);
  const questions = (await client.query(`SELECT key, include_in_sku, input_type
    FROM questions WHERE category_code=$1 ORDER BY id`, [target.categoryCode])).rows;
  const names = inheritRecountNames(source, target, schema, questions, decodedAnswers);
  const binding = { version: RECOUNT_EVIDENCE_VERSION,
    sourceState: getRecountStateSignature(source),
    lifecycle: states.map((s) => ({ productId: Number(s.product_id), revision: String(s.revision),
      confirmedRevision: String(s.confirmed_revision), deliveryVersion: String(s.delivery_version),
      route: s.route, holdReason: s.hold_reason, sourceCorrectionId: s.source_correction_id,
      evidence: s.evidence })),
    lineage: disposition.lineage, exposure: disposition.evidence,
    route: disposition.route, holdReason: disposition.holdReason, names };
  return { binding, signature: hashPayload(binding), disposition, names,
    delivery: { route: disposition.route, holdReason: disposition.holdReason,
      exposure: disposition.evidence.classification, nameReviewRequired: names.reviewRequired } };
}

module.exports = { buildRecountEvidence, RECOUNT_EVIDENCE_VERSION, refreshRequired };
