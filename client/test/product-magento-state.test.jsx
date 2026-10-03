import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { ProductMagentoState } from '../src/components/app/ProductMagentoState.jsx';
import { api } from '../src/lib/api.js';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(data) {
  return { data };
}

function auth(principalLifetime = { id: 'operator-1', valid: true }, permissions = ['products.view']) {
  return { permissions, principalLifetime };
}

function renderState(productId, principalLifetime, permissions, props = {}) {
  const view = render(
    <AuthContext.Provider value={auth(principalLifetime, permissions)}>
      <MemoryRouter><ProductMagentoState product={{ productId, publicSku: 'SV5111010', categoryCode: 'SV', status: 'active' }} {...props} /></MemoryRouter>
    </AuthContext.Provider>
  );
  return {
    ...view,
    rerenderProduct(nextProductId, nextPrincipal = principalLifetime) {
      view.rerender(
        <AuthContext.Provider value={auth(nextPrincipal, permissions)}>
          <MemoryRouter><ProductMagentoState product={{ productId: nextProductId }} /></MemoryRouter>
        </AuthContext.Provider>
      );
    },
  };
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

it('links a processing readiness issue directly to its correspondence without writes', async () => {
  api.get.mockResolvedValue(response({ state: 'needs_attention', problems: [{
    code: 'PRODUCT_EVALUATION_NOT_READY', issueFields: ['kamin_obrobka'],
  }] }));
  renderState(1368, undefined, ['products.view', 'export_templates.view']);
  expect((await screen.findByRole('link', { name: 'Відповідності: Обробка каменю' })).getAttribute('href')).toBe('/admin/magento/categories/SV?field=kamin_obrobka');
  expect(api.post).not.toHaveBeenCalled();
});

it('removes stale status and actions when a manual refresh fails', async () => {
  api.get
    .mockResolvedValueOnce(response({ state: 'needs_attention', reason: 'Перевірте товар.' }))
    .mockRejectedValueOnce(new Error('status unavailable'));
  renderState(7);

  await screen.findByText('Magento: Потребує уваги');
  expect(screen.getByRole('link', { name: 'Переглянути проблему' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Оновити стан Magento' }));

  await screen.findByText('Стан тимчасово недоступний');
  expect(screen.queryByText('Magento: Потребує уваги')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Переглянути проблему' })).toBeNull();
});

it('offers existing name and narrow SV size repair workflows from readiness status', async () => {
  const saved = vi.fn(); const recount = vi.fn();
  api.get.mockResolvedValue(response({ state: 'needs_attention', reason: 'generic', problems: [{
    code: 'PRODUCT_EVALUATION_NOT_READY',
    message: 'Товар не готовий до синхронізації. Потрібно доповнити або виправити дані товару.',
    issueFields: ['kamin_obrobka', 'name', 'rozmir_suveniriv'],
  }] }));
  api.post.mockImplementation(async (url) => {
    if (url === '/product-information/preview') return response({ previewToken: 'size-proof',
      changes: [{ key: 'size', before: null, after: '12×8 см' }] });
    if (url === '/product-information/apply') return response({ productId: 1368 });
    throw new Error(`Unexpected ${url}`);
  });
  renderState(1368, undefined, ['products.view', 'products.recount', 'exports.create'], {
    onSaved: saved, onRepairCharacteristics: recount,
  });
  await screen.findByText('Товар не готовий до синхронізації');
  expect(screen.getByRole('button', { name: 'Заповнити назви' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Заповнити розмір' }));
  expect(screen.getByText('Розмір товару · SV5111010')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Розмір'), { target: { value: '12 × 8 см' } });
  fireEvent.click(screen.getByRole('button', { name: 'Переглянути зміну' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/product-information/preview', {
    productId: 1368, answersPatch: { size: '12 × 8 см' },
  }));
  fireEvent.click(await screen.findByRole('button', { name: 'Зберегти розмір' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/product-information/apply', {
    productId: 1368, answersPatch: { size: '12×8 см' }, previewToken: 'size-proof',
    reason: 'Доповнення даних для синхронізації Magento',
  }));
  expect(recount).not.toHaveBeenCalled();
  expect(saved).toHaveBeenCalledOnce();
});

it('readiness actions follow capabilities and name conflicts keep their separate workflow', async () => {
  api.get.mockResolvedValue(response({ state: 'needs_attention', nameConflict: true, problems: [{
    code: 'PRODUCT_EVALUATION_NOT_READY', issueFields: ['name', 'rozmir_suveniriv'],
  }] }));
  renderState(1368, undefined, ['products.view']);
  await screen.findByText('Товар не готовий до синхронізації');
  expect(screen.getByText(/Передайте виправлення оператору/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Заповнити назви' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Заповнити розмір' })).toBeNull();
});

it('keeps an open name review mounted while a polling refresh fails', async () => {
  const refreshRead = deferred();
  api.get
    .mockResolvedValueOnce(response({ state: 'needs_attention', nameConflict: true }))
    .mockImplementationOnce(() => refreshRead.promise);
  api.post.mockResolvedValueOnce(response({
    amber: { all: 'Назва Amber', en: 'Amber name' },
    magento: { all: 'Назва Magento', en: 'Magento name' },
    previewToken: 'preview-token',
  }));
  renderState(7, undefined, ['products.view', 'exports.create']);

  fireEvent.click(await screen.findByRole('button', { name: 'Вибрати актуальну назву' }));
  expect(await screen.findByText(/Назва Amber/)).toBeTruthy();

  window.dispatchEvent(new Event('focus'));
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('dialog', { name: 'Виберіть актуальну назву' })).toBeTruthy();
  expect(screen.getByText(/Назва Amber/)).toBeTruthy();

  refreshRead.reject(new Error('status unavailable'));
  await screen.findByText('Стан тимчасово недоступний');
  expect(screen.getByRole('dialog', { name: 'Виберіть актуальну назву' })).toBeTruthy();
  expect(screen.getByText(/Назва Amber/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Вибрати актуальну назву' })).toBeNull();
});

it('hides the previous product state immediately when the product changes', async () => {
  const secondRead = deferred();
  api.get
    .mockResolvedValueOnce(response({ state: 'synced' }))
    .mockImplementationOnce(() => secondRead.promise);
  const view = renderState(7);
  await screen.findByText('Magento: Синхронізовано');

  view.rerenderProduct(8);
  expect(screen.queryByText('Magento: Синхронізовано')).toBeNull();
  secondRead.resolve(response({ state: 'pending' }));
  expect(await screen.findByText('Magento: Очікує синхронізації')).toBeTruthy();
});

it('ignores an older product response that resolves after the current product', async () => {
  const firstRead = deferred();
  const secondRead = deferred();
  api.get
    .mockImplementationOnce(() => firstRead.promise)
    .mockImplementationOnce(() => secondRead.promise);
  const view = renderState(7);
  view.rerenderProduct(8);

  secondRead.resolve(response({ state: 'synced' }));
  await screen.findByText('Magento: Синхронізовано');
  firstRead.resolve(response({ state: 'needs_attention', reason: 'Старий товар' }));
  await waitFor(() => expect(screen.queryByText('Старий товар')).toBeNull());
  expect(screen.getByText('Magento: Синхронізовано')).toBeTruthy();
});

it('fences status evidence by principal lifetime', async () => {
  const nextRead = deferred();
  const firstPrincipal = { id: 'operator-1', valid: true };
  const nextPrincipal = { id: 'operator-2', valid: true };
  api.get
    .mockResolvedValueOnce(response({ state: 'synced' }))
    .mockImplementationOnce(() => nextRead.promise);
  const view = renderState(7, firstPrincipal);
  await screen.findByText('Magento: Синхронізовано');

  firstPrincipal.valid = false;
  view.rerenderProduct(7, nextPrincipal);
  expect(screen.queryByText('Magento: Синхронізовано')).toBeNull();
  nextRead.resolve(response({ state: 'not_tracked' }));
  expect(await screen.findByText('Magento: Синхронізацію ще не відстежуємо')).toBeTruthy();
});
