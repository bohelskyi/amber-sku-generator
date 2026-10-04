const editor = require('./integration-editor.service');
const { compareSchema } = require('./binding-drift');
const { normalizePath } = require('./sync-preview-categories');
const { hash } = require('./binding-contract');

const messages = {
  STORE_TOPOLOGY_CHANGED: 'Змінилася структура магазинів або мовних представлень.',
  ATTRIBUTE_SET_MISSING: 'Набір характеристик більше не доступний у Magento.',
  ATTRIBUTE_SET_LABEL_CHANGED: 'Назву набору характеристик змінено.',
  ATTRIBUTE_MISSING: 'Атрибут більше не доступний у Magento.',
  ATTRIBUTE_ID_CHANGED: 'Атрибут замінено іншим; попередній зв’язок потребує перевірки.',
  ATTRIBUTE_LABEL_CHANGED: 'Назву атрибута змінено.',
  ATTRIBUTE_METADATA_CHANGED: 'Тип або область застосування атрибута змінилася.',
  ATTRIBUTE_NOT_IN_EXPECTED_SET: 'Атрибут відсутній у потрібному наборі характеристик.',
  OPTION_ID_MISSING: 'Підключений варіант характеристики більше не доступний.',
  OPTION_ID_LABEL_CHANGED: 'Назва підключеного варіанта змінилася.',
  CATEGORY_PATH_CHANGED: 'Підключений розділ магазину відсутній або має інший шлях.',
  REQUIRED_ATTRIBUTE_ADDED: 'У наборі з’явився новий обов’язковий атрибут. Перевірте дані для створення товарів.',
};

// Structure evidence is deliberately separate from product delivery. Unused or
// explicitly refused draft material cannot become an operational failure.
function structureReport(revision, observation) {
  if (!revision) return { state: 'unavailable', reason: 'Немає опублікованого підключення для порівняння.', findings: [], productChecks: 0 };
  const routes = revision.bindings.routes.filter((route) => route.enabled && route.reviewState === 'approved');
  const routeKeys = new Set(routes.map((route) => route.routeKey));
  if (!routes.length) return { state: 'unavailable', reason: 'Немає підключених категорій для порівняння.', findings: [], productChecks: 0 };
  const attributes = revision.bindings.attributes.filter((attribute) => routeKeys.has(attribute.routeKey) && attribute.reviewState === 'approved');
  const keys = new Set(attributes.map((attribute) => attribute.bindingKey));
  const scoped = { ...revision, bindings: { ...revision.bindings, routes, attributes,
    options: revision.bindings.options.filter((option) => keys.has(option.bindingKey) && option.reviewState === 'approved') } };
  const compared = compareSchema(scoped, observation.schema);
  const diagnostics = compared.diagnostics.filter((item) => item.code !== 'SCHEMA_FINGERPRINT_CHANGED');
  const metadata = (attribute) => Object.fromEntries(Object.entries(attribute || {}).filter(([key]) => !['options', 'default_frontend_label', 'frontend_labels'].includes(key)));
  for (const attribute of attributes) {
    const before = revision.schema.attributes.find((item) => item.attribute_code === attribute.attributeCode);
    const after = observation.schema.attributes.find((item) => item.attribute_code === attribute.attributeCode);
    if (before && after && hash(metadata(before)) !== hash(metadata(after))
      && !diagnostics.some((item) => item.bindingKey === attribute.bindingKey && ['ATTRIBUTE_ID_CHANGED', 'ATTRIBUTE_METADATA_CHANGED'].includes(item.code))) {
      diagnostics.push({ code: 'ATTRIBUTE_METADATA_CHANGED', bindingKey: attribute.bindingKey, attributeCode: attribute.attributeCode });
    }
  }
  for (const route of routes) {
    const oldSet = revision.schema.attributeSets.find((item) => item.attribute_set_id === route.setId);
    const newSet = observation.schema.attributeSets.find((item) => item.attribute_set_id === route.setId);
    for (const code of newSet?.attributeCodes || []) {
      const after = observation.schema.attributes.find((item) => item.attribute_code === code);
      const before = revision.schema.attributes.find((item) => item.attribute_code === code);
      if ([true, 1].includes(after?.is_required) && (!oldSet?.attributeCodes.includes(code) || ![true, 1].includes(before?.is_required))) {
        diagnostics.push({ code: 'REQUIRED_ATTRIBUTE_ADDED', routeKey: route.routeKey, attributeCode: code });
      }
    }
  }
  for (const attribute of attributes) for (const category of attribute.evidence?.categories || []) {
    if (category.reviewState !== 'approved' || !category.categoryId) continue;
    const exact = observation.categories.find((node) => node.categoryId === String(category.categoryId));
    const path = category.normalizedPath || normalizePath(category.path || category.requestedPath || '');
    if (!exact?.comparable || exact.normalizedPath !== path) diagnostics.push({ code: 'CATEGORY_PATH_CHANGED',
      bindingKey: attribute.bindingKey, path: category.path || category.requestedPath || path });
  }
  const findings = diagnostics.map((item) => {
    const attribute = attributes.find((entry) => entry.bindingKey === item.bindingKey);
    const route = routes.find((entry) => entry.routeKey === (item.routeKey || attribute?.routeKey));
    const remote = observation.schema.attributes.find((entry) => entry.attribute_code === item.attributeCode)
      || revision.schema.attributes.find((entry) => entry.attribute_code === item.attributeCode);
    return { ...item, message: messages[item.code] || 'Потрібна перевірка налаштування.',
      categoryCode: route?.routeKey.split(/[.:]/)[0] || null, field: item.attributeCode || attribute?.target || null,
      label: remote?.default_frontend_label || item.attributeCode || route?.label || null };
  });
  return { state: findings.length ? 'needs_review' : 'checked', bindingRevisionId: revision.id,
    observedAt: observation.observedAt, routesChecked: routes.length, attributesChecked: attributes.length,
    productChecks: 0, findings };
}

async function check(config, options = {}) {
  const snapshot = () => editor.read(options, (client) => editor.selected(client, config));
  const revision = await snapshot();
  // No PostgreSQL transaction is held during the explicit bounded remote GETs.
  const observation = await editor.discovery(config, options);
  const current = await snapshot();
  const comparison = current?.id !== revision?.id || current?.revision !== revision?.revision
    ? { state: 'stale', reason: 'Підключення змінилося під час перевірки. Перевірте структуру ще раз.', findings: [], productChecks: 0 }
    : structureReport(revision, observation);
  return { ...observation, comparison };
}
module.exports = { check, structureReport };
