export function getPermissionUiState(permissions = []) {
  const effectivePermissions = new Set(Array.isArray(permissions) ? permissions : []);
  const has = (permissionKey) => effectivePermissions.has(permissionKey);

  return {
    canApplyDirectRecount: has('products.recount'),
    canApplyRepricing: has('repricing.apply'),
    canArchiveProducts: has('products.archive'),
    canClaimCorrections: has('corrections.claim'),
    canCompleteCorrections: has('corrections.complete'),
    canCreateCorrectionRequest: has('corrections.create'),
    canCreateExports: has('exports.create'),
    canCreateProducts: has('products.create'),
    canForceReleaseCorrections: has('corrections.force_release'),
    canManagePricing: has('pricing.manage'),
    canRejectCorrections: has('corrections.reject'),
    canRollbackRepricing: has('repricing.rollback'),
    canViewCatalog: has('catalog.view'),
    canViewPricing: has('pricing.view'),
  };
}

export function getRecountUiMode(permissionUi) {
  if (permissionUi.canApplyDirectRecount && permissionUi.canCreateCorrectionRequest) {
    return 'choice';
  }
  if (permissionUi.canApplyDirectRecount) return 'apply';
  if (permissionUi.canCreateCorrectionRequest) return 'request';
  return null;
}
