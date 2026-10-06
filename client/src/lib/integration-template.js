import { COLUMN_CONTRACT, requiredColumns } from './export-template-columns.js';
export function enableExtensibleContract(definition) {
  if (definition.evaluatorVersion !== 'magento-declarative-3' || definition.outputContract !== COLUMN_CONTRACT) throw new Error('Спочатку оновіть контракт колонок для шаблону з публічним артикулом.');
  return { ...structuredClone(definition), evaluatorVersion: 'magento-declarative-4' };
}
export function addIntegrationCategory(definition, input) {
  if (!['magento-declarative-4', 'magento-declarative-5'].includes(definition.evaluatorVersion) || definition.groups.length >= 64) throw new Error('Потрібен розширюваний контракт v4/v5; максимум 64 категорії.');
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(input.code) || definition.groups.some((g) => g.route === input.code)) throw new Error('Потрібен унікальний код категорії Amber.');
  for (const key of ['label','nameUa','nameEn','attributeSet','categoryPath']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 200) throw new Error('Заповніть обидві назви, набір атрибутів та точний шлях категорії.');
  }
  const next = structuredClone(definition);
  const productSource = (field, type) => {
    const found = Object.entries(next.sources).find(([, s]) => s.kind === 'product' && s.field === field);
    if (found) return found[0];
    let id = `integration_${field}`; while (Object.hasOwn(next.sources, id)) id += '_new';
    next.sources[id] = { kind: 'product', field, type }; return id;
  };
  const sku = productSource('public_sku', 'text'); const price = productSource('total_price_uah', 'scalar');
  const literal = (value) => ({ op: 'literal', value });
  const text = (id) => ({ op: 'text', input: { op: 'source', id }, trim: false, format: 'scalar-v1', onAbsent: 'empty' });
  // All text is explicitly supplied by the administrator; no translation or semantic ID inference.
  next.groups.push({ route: input.code, name: input.label.trim(), columns: [...requiredColumns, 'categories', 'product_online', 'visibility'], evaluate: [],
    rows: ['base','english'].map((id) => ({ id, default: '', cells: { sku: text(sku), price: text(price),
      name: { op: 'join', items: [literal(id === 'base' ? input.nameUa.trim() : input.nameEn.trim()), text(sku)], delimiter: ' ', omitEmpty: true },
      store_view_code: literal(id === 'base' ? '' : 'en'), attribute_set_code: literal(input.attributeSet.trim()), product_type: literal('simple'),
      categories: literal(id === 'base' ? input.categoryPath.trim() : ''), product_online: literal(id === 'base' ? '2' : ''),
      visibility: literal(id === 'base' ? 'Catalog, Search' : '') } })) });
  return next;
}
