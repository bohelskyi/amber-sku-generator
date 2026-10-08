import { api } from '../lib/api.js';

export function createHistoricalReactivationApi(client = api) {
  const root = '/products/historical-reactivation';
  return Object.freeze({
    preview: (skus, operationId) => client.post(root + '/preview', { skus, ...(operationId ? { operationId } : {}) }),
    confirm: (payload) => client.post(root + '/confirm', payload),
    previewWeightNormalization: ({ productId, article, bindingRevisionId }) => client.post(root + '/weight-normalization/preview', { productId, article, bindingRevisionId }),
    saveWeightNormalization: ({ productId, article, bindingRevisionId, previewToken, reviewExpiresAt, confirmEquivalentWeightNormalization }) =>
      client.post(root + '/weight-normalization/apply', { productId, article, bindingRevisionId, previewToken, reviewExpiresAt, confirmEquivalentWeightNormalization }),
    previewManualNames: (payload) => client.post('/product-magento-name/preview', payload),
    saveManualNames: (payload) => client.post('/product-magento-name/apply', payload),
    previewNames: (payload) => client.post('/magento/name-resolution/preview', payload),
    acceptNames: (payload) => client.post('/magento/name-resolution/apply', payload),
    operation: (operationId, options = {}) => client.get(root + '/operations/' + encodeURIComponent(operationId), options),
    status: (batchId, options = {}) => client.get(root + '/batches/' + encodeURIComponent(batchId), options),
    inspect: (intentId, options = {}) => client.get(root + '/intents/' + encodeURIComponent(intentId) + '/inspection', options),
    reconcile: (intentId, review) => client.post(root + '/reconcile', typeof review === 'string'
      ? { intentId, reviewHash: review, confirmObservedHiddenResult: true }
      : { intentId, review: review.review, reviewHash: review.reviewHash, reason: review.reason }),
    cancel: (intentId) => client.post(root + '/cancel', { intentId, confirmNoDispatchCancellation: true }),
  });
}
export const historicalReactivationApi = createHistoricalReactivationApi();
