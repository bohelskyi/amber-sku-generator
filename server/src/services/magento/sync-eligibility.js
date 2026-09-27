// Product currency and typed exclusion meanings follow full-product lifecycle
// state. Delivery history is evidence, not the Magento same-SKU UPDATE selector.
function syncEligibility(product, currentMagento) {
  const state = product.exportState;
  const mode = currentMagento ? 'update' : 'create';
  const reasons = [];
  const deny = (code, rule) => reasons.push({ code, rule });
  if (product.status !== 'active') deny('AMBER_PRODUCT_NOT_CURRENT', `products.status = ${product.status ?? 'unknown'}`);
  if (product.corrected_to_product_id != null) deny('AMBER_PRODUCT_NOT_CURRENT', 'products.corrected_to_product_id IS NOT NULL');
  if (state?.route === 'retired') deny('AMBER_PRODUCT_NOT_CURRENT', 'product_full_export_state.route = retired');
  if (currentMagento && currentMagento.sku !== product.full_sku) deny('AMBER_SYNC_IDENTITY_MISMATCH', 'Magento SKU must exactly equal products.full_sku; rename is unsupported');

  // These are the independent exclusion signals already used by the lifecycle
  // repair classifier. They win even if a stale product flag says not excluded.
  if (state?.business_exclusion_state === 'excluded') deny('AMBER_PRODUCT_EXCLUDED', 'product_full_export_state.business_exclusion_state = excluded');
  if (state?.hold_reason === 'intentional_exclusion') deny('AMBER_PRODUCT_EXCLUDED', 'product_full_export_state.hold_reason = intentional_exclusion');
  if (state?.independentExclusion === true) deny('AMBER_PRODUCT_EXCLUDED', 'product_full_export_state.evidence.independentExclusion = true');
  if (state?.recount_compatibility_excluded) deny('AMBER_PRODUCT_EXCLUDED', 'product_full_export_state.recount_compatibility_excluded = true');

  const priorExposureUpdate = mode === 'update' && currentMagento.sku === product.full_sku
    && state?.route === 'hold' && state.hold_reason === 'prior_exposure'
    && ['none', 'unknown'].includes(state.business_exclusion_state);
  if (state?.route === 'hold' && !priorExposureUpdate && state.hold_reason !== 'intentional_exclusion') {
    deny('AMBER_SYNC_ELIGIBILITY_UNRESOLVED', `product_full_export_state.route = hold; hold_reason = ${state.hold_reason}; mode = ${mode}`);
  }
  if (state && !['normal', 'replacement', 'hold', 'retired'].includes(state.route)) {
    deny('AMBER_SYNC_ELIGIBILITY_UNRESOLVED', 'Unrecognized product lifecycle route');
  }
  if (state && !['none', 'unknown', 'excluded'].includes(state.business_exclusion_state)) {
    deny('AMBER_SYNC_ELIGIBILITY_UNRESOLVED', 'Unrecognized business exclusion state');
  }
  if (!priorExposureUpdate && (Number(product.exclude_from_export) !== 0 || state?.business_exclusion_state === 'unknown')) {
    if (Number(product.exclude_from_export) !== 0) deny('AMBER_PRODUCT_EXCLUDED', 'products.exclude_from_export <> 0; no verified prior-exposure UPDATE exception');
    if (state?.business_exclusion_state === 'unknown') deny('AMBER_SYNC_ELIGIBILITY_UNRESOLVED', 'product_full_export_state.business_exclusion_state = unknown');
  }
  const eligible = reasons.length === 0;
  const reason = eligible ? priorExposureUpdate
    ? 'Current active product and exact Magento SKU match: legacy prior_exposure delivery hold does not block UPDATE; no explicit business or compatibility exclusion.'
    : 'Current active product with no business exclusion or unresolved lifecycle restriction.'
    : reasons.map((r) => r.rule).join('; ');
  return { eligible, mode, reason, reasonCode: eligible ? priorExposureUpdate
    ? 'EXACT_SKU_UPDATE_PRIOR_EXPOSURE_ALLOWED' : 'CURRENT_PRODUCT_ALLOWED' : 'SYNC_ELIGIBILITY_BLOCKED', reasons,
  legacyExport: { excludeFromExport: product.exclude_from_export, state: state || null,
    priorExposureIgnoredForUpdate: eligible && priorExposureUpdate, stateModified: false } };
}
module.exports = { syncEligibility };
