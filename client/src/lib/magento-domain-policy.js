import { deliveryPolicies } from './magento-category-workspace.js';
import { fieldLabels } from './export-template-editor.js';
import { withRepairContext } from './magento-repair-context.js';

const operations = {
  inventory: { label: 'Початкові залишки', row: 'base', store: 'all' },
  websites: { label: 'Належність до вебсайтів', row: 'base', store: 'all' },
  storeViews: { label: 'Передавання англійською', row: 'english', store: 'en' },
};
const controls = new Set(['sku', 'product_type', 'attribute_set_code', 'store_view_code']);
const bounded = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit
  && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const code = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(value);
const category = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(value);
const own = (values, key) => typeof key === 'string' && Object.hasOwn(values, key) ? values[key] : null;
const counter = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9][0-9]{0,18}$/.test(String(value))
  && BigInt(value) <= 9223372036854775806n ? String(value) : null;

function requiredPolicy(problem) {
  if (problem.operation === 'inventory' && ['qty', 'is_in_stock'].includes(problem.target)) return 'initialize_create_only';
  if (problem.operation === 'websites' && problem.target === 'product_websites') return 'authoritative_create_update';
  if (problem.operation === 'storeViews' && code(problem.target)) return controls.has(problem.target) ? 'magento_managed' : 'authoritative_create_update';
  return null;
}

// A display/link projection of the reviewed response; never a policy choice or
// approval. The receiver in PR #149 rechecks the tuple against its fresh DTO.
export function domainPolicyGuidance(problem, { review, revision, currentPublishedId, productId, repairContext } = {}) {
  if (problem?.code !== 'DOMAIN_POLICY_REVIEW_REQUIRED') return null;
  const operation = own(operations, problem.operation);
  const target = code(problem.target) ? problem.target : null;
  const observedLabel = Array.isArray(revision?.schema?.attributes)
    ? revision.schema.attributes.find(attribute => attribute?.attribute_code === target)?.default_frontend_label : null;
  const fieldLabel = bounded(problem.fieldLabel, 500) ? problem.fieldLabel : bounded(observedLabel, 500) ? observedLabel
    : own(fieldLabels, target) || target || 'Поле не визначено';
  const policyLabel = own(deliveryPolicies, problem.requiredPolicy);
  const supported = operation && target && policyLabel && requiredPolicy(problem) === problem.requiredPolicy;
  const scopeLabel = operation ? operation.row === 'english' ? 'EN' : 'UA / основний магазин' : 'Мову не визначено';
  const result = { operationLabel: operation?.label || 'Операцію не визначено', fieldLabel, scopeLabel,
    policyLabel: policyLabel || 'Поведінку не визначено',
    message: supported
      ? `Для дії «${operation.label}» поле «${fieldLabel}» (${scopeLabel}) потребує поведінки «${policyLabel}». Перевірте налаштування передавання.`
      : 'Вимогу до поведінки поля не вдалося визначити повністю. Перегляньте технічні дані та налаштування інтеграції.',
    href: '/admin/magento', linkLabel: 'Переглянути налаштування інтеграції', exact: false };
  const checked = Array.isArray(review?.checked) && Number.isSafeInteger(productId) && productId > 0
    ? review.checked.filter(item => item?.kind === 'current' && item.productId === productId) : [];
  const product = checked.length === 1 ? checked[0] : null;
  const current = currentPublishedId ?? null;
  const headersMatch = bounded(revision?.id, 256) && review?.bindingRevisionId === revision.id
    && counter(revision.revision) && counter(review.expectedRevision) === counter(revision.revision)
    && Object.hasOwn(review, 'expectedCurrentId') && review.expectedCurrentId === current && (current === null || bounded(current, 256));
  if (!headersMatch || !category(product?.group)) return result;
  const params = new URLSearchParams({ binding: revision.id });
  if (current !== null) params.set('source', current);
  params.set('review', 'policies');
  const path = `/admin/magento/categories/${encodeURIComponent(product.group)}`;
  const general = withRepairContext(`${path}?${params}`, repairContext, {
    productId: String(productId), category: product.group, route: '', field: '', path: '', question: '', value: '',
  });
  result.href = general; result.linkLabel = 'Переглянути всі правила категорії';
  const route = product.routeKey;
  const sameScope = operation && bounded(route, 200) && route.split(/[.:]/)[0] === product.group
    && (problem.routeKey === undefined || problem.routeKey === route)
    && (problem.category === undefined || problem.category === product.group)
    && (problem.scope === undefined || problem.scope === operation.store)
    && (problem.storeCode === undefined || problem.storeCode === operation.store)
    && (problem.rowId === undefined || problem.rowId === operation.row);
  if (!sameScope || !supported) return result;
  const attributes = Array.isArray(revision.bindings?.attributes) ? revision.bindings.attributes.filter(attribute =>
    attribute?.routeKey === route && attribute.rowId === operation.row && attribute.target === target) : [];
  const attribute = attributes.length === 1 ? attributes[0] : null;
  if (!bounded(attribute?.bindingKey, 256)) return result;
  const policies = Array.isArray(revision.bindings?.policies) ? revision.bindings.policies.filter(policy =>
    policy?.bindingKey === attribute.bindingKey && policy.storeCode === operation.store) : [];
  if (policies.length !== 1) return result;
  // Restore the category API's exact 200-character route after the generic
  // repair context's 160-character bound. Do not construct an opaque entry ID.
  const exact = new URLSearchParams(general.split('?')[1]);
  exact.set('route', route); exact.set('language', operation.row);
  exact.set('reviewField', target); exact.set('reviewStore', operation.store);
  return { ...result, href: `${path}?${exact}`, linkLabel: 'Переглянути правило передавання', exact: true };
}
