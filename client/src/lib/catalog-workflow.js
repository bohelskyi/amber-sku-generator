export const isNativeCatalog = (config) => config?.catalogWorkflow?.identityMode === 'public_identity';
export const hasGeneratedQuestionKeys = (config) => isNativeCatalog(config)
  && config.catalogWorkflow.serverGeneratedQuestionKeys === true;
