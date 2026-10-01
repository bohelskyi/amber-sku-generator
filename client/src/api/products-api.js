import { api } from '../lib/api';

export function createProductsApi(client = api) {
  return Object.freeze({
    getConfig: () => client.get('/config'),
    getRecent: () => client.get('/products'),
    previewPrice: (payload) => client.post('/price-preview', payload),
    preview: (payload) => client.post('/preview', payload),
    save: (payload) => client.post('/save', payload),
    getVariation: (sku) => client.post('/variation', { sku }),
    archive: (skuToDelete) => client.post('/delete', { skuToDelete }),
    previewTestDeletion: (productId) => client.post('/products/test-delete/preview', { productId }),
    applyTestDeletion: (payload) => client.post('/products/test-delete/apply', payload),
  });
}

export const productsApi = createProductsApi();
