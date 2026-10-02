const { createMagentoClient } = require('./client');
const { bindingKey } = require('./binding-validation');
const { hash } = require('./binding-contract');

const present = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const positiveId = (v) => Number.isSafeInteger(v) && v > 0;
const controls = new Set(['sku', 'product_type', 'attribute_set_code', 'store_view_code']);
function invalid() { throw Object.assign(new Error('Invalid bounded domain evidence'), { code: 'MAGENTO_RESPONSE_INVALID' }); }

// These are Magento 2.4.6 MSI read contracts, not legacy stock-item write assumptions.
async function readDomains(config, { client, schema, sku, raw, expected, fetchImpl }) {
  const evidence = { inventory: null, english: null, failures: [] };
  if (present(expected.base.qty) || present(expected.base.is_in_stock)) {
    try {
      const stock = await client.getInventoryStockForWebsite('base');
      if (!positiveId(stock?.stock_id) || !stock.extension_attributes?.sales_channels?.some((s) => s.type === 'website' && s.code === 'base')) invalid();
      const sources = await client.getInventorySourcesForStock(stock.stock_id);
      const items = await client.getInventorySourceItemsBySku(sku);
      if (!Array.isArray(sources) || sources.length > 100 || sources.some((s) => typeof s.source_code !== 'string' || !/^[\w-]{1,100}$/.test(s.source_code)
        || typeof s.enabled !== 'boolean') || new Set(sources.map((s) => s.source_code)).size !== sources.length
        || !Array.isArray(items?.items) || items.items.length > 100 || items.total_count !== items.items.length
        || items.items.some((i) => i.sku !== sku || typeof i.source_code !== 'string' || !/^[\w-]{1,100}$/.test(i.source_code)
          || typeof i.quantity !== 'number' || !Number.isFinite(i.quantity) || ![0, 1].includes(i.status))
        || new Set(items.items.map((i) => i.source_code)).size !== items.items.length) invalid();
      evidence.inventory = { stockId: stock.stock_id, websiteCode: 'base',
        sources: sources.map((s) => ({ sourceCode: s.source_code, enabled: s.enabled })),
        sourceItems: items.items.map((i) => ({ sourceCode: i.source_code, qty: i.quantity, isInStock: i.status === 1 })) };
    } catch (cause) { evidence.failures.push({ code: 'INVENTORY_READ_UNAVAILABLE', operation: 'inventory', reason: safeReason(cause) }); }
  }
  const code = expected.english.store_view_code;
  const views = schema.storeTopology.storeViews.filter((s) => s.code === code && s.is_active === true);
  if (raw && views.length === 1) {
    try {
      const product = await createMagentoClient(config, { fetchImpl, storeCode: code }).findProductBySku(sku);
      if (product.id !== raw.id || product.sku !== sku || !Array.isArray(product.custom_attributes)
        || product.custom_attributes.length > 1000
        || new Set(product.custom_attributes.map((a) => a.attribute_code)).size !== product.custom_attributes.length) invalid();
      const fields = { name: product.name };
      const targets = new Set(Object.keys(expected.english));
      for (const a of product.custom_attributes) if (targets.has(a.attribute_code)) fields[a.attribute_code] = a.value;
      evidence.english = { id: product.id, sku: product.sku, fields,
        preservedFieldHashes: Object.fromEntries(product.custom_attributes.filter((a) => !present(expected.english[a.attribute_code])
          && schema.attributes.some((s) => s.attribute_code === a.attribute_code && s.scope === 'store'))
          .map((a) => [a.attribute_code, hash(a.value)])),
        preservedFields: product.custom_attributes.filter((a) => !targets.has(a.attribute_code)).map((a) => a.attribute_code) };
    } catch (cause) { evidence.failures.push({ code: 'STORE_VIEW_READ_UNAVAILABLE', operation: 'storeViews', reason: safeReason(cause) }); }
  }
  return evidence;
}
function safeReason(cause) {
  return /^MAGENTO_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'MAGENTO_READ_FAILED';
}

