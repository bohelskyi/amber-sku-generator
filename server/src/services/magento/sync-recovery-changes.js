const { hash, safeData } = require('./binding-contract');
const { currentAssignments } = require('./sync-preview-categories');
const currentLinks = (raw) => currentAssignments(raw).links || [];
const labels = { name: 'Назва', price: 'Ціна', weight: 'Вага', status: 'Доступність товару', visibility: 'Видимість у магазині',
  type_id: 'Тип товару', attribute_set_id: 'Набір характеристик', sku: 'Артикул' };

// Only fields in the immutable original operation are shown. This projection
// never creates a replacement intent or copies unrelated Magento attributes.
function unsentChanges(job, steps, observation) {
  if (!observation) return [];
  const output = [];
  const schema = observation.schema;
  const category = (id) => observation.categoryNodes?.find((n) => n.categoryId === String(id))?.path || `Категорія ${id}`;
  const categoryLinks = (links) => (links || []).map((v) => `${category(v.category_id)} · позиція ${v.position ?? 'невідома'}`).join('; ');
  const display = (key, value) => {
    if (value === null || value === undefined) return null;
    if (key === 'status') return Number(value) === 2 ? 'Вимкнено' : Number(value) === 1 ? 'Увімкнено' : String(value);
    if (key === 'attribute_set_id') return schema.attributeSets?.find((s) => s.attribute_set_id === Number(value))?.attribute_set_name || String(value);
    const attribute = schema.attributes?.find((a) => a.attribute_code === key);
    if (['select', 'multiselect'].includes(attribute?.frontend_input)) {
      return String(value).split(',').map((id) => attribute.options?.find((o) => o.value === id)?.label || id).join('; ');
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  };
  const add = (ordinal, label, before, after) => {
    if (hash(before ?? null) !== hash(after ?? null)) output.push({ ordinal, label, before: before ?? null, after: after ?? null });
  };
  for (const item of steps.filter((s) => s.state === 'not_sent' && !s.matches)) {
    const { ordinal } = item; const operation = job.intent.operations[ordinal]; const payload = operation.payload;
    if (['coreProduct', 'storeViews'].includes(operation.domain)) {
      const source = operation.domain === 'storeViews' ? observation.domainEvidence.english?.fields || {} : {
        ...observation.raw, ...Object.fromEntries((observation.raw?.custom_attributes || []).map((a) => [a.attribute_code, a.value])),
      };
      const fields = { ...payload.product, ...Object.fromEntries((payload.product.custom_attributes || []).map((a) => [a.attribute_code, a.value])) };
      for (const [key, value] of Object.entries(fields)) {
        if (['custom_attributes', 'extension_attributes', 'sku'].includes(key)) continue;
        const label = labels[key] || schema.attributes?.find((a) => a.attribute_code === key)?.default_frontend_label || `Поле «${key}»`;
        add(ordinal, operation.domain === 'storeViews' ? `${label} (англійська)` : label, display(key, source[key]), display(key, value));
      }
      if (payload.product.extension_attributes?.category_links) add(ordinal, 'Категорії',
        categoryLinks(currentLinks(observation.raw)), categoryLinks(payload.product.extension_attributes.category_links));
    } else if (operation.domain === 'categoryLinkDelete' || operation.domain === 'categoryLinkSave') {
      const id = operation.domain === 'categoryLinkDelete' ? payload.categoryId : payload.productLink.category_id;
      const before = (currentLinks(observation.raw) || []).find((v) => v.category_id === String(id));
      const after = operation.domain === 'categoryLinkDelete' ? null : payload.productLink;
      add(ordinal, `Категорія: ${category(id)}`, before ? categoryLinks([before]) : null, after ? categoryLinks([after]) : null);
    } else if (operation.domain === 'categories') {
      add(ordinal, 'Категорії', categoryLinks(currentLinks(observation.raw)), categoryLinks(payload.product.extension_attributes.category_links));
    } else if (operation.domain === 'websites') {
      const id = payload.productWebsiteLink.website_id;
      const name = schema.storeTopology?.websites?.find((w) => w.id === id)?.name || `Вебсайт ${id}`;
      add(ordinal, `Магазин: ${name}`, observation.raw?.extension_attributes?.website_ids?.includes(id) ? 'Підключено' : 'Не підключено', 'Підключено');
    } else if (operation.domain === 'inventory') {
      for (const item of payload.sourceItems) {
        const before = observation.domainEvidence.inventory?.sourceItems.find((s) => s.sourceCode === item.source_code);
        add(ordinal, `Фізичний залишок (${item.source_code})`, before?.qty ?? null, item.quantity);
        add(ordinal, `Наявність (${item.source_code})`, before ? (before.isInStock ? 'Є в наявності' : 'Немає в наявності') : null,
          item.status ? 'Є в наявності' : 'Немає в наявності');
      }
    }
  }
  // An oversized review is blocked, never silently shortened before a write.
  return safeData(output, [], 512 * 1024);
}
module.exports = { unsentChanges };
