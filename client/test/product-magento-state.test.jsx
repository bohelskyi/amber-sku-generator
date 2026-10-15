import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { ProductMagentoState } from '../src/components/app/ProductMagentoState.jsx';
import { ProductMagentoAttention } from '../src/components/app/ProductMagentoAttention.jsx';
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

it('offers one exact Attention handoff without mounting configuration or repair actions', async () => {
  api.get.mockResolvedValue(response({ state: 'needs_attention', problems: [{
    code: 'PRODUCT_EVALUATION_NOT_READY', issueFields: ['kamin_obrobka'], message: 'Оберіть обробку каменю.',
  }] }));
  renderState(1368, undefined, ['products.view', 'export_templates.view']);
  expect((await screen.findByRole('link', { name: 'Переглянути проблему' })).getAttribute('href')).toBe('/attention?problem=1368');
  expect(screen.getByText('Оберіть обробку каменю.')).toBeTruthy();
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Виправити характеристики' })).toBeNull();
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

it('keeps an unqueued inherited-name review available on demand with authoritative confirmation', async () => {
  const onSaved = vi.fn();
  api.get.mockResolvedValue(response({ state: 'synced', problems: [] }));
  api.post.mockImplementation(async (url) => {
    if (url === '/product-magento-name/preview') return response({ publicSku: 'SV5111010',
      subjectUa: 'Камінь', subjectEn: 'Stone', reviewRequired: true, canConfirmUnchanged: true, previewToken: 'legacy-proof' });
    if (url === '/product-magento-name/apply') return response({ productId: 7 });
    throw new Error(`Unexpected ${url}`);
  });
  renderState(7, undefined, ['products.view', 'exports.create'], { onSaved,
    product: { productId: 7, publicSku: 'SV5111010', categoryCode: 'SV', status: 'active', magentoNameReviewRequired: true } });
  await screen.findByText('Успадковані назви потребують підтвердження.');
  expect(screen.getByText('Потрібна перевірка назв')).toBeTruthy();
  expect(screen.queryByText('Magento: Синхронізовано')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: 'Переглянути проблему' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити назви' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Підтвердити без змін' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(api.post).toHaveBeenCalledWith('/product-magento-name/apply', {
    productId: 7, subjectUa: 'Камінь', subjectEn: 'Stone', previewToken: 'legacy-proof', confirmUnchanged: true,
  });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('hands inherited names to an authorized operator and keeps queued problems in Attention', async () => {
  api.get.mockResolvedValue(response({ state: 'needs_attention', problems: [{ code: 'PRODUCT_EVALUATION_NOT_READY',
    resolution: 'product', issueFields: ['name'], message: 'Успадковані назви потребують перевірки.' }] }));
  renderState(7, undefined, ['products.view'], {
    product: { productId: 7, categoryCode: 'SV', status: 'active', magentoNameReviewRequired: true },
  });
  expect(screen.getByText('Передайте перевірку назв оператору з дозволом на їх зміну.')).toBeTruthy();
  await screen.findByRole('link', { name: 'Переглянути проблему' });
  expect(screen.queryByRole('button', { name: 'Перевірити назви' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('retains the existing name and exact SV size repairs in the Attention repair component', async () => {
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
  render(<AuthContext.Provider value={auth(undefined, ['products.view', 'products.recount', 'exports.create'])}>
    <MemoryRouter><ProductMagentoAttention compact
      product={{ productId: 1368, publicSku: 'SV5111010', categoryCode: 'SV', status: 'active' }}
      problems={[{ code: 'PRODUCT_EVALUATION_NOT_READY', issueFields: ['kamin_obrobka', 'name', 'rozmir_suveniriv'] }]}
      onSaved={saved} onRepairCharacteristics={recount} /></MemoryRouter>
  </AuthContext.Provider>);
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

it('viewers see the same problem handoff without repair or name mutation controls', async () => {
  api.get.mockResolvedValue(response({ state: 'needs_attention', nameConflict: true, problems: [{
    code: 'PRODUCT_EVALUATION_NOT_READY', issueFields: ['name', 'rozmir_suveniriv'], message: 'Перевірте дані товару.',
  }] }));
  renderState(1368, undefined, ['products.view']);
  await screen.findByText('Перевірте дані товару.');
  expect(screen.getByRole('link', { name: 'Переглянути проблему' }).getAttribute('href')).toBe('/attention?problem=1368');
  expect(screen.queryByRole('button', { name: 'Заповнити назви' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Заповнити розмір' })).toBeNull();
});

it('uses the same recovery priority as Attention and does not display secondary blockers or start their workflows', async () => {
  api.get.mockResolvedValue(response({ state: 'needs_attention', nameConflict: true, problems: [
    { code: 'PRODUCT_EVALUATION_NOT_READY', message: 'Заповніть розмір', issueFields: ['rozmir_suveniriv'] },
    { code: 'reconciliation_required', message: 'Потрібно перевірити результат попередньої зміни.' },
  ] }));
  renderState(7, undefined, ['products.view', 'exports.create']);
  await screen.findByText('Потрібно перевірити результат попередньої зміни.');
  expect(screen.queryByText('Заповніть розмір')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Вибрати актуальну назву' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
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
