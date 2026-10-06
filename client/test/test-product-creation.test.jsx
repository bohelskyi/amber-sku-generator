import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AppPage from '../src/pages/AppPage.jsx';
import { ProductRegister } from '../src/components/app/ProductRegister.jsx';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import * as photoHooks from '../src/hooks/useProductPhotos.js';
import { validateIntegrationResume } from '../src/lib/integration-task-resume.js';
import { hasTestCreationCapability } from '../src/lib/test-product.js';

const photoId = '00000000-0000-4000-8000-000000000091';
const taskId = '00000000-0000-4000-8000-000000000092';
let config, auth, post, photos;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  config = { categories: { SV: { code: 'SV', name: 'Сувеніри', requires_weight: 0 } }, questions: { SV: [] },
    productCreation: { identityMode: 'public_identity', pricingDecision: { available: true, modes: ['system_auto', 'manual_uah'] },
      testProducts: { available: true, administratorOnly: true, prefix: 'TEST-', targetStatus: 2 } },
    productPhotoRequirements: { available: true }, extraConfig: {} };
  auth = { roles: [{ key: 'administrator' }], permissions: ['products.view', 'products.create', 'products.decode', 'products.recount', 'history.view'],
    principalLifetime: { id: 'test-product-ui-owner', valid: true } };
  photos = { photos: [{ id: photoId, name: 'test.png', mimeType: 'image/png' }], photoIds: [photoId],
    ready: true, enableWhenVerified: true, busy: false, loading: false, dirty: false, failedUploads: [], hasPendingUploads: false,
    creationPayload: { photoIds: [photoId], enableWhenPhotosVerified: true }, contentUrl: () => 'data:image/png;base64,',
    reset: vi.fn(), reorderPhotos: vi.fn(), setEnableWhenVerified: vi.fn(), removePhoto: vi.fn(), restoreStaged: vi.fn().mockReturnValue(true) };
  vi.spyOn(photoHooks, 'useProductPhotos').mockImplementation(() => photos);
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/config') return { data: config };
    if (url === '/products/register') return { data: { items: [], filterOptions: { categories: [] }, pageInfo: { hasMore: false } } };
    return { data: [] };
  });
  post = vi.spyOn(api, 'post').mockImplementation(async (url, payload) => {
    if (url === '/preview' || url === '/price-preview') return { data: { identityMode: 'public_identity', mode: 'public_identity',
      characteristicConfigHash: 'a'.repeat(64), normalizedAnswers: {}, weightVal: 0, previewToken: 'server-signed-test-flag',
      totalPriceUah: 1200, calculatedPriceUah: 1200, totalPrice: 30, uahRate: 40,
      isTestProduct: payload.isTestProduct === true, ...(payload.isTestProduct ? { testTargetStatus: 2 } : {}) } };
    if (url === '/save') return { data: { success: true, id: 5012, publicSku: payload.isTestProduct ? 'TEST-000001' : 'AG-000004',
      isTestProduct: payload.isTestProduct === true, ...(payload.isTestProduct ? { testTargetStatus: 2 } : {}) } };
    throw Error('Unexpected mutation ' + url);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('does not expose TEST allocation when native identity is not active', () => {
  config.productCreation.identityMode = 'encoded_sku';
  expect(hasTestCreationCapability(config)).toBe(false);
});
function open(entry = '/products/create?category=SV') {
  const router = createMemoryRouter([{ path: '*', element: <AppPage /> }], { initialEntries: [entry] });
  const view = render(<AuthContext.Provider value={auth}><RouterProvider router={router} /></AuthContext.Provider>);
  router.updateAuth = (next) => view.rerender(<AuthContext.Provider value={next}><RouterProvider router={router} /></AuthContext.Provider>);
  return router;
}
async function verify() {
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  return screen.findByRole('button', { name: 'Зберегти товар' });
}

it.each(['manager', 'custom-administrator-name', 'capability-off'])('hides TEST control for %s without preventing ordinary creation', async (mode) => {
  if (mode === 'manager') auth.roles = [{ key: 'manager' }];
  if (mode === 'custom-administrator-name') auth.roles = [{ key: 'custom', displayName: 'Administrator' }];
  if (mode === 'capability-off') config.productCreation.testProducts.available = false;
  open();
  await screen.findByRole('button', { name: 'Перевірити дані' });
  expect(screen.queryByRole('checkbox', { name: 'Створити TEST товар' })).toBeNull();
  await verify();
  expect(post.mock.calls.find(([url]) => url === '/preview')[1]).not.toHaveProperty('isTestProduct');
});

it('defaults to ordinary creation and requires a fresh server preview after toggling TEST', async () => {
  open();
  const checkbox = await screen.findByRole('checkbox', { name: 'Створити TEST товар' });
  expect(checkbox.checked).toBe(false);
  await verify();
  fireEvent.click(checkbox);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Зберегти товар' })).toBeNull());
  expect(screen.queryByRole('region', { name: 'Серверна перевірка TEST товару' })).toBeNull();
  await verify();
  const payload = post.mock.calls.filter(([url]) => url === '/preview').at(-1)[1];
  expect(payload).toMatchObject({ isTestProduct: true, enableWhenPhotosVerified: false, photoIds: [photoId] });
  expect(screen.getByText('Сервер підтвердив TEST товар')).toBeTruthy();
  const enable = screen.getByRole('checkbox', { name: 'Увімкнути товар у Magento після перевірки всіх фото' });
  expect(enable.disabled).toBe(true); expect(enable.checked).toBe(false);
  fireEvent.click(checkbox);
  expect(screen.getByRole('checkbox', { name: 'Увімкнути товар у Magento після перевірки всіх фото' }).checked).toBe(true);
  await verify();
  expect(post.mock.calls.filter(([url]) => url === '/preview').at(-1)[1]).toMatchObject({ enableWhenPhotosVerified: true });
  expect(post.mock.calls.some(([url]) => url === '/save')).toBe(false);
});

it('saves the exact signed TEST request and displays only the server-assigned separate article', async () => {
  open();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Створити TEST товар' }));
  expect(screen.queryByText('TEST-000001')).toBeNull();
  fireEvent.click(await verify());
  await screen.findByText('TEST товар збережено');
  expect(screen.getByText('TEST-000001')).toBeTruthy();
  const saved = post.mock.calls.find(([url]) => url === '/save')[1];
  expect(saved).toMatchObject({ isTestProduct: true, enableWhenPhotosVerified: false, previewToken: 'server-signed-test-flag' });
  expect(saved.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
  expect(screen.getByRole('region', { name: 'Тестовий товар' })).toBeTruthy();
});

it('retains a reviewed TEST draft and disables new save when the actual Administrator role is revoked', async () => {
  const router = open();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Створити TEST товар' }));
  await verify();
  router.updateAuth({ ...auth, roles: [{ key: 'manager' }] });
  await screen.findByText('Для продовження створення TEST товару потрібен чинний доступ Адміністратора. Ознака TEST збережена.');
  expect(screen.queryByRole('checkbox', { name: 'Створити TEST товар' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Зберегти товар' }).disabled).toBe(true);
  expect(screen.getByText('Обрано TEST товар. Ознака зберігається назавжди; звичайна серія AG не використовується.')).toBeTruthy();
  expect(post.mock.calls.some(([url]) => url === '/save')).toBe(false);
});

it('rejects a preview that fails to confirm the selected immutable TEST marker', async () => {
  post.mockImplementation(async () => ({ data: { identityMode: 'public_identity', totalPriceUah: 1200, isTestProduct: false } }));
  open();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Створити TEST товар' }));
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByText('Сервер не підтвердив обраний тип товару. Повторіть перевірку.');
  expect(screen.queryByRole('button', { name: 'Зберегти товар' })).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Створити TEST товар' }).checked).toBe(true);
});

it('retains the immutable TEST payload and UUID after an ambiguous save and locks the toggle until recovery', async () => {
  const original = post.getMockImplementation(); let saves = 0;
  post.mockImplementation(async (url, payload) => {
    if (url === '/save' && ++saves === 1) throw Error('Lost response');
    return original(url, payload);
  });
  open();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Створити TEST товар' }));
  fireEvent.click(await verify());
  const retry = await screen.findByRole('button', { name: 'Перевірити результат збереження' });
  const checkbox = screen.getByRole('checkbox', { name: 'Створити TEST товар' });
  expect(checkbox.disabled).toBe(true);
  expect(checkbox.checked).toBe(true);
  fireEvent.click(retry);
  await screen.findByText('TEST товар збережено');
  const requests = post.mock.calls.filter(([url]) => url === '/save').map(([,body]) => body);
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toMatchObject({ isTestProduct: true, enableWhenPhotosVerified: false });
});

it('marks register TEST rows from server metadata rather than guessing from an article prefix', async () => {
  api.get.mockImplementation(async () => ({ data: { items: [
    { id: 5012, publicSku: 'TEST-000001', isTestProduct: true, status: 'active', categoryCode: 'SV' },
    { id: 5011, publicSku: 'AG-000003', isTestProduct: false, status: 'active', categoryCode: 'SV' },
    { id: 4999, publicSku: 'TEST-999999', isTestProduct: false, status: 'active', categoryCode: 'SV' },
  ], filterOptions: { categories: [] }, pageInfo: { hasMore: false } } }));
  const router = createMemoryRouter([{ path: '*', element: <ProductRegister /> }]);
  render(<RouterProvider router={router} />);
  const article = await screen.findByText('TEST-000001');
  expect(within(article.closest('tr')).getByText('TEST', { exact: true })).toBeTruthy();
  expect(within(screen.getByText('AG-000003').closest('tr')).queryByText('TEST', { exact: true })).toBeNull();
  expect(within(screen.getByText('TEST-999999').closest('tr')).queryByText('TEST', { exact: true })).toBeNull();
});

it('shows the immutable TEST marker in product details and prevents photo activation without creating another product', async () => {
  const original = post.getMockImplementation();
  post.mockImplementation(async (url, payload) => url === '/decode' ? { data: {
    existsInDb: true, sku: 'TEST-000001', publicSku: 'TEST-000001', isTestProduct: true, testTargetStatus: 2,
    identityMode: 'public_identity', characteristicConfig: { id: '1', version: '1', configHash: 'a'.repeat(64) },
    category: config.categories.SV, decodedAnswers: [], product: { id: 5012, status: 'active', weight: 0, details: { answers: {} } },
    skuSchema: { id: null, version: null, marker: '' }, suffix: { type: 'none', raw: null, value: null }, pricing: null,
  } } : original(url, payload));
  open('/products/open?article=TEST-000001');
  await screen.findByRole('heading', { level: 1, name: 'Товар TEST-000001' });
  expect(screen.getByRole('region', { name: 'Тестовий товар' })).toBeTruthy();
  const enable = screen.getByRole('checkbox', { name: 'Увімкнути товар у Magento після перевірки всіх фото' });
  expect(enable.disabled).toBe(true); expect(enable.checked).toBe(false);
  expect(post.mock.calls.map(([url]) => url)).toEqual(['/decode']);
});

it('treats a save receipt without the original TEST marker as uncertain instead of reporting ordinary success', async () => {
  const original = post.getMockImplementation();
  post.mockImplementation(async (url, payload) => url === '/save'
    ? { data: { success: true, id: 5012, publicSku: 'AG-000004', isTestProduct: false } } : original(url, payload));
  open();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Створити TEST товар' }));
  fireEvent.click(await verify());
  await screen.findByRole('button', { name: 'Перевірити результат збереження' });
  expect(screen.queryByText('TEST товар збережено')).toBeNull();
  expect(screen.queryByText('Товар збережено')).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Створити TEST товар' }).disabled).toBe(true);
  expect(post.mock.calls.filter(([url]) => url === '/save')).toHaveLength(1);
});

it('preserves a Boolean TEST marker in resumed task context and rejects malformed or enabling intent', () => {
  const product = { categoryCode: 'SV', answers: {}, weight: 0, isTestProduct: true, photoIds: [], enableWhenPhotosVerified: false };
  const task = { id: taskId, categoryCode: 'SV', state: 'open', deliveryAccepted: false,
    resumeHref: '/products/create?integrationTask=' + taskId,
    creationContext: { product, photos: [], unavailablePhotoIds: [], canResume: true } };
  expect(validateIntegrationResume(task, taskId, config).product.isTestProduct).toBe(true);
  expect(() => validateIntegrationResume({ ...task, creationContext: { ...task.creationContext, product: { ...product, isTestProduct: 'true' } } }, taskId, config)).toThrow(/Ознака TEST/);
  expect(() => validateIntegrationResume({ ...task, creationContext: { ...task.creationContext, product: { ...product, enableWhenPhotosVerified: true } } }, taskId, config)).toThrow(/не може бути ввімкнений/);
});

it('projects photo activation off for TEST while retaining the ordinary stored preference', async () => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'get').mockResolvedValue({ data: { productId: 5012, version: '1', photos: [{ id: photoId, name: 'test.png', mimeType: 'image/png' }], enableWhenVerified: true, delivery: null } });
  const { result, rerender } = renderHook(({ allowed }) => photoHooks.useProductPhotos({ productId: 5012, allowProductActivation: allowed }),
    { initialProps: { allowed: true }, wrapper: ({ children }) => <AuthContext.Provider value={auth}>{children}</AuthContext.Provider> });
  await waitFor(() => expect(result.current.enableWhenVerified).toBe(true));
  rerender({ allowed: false });
  expect(result.current.enableWhenVerified).toBe(false);
  expect(result.current.creationPayload.enableWhenPhotosVerified).toBe(false);
  rerender({ allowed: true });
  expect(result.current.enableWhenVerified).toBe(true);
  await act(async () => result.current.reset());
});

it.each([true, false])('retains a resumed TEST snapshot without converting it into ordinary creation when Administrator access is %s', async (allowed) => {
  if (!allowed) auth.roles = [{ key: 'manager' }];
  const product = { categoryCode: 'SV', answers: {}, weight: 0, isTestProduct: true, photoIds: [], enableWhenPhotosVerified: false };
  const task = { id: taskId, categoryCode: 'SV', categoryLabel: 'Сувеніри', state: 'open', deliveryAccepted: false,
    resumeHref: '/products/create?integrationTask=' + taskId,
    creationContext: { product, photoCount: 0, photos: [], unavailablePhotoIds: [], canResume: true } };
  const original = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, ...args) => url === '/integration-tasks/' + taskId ? { data: task } : original(url, ...args));
  open('/products/create?integrationTask=' + taskId);
  fireEvent.click(await screen.findByRole('button', { name: 'Відновити введені дані та фото' }));
  if (allowed) {
    expect((await screen.findByRole('checkbox', { name: 'Створити TEST товар' })).checked).toBe(true);
    await verify();
    expect(post.mock.calls.find(([url]) => url === '/preview')[1].isTestProduct).toBe(true);
  } else {
    await screen.findByText('Збережена задача містить TEST товар. Для відновлення потрібен чинний доступ Адміністратора; ознака TEST не змінюється.');
    expect(photos.restoreStaged).not.toHaveBeenCalled();
    expect(post.mock.calls.some(([url]) => url === '/preview' || url === '/save')).toBe(false);
  }
  expect(task.creationContext.product.isTestProduct).toBe(true);
});
