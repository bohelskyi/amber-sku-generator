import { catalogTextFields } from './catalog-characteristics.js';
import { fieldLabels } from './export-template-editor.js';
import { localValueLabel } from './magento-category-workspace.js';

export const reviewGroups = ['Назви та SEO', 'Ціна', 'Характеристики', 'Службові'];
const priceFields = new Set(['price', 'special_price', 'special_price_from_date', 'special_price_to_date', 'cost']);
const serviceFields = new Set(['sku', 'store_view_code', 'attribute_set_code', 'product_type', 'product_websites', 'product_online', 'visibility', 'categories', 'qty', 'is_in_stock', 'tax_class_name', 'tax_class_id', 'url_key']);

export function reviewLanguage(entry) {
  if (entry.row === 'base') return 'UA';
  if (entry.row === 'english') return 'EN';
  return entry.kind === 'route' && !entry.row ? 'Спільне' : 'Не визначено';
}

export function reviewGroup(entry) {
  if (entry.kind === 'route' || entry.kind === 'category' || serviceFields.has(entry.target)) return 'Службові';
  if (catalogTextFields.has(entry.target)) return 'Назви та SEO';
  return priceFields.has(entry.target) ? 'Ціна' : 'Характеристики';
}

// Only the label changes: command identities and semantic option IDs stay opaque.
export function reviewEntryLabel(entry, revision, questions, categoryCode) {
  if (entry.kind === 'policy' || entry.kind === 'attribute') {
    return (Object.hasOwn(fieldLabels, entry.target) ? fieldLabels[entry.target] : null)
      || revision.schema.attributes.find((attribute) => attribute.attribute_code === entry.target)?.default_frontend_label
      || (entry.kind === 'attribute' ? entry.label : null) || entry.target;
  }
  const match = entry.source?.match(/\.([^.=]+)=value_id:(-?\d+)$/);
  const question = entry.group === categoryCode && match ? questions.find((item) => item.id === match[1]) : null;
  const option = question?.options.find((item) => String(item.id) === match[2]);
  return question ? `${question.label}: ${option?.label || localValueLabel(questions, match[1], match[2], entry.evaluated)}` : entry.evaluated || entry.label || entry.target;
}