function planDomains({ expected, schema, revision, routeKey, raw, sku, evidence = {}, block }) {
  const binding = (target, row = 'base') => revision?.bindings.attributes.find((a) => a.routeKey === routeKey && a.rowId === row && a.target === target);
  const policy = (target, row = 'base') => {
    const key=bindingKey(routeKey || '', row, target);
    return revision?.bindings.policies.find((p) => p.bindingKey === key && p.storeCode === (row === 'english' ? 'en' : 'all'));
  };
  function approved(target, operation, requiredPolicy, row = 'base') {
    const a = binding(target, row); const p = policy(target, row);
    if (a?.reviewState !== 'approved') block(`${operation === 'storeViews' ? 'STORE_VIEW' : operation.toUpperCase().replace(/S$/, '')}_BINDING_REVIEW_REQUIRED`, { operation, target });
    if (p?.reviewState !== 'approved' || p.policy !== requiredPolicy) block('DOMAIN_POLICY_REVIEW_REQUIRED', { operation, target, requiredPolicy });
    return a?.reviewState === 'approved' && p?.reviewState === 'approved' && p.policy === requiredPolicy;
  }
  for (const failure of evidence.failures || []) block(failure.code, failure);
  const inventory = { expected: { qty: expected.base.qty ?? null, is_in_stock: expected.base.is_in_stock ?? null },
    initialization: { qty: 1, is_in_stock: true }, current: evidence.inventory || null,
    evidenceSource: 'Magento_InventoryApi source-items / InventorySalesApi stock-resolver',
    quantityMeaning: 'Physical source quantity/status; not reservation-adjusted salable quantity',
    action: raw ? 'preserve' : 'initialize_after_create', candidatePayload: null, status: 'not_applicable' };
  if (present(expected.base.qty) || present(expected.base.is_in_stock)) {
    const qtyApproved = approved('qty', 'inventory', 'initialize_create_only');
    const stockApproved = approved('is_in_stock', 'inventory', 'initialize_create_only');
    inventory.authority = qtyApproved && stockApproved ? 'authoritative' : 'candidate_only';
    inventory.status = evidence.inventory ? 'read' : 'unresolved';
    if (!evidence.inventory) block('INVENTORY_EVIDENCE_UNAVAILABLE');
    if (Number(expected.base.qty) !== 1 || !['1', 'true'].includes(String(expected.base.is_in_stock))) block('INVENTORY_INITIAL_VALUE_INVALID');
    if (!raw && evidence.inventory) {
      const sources = evidence.inventory.sources.filter((s) => s.enabled);
      if (evidence.inventory.sourceItems.length) block('INVENTORY_ORPHAN_SOURCE_ITEMS_PRESENT');
      else if (sources.length !== 1) block('INVENTORY_CREATE_SOURCE_UNRESOLVED');
      else inventory.candidatePayload = { sourceItems: [{ sku, source_code: sources[0].sourceCode, quantity: 1, status: 1 }] };
    }
  }

  const websiteCodes = String(expected.base.product_websites || '').split(',').map((c) => c.trim()).filter(Boolean);
  const websiteIds = raw?.extension_attributes?.website_ids;
  const currentKnown = !raw || (Array.isArray(websiteIds) && websiteIds.length <= 100 && websiteIds.every(positiveId)
    && new Set(websiteIds).size === websiteIds.length);
  const websites = { policy: 'ensure_membership_preserve_additional', currentIds: raw ? currentKnown ? websiteIds : null : [],
    requested: [], wouldAdd: [], preservedAdditionalIds: [], operations: [], action: 'unchanged' };
  if (websiteCodes.length) {
    const authorized = approved('product_websites', 'websites', 'authoritative_create_update');
    if (!currentKnown) block('WEBSITE_ASSIGNMENTS_UNAVAILABLE');
    for (const code of [...new Set(websiteCodes)]) {
      const matches = schema.storeTopology.websites.filter((w) => w.code === code && positiveId(w.id));
      const pinned = revision?.schema.storeTopology.websites.filter((w) => w.code === code) || [];
      const websiteId = matches.length === 1 ? matches[0].id : null;
      const stable = pinned.length === 1 && pinned[0].id === websiteId;
      websites.requested.push({ code, websiteId, authority: authorized && stable ? 'authoritative' : 'candidate_only' });
      if (websiteId === null) block('WEBSITE_IDENTITY_UNRESOLVED', { codeRequested: code });
      else if (!stable) block('WEBSITE_IDENTITY_REVIEW_REQUIRED', { codeRequested: code, websiteId });
      if (currentKnown && websiteId !== null && !websites.currentIds.includes(websiteId)) {
        websites.wouldAdd.push(websiteId);
        websites.operations.push({ contract: 'ProductWebsiteLinkRepositoryInterface.save',
          candidatePayload: { productWebsiteLink: { sku, website_id: websiteId } } });
      }
    }
    websites.preservedAdditionalIds = (websites.currentIds || []).filter((id) => !websites.requested.some((w) => w.websiteId === id));
    websites.action = websites.wouldAdd.length ? 'would_add' : currentKnown ? 'unchanged' : 'unresolved';
  }

  const english = expected.english;
  const storeViews = { englishTemplateValues: english, storeCode: english.store_view_code ?? null, storeId: null,
    current: evidence.english || null, diff: [], preservedFields: [...(evidence.english?.preservedFields || [])],
    candidatePayload: null, action: 'not_applicable', scope: 'store_only_nonempty_values' };
  if (Object.entries(english).some(([k, v]) => !controls.has(k) && present(v))) {
    const views = schema.storeTopology.storeViews.filter((v) => v.code === english.store_view_code && v.is_active === true);
    const pinned = revision?.schema.storeTopology.storeViews.find((v) => v.code === english.store_view_code);
    const view = views.length === 1 ? views[0] : null;
    storeViews.storeId = view?.id ?? null;
    if (!view || view.code !== 'en') block('STORE_VIEW_IDENTITY_UNRESOLVED');
    else if (!pinned || pinned.id !== view.id || pinned.website_id !== view.website_id || pinned.store_group_id !== view.store_group_id) block('STORE_VIEW_IDENTITY_REVIEW_REQUIRED');
    if (raw && !evidence.english) block('STORE_VIEW_CURRENT_PRODUCT_UNAVAILABLE');
    const payload = { sku, custom_attributes: [] };
    for (const [target, value] of Object.entries(english)) {
      if (controls.has(target)) {
        approved(target, 'storeViews', 'magento_managed', 'english');
        if ((target === 'sku' && value !== sku) || (target === 'product_type' && value !== expected.base.product_type)
          || (target === 'attribute_set_code' && value !== expected.base.attribute_set_code)) block('STORE_VIEW_IDENTITY_CONTROL_MISMATCH', { target });
        continue; // Routing/identity only; never write global fields through the scoped operation.
      }
      const current = evidence.english?.fields[target] ?? null;
      if (!present(value)) {
        storeViews.diff.push({ target, current, evaluated: value ?? null, action: 'preserve', reason: 'empty_template_value' });
        storeViews.preservedFields.push(target); continue;
      }
      const authorized = approved(target, 'storeViews', 'authoritative_create_update', 'english');
      const a = binding(target, 'english');
      const attribute = schema.attributes.find((x) => x.attribute_code === (a?.attributeCode || target));
      const oldAttribute = revision?.schema.attributes.find((x) => x.attribute_code === (a?.attributeCode || target));
      const route = revision?.bindings.routes.find((r) => r.routeKey === routeKey);
      const selected = schema.attributeSets.find((s) => s.attribute_set_id === route?.setId);
      const supported = attribute?.scope === 'store' && ['text', 'textarea'].includes(attribute.frontend_input)
        && attribute.attribute_code === target && (!attribute.apply_to?.length || attribute.apply_to.includes(expected.base.product_type))
        && selected?.attributeCodes.includes(target) && oldAttribute?.attribute_id === attribute.attribute_id;
      if (!supported) block('STORE_VIEW_ATTRIBUTE_UNSUPPORTED', { target });
      const same = current === value;
      const action = !supported || !authorized ? 'blocked' : same ? 'unchanged' : current === null ? 'would_add' : 'would_update';
      storeViews.diff.push({ target, current, evaluated: value, candidate: supported ? value : null,
        authority: authorized ? 'authoritative' : 'candidate_only', action });
      if (supported && authorized && !same) {
        if (target === 'name') payload.name = value;
        else payload.custom_attributes.push({ attribute_code: target, value });
      }
    }
    if (payload.name !== undefined || payload.custom_attributes.length) storeViews.candidatePayload = { product: payload };
    storeViews.action = storeViews.candidatePayload ? 'would_update' : 'unchanged';
  }
  return { inventory, websites, storeViews };
}
module.exports = { readDomains, planDomains };
