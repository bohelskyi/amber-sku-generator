import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import AttentionPage from '../src/pages/AttentionPage.jsx';
import { correctionsApi } from '../src/api/corrections-api.js';
import { useMagentoSummary } from '../src/hooks/useMagentoSummary.js';

vi.mock('../src/api/corrections-api.js', () => ({ correctionsApi: { listRequestPage: vi.fn() } }));

const auth = (permissions) => ({
  permissions, identity: { name: 'Оператор' }, principalLifetime: { valid: true }, logout: vi.fn(),
});
const renderPage = (permissions = ['corrections.view', 'products.view']) => render(
  <AuthContext.Provider value={auth(permissions)}><MemoryRouter><AttentionPage /></MemoryRouter></AuthContext.Provider>
);

beforeEach(() => {
  vi.restoreAllMocks();
  correctionsApi.listRequestPage.mockResolvedValue({ data: { items: [], summary: { active: 4 } } });
  vi.spyOn(api, 'get').mockResolvedValue({ data: { items: [], pageInfo: { total: 0 }, categories: [] } });
});
afterEach(cleanup);

it('opens the real product problem queue without reading legacy corrections', async () => {
  api.get.mockResolvedValue({ data: { items: [{ productId: 7, article: 'AG-000007', category: 'SV',
    problems: [{ code: 'PRODUCT_EVALUATION_NOT_READY', resolution: 'product', message: 'Перевірте дані',
      issueFields: ['kamin_obrobka'], evaluationIssues: [{ field: 'kamin_obrobka', message: 'Оберіть обробку каменю.' }] }] }], pageInfo: { total: 1 } } });
  renderPage();
  await screen.findByRole('heading', { name: /AG-000007/ });
  expect(screen.getAllByText(/Оберіть обробку каменю/).length).toBeGreaterThan(0);
  expect(screen.queryByText('Запити на виправлення')).toBeNull();
  expect(correctionsApi.listRequestPage).not.toHaveBeenCalled();
  expect(api.get).toHaveBeenCalledWith('/magento/problems/page', expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it('does not present an unavailable read as an empty queue', async () => {
  api.get.mockRejectedValue(new Error('unavailable'));
  renderPage();
  await screen.findByText('Не вдалося оновити проблеми доставки.');
  expect(screen.queryByText('Зафіксованих проблем немає')).toBeNull();
});

it('does not expose synchronization evidence through legacy correction permissions', () => {
  renderPage(['corrections.view']);
  expect(screen.getByText(/Перегляд проблем синхронізації недоступний/)).toBeTruthy();
  expect(api.get).not.toHaveBeenCalled();
  expect(correctionsApi.listRequestPage).not.toHaveBeenCalled();
});

it('selected off-page product stays exact and a failed detail never falls back to the first row', async () => {
  api.get.mockImplementation(async (url) => ({ data: url === '/magento/problems/page'
    ? { items: [{ productId: 1, article: 'AG-000001', problems: [{ code: 'configuration', message: 'Інша проблема' }] }], pageInfo: { total: 1 } }
    : { productId: 99, article: 'AG-000099', state: 'pending', problems: [] } }));
  render(<AuthContext.Provider value={auth(['products.view'])}><MemoryRouter initialEntries={['/attention?problem=99&search=AG-1']}><AttentionPage /></MemoryRouter></AuthContext.Provider>);
  await screen.findByRole('heading', { name: /AG-000099/ });
  expect(screen.queryByRole('heading', { name: /AG-000001/ })).toBeNull();
  expect(screen.getByText(/Поточна зміна очікує завершення доставки/)).toBeTruthy();
  api.get.mockRejectedValue(new Error('unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Оновити' }));
  await screen.findByText('Не вдалося прочитати стан вибраного товару. Оновіть дані.');
  expect(screen.queryByRole('heading', { name: /AG-000001/ })).toBeNull();
});

it('search and filters are submitted as bounded server reads', async () => {
  renderPage();
  await screen.findByText('Зафіксованих проблем немає');
  fireEvent.change(screen.getByLabelText('Артикул'), { target: { value: 'AG-000008' } });
  fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'product' } });
  fireEvent.click(screen.getByRole('button', { name: 'Знайти' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/magento/problems/page', expect.objectContaining({
    params: expect.objectContaining({ search: 'AG-000008', reason: 'product', limit: 20, offset: 0 }),
  })));
});

it('does not expose a previous principal summary while the next principal is loading', async () => {
  let resolveNext;
  api.get
    .mockResolvedValueOnce({ data: { problemCount: 3 } })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));
  const firstPrincipal = { id: 'first', valid: true };
  const secondPrincipal = { id: 'second', valid: true };
  const Probe = () => {
    const state = useMagentoSummary();
    return <span>{state.loading ? 'loading' : state.summary?.problemCount ?? 'none'}</span>;
  };
  const show = (principal) => <AuthContext.Provider value={{ ...auth(['products.view']), principalLifetime: principal }}><Probe /></AuthContext.Provider>;
  const view = render(show(firstPrincipal));

  await screen.findByText('3');
  view.rerender(show(secondPrincipal));
  expect(screen.queryByText('3')).toBeNull();
  await screen.findByText('loading');
  await act(async () => resolveNext({ data: { problemCount: 7 } }));
  await screen.findByText('7');
});

it('successful repair retains the selected product when it leaves the attention queue without claiming delivery', async () => {
  let corrected = false;
  const item = { productId: 7, article: 'AG-000007', category: 'SV', productStatus: 'active', state: 'needs_attention', problems: [
    { code: 'PRODUCT_EVALUATION_NOT_READY', resolution: 'product', message: 'Заповніть розмір', issueFields: ['rozmir_suveniriv'] },
  ] };
  api.get.mockImplementation(async (url) => ({ data: url === '/magento/problems/page'
    ? { items: corrected ? [] : [item], pageInfo: { total: corrected ? 0 : 1 } }
    : { ...item, state: 'pending', problems: [] } }));
  vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/product-information/preview') return { data: { previewToken: 'reviewed-size', changes: [{ key: 'size', after: '12×8 см' }] } };
    if (url === '/product-information/apply') { corrected = true; return { data: { productId: 7 } }; }
    throw new Error('Unexpected mutation');
  });
  renderPage(['products.view', 'products.recount']);
  fireEvent.click(await screen.findByRole('button', { name: 'Заповнити розмір' }));
  fireEvent.change(screen.getByLabelText('Розмір'), { target: { value: '12×8 см' } });
  fireEvent.click(screen.getByRole('button', { name: 'Переглянути зміну' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Зберегти розмір' }));
  await screen.findByText('Дані виправлено в Amber. Результат доставки показано окремо у стані Magento.');
  await screen.findByText('Magento: Очікує синхронізації');
  expect(screen.getByRole('heading', { name: /AG-000007/ })).toBeTruthy();
  expect(screen.queryByText('Magento: Синхронізовано')).toBeNull();
  expect(api.get.mock.calls.some(([url]) => url === '/magento/problems/7')).toBe(true);
});
