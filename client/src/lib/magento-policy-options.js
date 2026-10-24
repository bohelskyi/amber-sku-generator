const englishControls = new Set(['sku', 'product_type', 'attribute_set_code', 'store_view_code']);

// UI restriction only. The server still validates scope, ownership and delivery.
// Base rows retain their existing choices, including installation-specific stores.
export function policyReviewConstraint(entry) {
  if (entry.kind !== 'policy' || entry.row === 'base') return null;
  if (entry.row !== 'english' || entry.label !== 'en') return { kind: 'scope', choices: [] };
  if (englishControls.has(entry.target)) return { kind: 'control', choices: [] };
  return { kind: 'content', choices: ['authoritative_create_update'] };
}

export function policyReviewChoice(entry, value) {
  const constraint = policyReviewConstraint(entry);
  if (!constraint) return value;
  if (constraint.kind === 'control') return entry.identity === 'magento_managed' ? entry.identity : '';
  return constraint.choices.includes(value) ? value : '';
}

export function canConfirmPolicy(entry, value) {
  const constraint = policyReviewConstraint(entry);
  if (!constraint) return true;
  if (constraint.kind === 'control') return entry.identity === 'magento_managed' && value === entry.identity
    && ['proposed', 'review_required'].includes(entry.reviewState);
  return constraint.choices.includes(value);
}
