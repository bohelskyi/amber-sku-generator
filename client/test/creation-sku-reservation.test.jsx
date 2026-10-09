import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AppPage from '../src/pages/AppPage.jsx';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { useSkuManager } from '../src/hooks/useSkuManager.js';
import * as photoHooks from '../src/hooks/useProductPhotos.js';

let config, post, previewKeys, saveKeys, cancelKeys, calls, unknownSave, delayedPreview;
const auth = { applicationUser: { id: 21 }, roles: [{ key: 'storekeeper' }],
  permissions: ['products.view', 'products.create', 'products.decode', 'products.recount', 'history.view', 'exports.view'],
  principalLifetime: { id: 'warehouse-hotfix-owner', valid: true } };
const article = 'AG-123456';
const photos = { photos: [], ready: true, creationPayload: {}, hasPendingUploads: false, reset: vi.fn() };
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  previewKeys = []; saveKeys = []; cancelKeys = []; calls = []; unknownSave = false; delayedPreview = null;
  config = { categories: { AR: { code: 'AR', name: 'Аксесуари', requires_weight: 0 } }, questions: { AR: [] }, extraConfig: {},
    productNameReadiness: { available: true, policy: 'effective-product-names-v1' },
    productCreation: { identityMode: 'public_identity', skuReservation: { available: true, version: 1 },
      pricingDecision: { available: true, modes: ['system_auto', 'manual_uah'] } } };
  vi.spyOn(photoHooks, 'useProductPhotos').mockImplementation(() => photos);
  vi.spyOn(api, 'get').mockImplementation(async url => ({ data: url === '/config' ? config : {} }));
  post = vi.spyOn(api, 'post').mockImplementation(async (url, payload) => {
    calls.push([url, payload]);
    if (url === '/products/creation/cancel') { cancelKeys.push(payload.idempotencyKey); return { data: { state: 'cancelled' } }; }
    if (url === '/price-preview') return { data: { totalPriceUah: 100 } };
    if (url === '/preview') {
      previewKeys.push(payload.idempotencyKey);
      if (delayedPreview) await delayedPreview;
      return { data: { mode: 'public_identity', identityMode: 'public_identity', isTestProduct: false,
        characteristicConfigHash: 'a'.repeat(64), normalizedAnswers: {}, weightVal: 0, previewToken: 'reviewed-' + previewKeys.length,
        totalPriceUah: 100, calculatedPriceUah: 100, totalPrice: 2.5, uahRate: 40,
        publicSku: article, skuReservation: { version: 1, idempotencyKey: payload.idempotencyKey,
          publicSku: article, categoryCode: 'AR', isTestProduct: false },
        creationNames: { ready: Boolean(payload.magentoNames?.all && payload.magentoNames?.en), names: payload.magentoNames || { all: null, en: null } } } };
    }
    if (url === '/save') {
      saveKeys.push(payload.idempotencyKey);
      if (unknownSave) { unknownSave = false; throw Error('Lost save response'); }
      return { data: { success: true, id: 9001, publicSku: article, isTestProduct: false } };
    }
    throw Error('Unexpected command ' + url);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const wrapper = ({ children }) => <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
async function hook() {
  const view = renderHook(() => useSkuManager(), { wrapper });
  await waitFor(() => expect(view.result.current.config).toBe(config));
  act(() => view.result.current.resetProductFlow('AR'));
  return view;
}
async function named(result) {
  await act(async () => result.current.handlePreview());
  act(() => result.current.handleNameSubject('magento_name_subject_ua', 'Фігура ' + article));
  act(() => result.current.handleNameSubject('magento_name_subject_en', 'Figurine ' + article));
  await act(async () => result.current.handlePreview());
}
it('Storekeeper sees the reserved article while entering full UA/EN names, then saves that same article', async () => {
  const router = createMemoryRouter([{ path: '*', element: <AppPage /> }], { initialEntries: ['/products/create?category=AR'] });
  render(<AuthContext.Provider value={auth}><RouterProvider router={router} /></AuthContext.Provider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити дані' }));
  await screen.findByText(article);
  fireEvent.change(screen.getByLabelText(/Повна назва товару українською/), { target: { value: 'Фігура ' + article } });
  expect(screen.getByText(article)).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/Повна назва товару англійською/), { target: { value: 'Figurine ' + article } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  const save = await screen.findByRole('button', { name: 'Зберегти товар' });
  await waitFor(() => expect(save.disabled).toBe(false)); fireEvent.click(save);
  await screen.findByText(/Товар збережено/);
  expect(previewKeys).toHaveLength(2); expect(new Set(previewKeys).size).toBe(1); expect(saveKeys).toEqual([previewKeys[0]]);
  expect(calls.find(([url]) => url === '/save')[1]).toMatchObject({ magentoNames: { all: 'Фігура ' + article, en: 'Figurine ' + article }, skuReservation: { publicSku: article } });
  expect(cancelKeys).toEqual([]);
});
it('name edits and retries keep UUID; cancellation closes it and a new form starts another', async () => {
  const { result } = await hook(); await named(result);
  const original = previewKeys[0]; expect(previewKeys[1]).toBe(original);
  act(() => result.current.resetProductFlow('AR'));
  await waitFor(() => expect(cancelKeys).toEqual([original]));
  expect(result.current.reservedCreationSku).toBeNull();
  await act(async () => result.current.handlePreview());
  expect(previewKeys[2]).not.toBe(original);
});
it('lost preview retries exact UUID; late preview after cancellation cannot replace the new form', async () => {
  const { result } = await hook();
  post.mockRejectedValueOnce(Error('Preview reply lost'));
  await act(async () => { try { await result.current.handlePreview(); } catch { /* expected */ } });
  const original = post.mock.calls.find(([url]) => url === '/preview')[1].idempotencyKey;
  expect(original).toMatch(/^[0-9a-f-]{36}$/);
  await act(async () => result.current.handlePreview());
  expect(previewKeys[0]).toBe(original);
  let finish;
  delayedPreview = new Promise(resolve => { finish = resolve; });
  let pending;
  act(() => { pending = result.current.handlePreview(); });
  act(() => result.current.resetProductFlow('AR'));
  await act(async () => { finish(); await pending; });
  expect(result.current.reservedCreationSku).toBeNull(); expect(result.current.previewData).toBeNull();
});
it('unknown save locks editing/cancel and recovers byte-identical request plus the reserved SKU', async () => {
  const { result } = await hook(); await named(result); unknownSave = true;
  act(() => result.current.handleSave());
  await waitFor(() => expect(result.current.isCreationSaveUncertain).toBe(true));
  act(() => result.current.resetProductFlow('AR')); expect(cancelKeys).toEqual([]);
  act(() => result.current.handleNameSubject('magento_name_subject_ua', 'Changed after unknown'));
  act(() => result.current.handleSave());
  await waitFor(() => expect(result.current.savedProduct?.publicSku).toBe(article));
  const saves = calls.filter(([url]) => url === '/save').map(([, payload]) => payload);
  expect(saves).toHaveLength(2); expect(saves[0]).toEqual(saves[1]); expect(saveKeys).toEqual([previewKeys[0], previewKeys[0]]);
});
