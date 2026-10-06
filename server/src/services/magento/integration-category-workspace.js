const c = require('./binding-contract');
const editor = require('./integration-editor.service');
const { getAppConfig } = require('../catalog/catalog-read-model');
const { review } = require('./binding-review');

const TEXT = new Set(['text', 'textarea']);
const PROTECTED = new Set(['sku', 'store_view_code', 'product_type']);
const EDITABLE = new Set(['text', 'textarea', 'select', 'multiselect', 'boolean', 'price', 'weight']);
const LABELS = { name: 'Назва товару', description: 'Опис', short_description: 'Короткий опис',
  meta_title: 'Заголовок у пошуку', meta_description: 'Опис у пошуку', meta_keyword: 'Ключові слова',
  categories: 'Категорії магазину', weight: 'Вага', price: 'Ціна', sku: 'Артикул', attribute_set_code: 'Набір характеристик' };
const REGULAR_NATIVE = new Set(Object.keys(LABELS).filter((code) => !['categories', 'sku', 'attribute_set_code'].includes(code)));
const SERVICE = new Set(['categories', 'attribute_set_code', 'category_ids', 'custom_layout_update', 'layout_update_xml',
  'external_id', 'old_id', 'has_options', 'required_options', 'has_enabled', 'url_key', 'image_label', 'small_image_label', 'thumbnail_label']);

function emptyLiteral(definition, expression, seen = new Set()) {
  if (expression?.op === 'ref' && !seen.has(expression.id)) return emptyLiteral(definition,
    definition.bindings.find((b) => b.id === expression.id)?.value, new Set([...seen, expression.id]));
  return expression?.op === 'literal' && (expression.value === '' || expression.value === null);
}

function fieldReview(binding, route, entries, remote, inSet, empty) {
  if (empty && !binding && !remote?.is_required) return [];
  const reasons = [];
  if (empty && remote?.is_required) reasons.push({ kind: 'text', message: 'Обов’язкове поле порожнє. Заповніть його текст або виберіть джерело.' });
  if (remote && !inSet) reasons.push({ kind: 'structure', message: 'Поле не входить до вибраного набору характеристик Magento. Перевірте набір або структуру магазину.' });
  if (!binding && !empty) reasons.push({ kind: 'attribute', message: 'Для цього правила ще немає підтвердженої прив’язки до поля Magento.' });
  if (route && (route.reviewState !== 'approved' || !route.enabled)) reasons.push({ kind: 'route', message: 'Набір характеристик цієї категорії ще не підтверджено або вимкнено.' });
  const messages = { attribute: 'Потрібно підтвердити, у яке поле Magento передаємо значення.',
    option: 'Є значення менеджера без підтвердженої відповідності Magento. Виберіть відповідності нижче.',
    policy: 'Виберіть, хто заповнює це поле: менеджер чи Magento.', category: 'Підтвердьте, у якій категорії магазину має бути товар.' };
  for (const kind of Object.keys(messages)) if (entries.some((e) => e.kind === kind && !['approved', 'not_applicable', 'blocked'].includes(e.reviewState))) reasons.push({ kind, message: messages[kind] });
  return reasons;
}

// Output provenance, not guard/readiness dependencies. Similar labels and unused
// source declarations cannot establish that a characteristic is transmitted.
function outputSources(definition, node, seen = new Set(), found = new Set()) {
  if (!node || typeof node !== 'object') return found;
  if (node.op === 'source') found.add(node.id);
  if (node.op === 'ref' && !seen.has(node.id)) {
    outputSources(definition, definition.bindings.find((b) => b.id === node.id)?.value, new Set([...seen, node.id]), found);
    return found;
  }
  if (node.op === 'when') {
    outputSources(definition, node.then, seen, found); outputSources(definition, node.else, seen, found); return found;
  }
  if (['require', 'questionValue'].includes(node.op)) return outputSources(definition, node.value, seen, found);
  Object.values(node).forEach((value) => { if (typeof value === 'object') outputSources(definition, value, seen, found); });
  return found;
}

function questionUsage(catalog, definition, categoryCode) {
  const group = definition?.groups.find((g) => g.route === categoryCode);
  return (catalog.questions[categoryCode] || []).map((q) => {
    const uses = [];
    for (const row of group?.rows || []) for (const [target, expression] of Object.entries(row.cells)) {
      if ([...outputSources(definition, expression)].some((id) => {
        const source = definition.sources[id];
        return source?.category === categoryCode && source.key === q.id && ['semantic', 'information'].includes(source.kind);
      })) uses.push({ target, rowId: row.id });
    }
    return { ...q, options: (q.options || []).filter((o) => !o.archived), uses };
  });
}

