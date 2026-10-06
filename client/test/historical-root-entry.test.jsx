import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom';
import AppPage from '../src/pages/AppPage.jsx';
import { AuthContext } from '../src/auth/auth-context.js';
import { makeReview, makeReceipt } from './historical-fixtures.js';
import { api } from '../src/lib/api.js';

const baseConfig = {
  categories: { NM: { code: 'NM', name: 'Намисто', requires_weight: 1 } },
  questions: { NM: [{ id: 'weight', label: 'Вага менеджера', input_type: 'text', required: 1,
    numeric_validation: { kind: 'decimal', unit: 'г', min: 0, minInclusive: false, maxFractionDigits: 3 } }] },
  productCreation: { identityMode: 'public_identity', pricingDecision: { available: true, modes: ['system_auto', 'manual_uah', 'usd_per_gram'] } },
  productPhotoRequirements: { available: true }, productLifecycle: { available: true }, extraConfig: {},
};
const nativePreview = {
  identityMode: 'public_identity', mode: 'public_identity', characteristicConfigHash: 'a'.repeat(64),
  normalizedAnswers: { weight: 12.7 }, weightVal: 12.7, previewToken: 'reviewed-native-proof',
  fullProposedSku: null, skuSchemaVersionId: null, totalPriceUah: 1200, calculatedPriceUah: 1200, totalPrice: 30, uahRate: 40,
};
const nativeProduct = {
  existsInDb: true, sku: 'AG-000091', internalSku: null, publicSku: 'AG-000091',
  identityMode: 'public_identity', characteristicConfig: { id: '1', version: '1', configHash: 'a'.repeat(64) },
  category: baseConfig.categories.NM, decodedAnswers: [{ key: 'weight', label: 'Вага менеджера', value_id: 12.7, value_label: '12.7 г' }],
  product: { id: 91, status: 'active', weight: 12.7, details: { answers: { weight: 12.7 } } },
  skuSchema: { id: null, version: null, marker: '' }, suffix: { type: 'none', raw: null, value: null }, pricing: null,
};
let config, decoded, post, owner, writeText, operations;
const operation = (kind, id, skus, result, selectedSkus = null) => ({ format: 'historical-review-operation-v1',
  operationId: id, kind, state: result ? 'ready' : 'queued', skus, selectedSkus, result,
  deadlineAt: new Date(Date.now() + 300000).toISOString(), progress: { phase: result ? 'ready' : 'queued', completed: result ? skus.length : 0, total: skus.length } });
