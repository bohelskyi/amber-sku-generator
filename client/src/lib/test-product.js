export const isTestProduct = (product) => product?.isTestProduct === true;
export const hasTestCreationCapability = (config) => {
  const capability = config?.productCreation?.testProducts;
  return config?.productCreation?.identityMode === 'public_identity' && capability?.available === true && capability.administratorOnly === true
    && capability.prefix === 'TEST-' && capability.targetStatus === 2;
};
export function matchesTestCreationResult(result, requested, saved = false) {
  if (!requested) return result?.isTestProduct !== true;
  return result?.isTestProduct === true && result.testTargetStatus === 2
    && (!saved || typeof result.publicSku === 'string' && /^TEST-\d{6,}$/.test(result.publicSku));
}