function projectCategory(catalog, revision, definition, categoryCode, input = {}) {
  if (!Object.hasOwn(catalog.categories, categoryCode)) throw c.error(404, 'MAGENTO_CATEGORY_NOT_FOUND', 'Категорію не знайдено.');
  const groupIndex = definition?.groups.findIndex((g) => g.route === categoryCode) ?? -1;
  const group = definition?.groups[groupIndex];
  const questions = questionUsage(catalog, definition, categoryCode);
  const routes = (revision?.bindings.routes || []).filter((r) => r.routeKey.split(/[.:]/)[0] === categoryCode);
  if (input.routeKey && !routes.some((r) => r.routeKey === input.routeKey)) c.invalid();
  const route = routes.find((r) => r.routeKey === input.routeKey) || routes[0];
  const rowId = input.rowId || 'base';
  const rowIndex = group?.rows.findIndex((r) => r.id === rowId) ?? -1;
  const row = group?.rows[rowIndex];
  const set = revision?.schema.attributeSets.find((s) => s.attribute_set_id === route?.setId);
  const decisions = revision ? review(revision, { group: categoryCode, routeKey: route?.routeKey, row: rowId }) : [];
  const codes = [...new Set([...(set?.attributeCodes || []), ...(group?.columns || [])])];
  const attributes = codes.map((code) => {
    const remote = revision?.schema.attributes.find((a) => a.attribute_code === code);
    const binding = revision?.bindings.attributes.find((a) => a.routeKey === route?.routeKey && a.rowId === rowId && (a.attributeCode || a.target) === code);
    const target = binding?.target || code;
    const expression = row?.cells[target];
    const sources = expression ? [...outputSources(definition, expression)].map((id) => {
      const source = definition.sources[id];
      const question = source?.category === categoryCode && questions.find((q) => q.id === source.key);
      return { id, ...source, label: question?.label || source?.field || source?.key || id };
    }) : [];
    const entries = decisions.filter((e) => e.target === target);
    const unresolved = entries.filter((e) => !['approved', 'not_applicable', 'blocked'].includes(e.reviewState)).length;
    const policy = entries.find((e) => e.kind === 'policy');
    const text = !['sku', 'weight', 'price', 'categories', 'attribute_set_code'].includes(code)
      && (TEXT.has(remote?.frontend_input) || ['name', 'description', 'short_description', 'meta_title', 'meta_description', 'meta_keyword'].includes(code));
    const service = PROTECTED.has(code) || SERVICE.has(code) || remote?.is_user_defined === false && !REGULAR_NATIVE.has(code);
    const empty = emptyLiteral(definition, expression);
    const reviewReasons = expression === undefined ? [] : fieldReview(binding, route, entries, remote, set?.attributeCodes.includes(code), empty);
    if (revision?.catalogAvailability?.resources.some((resource) => resource.attributeCode === code)) reviewReasons.push({
      kind: 'retired_resource', message: 'Цей тестовий ресурс Magento вже видалено. Чернетка збережена для історії й потребує нової підготовки від чинної публікації.' });
    const reason = PROTECTED.has(code) ? 'Системне правило захищено.'
      : remote && !set?.attributeCodes.includes(code) ? 'Атрибут не входить до вибраного набору Magento.'
        : remote && !EDITABLE.has(remote.frontend_input) ? 'Цей тип атрибута доступний лише для перегляду.'
          : !remote && !expression ? 'Опис атрибута недоступний.' : null;
    return { code, target, label: LABELS[code] || remote?.default_frontend_label || group?.columnLabels?.[target] || code,
      inputType: remote?.frontend_input ?? null, required: remote?.is_required ?? null, text, service, empty, reviewReasons,
      configured: expression !== undefined, sources, policy: policy?.identity || null, policyApproved: policy?.reviewState === 'approved',
      state: expression === undefined ? 'unmapped' : binding && ['blocked', 'not_applicable'].includes(binding.reviewState) ? 'excluded'
        : reviewReasons.length ? 'review' : empty && !binding ? 'empty' : 'connected',
      unresolved, editable: !reason && groupIndex >= 0, restriction: reason, inSet: set?.attributeCodes.includes(code) || false };
  });
  return { category: { code: categoryCode, name: catalog.categories[categoryCode].name },
    revision: revision ? { id: revision.id, revision: revision.revision, state: revision.state, publishedAt: revision.publishedAt || null, templateId: revision.templateId, templateVersionId: revision.templateVersionId,
      ...(revision.catalogAvailability ? { catalogAvailability: revision.catalogAvailability } : {}) } : null,
    observedAt: revision?.observedAt || null, groupIndex, rowIndex,
    routes: routes.map((r) => ({ ...r, setName: revision.schema.attributeSets.find((s) => s.attribute_set_id === r.setId)?.attribute_set_name || 'Набір ще не вибрано' })),
    routeKey: route?.routeKey || null, attributes, questions,
    placements: decisions.filter((e) => e.kind === 'category'),
    reviewScope: { categoryCount: definition?.groups.length || 0,
      unresolved: revision ? review(revision).filter((entry) =>
        !['approved', 'not_applicable', 'blocked'].includes(entry.reviewState))
        .map(({ group, target, row, kind, reviewState }) => ({ group, target, row, kind, reviewState })) : [] },
    unboundCount: questions.filter((q) => !q.uses.length).length,
    template: definition ? { id: revision.templateId, versionId: revision.templateVersionId, definition } : null };
}