beforeEach(() => {
  config = structuredClone(baseConfig); decoded = structuredClone(nativeProduct);
  operations = new Map();
  owner = { id: 'root-integration-test', valid: true };
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({ data:
    url.startsWith('/products/historical-reactivation/operations/') ? operations.get(url.split('/').at(-1))
      : url === '/config' ? config : url === '/products' ? [] : url === '/products/91/photos'
      ? { productId: 91, version: '0', photos: [], enableWhenVerified: false, delivery: null }
      : url === '/products/91/lifecycle' ? { productId: 91, visibility: null }
        : url === '/magento/product-status/91' ? { state: 'not_queued' } : {} }));
  post = vi.spyOn(api, 'post').mockImplementation(async (url, body) => {
    if (url === '/products/historical-reactivation/preview') {
      operations.set(body.operationId, operation('preview', body.operationId, body.skus, makeReview()));
      return {status:202,data:operation('preview', body.operationId, body.skus, null)};
    }
    if (url === '/products/historical-reactivation/confirm') {
      operations.set(body.idempotencyKey, operation('confirm', body.idempotencyKey, body.skus,
        {...makeReceipt(),batchId:body.idempotencyKey}, body.selectedSkus));
      return {status:202,data:operation('confirm', body.idempotencyKey, body.skus, null, body.selectedSkus)};
    }
    if (url === '/decode') return { data: decoded };
    if (url === '/preview' || url === '/price-preview') return { data: config.productCreation.identityMode === 'encoded_sku'
      ? { fullProposedSku: 'NM-LEGACY-92', skuSchemaVersionId: 3, previewToken: 'reviewed-legacy-proof', weightVal: 12.7,
        totalPriceUah: 1200, calculatedPriceUah: 1200, totalPrice: 30, uahRate: 40 }
      : nativePreview };
    if (url === '/save') return { data: { success: true, id: 92, publicSku: 'AG-000092' } };
    if (url === '/delete') return { data: { success: true, message: 'Архівування в Amber виконано.', visibilityIntent: { status: 'queued' } } };
    if (url === '/products/restore/preview') return { data: { skus: ['AG-000091'], reviewNonce: 'nonce', reviewHash: 'hash',
      counts: { found: 1, skipped: 0, conflicts: 0 }, items: [{ article: 'AG-000091', disposition: 'found', confirmedMagentoId: 501 }] } };
    throw new Error(`Unexpected mutation ${url}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function openWorkspace(permissions, initialEntry = '/products', roles = []) {
  const auth = { permissions, roles, principalLifetime: owner };
  const router = createMemoryRouter([{ path: '*', element: <AuthContext.Provider value={auth}>
    <Link to="/products">Товари навігація</Link><AppPage />
  </AuthContext.Provider> }], { initialEntries: [initialEntry] });
  render(<RouterProvider router={router} />);
  return router;
}

const historicalPermissions = ['products.view','products.archive','history.view','export_templates.manage','export_templates.publish'];
it.each([
 {role:'administrator',available:true,permissions:historicalPermissions,offered:true},
 {role:'manager',available:true,permissions:historicalPermissions,offered:false},
 {role:'administrator',available:false,permissions:historicalPermissions,offered:false},
 {role:'administrator',available:true,permissions:historicalPermissions.filter(p=>p!=='export_templates.publish'),offered:false},
])('historical entry uses real Administrator and effective capability; ordinary restore unchanged: $role/$available/$offered',async({role,available,permissions,offered})=>{
 config.historicalReactivation={available,format:'historical-reactivation-v1',administratorOnly:true,maxItems:100,targetStatus:2};
 openWorkspace(permissions,'/products',[{key:role}]);
 await screen.findByRole('button',{name:'Відновити за артикулами'});
 await waitFor(()=>expect(Boolean(screen.queryByRole('button',{name:'Нове історичне рішення Адміністратора'}))).toBe(offered));
 expect(post).not.toHaveBeenCalled();
 if(offered){fireEvent.click(screen.getByRole('button',{name:'Нове історичне рішення Адміністратора'}));const dialog=screen.getByRole('dialog',{name:'Відновлення товарів'});fireEvent.change(within(dialog).getByLabelText('Точні артикули, по одному в рядку'),{target:{value:'AR-000001'}});expect(post).not.toHaveBeenCalled();expect(within(dialog).queryByRole('button',{name:/Підтвердити нове рішення/})).toBeNull();}
});

it('leaving an unsent historical list uses dirty-navigation Stay and Discard without creating an intent',async()=>{
 config.historicalReactivation={available:true,format:'historical-reactivation-v1',administratorOnly:true,maxItems:100,targetStatus:2};openWorkspace(historicalPermissions,'/products',[{key:'administrator'}]);fireEvent.click(await screen.findByRole('button',{name:'Нове історичне рішення Адміністратора'}));fireEvent.change(screen.getByLabelText('Точні артикули, по одному в рядку'),{target:{value:'AR-000001'}});fireEvent.click(screen.getByRole('button',{name:'Закрити історичне рішення'}));await screen.findByRole('dialog',{name:'Незбережені зміни'});fireEvent.click(screen.getByRole('button',{name:'Залишитися'}));expect(screen.getByLabelText('Точні артикули, по одному в рядку').value).toBe('AR-000001');fireEvent.click(screen.getByRole('button',{name:'Закрити історичне рішення'}));fireEvent.click(await screen.findByRole('button',{name:'Відкинути й перейти'}));await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Відновлення товарів'})).toBeNull());fireEvent.click(screen.getByRole('button',{name:'Нове історичне рішення Адміністратора'}));expect(screen.getByLabelText('Точні артикули, по одному в рядку').value).toBe('');expect(post).not.toHaveBeenCalled();
});

it('root entry previews exact articles and only acknowledged selection creates a historical receipt through the existing authenticated API',async()=>{
 config.historicalReactivation={available:true,format:'historical-reactivation-v1',administratorOnly:true,maxItems:100,targetStatus:2};openWorkspace(historicalPermissions,'/products',[{key:'administrator'}]);fireEvent.click(await screen.findByRole('button',{name:'Нове історичне рішення Адміністратора'}));fireEvent.change(screen.getByLabelText('Точні артикули, по одному в рядку'),{target:{value:'AR-000001\nSV-000002\nMISSING'}});expect(post).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Перевірити товари'}));await screen.findByText('Можна відновити: 2. Потребують уваги: 0. Пропущено: 1.', {}, { timeout: 3000 });expect(post.mock.calls).toEqual([['/products/historical-reactivation/preview',{skus:['AR-000001','SV-000002','MISSING'],operationId:expect.any(String)}]]);fireEvent.click(screen.getByRole('checkbox',{name:'Обрати AR-000001'}));fireEvent.click(screen.getByRole('checkbox',{name:/Погоджую/}));fireEvent.click(screen.getByRole('button',{name:'Відновити вибране (1)'}));await screen.findByText('Результати відновлення', {}, { timeout: 3000 });const [url,command]=post.mock.calls[1];expect(url).toBe('/products/historical-reactivation/confirm');expect(command.selectedSkus).toEqual(['AR-000001']);expect(command.skus).toEqual(['AR-000001','SV-000002','MISSING']);expect(command.reviewHash).toBe('a'.repeat(64));expect(command.confirmCurrentFactsAndHiddenUpdate).toBe(true);expect(screen.getByText(/Це ще не підтвердження завершення всіх етапів/)).toBeTruthy();
});
