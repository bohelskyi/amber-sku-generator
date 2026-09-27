const { hash, error, safeData } = require('./binding-contract');
const { planPreview, comparison } = require('./sync-preview');
const { currentAssignments } = require('./sync-preview-categories');

const fail = (code) => { throw error(409, code, code); };
const equal = (a, b) => hash(a) === hash(b);
const clean = (v) => JSON.parse(JSON.stringify(v));
const links = (v) => [...v].sort((a, b) => String(a.category_id).localeCompare(String(b.category_id)));
function fields(raw) {
  return { ...raw, ...Object.fromEntries((raw?.custom_attributes || []).map((a) => [a.attribute_code, a.value])) };
}
function intent(report) {
  if (!report.sendable) fail('MAGENTO_SYNC_PLAN_NOT_SENDABLE');
  const core = clean(report.sendability.operations.coreProduct.candidatePayload);
  if (report.mode === 'create' && core.product.status !== 2) fail('MAGENTO_SYNC_CREATE_MUST_BE_DISABLED');
  if (report.mode === 'update' && Object.hasOwn(core.product, 'status')) fail('MAGENTO_SYNC_UPDATE_STATUS_MUST_BE_PRESERVED');
  const operations = [{ domain: 'coreProduct', payload: core }];
  const categoryLinks = report.sendability.operations.categories.candidateLinks;
  if (categoryLinks) operations.push({ domain: 'categories', payload: { product: { sku: core.product.sku,
    extension_attributes: { category_links: links(categoryLinks) } } } });
  if (report.transport.inventory.candidatePayload) operations.push({ domain: 'inventory', payload: report.transport.inventory.candidatePayload });
  for (const w of report.transport.websites.operations) operations.push({ domain: 'websites', payload: w.candidatePayload });
  if (report.transport.storeViews.candidatePayload) operations.push({ domain: 'storeViews', payload: report.transport.storeViews.candidatePayload });
  return clean({ version: 1, mode: report.mode, operations,
    websiteIds: report.transport.websites.requested.map((w) => w.websiteId).sort((a, b) => a - b),
    englishValues: Object.fromEntries(report.transport.storeViews.diff.filter((d) => d.authority === 'authoritative')
      .map((d) => [d.target, d.candidate])) });
}
function baseline(observation, report) {
  const { raw, domainEvidence } = observation;
  const written = fields(report.sendability.operations.coreProduct.candidatePayload.product);
  const preservation = {};
  if (raw) {
    for (const [k, v] of Object.entries(raw)) if (!['custom_attributes', 'extension_attributes', 'updated_at'].includes(k)
      && !Object.hasOwn(written, k)) preservation[`native.${k}`] = hash(v);
    for (const a of raw.custom_attributes || []) if (!Object.hasOwn(written, a.attribute_code) && a.attribute_code !== 'category_ids') {
      preservation[`custom.${a.attribute_code}`] = hash(a.value);
    }
    for (const [k, v] of Object.entries(raw.extension_attributes || {})) if (!['category_links', 'website_ids'].includes(k)) preservation[`extension.${k}`] = hash(v);
  }
  const keys = new Set([...Object.keys(report.currentMagento?.fields || {}), 'category_ids']);
  const minimized = raw ? { ...Object.fromEntries(['id', 'sku', 'attribute_set_id', 'name', 'price', 'type_id', 'status', 'visibility', 'weight']
    .filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])),
  custom_attributes: (raw.custom_attributes || []).filter((a) => keys.has(a.attribute_code)),
  extension_attributes: { category_links: raw.extension_attributes?.category_links,
    website_ids: raw.extension_attributes?.website_ids } } : null;
  return safeData(clean({ raw: minimized, domainEvidence, preservation }), [], 512 * 1024);
}
function replan(job, observation) {
  if (observation.categoryFailures?.length) fail('MAGENTO_SYNC_CATEGORY_READ_FAILED');
  const report = planPreview(observation.amber, observation.schema, job.baseline.raw, observation.categoryNodes,
    { domainEvidence: job.baseline.domainEvidence });
  if (!equal(intent(report), job.intent)) fail('MAGENTO_SYNC_PLAN_CHANGED');
}
function matchesProduct(payload, raw, schema) {
  if (!raw) return false;
  const values = fields(raw);
  return Object.entries(payload.product).every(([k, v]) => k === 'custom_attributes'
    ? v.every((a) => ['select', 'multiselect', 'boolean'].includes(schema?.attributes.find((x) => x.attribute_code === a.attribute_code)?.frontend_input)
      ? String(a.value) === String(values[a.attribute_code])
      : ['exact', 'numeric_equivalent_formatting'].includes(comparison(a.value, values[a.attribute_code] ?? null)))
    : k === 'extension_attributes' ? equal(links(v.category_links), links(currentLinks(raw) || []))
      : ['name', 'sku', 'type_id'].includes(k) ? v === values[k]
        : ['exact', 'numeric_equivalent_formatting'].includes(comparison(v, values[k] ?? null)));
}
function currentLinks(raw) {
  const c = currentAssignments(raw);
  return c.known ? c.links : null;
}
function matches(operation, observation) {
  const { raw, domainEvidence } = observation;
  if (!raw) return false;
  if (operation.domain === 'inventory') return operation.payload.sourceItems.every((i) => domainEvidence.inventory?.sourceItems.some((s) =>
    s.sourceCode === i.source_code && s.qty === i.quantity && Number(s.isInStock) === i.status));
  if (operation.domain === 'websites') return raw.extension_attributes?.website_ids?.includes(operation.payload.productWebsiteLink.website_id) === true;
  if (operation.domain === 'storeViews') return matchesProduct(operation.payload,
    domainEvidence.english ? { sku: domainEvidence.english.sku, ...domainEvidence.english.fields } : null);
  return matchesProduct(operation.payload, raw, observation.schema);
}
function preserve(job, observation) {
  if (!observation.raw) { if (job.intent.mode === 'update') fail('MAGENTO_SYNC_REMOTE_IDENTITY_CHANGED'); return; }
  const id = job.remote_product_id || job.baseline.raw?.id;
  if (id && Number(id) !== observation.raw.id) fail('MAGENTO_SYNC_REMOTE_IDENTITY_CHANGED');
  if (observation.raw.sku !== job.sku) fail('MAGENTO_SYNC_REMOTE_IDENTITY_CHANGED');
  for (const [path, expected] of Object.entries(job.baseline.preservation)) {
    const [kind, key] = path.split('.');
    const value = kind === 'native' ? observation.raw[key] : kind === 'extension' ? observation.raw.extension_attributes?.[key]
      : observation.raw.custom_attributes?.find((a) => a.attribute_code === key)?.value;
    if (value === undefined || hash(value) !== expected) fail('MAGENTO_SYNC_PRESERVED_FIELD_CHANGED');
  }
  if (job.intent.mode === 'update' && !equal(job.baseline.domainEvidence.inventory, observation.domainEvidence.inventory)) fail('MAGENTO_SYNC_INVENTORY_CHANGED');
  for (const id of job.baseline.raw?.extension_attributes?.website_ids || []) {
    if (!observation.raw.extension_attributes?.website_ids?.includes(id)) fail('MAGENTO_SYNC_WEBSITE_REMOVED');
  }
  for (const [k, v] of Object.entries(job.baseline.domainEvidence.english?.preservedFieldHashes || {})) {
    if (observation.domainEvidence.english?.preservedFieldHashes?.[k] !== v) fail('MAGENTO_SYNC_PRESERVED_EN_FIELD_CHANGED');
  }
}
function precondition(job, operation, observation) {
  if (matches(operation, observation)) return;
  if (operation.domain === 'inventory') {
    if (job.intent.mode !== 'create' || observation.raw?.status !== 2
      || observation.domainEvidence.inventory?.sourceItems.some((s) => s.qty !== 0)) fail('MAGENTO_SYNC_REMOTE_STATE_CHANGED');
    return;
  }
  if (operation.domain === 'websites') return; // Additive, never copies a stale complete list.
  if (operation.domain === 'storeViews' && job.intent.mode === 'create' && job.remote_product_id && observation.raw?.status === 2) return;
  if (operation.domain === 'categories') {
    if (!equal(links(currentLinks(observation.raw) || []), links(currentLinks(job.baseline.raw) || []))) fail('MAGENTO_SYNC_REMOTE_STATE_CHANGED');
    return;
  }
  const before = operation.domain === 'storeViews' ? job.baseline.domainEvidence.english?.fields || {} : fields(job.baseline.raw);
  const after = operation.domain === 'storeViews' ? observation.domainEvidence.english?.fields || {} : fields(observation.raw);
  if (operation.domain === 'coreProduct' && job.intent.mode === 'create') {
    if (observation.raw) fail('MAGENTO_SYNC_REMOTE_STATE_CHANGED');
    return;
  }
  const keys = Object.keys(fields(operation.payload.product)).filter((k) => !['sku', 'custom_attributes'].includes(k));
  if (keys.some((k) => !equal(before[k] ?? null, after[k] ?? null))) fail('MAGENTO_SYNC_REMOTE_STATE_CHANGED');
}
function verifyAll(job, observation) {
  preserve(job, observation);
  if (!job.intent.operations.every((op) => matches(op, observation))) fail('MAGENTO_SYNC_VERIFICATION_MISMATCH');
  if (!job.intent.websiteIds.every((id) => observation.raw?.extension_attributes?.website_ids?.includes(id))) fail('MAGENTO_SYNC_VERIFICATION_MISMATCH');
  for (const [k, value] of Object.entries(job.intent.englishValues)) {
    if (!['exact', 'numeric_equivalent_formatting'].includes(comparison(value, observation.domainEvidence.english?.fields[k] ?? null))) fail('MAGENTO_SYNC_VERIFICATION_MISMATCH');
  }
}
function preflight(job, observation) {
  preserve(job, observation);
  if (job.intent.mode !== 'update') return;
  // A new remote difference must not expand an already bound operation plan.
  for (const operation of job.intent.operations) precondition(job, operation, observation);
  const en = job.intent.operations.find((op) => op.domain === 'storeViews');
  const enWrites = fields(en?.payload.product);
  for (const [k, value] of Object.entries(job.intent.englishValues)) if (!Object.hasOwn(enWrites, k)
    && observation.domainEvidence.english?.fields[k] !== value) fail('MAGENTO_SYNC_REMOTE_STATE_CHANGED');
  for (const id of job.intent.websiteIds) if (!job.intent.operations.some((op) => op.domain === 'websites' && op.payload.productWebsiteLink.website_id === id)
    && !observation.raw?.extension_attributes?.website_ids?.includes(id)) fail('MAGENTO_SYNC_REMOTE_STATE_CHANGED');
}
module.exports = { intent, baseline, replan, matches, preserve, precondition, preflight, verifyAll, fail, clean };
