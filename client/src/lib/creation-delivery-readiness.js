const questions = { NM: 'extra', AR: 'size' };
const safeIdentity = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function creationDeliveryState(readiness, categoryCode) {
  if (!readiness) return null;
  if (readiness.scope !== 'native_characteristic_source_support' || readiness.categoryCode !== categoryCode
      || !['configuration_required', 'not_checked', 'no_native_upgrade_blocker'].includes(readiness.status)) return { status: 'not_checked' };
  if (readiness.status !== 'configuration_required') return { status: readiness.status };
  const upgrade = readiness.code === 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED'
    && questions[categoryCode] === readiness.questionKey
    && readiness.targetContract === 'public-product-characteristics-v1';
  const deferred = readiness.code === 'SOURCE_SUPPORT_DEFERRED_VALUE'
    && categoryCode === 'AR' && readiness.questionKey === 'size'
    && ['29', '30', '31'].includes(readiness.valueId);
  const category = readiness.code === 'MAGENTO_CATEGORY_NOT_LINKED' && readiness.questionKey === null && readiness.valueId === null;
  const value = readiness.code === 'MAGENTO_SOURCE_VALUE_NOT_LINKED' && safeIdentity(readiness.questionKey)
    && typeof readiness.valueId === 'string' && /^(0|[1-9][0-9]*)$/.test(readiness.valueId);
  if ((!upgrade && !deferred && !category && !value) || !safeIdentity(readiness.bindingRevisionId)) return { status: 'not_checked' };
  const returnTo = '/products/create?' + new URLSearchParams({ category: categoryCode });
  return { status: 'configuration_required', kind: category ? 'category' : value ? 'source_value' : deferred ? 'deferred_value' : 'native_upgrade', questionKey: readiness.questionKey,
    href: '/admin/magento/categories/' + encodeURIComponent(categoryCode) + '?' + new URLSearchParams({
      ...(readiness.questionKey ? { question: readiness.questionKey } : {}), binding: readiness.bindingRevisionId, ...(deferred || value ? { value: readiness.valueId } : {}), returnTo,
    }) };
}
