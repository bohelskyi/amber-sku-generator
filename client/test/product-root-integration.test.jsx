import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom';
import AppPage from '../src/pages/AppPage.jsx';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { useDirtyNavigation } from '../src/hooks/useDirtyNavigation.jsx';
import * as photoHooks from '../src/hooks/useProductPhotos.js';

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
let config, decoded, post, get, owner, writeText;
beforeEach(() => {
  config = structuredClone(baseConfig); decoded = structuredClone(nativeProduct);
  owner = { id: 'root-integration-test', valid: true };
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  Element.prototype.scrollIntoView = vi.fn();
  get = vi.spyOn(api, 'get').mockImplementation(async (url) => ({ data:
    url === '/config' ? config : url === '/products' ? [] : url === '/products/91/photos'
      ? { productId: 91, version: '0', photos: [], enableWhenVerified: false, delivery: null }
      : url === '/products/91/lifecycle' ? { productId: 91, visibility: null }
        : url === '/magento/product-status/91' ? { state: 'not_queued' } : {} }));
  post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
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

function openWorkspace(permissions, initialEntry = '/products') {
  const auth = { permissions, roles: [], principalLifetime: owner };
  const router = createMemoryRouter([{ path: '*', element: <AuthContext.Provider value={auth}>
    <Link to="/products">Товари навігація</Link><AppPage />
  </AuthContext.Provider> }], { initialEntries: [initialEntry] });
  render(<RouterProvider router={router} />);
  return router;
}

it.each([
  { permissions: ['products.view', 'products.archive'], capability: true, offered: true },
  { permissions: ['products.view'], capability: true, offered: false },
  { permissions: ['products.archive'], capability: true, offered: false },
  { permissions: ['products.view', 'products.archive'], capability: false, offered: false },
  { permissions: ['products.view', 'products.archive'], capability: undefined, offered: false },
])('offers restore only with both permissions and advertised capability: $permissions / $capability', async ({ permissions, capability, offered }) => {
  config.productLifecycle = capability === undefined ? undefined : { available: capability };
  openWorkspace(permissions);
  await screen.findByRole('heading', { level: 1, name: 'Товари' });
  if (permissions.includes('products.view')) await waitFor(() => expect(get).toHaveBeenCalledWith('/config'));
  await waitFor(() => expect(Boolean(screen.queryByRole('button', { name: 'Відновити за артикулами' }))).toBe(offered));
  expect(post).not.toHaveBeenCalled();
});

it('opens restore and retains typed articles without any POST until the explicit list review', async () => {
  openWorkspace(['products.view', 'products.archive']);
  fireEvent.click(await screen.findByRole('button', { name: 'Відновити за артикулами' }));
  const dialog = screen.getByRole('dialog', { name: 'Відновити товари за артикулами' });
  fireEvent.change(within(dialog).getByLabelText('Артикули, по одному в рядку'), { target: { value: 'AG-000091' } });
  expect(post).not.toHaveBeenCalled();
  expect(within(dialog).queryByRole('button', { name: 'Підтвердити відновлення та синхронізацію' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Перевірити список' }));
  await within(dialog).findByText('Архівований товар — можна відновити');
  expect(post).toHaveBeenCalledExactlyOnceWith('/products/restore/preview', { skus: ['AG-000091'] });
  expect(within(dialog).getByRole('button', { name: 'Підтвердити відновлення та синхронізацію' })).toBeTruthy();
});

it.each([false, true])('gates existing-product photo edits on recount permission: %s', async (canRecount) => {
  openWorkspace(['products.view', 'products.decode', ...(canRecount ? ['products.recount'] : [])], '/products/open?article=AG-000091');
  await screen.findByRole('heading', { level: 1, name: 'Товар AG-000091' });
  await screen.findByRole('heading', { name: 'Фотографії' });
  await waitFor(() => expect(get.mock.calls.some(([url]) => url === '/products/91/photos')).toBe(true));
  expect(Boolean(screen.queryByLabelText('Додати фото'))).toBe(canRecount);
  expect(screen.queryByText('Внутрішній SKU')).toBeNull();
  expect(screen.getByText('Версія характеристик')).toBeTruthy();
  expect(post.mock.calls.map(([url]) => url)).toEqual(['/decode']);
});

it('does not read or display existing-product photos when the backend capability is unavailable', async () => {
  config.productPhotoRequirements.available = false;
  openWorkspace(['products.view', 'products.decode', 'products.recount'], '/products/open?article=AG-000091');
  await screen.findByRole('heading', { level: 1, name: 'Товар AG-000091' });
  expect(screen.queryByRole('heading', { name: 'Фотографії' })).toBeNull();
  expect(get.mock.calls.some(([url]) => url === '/products/91/photos')).toBe(false);
});

it('keeps archived-product photo selection read-only even with recount permission', async () => {
  decoded.product.status = 'archived';
  openWorkspace(['products.view', 'products.decode', 'products.recount'], '/products/open?article=AG-000091');
  await screen.findByRole('heading', { level: 1, name: 'Товар AG-000091' });
  await screen.findByRole('heading', { name: 'Фотографії' });
  expect(screen.queryByLabelText('Додати фото')).toBeNull();
  expect(post.mock.calls.map(([url]) => url)).toEqual(['/decode']);
});

it.each(['public_identity', 'encoded_sku'])('archives the public article after explicit confirmation for %s products', async (identityMode) => {
  if (identityMode === 'encoded_sku') decoded = { ...decoded, identityMode, characteristicConfig: null,
    sku: 'NM-LEGACY-91', internalSku: 'NM-LEGACY-91', baseSku: 'NM', skuSchema: { id: 3, version: 3, marker: '' } };
  openWorkspace(['products.view', 'products.decode', 'products.archive'], '/products/open?article=AG-000091');
  fireEvent.click(await screen.findByRole('button', { name: 'Архівувати товар' }));
  const dialog = screen.getByRole('dialog', { name: 'Архівувати товар?' });
  expect(within(dialog).getByText('AG-000091')).toBeTruthy();
  expect(post.mock.calls.map(([url]) => url)).toEqual(['/decode']);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Архівувати товар' }));
  await screen.findByText('Товар архівовано в Amber');
  expect(post).toHaveBeenCalledWith('/delete', { skuToDelete: 'AG-000091' });
  expect(post.mock.calls.filter(([url]) => url === '/delete')).toHaveLength(1);
});

it.each(['public_identity', 'encoded_sku'])('uses explicit creation review and permission-gated photo UI for %s', async (identityMode) => {
  config.productCreation.identityMode = identityMode;
  config.productCreation.pricingDecision.available = identityMode === 'public_identity';
  openWorkspace(['products.view', 'products.create'], '/products/create?category=NM');
  const weight = await screen.findByLabelText(/Вага менеджера/);
  expect(Boolean(screen.queryByRole('heading', { name: 'Фотографії' }))).toBe(identityMode === 'public_identity');
  expect(screen.queryByRole('button', { name: 'Зберегти товар' })).toBeNull();
  expect(post.mock.calls.some(([url]) => ['/preview', '/save', '/product-photos/stage'].includes(url))).toBe(false);
  fireEvent.change(weight, { target: { value: '12,7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  expect(screen.getByRole('button', { name: 'Копіювати ціну' })).toBeTruthy();
  expect(Boolean(screen.queryByRole('button', { name: 'Додати варіацію' }))).toBe(identityMode === 'encoded_sku');
  expect(Boolean(screen.queryByText('Внутрішній SKU'))).toBe(identityMode === 'encoded_sku');
  fireEvent.click(screen.getByRole('button', { name: 'Копіювати ціну' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith('1200 ₴'));
  expect(post.mock.calls.filter(([url]) => url === '/preview')).toHaveLength(1);
  expect(post.mock.calls.some(([url]) => url === '/save')).toBe(false);
});

it('does not expose creation or photo upload controls without products.create', async () => {
  openWorkspace(['products.view'], '/products/create?category=NM');
  await screen.findByRole('heading', { level: 1, name: 'Створення товару' });
  await waitFor(() => expect(get).toHaveBeenCalledWith('/config'));
  expect(screen.queryByRole('button', { name: 'Перевірити дані' })).toBeNull();
  expect(screen.queryByLabelText('Додати фото')).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

it('can stay on an uncertain native save after a blocked navigation and recover the original attempt', async () => {
  let saves = 0;
  post.mockImplementation(async (url) => {
    if (url === '/save') {
      if (++saves === 1) throw new Error('Lost response');
      return { data: { success: true, id: 92, publicSku: 'AG-000092' } };
    }
    return { data: nativePreview };
  });
  const router = openWorkspace(['products.view', 'products.create'], '/products/create?category=NM');
  fireEvent.change(await screen.findByLabelText(/Вага менеджера/), { target: { value: '12,7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Зберегти товар' }));
  await screen.findByRole('button', { name: 'Перевірити результат збереження' });
  fireEvent.click(screen.getByRole('link', { name: 'Товари навігація' }));
  const guard = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  expect(within(guard).getByRole('button', { name: 'Відкинути й перейти' }).disabled).toBe(true);
  const stay = within(guard).getByRole('button', { name: 'Залишитися' });
  expect(stay.disabled).toBe(false);
  fireEvent.click(stay);
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Незбережені зміни' })).toBeNull());
  expect(router.state.location.pathname).toBe('/products/create');
  expect(post.mock.calls.filter(([url]) => url === '/save')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити результат збереження' }));
  await screen.findByText('Товар збережено');
  const requests = post.mock.calls.filter(([url]) => url === '/save');
  expect(requests).toHaveLength(2);
  expect(requests[1][1]).toEqual(requests[0][1]);
});

it.each(['false', 'rejected'])('holds navigation during a guard-initiated save and remains after a %s result', async (outcome) => {
  let resolveSave, rejectSave;
  const saving = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
  const save = vi.fn(() => saving), discard = vi.fn();
  function SavingGuard() {
    const navigation = useDirtyNavigation({ dirty: true, save, discard });
    return <><Link to="/target">Інший розділ</Link>{navigation.prompt}</>;
  }
  const router = createMemoryRouter([{ path: '*', element: <SavingGuard /> }], { initialEntries: ['/source'] });
  render(<RouterProvider router={router} />);
  fireEvent.click(screen.getByRole('link', { name: 'Інший розділ' }));
  const guard = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  fireEvent.click(within(guard).getByRole('button', { name: 'Зберегти й перейти' }));
  expect(within(guard).getByRole('button', { name: 'Залишитися' }).disabled).toBe(true);
  expect(within(guard).getByRole('button', { name: 'Відкинути й перейти' }).disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog', { name: 'Незбережені зміни' })).toBeTruthy();
  await act(async () => { if (outcome === 'rejected') rejectSave(new Error('Save rejected')); else resolveSave(false); });
  await waitFor(() => expect(within(guard).getByRole('button', { name: 'Залишитися' }).disabled).toBe(false));
  expect(router.state.location.pathname).toBe('/source');
  expect(save).toHaveBeenCalledOnce(); expect(discard).not.toHaveBeenCalled();
  fireEvent.click(within(guard).getByRole('button', { name: 'Залишитися' }));
  expect(screen.queryByRole('dialog', { name: 'Незбережені зміни' })).toBeNull();
});

it('retains an existing product failed first photo upload on Stay and resets it exactly once before accepted departure', async () => {
  const useOriginalPhotos = photoHooks.useProductPhotos;
  let currentPhotoState, router;
  const resetLocations = [];
  vi.spyOn(photoHooks, 'useProductPhotos').mockImplementation(function useObservedProductPhotos(options) {
    const controller = useOriginalPhotos(options);
    if (options.productId !== 91) return controller;
    currentPhotoState = controller;
    return { ...controller, reset: () => { resetLocations.push(router.state.location.pathname); controller.reset(); } };
  });
  post.mockImplementation(async (url) => {
    if (url === '/decode') return { data: decoded };
    if (url === '/product-photos/stage') throw new Error('Stage response lost');
    throw new Error(`Unexpected mutation ${url}`);
  });
  router = openWorkspace(['products.view', 'products.decode', 'products.recount'], '/products/open?article=AG-000091');
  const upload = await screen.findByLabelText('Додати фото');
  await waitFor(() => expect(upload.disabled).toBe(false));
  fireEvent.change(upload, { target: { files: [new File([new Uint8Array(40)], 'lost-first.png', { type: 'image/png' })] } });
  const warning = 'Не всі фото збережені. Зберегти фотографії можна після повторного збереження або вилучення цих фото зі спроби.';
  await screen.findByText(warning);
  expect(currentPhotoState.dirty).toBe(false);
  expect(currentPhotoState.photos).toHaveLength(0);
  expect(currentPhotoState.failedUploads).toHaveLength(1);
  expect(currentPhotoState.hasPendingUploads).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: 'Товари навігація' }));
  const firstGuard = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  fireEvent.click(within(firstGuard).getByRole('button', { name: 'Залишитися' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Незбережені зміни' })).toBeNull());
  expect(router.state.location.pathname).toBe('/products/open');
  expect(screen.getByText(warning)).toBeTruthy();
  expect(currentPhotoState.failedUploads).toHaveLength(1);
  expect(resetLocations).toHaveLength(0);
  expect(post.mock.calls.filter(([url]) => url === '/product-photos/stage')).toHaveLength(1);
  fireEvent.click(screen.getByRole('link', { name: 'Товари навігація' }));
  const secondGuard = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  fireEvent.click(within(secondGuard).getByRole('button', { name: 'Відкинути й перейти' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/products'));
  expect(resetLocations).toEqual(['/products/open']);
  expect(post.mock.calls.filter(([url]) => url === '/product-photos/stage')).toHaveLength(1);
});

it('blocks creation-photo discard during an in-flight stage while Stay preserves the original upload', async () => {
  const useOriginalPhotos = photoHooks.useProductPhotos;
  let currentCreationPhotos, resolveStage;
  vi.spyOn(photoHooks, 'useProductPhotos').mockImplementation(function useObservedCreationPhotos(options) {
    const controller = useOriginalPhotos(options);
    if (options.productId == null && options.canEdit) currentCreationPhotos = controller;
    return controller;
  });
  post.mockImplementation((url) => {
    if (url === '/product-photos/stage') return new Promise((resolve) => { resolveStage = resolve; });
    return Promise.reject(new Error(`Unexpected mutation ${url}`));
  });
  const router = openWorkspace(['products.view', 'products.create'], '/products/create?category=NM');
  const upload = await screen.findByLabelText('Додати фото');
  await waitFor(() => expect(upload.disabled).toBe(false));
  fireEvent.change(upload, { target: { files: [new File([new Uint8Array(40)], 'pending-create.png', { type: 'image/png' })] } });
  await waitFor(() => expect(post.mock.calls.filter(([url]) => url === '/product-photos/stage')).toHaveLength(1));
  expect(currentCreationPhotos.busy).toBe(true);
  expect(currentCreationPhotos.hasPendingUploads).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: 'Товари навігація' }));
  const guard = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  expect(within(guard).getByRole('button', { name: 'Відкинути й перейти' }).disabled).toBe(true);
  expect(within(guard).getByRole('button', { name: 'Залишитися' }).disabled).toBe(false);
  expect(within(guard).queryByRole('button', { name: 'Зберегти й перейти' })).toBeNull();
  fireEvent.click(within(guard).getByRole('button', { name: 'Залишитися' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Незбережені зміни' })).toBeNull());
  expect(router.state.location.pathname).toBe('/products/create');
  expect(currentCreationPhotos.busy).toBe(true);
  expect(post).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Перевірити дані' }).disabled).toBe(true);
  await act(async () => resolveStage({ data: { id: '4c6769bb-aae8-4e95-8a25-28374690eae1', name: 'pending-create.png', mimeType: 'image/png' } }));
  await screen.findByText('Головне');
  expect(currentCreationPhotos.busy).toBe(false);
  expect(currentCreationPhotos.photos).toHaveLength(1);
  fireEvent.click(screen.getByRole('link', { name: 'Товари навігація' }));
  const finishedGuard = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  expect(within(finishedGuard).getByRole('button', { name: 'Відкинути й перейти' }).disabled).toBe(false);
  expect(post).toHaveBeenCalledOnce();
});
it('shows exact pending delivery before native save and retains the authoritative saved-receipt warning', async () => {
  const diagnostic = { scope: 'native_characteristic_source_support', status: 'configuration_required',
    code: 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED', categoryCode: 'NM', questionKey: 'extra',
    bindingRevisionId: 'preview-binding', targetContract: 'public-product-characteristics-v1' };
  post.mockImplementation(async (url) => {
    if (url === '/preview' || url === '/price-preview') return { data: { ...nativePreview, creationDeliveryReadiness: diagnostic } };
    if (url === '/save') return { data: { success: true, id: 92, publicSku: 'AG-000092',
      creationDeliveryReadiness: { ...diagnostic, bindingRevisionId: 'authoritative-save-binding' } } };
    throw new Error('Unexpected mutation ' + url);
  });
  openWorkspace(['products.view', 'products.create', 'export_templates.view', 'export_templates.manage'], '/products/create?category=NM');
  fireEvent.change(await screen.findByLabelText(/Вага менеджера/), { target: { value: '12,7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  const save = await screen.findByRole('button', { name: 'Зберегти товар' });
  expect(save.disabled).toBe(false);
  const warning = screen.getByRole('alert', { name: 'Передавання нового товару в Magento' });
  expect(save.getAttribute('aria-describedby')).toBe(warning.id);
  expect(screen.getByText('Очікує підключення')).toBeTruthy();
  const previewLink = screen.getByRole('link', { name: 'Підготувати підключення у новій вкладці' });
  expect(previewLink.href).toContain('binding=preview-binding');
  expect(previewLink.target).toBe('_blank');
  expect(post.mock.calls.filter(([url]) => url === '/save')).toHaveLength(0);
  fireEvent.click(save);
  await screen.findByText('Товар збережено');
  expect(screen.getByText('Перевірка на момент збереження')).toBeTruthy();
  expect(screen.getByText('Збережено в менеджері. Доставку в Magento не підтверджено.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Підготувати підключення у новій вкладці' }).href).toContain('binding=authoritative-save-binding');
  const payload = post.mock.calls.find(([url]) => url === '/save')[1];
  expect(payload.previewToken).toBe(nativePreview.previewToken);
  expect(payload.creationDeliveryReadiness).toBeUndefined();
  expect(post.mock.calls.map(([url]) => url).every(url => ['/preview', '/price-preview', '/save'].includes(url))).toBe(true);
});
it('refreshes the narrow delivery diagnostic only on explicit recheck while preserving entered characteristics', async () => {
  const diagnostic = { scope: 'native_characteristic_source_support', status: 'configuration_required',
    code: 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED', categoryCode: 'NM', questionKey: 'extra',
    bindingRevisionId: 'old-binding', targetContract: 'public-product-characteristics-v1' };
  let checks = 0;
  post.mockImplementation(async (url) => {
    if (url === '/price-preview') return { data: nativePreview };
    if (url === '/preview') return { data: { ...nativePreview, creationDeliveryReadiness: ++checks === 1 ? diagnostic
      : { ...diagnostic, status: 'no_native_upgrade_blocker', code: null, bindingRevisionId: 'reviewed-new-binding' } } };
    throw new Error('Unexpected mutation ' + url);
  });
  openWorkspace(['products.view', 'products.create'], '/products/create?category=NM');
  const weight = await screen.findByLabelText(/Вага менеджера/);
  fireEvent.change(weight, { target: { value: '12,7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByText('Очікує підключення');
  expect(screen.queryByRole('link', { name: /Підготувати підключення/ })).toBeNull();
  expect(screen.getByText(/із правом керування інтеграцією/)).toBeTruthy();
  expect(checks).toBe(1);
  fireEvent.click(screen.getByText('Деталі', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('button', { name: 'Оновити перевірку' }));
  await screen.findByText(/передавання товару в Magento перевіряється окремо/);
  expect(checks).toBe(2);
  expect(weight.value).toBe('12,7');
  expect(screen.queryByText('Очікує підключення')).toBeNull();
  expect(screen.getByText('Дані перевірено')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Зберегти товар' }).disabled).toBe(false);
  expect(post.mock.calls.some(([url]) => url === '/save')).toBe(false);
});
it('holds Save during a pending explicit diagnostic refresh and never posts an old proof concurrently', async () => {
  const diagnostic = { scope: 'native_characteristic_source_support', status: 'configuration_required',
    code: 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED', categoryCode: 'NM', questionKey: 'extra',
    bindingRevisionId: 'old-binding', targetContract: 'public-product-characteristics-v1' };
  let checks = 0, resolveRefresh;
  post.mockImplementation((url) => {
    if (url === '/price-preview') return Promise.resolve({ data: nativePreview });
    if (url === '/preview') return ++checks === 1
      ? Promise.resolve({ data: { ...nativePreview, creationDeliveryReadiness: diagnostic } })
      : new Promise(resolve => { resolveRefresh = resolve; });
    return Promise.reject(new Error('Unexpected mutation ' + url));
  });
  openWorkspace(['products.view', 'products.create'], '/products/create?category=NM');
  fireEvent.change(await screen.findByLabelText(/Вага менеджера/), { target: { value: '12,7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByText('Очікує підключення');
  fireEvent.click(screen.getByText('Деталі', { selector: 'summary' }));
  fireEvent.click(screen.getByRole('button', { name: 'Оновити перевірку' }));
  const save = screen.getByRole('button', { name: 'Зберегти товар' });
  await waitFor(() => expect(resolveRefresh).toBeTypeOf('function'));
  expect(save.disabled).toBe(true);
  fireEvent.click(save);
  expect(post.mock.calls.some(([url]) => url === '/save')).toBe(false);
  await act(async () => resolveRefresh({ data: { ...nativePreview, previewToken: 'fresh-proof',
    creationDeliveryReadiness: { ...diagnostic, status: 'no_native_upgrade_blocker', code: null } } }));
  await screen.findByText('Дані перевірено');
  expect(save.disabled).toBe(false);
});
it('shows a separate deferred-size review before local save even when native evaluator5 is supported', async () => {
  config.categories = { AR: { code: 'AR', name: 'Розмірний виріб', requires_weight: 1 } };
  config.questions = { AR: [...baseConfig.questions.NM, { id: 'size', label: 'Розмір', input_type: 'options',
    required: 1, options: [{ id: 29, label: 'Двадцять дев’ятий розмір' }] }] };
  const diagnostic = { scope: 'native_characteristic_source_support', status: 'configuration_required',
    code: 'SOURCE_SUPPORT_DEFERRED_VALUE', categoryCode: 'AR', questionKey: 'size', valueId: '29',
    bindingRevisionId: 'reviewed-evaluator5', evaluatorVersion: 'magento-declarative-5' };
  post.mockImplementation(async (url) => {
    if (url === '/price-preview') return { data: nativePreview };
    if (url === '/preview') return { data: { ...nativePreview, normalizedAnswers: { weight: 12.7, size: 29 }, creationDeliveryReadiness: diagnostic } };
    throw new Error('Unexpected mutation ' + url);
  });
  openWorkspace(['products.view', 'products.create', 'export_templates.view'], '/products/create?category=AR');
  fireEvent.change(await screen.findByLabelText(/Вага менеджера/), { target: { value: '12,7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Двадцять дев’ятий розмір' }));
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  const save = await screen.findByRole('button', { name: 'Зберегти товар' });
  expect(save.disabled).toBe(false);
  const review = screen.getByRole('link', { name: 'Перевірити значення та відповідність у новій вкладці' });
  expect(review.href).toContain('/admin/magento/categories/AR?question=size');
  expect(review.href).toContain('value=29');
  expect(screen.getByText('«Розмір»: значення «Двадцять дев’ятий розмір» відкладено в правилах')).toBeTruthy();
  expect(screen.getByText('Можна зберегти лише в менеджері.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: /Підготувати підключення/ })).toBeNull();
  expect(post.mock.calls.some(([url]) => url === '/save')).toBe(false);
});