function query(input) {
  c.command(input, [], ['bindingRevisionId', 'routeKey', 'rowId']);
  if (input.bindingRevisionId) c.identity(input.bindingRevisionId);
  if (input.routeKey !== undefined && (typeof input.routeKey !== 'string' || !input.routeKey || input.routeKey.length > 200)) c.invalid();
  if (input.rowId !== undefined && !['base', 'english'].includes(input.rowId)) c.invalid();
}
async function readCategory(config, categoryCode, input = {}, options = {}) {
  query(input);
  if (typeof categoryCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,31}$/.test(categoryCode)) c.invalid();
  const { selectedRevision: ignored, ...result } = await editor.read(options, (client) => categoryOnClient(client, config, categoryCode, input));
  void ignored; return result;
}
async function categoryOnClient(client, config, categoryCode, input) {
    const catalog = await getAppConfig(client);
    const revision = await editor.selected(client, config, input.bindingRevisionId);
    const compiled = revision ? await editor.compiledRevision(client, revision) : null;
    const result = projectCategory(catalog, revision, compiled?.compiled.definition, categoryCode, input);
    const current = revision ? await require('./binding-repository').current(client, revision.installationKey) : null;
    return { ...result, currentPublishedId: current?.id || null, selectedRevision: revision };
}
async function readField(config, categoryCode, field, input = {}, options = {}) {
  if (!c.code(field)) c.invalid();
  query(input);
  if (typeof categoryCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,31}$/.test(categoryCode)) c.invalid();
  return editor.read(options, async (client) => {
    const result = await categoryOnClient(client, config, categoryCode, input);
    const attribute = result.attributes.find((a) => a.code === field);
    if (!attribute) throw c.error(404, 'MAGENTO_FIELD_NOT_FOUND', 'Поле не знайдено в цій категорії.');
    const revision = result.selectedRevision;
    return { attribute, revision: result.revision, observedAt: result.observedAt,
      options: revision.schema.attributes.find((a) => a.attribute_code === field)?.options || [],
      entries: review(revision, { group: categoryCode, routeKey: result.routeKey, row: input.rowId || 'base', targets: [attribute.target] }) };
  });
}
async function observeCategory(config, categoryCode, input = {}, options = {}) {
  query(input);
  if (typeof categoryCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,31}$/.test(categoryCode)) c.invalid();
  const original = await editor.read(options, (client) => categoryOnClient(client, config, categoryCode, input));
  // Bounded remote GETs hold no local transactions or business locks.
  const observation = await editor.discovery(config, options);
  const current = await editor.read(options, (client) => categoryOnClient(client, config, categoryCode, input));
  if (current.revision?.id !== original.revision?.id || current.revision?.revision !== original.revision?.revision
    || current.currentPublishedId !== original.currentPublishedId) throw c.error(409, 'MAGENTO_BINDING_CONFLICT', 'Підключення змінилося під час читання Magento. Повторіть перевірку.');
  if (!current.selectedRevision) { const { selectedRevision: ignored, ...result } = current; void ignored; return result; }
  const revision = { ...current.selectedRevision, schema: observation.schema, observedAt: observation.observedAt };
  const catalog = { categories: { [categoryCode]: current.category }, questions: { [categoryCode]: current.questions } };
  const result = projectCategory(catalog, revision, current.template.definition, categoryCode, input);
  const comparison = require('./integration-structure-check').structureReport(current.selectedRevision, observation);
  for (const attribute of result.attributes) if (comparison.findings.some((f) => f.field === attribute.code && f.categoryCode === categoryCode)) {
    attribute.state = 'review';
    attribute.reviewReasons = [{ kind: 'structure', message: 'Структура цього поля в Magento змінилася. Перевірте актуальний набір, поле та значення перед підтвердженням прив’язки.' }];
  }
  return { ...result, currentPublishedId: current.currentPublishedId, liveObservation: true, comparison };
}
module.exports = { outputSources, questionUsage, projectCategory, readCategory, readField, observeCategory };
