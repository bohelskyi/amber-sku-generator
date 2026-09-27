const { validateBaseUrl } = require('../../config/magento');
const { signCategoryCreateRequest } = require('./oauth');
const { readJson } = require('./client');
const { error } = require('./binding-contract');

// Deliberately separate from the GET-only product/schema client. No arbitrary
// path, HTTP method, category name, update, or recursive tree creation API.
async function createInclusionCategory(config, body, { apply, fetchImpl = globalThis.fetch } = {}) {
  if (apply !== true) throw error(422, 'MAGENTO_CATEGORY_APPLY_REQUIRED', 'Explicit apply required');
  if (!config?.configured) throw error(422, 'MAGENTO_NOT_CONFIGURED', 'Configuration required');
  const category = body?.category;
  if (JSON.stringify(Object.keys(body || {}).sort()) !== '["category"]'
    || JSON.stringify(Object.keys(category || {}).sort()) !== '["include_in_menu","is_active","name","parent_id"]'
    || category.name !== 'З інклюзом' || category.is_active !== true || category.include_in_menu !== false
    || !Number.isSafeInteger(category.parent_id) || category.parent_id <= 0) {
    throw error(422, 'MAGENTO_CATEGORY_OPERATION_INVALID', 'Invalid category operation');
  }
  const url = `${validateBaseUrl(config.baseUrl)}/rest/all/V1/categories`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: signCategoryCreateRequest(url, config) },
      body: JSON.stringify(body) });
    if (!response.ok) throw error(502, 'MAGENTO_CATEGORY_CREATE_UNCERTAIN', 'Create outcome requires read verification');
    return await readJson(response);
  } catch {
    // Never expose remote error bodies or retry a POST automatically.
    throw error(502, 'MAGENTO_CATEGORY_CREATE_UNCERTAIN', 'Create outcome requires read verification');
  } finally {
    controller.abort(); clearTimeout(timer);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
module.exports = { createInclusionCategory };
