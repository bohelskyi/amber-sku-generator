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

function renderState(productId, principalLifetime, permissions) {
  const view = render(
    <AuthContext.Provider value={auth(principalLifetime, permissions)}>
      <MemoryRouter><ProductMagentoState product={{ productId }} /></MemoryRouter>
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
