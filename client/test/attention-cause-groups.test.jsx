import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import SyncProblemsPage from '../src/pages/SyncProblemsPage.jsx';
import MagentoFirstSyncFields from '../src/components/attention/MagentoFirstSyncFields.jsx';
import { problemTaskKey } from '../src/components/attention/sync-problem-presentation.js';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const id = 'a'.repeat(32);
const permissions = ['products.view', 'export_templates.view', 'export_templates.manage', 'export_templates.publish', 'exports.view'];
const auth = { permissions, principalLifetime: { id: 'actor', valid: true }, roles: [{ key: 'administrator' }] };
const problem = { code: 'OPTION_BINDING_REVIEW_REQUIRED', resolution: 'integration_configuration', target: 'color', question: 'kolir', value: '0',
  causeContext: { kind: 'semantic_option', question: 'kolir', target: 'color', value: '0', routeKey: 'KL.color' } };
const item = { productId: 7, article: 'AG-000007', category: 'KL', state: 'needs_attention', problems: [problem], groupProblem: problem };
const response = { items: [{ id, problem, sharedConfiguration: true, productCount: 32, exampleProduct: item }],
  summary: { productCount: 32, diagnosticCount: 37 }, pageInfo: { total: 1 }, categories: [{ code: 'KL', name: 'Кулони' }] };
const shell = (content, path = '/attention') => render(<AuthContext.Provider value={auth}><MemoryRouter initialEntries={[path]}>{content}</MemoryRouter></AuthContext.Provider>);

it('starts with shared causes, counts all affected products and preserves zero identity and group return in Catalog', async () => {
  api.get.mockResolvedValue({ data: response }); shell(<SyncProblemsPage />);
  const groups = await screen.findByRole('region', { name: 'Причини проблем' });
  expect(within(groups).getByRole('button', { name: '32' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'З чого почати' })).toBeNull();
  const target = new URL(screen.getByRole('link', { name: 'Налаштувати відповідність' }).href);
  expect(target.pathname).toBe('/admin/catalog');
  expect(target.searchParams.get('question')).toBe('kolir'); expect(target.searchParams.get('value')).toBe('0');
  expect(target.searchParams.get('route')).toBe('KL.color');
  expect(target.searchParams.get('productId')).toBe('7'); expect(target.searchParams.get('returnTo')).toBe(`/attention?group=${id}`);
  expect(api.get.mock.calls.map(([url]) => url)).toEqual(['/magento/problem-groups/page']);
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps every server-provided problem category selectable after a category-filtered group response', async () => {
  const categories = [{ code: 'KL', name: 'Кулони' }, { code: 'SV', name: 'Свічки' }];
  const candleGroup = { ...response.items[0], id: 'b'.repeat(32), productCount: 4,
    exampleProduct: { ...item, productId: 8, article: 'AG-000008', category: 'SV' } };
  let resolveFiltered;
  api.get.mockImplementation((url, { params }) => {
    if (params.category === 'KL') return new Promise(resolve => { resolveFiltered = resolve; });
    return Promise.resolve({ data: { ...response, categories,
      items: params.category === 'SV' ? [candleGroup] : [...response.items, candleGroup],
      pageInfo: { total: params.category === 'SV' ? 1 : 2 } } });
  });
  shell(<SyncProblemsPage />);
  await screen.findByRole('option', { name: 'Свічки' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Категорія' }), { target: { value: 'KL' } });
  fireEvent.click(screen.getByRole('button', { name: 'Знайти' }));
  await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/magento/problem-groups/page', expect.objectContaining({
    params: expect.objectContaining({ category: 'KL', offset: 0, limit: 20 }),
  })));
  await act(async () => resolveFiltered({ data: { ...response, categories } }));

  const categorySelect = screen.getByRole('combobox', { name: 'Категорія' });
  expect(categorySelect.value).toBe('KL');
  expect(within(categorySelect).getAllByRole('option').map(option => option.value)).toEqual(['', 'KL', 'SV']);
  expect(screen.getByRole('region', { name: 'Причини проблем' })).toBeTruthy();

  fireEvent.change(categorySelect, { target: { value: 'SV' } });
  fireEvent.click(screen.getByRole('button', { name: 'Знайти' }));
  await screen.findByRole('button', { name: '4' });
  expect(api.get).toHaveBeenLastCalledWith('/magento/problem-groups/page', expect.objectContaining({
    params: expect.objectContaining({ category: 'SV', offset: 0, limit: 20 }),
  }));
  const nextCategorySelect = screen.getByRole('combobox', { name: 'Категорія' });
  expect(nextCategorySelect.value).toBe('SV');
  expect(within(nextCategorySelect).getByRole('option', { name: 'Кулони' })).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps the chosen group diagnostic when a product has another higher-priority cause and preserves exact return context', async () => {
  const other = { code: 'PRODUCT_EVALUATION_NOT_READY', resolution: 'product', message: 'Інша перешкода' };
  const wrongPath = { code: 'CATEGORY_PATH_MISSING', resolution: 'integration_configuration', target: 'categories', path: 'Подарунки/Кулони', routeKey: 'KL.gifts', message: 'Немає розділу' };
  const chosen = { ...wrongPath, path: 'Прикраси/Кулони', routeKey: 'KL.base' };
  const member = { ...item, problems: [other, wrongPath, chosen], groupProblem: chosen };
  const exact = { ...member }; delete exact.groupProblem;
  api.get.mockImplementation(async url => ({ data: url === '/magento/problems/7' ? exact : { items: [member], pageInfo: { total: 1 } } }));
  shell(<SyncProblemsPage />, `/attention?group=${id}`);
  const queue = await screen.findByRole('complementary', { name: 'Черга проблем доставки' });
  fireEvent.click(within(queue).getByRole('button', { name: /AG-000007/ }));
  const active = await screen.findByRole('region', { name: 'З чого почати' });
  expect(within(active).getByRole('heading').textContent).toContain(chosen.path);
  expect(within(active).queryByText(other.message)).toBeNull();
  const link = new URL(within(active).getByRole('link', { name: 'Додати відсутню підкатегорію' }).href);
  expect(link.searchParams.get('path')).toBe(chosen.path);
  expect(link.searchParams.get('route')).toBe(chosen.routeKey);
  const returnUrl = new URL(link.searchParams.get('returnTo'), 'http://localhost');
  expect(returnUrl.searchParams.get('group')).toBe(id);
  expect(returnUrl.searchParams.get('problem')).toBe('7');
  expect(returnUrl.searchParams.get('task')).toBe(problemTaskKey(chosen));
  const path = returnUrl.pathname + returnUrl.search;
  cleanup(); shell(<SyncProblemsPage />, path);
  expect(within(await screen.findByRole('region', { name: 'З чого почати' })).getByRole('heading').textContent).toContain(chosen.path);
  expect(api.post).not.toHaveBeenCalled();
});

