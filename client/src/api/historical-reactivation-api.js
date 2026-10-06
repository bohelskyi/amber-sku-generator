import { api } from '../lib/api.js';

export function createHistoricalReactivationApi(client = api) {
  const root = '/products/historical-reactivation';
  return Object.freeze({
    preview: (skus) => client.post(root + '/preview', { skus }),
    confirm: (payload) => client.post(root + '/confirm', payload),
    status: (batchId, options = {}) => client.get(root + '/batches/' + encodeURIComponent(batchId), options),
    inspect: (intentId, options = {}) => client.get(root + '/intents/' + encodeURIComponent(intentId) + '/inspection', options),
    reconcile: (intentId, review) => client.post(root + '/reconcile', typeof review === 'string'
      ? { intentId, reviewHash: review, confirmObservedHiddenResult: true }
      : { intentId, review: review.review, reviewHash: review.reviewHash, reason: review.reason }),
    cancel: (intentId) => client.post(root + '/cancel', { intentId, confirmNoDispatchCancellation: true }),
  });
}
export const historicalReactivationApi = createHistoricalReactivationApi();