it('does not substitute another active workflow when a selected diagnostic is no longer present', async () => {
  api.get.mockImplementation(async url => ({ data: url === '/magento/problems/7' ? item : { items: [item], pageInfo: { total: 1 } } }));
  shell(<SyncProblemsPage />, `/attention?group=${id}&problem=7&task=${encodeURIComponent(problemTaskKey({ ...problem, target: 'other' }))}`);
  await screen.findByText('Вибрану причину не підтверджено в поточному стані товару. Оберіть доступну перешкоду нижче.');
  expect(screen.queryByRole('region', { name: 'З чого почати' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('paginates a legacy direct-product URL using bounded product pages without switching to causes', async () => {
  api.get.mockImplementation(async (url, options) => ({ data: url === '/magento/problems/7' ? item : {
    items: [item], pageInfo: { total: 61, hasNext: options.params.offset < 60, hasPrevious: options.params.offset > 0 },
  } }));
  shell(<SyncProblemsPage />, '/attention?problem=7&offset=20');
  const queue = await screen.findByRole('complementary', { name: 'Черга проблем доставки' });
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/magento/problems/page', expect.objectContaining({ params: expect.objectContaining({ limit: 20, offset: 20 }) })));
  fireEvent.click(within(queue).getByRole('button', { name: 'Далі' }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/magento/problems/page', expect.objectContaining({ params: expect.objectContaining({ limit: 20, offset: 40 }) })));
  fireEvent.click(within(queue).getByRole('button', { name: 'Назад' }));
  await waitFor(() => expect(api.get.mock.calls.filter(([url]) => url === '/magento/problems/page').at(-1)[1].params.offset).toBe(20));
  expect(screen.getByRole('region', { name: 'З чого почати' })).toBeTruthy();
  expect(api.get.mock.calls.some(([url]) => url === '/magento/problem-groups/page')).toBe(false);
  expect(api.post).not.toHaveBeenCalled();
});

it('opening a group requires an explicit product choice and returning retains the group without mounting a repair', async () => {
  api.get.mockImplementation(async url => ({ data: url === '/magento/problem-groups/page' ? response
    : url === '/magento/problems/7' ? item : { items: [item], pageInfo: { total: 32, hasNext: true } } }));
  shell(<SyncProblemsPage />);
  fireEvent.click(await screen.findByRole('button', { name: '32' }));
  const queue = await screen.findByRole('complementary', { name: 'Черга проблем доставки' });
  expect(screen.queryByRole('region', { name: 'З чого почати' })).toBeNull();
  fireEvent.click(within(queue).getByRole('button', { name: /AG-000007/ }));
  await screen.findByRole('region', { name: 'З чого почати' });
  expect(api.get.mock.calls.some(([url]) => url === '/magento/problems/7')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'До списку товарів' }));
  expect(screen.queryByRole('region', { name: 'З чого почати' })).toBeNull();
  expect(screen.getByRole('button', { name: 'До причин' })).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it('first sync shows only unresolved rows and mounts one field decision at a time', async () => {
  api.get.mockResolvedValue({ data: { currentPublishedId: 'fed6b54b-88ae-4bfb-ad52-bc84db493e34' } });
  const field = (target, overrides = {}) => ({ target, scope: 'all', status: 'conflict', reason: 'POPULATED_VALUES_DIFFER',
    local: { known: true, present: true, value: '12' }, remote: { known: true, present: true, value: '15' }, canAcceptRemote: true, canKeepLocal: true, ...overrides });
  api.post.mockResolvedValue({ data: { mode: 'first', sku: 'SKU', previewToken: 'a'.repeat(64), complete: false, readyForOutbound: false, blockers: [],
    fields: [field('weight'), field('price'), field('name', { received: true, canAcceptRemote: false, canKeepLocal: false })] } });
  shell(<MagentoFirstSyncFields sku="SKU" />);
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити актуальні поля' }));
  await screen.findByRole('button', { name: 'Розглянути: Вага · UA / основний магазин' });
  expect(screen.queryByRole('button', { name: 'Розглянути: Назва · UA / основний магазин' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Отримати значення Magento:/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Розглянути: Вага · UA / основний магазин' }));
  expect(screen.getAllByRole('button', { name: /Отримати значення Magento:/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Розглянути: Ціна · UA / основний магазин' }));
  expect(screen.queryByRole('region', { name: 'Вага · UA / основний магазин' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Ціна · UA / основний магазин' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Усі поля (3)' }));
  expect(screen.getByRole('button', { name: 'Розглянути: Назва · UA / основний магазин' })).toBeTruthy();
  expect(api.post).toHaveBeenCalledTimes(1);
});
