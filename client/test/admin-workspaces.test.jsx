import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import AdminPage from '../src/pages/AdminPage.jsx';

const category = { code: 'BR', name: 'Bracelets', requires_weight: 0, marketing_rounding_enabled: 1 };
const config = { categories: { BR: category }, questions: { BR: [] }, extraConfig: {} };
const response = (data) => ({ data, status: 200 });
const authValue = (permissions) => ({
  identity: { name: 'Operator' },
  applicationUser: { id: 7, status: 'active' },
  permissions,
  roles: [],
  logout: vi.fn(),
  refresh: vi.fn(),
});
const renderPage = (mode, permissions, initialEntry = '/') => {
  const router = createMemoryRouter([{ path: '*', element: <AdminPage mode={mode} /> }], { initialEntries: [initialEntry] });
  return render(<AuthContext.Provider value={authValue(permissions)}>
    <RouterProvider router={router} />
  </AuthContext.Provider>);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('opens the exact catalog context from Magento without writing or reopening a dismissed form', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return response(config);
    if (url === '/admin/sku-schema/BR') return response({ active: null, draftChanged: false });
    throw new Error(`Unexpected GET ${url}`);
  });
  const post = vi.spyOn(api, 'post');
  renderPage('catalog', ['catalog.view', 'catalog.manage'],
    '/admin/catalog?category=BR&action=new-question&returnTo=%2Fadmin%2Fmagento%2Fcategories%2FBR');
  expect(await screen.findByRole('textbox', { name: /Назва питання/ })).toBeTruthy();
  expect(screen.getByRole('link', { name: /Повернутися до інтеграції Magento/ }).getAttribute('href')).toBe('/admin/magento/categories/BR');
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Скасувати/ }));
  await waitFor(() => expect(screen.queryByRole('textbox', { name: /Назва питання/ })).toBeNull());
});

it('does not grant catalog editing from a deep link or accept an external return target', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return response(config);
    if (url === '/admin/sku-schema/BR') return response({ active: null, draftChanged: false });
    throw new Error(`Unexpected GET ${url}`);
  });
  renderPage('catalog', ['catalog.view'], '/admin/catalog?category=BR&action=new-question&returnTo=https%3A%2F%2Fexample.com');
  await screen.findByRole('button', { name: /Bracelets/ });
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/sku-schema/BR'));
  expect(screen.queryByRole('textbox', { name: /Назва питання/ })).toBeNull();
  expect(screen.queryByRole('link', { name: /Повернутися до інтеграції Magento/ })).toBeNull();
});

it('loads only the projection for the selected configuration workspace', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/pricing/config' || url === '/admin/config') return response(config);
    if (url === '/admin/prices/BR') return response({ scenarios: [], modifiers: [] });
    throw new Error(`Unexpected GET ${url}`);
  });
  renderPage('pricing', ['catalog.view', 'pricing.view']);
  fireEvent.click(await screen.findByRole('button', { name: /Bracelets/ }));
  await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/prices/BR'));
  expect(get).toHaveBeenCalledWith('/admin/pricing/config');
  expect(get).not.toHaveBeenCalledWith('/config');
  expect(get).not.toHaveBeenCalledWith('/admin/config');
  expect(get.mock.calls.some(([url]) => url.startsWith('/admin/sku-schema/'))).toBe(false);
});

it('returns from category setup to the exact pricing category without catalog reads or writes', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/pricing/config') return response(config);
    if (url === '/admin/prices/BR') return response({ scenarios: [], modifiers: [] });
    throw new Error(`Unexpected GET ${url}`);
  });
  const post = vi.spyOn(api, 'post');
  renderPage('pricing', ['pricing.view'], '/admin/pricing?category=BR&returnTo=%2Fadmin%2Fmagento%2Fcategories%2Fnew%3Fcategory%3DBR');
  await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/prices/BR'));
  expect(screen.getByRole('link', { name: /Повернутися до інтеграції/ }).getAttribute('href')).toBe('/admin/magento/categories/new?category=BR');
  expect(get).not.toHaveBeenCalledWith('/admin/config'); expect(post).not.toHaveBeenCalled();
});

it('gates schema publication independently from catalog editing', async () => {
  const readQuestion = {
    id: 'material', q_db_id: 11, label: 'Material', input_type: 'options', required: 1,
    include_in_sku: 1, sku_index: 1, sku_separator: '-', options: [{
      id: 1, db_id: 21, value_id: 1, sku_code: '1', label: 'Gold', label_en: 'Gold',
    }],
  };
  const readableConfig = { ...config, questions: { BR: [readQuestion] } };
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return response(readableConfig);
    if (url === '/admin/sku-schema/BR') return response({ active: { version: 1 }, draftChanged: true, nextVersion: 2 });
    throw new Error(`Unexpected GET ${url}`);
  });
  const post = vi.spyOn(api, 'post').mockResolvedValue(response({ version: 2 }));
  renderPage('catalog', ['catalog.view', 'sku_schemas.publish']);
  fireEvent.click(await screen.findByRole('button', { name: /Bracelets/ }));

  const publish = await screen.findByRole('button', { name: 'Опублікувати V2' });
  expect(publish.disabled).toBe(false);
  expect(screen.queryByRole('button', { name: 'Видалити категорію Bracelets' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Категорія', exact: true })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Переіндексувати SKU' })).toBeNull();
  fireEvent.click(screen.getByText('Material'));
  expect(screen.getByText('Gold')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Редагувати' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Видалити питання Material' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Редагувати Gold' })).toBeNull();
  fireEvent.click(publish);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/sku-schema/BR/publish'));
});

it('names destructive scope and waits for explicit confirmation', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return response(config);
    if (url === '/admin/sku-schema/BR') return response({ active: null, draftChanged: false });
    throw new Error(`Unexpected GET ${url}`);
  });
  const post = vi.spyOn(api, 'post').mockResolvedValue(response({ success: true }));
  renderPage('catalog', ['catalog.view', 'catalog.manage']);
  fireEvent.click(await screen.findByRole('button', { name: /Bracelets/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Видалити категорію Bracelets' }));

  const dialog = screen.getByRole('dialog', { name: 'Видалити «Bracelets»?' });
  expect(within(dialog).getByText(/питання, варіанти, цінові сценарії, матриці/)).toBeTruthy();
  expect(post).not.toHaveBeenCalledWith('/admin/delete-item', expect.anything());
  fireEvent.click(within(dialog).getByRole('button', { name: 'Видалити' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/delete-item', { type: 'category', id: 'BR' }));
});

it('closes a completed destructive confirmation even when its refresh fails', async () => {
  let deleted = false;
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') {
      if (deleted) throw new Error('refresh unavailable');
      return response(config);
    }
    if (url === '/admin/sku-schema/BR') return response({ active: null, draftChanged: false });
    throw new Error(`Unexpected GET ${url}`);
  });
  vi.spyOn(api, 'post').mockImplementation(async () => {
    deleted = true;
    return response({ success: true });
  });
  renderPage('catalog', ['catalog.view', 'catalog.manage']);
  fireEvent.click(await screen.findByRole('button', { name: /Bracelets/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Видалити категорію Bracelets' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Видалити' }));

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Видалити «Bracelets»?' })).toBeNull());
  expect(await screen.findByText('Категорію видалено, але дані не оновлено')).toBeTruthy();
  expect(screen.queryByText('Не вдалося видалити елемент')).toBeNull();
});

it('keeps a failed destructive command visible inside its active confirmation', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return response(config);
    if (url === '/admin/sku-schema/BR') return response({ active: null, draftChanged: false });
    throw new Error(`Unexpected GET ${url}`);
  });
  vi.spyOn(api, 'post').mockRejectedValue({ response: { data: { error: 'Deletion blocked' } } });
  renderPage('catalog', ['catalog.view', 'catalog.manage']);
  fireEvent.click(await screen.findByRole('button', { name: /Bracelets/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Видалити категорію Bracelets' }));

  const dialog = screen.getByRole('dialog', { name: 'Видалити «Bracelets»?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Видалити' }));
  expect(await within(dialog).findByText('Не вдалося видалити')).toBeTruthy();
  expect(within(dialog).getByText('Deletion blocked')).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'Видалити «Bracelets»?' })).toBeTruthy();
});

it('guards changed catalog fields before switching category and can explicitly discard them', async () => {
  const secondCategory = { code: 'NM', name: 'Necklaces', requires_weight: 1, marketing_rounding_enabled: 1 };
  const twoCategoryConfig = {
    categories: { BR: category, NM: secondCategory },
    questions: { BR: [], NM: [] },
    extraConfig: {},
  };
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return response(twoCategoryConfig);
    if (url.startsWith('/admin/sku-schema/')) return response({ active: null, draftChanged: false });
    throw new Error(`Unexpected GET ${url}`);
  });
  renderPage('catalog', ['catalog.view', 'catalog.manage']);
  fireEvent.click(await screen.findByRole('button', { name: /Bracelets/ }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Категорія', exact: true })[1]);
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва' }), { target: { value: 'Changed locally' } });
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Назва' }).value).toBe('Changed locally'));

  fireEvent.click(screen.getByRole('button', { name: /Necklaces/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  expect(screen.getAllByText('Bracelets').length).toBeGreaterThan(0);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Відкинути й перейти' }));
  await waitFor(() => expect(screen.getAllByText('Necklaces').length).toBeGreaterThan(0));
});

it('guards changed pricing settings before switching category', async () => {
  const secondCategory = { code: 'NM', name: 'Necklaces', requires_weight: 1 };
  const pricingConfig = {
    categories: { BR: category, NM: secondCategory },
    questions: { BR: [], NM: [] },
    extraConfig: {},
  };
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/pricing/config') return response(pricingConfig);
    if (url === '/admin/prices/BR') return response({ scenarios: [{
      id: 12, category_code: 'BR', name: 'Base', group_name: '', match_json: {}, axis_x_key: 'weight',
      axis_y_key: null, priority: 0, status: 'active', price_mode: 'fixed_uah', apply_modifiers: true,
      matrix: [], weight_bands: [],
    }], modifiers: [] });
    if (url === '/admin/prices/NM') return response({ scenarios: [], modifiers: [] });
    throw new Error(`Unexpected GET ${url}`);
  });
  renderPage('pricing', ['pricing.view', 'pricing.manage']);
  fireEvent.click(await screen.findByRole('button', { name: /Bracelets/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Редагувати' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва сценарію' }), { target: { value: 'Changed locally' } });

  fireEvent.click(screen.getByRole('button', { name: 'Модифікатори' }));
  let dialog = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  expect(screen.getByRole('button', { name: 'Сценарії' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Залишитися' }));

  fireEvent.click(screen.getByRole('button', { name: /Necklaces/ }));
  dialog = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  expect(dialog).toBeTruthy();
  expect(api.get).not.toHaveBeenCalledWith('/admin/prices/NM');
});

it('gives repeated weight-band controls row-specific accessible names', async () => {
  const weightCategory = { ...category, requires_weight: 1 };
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/pricing/config') return response({ ...config, categories: { BR: weightCategory } });
    if (url === '/admin/prices/BR') return response({ scenarios: [{
      id: 12, category_code: 'BR', name: 'Weight bands', group_name: '', match_json: {},
      axis_x_key: 'weight_band', axis_y_key: null, priority: 0, status: 'active',
      price_mode: 'fixed_uah', apply_modifiers: true, matrix: [], weight_bands: [
        { label: 'Light', min_weight: 0, max_weight: 10 },
        { label: 'Heavy', min_weight: 10, max_weight: '' },
      ],
    }], modifiers: [] });
    throw new Error(`Unexpected GET ${url}`);
  });
  renderPage('pricing', ['pricing.view', 'pricing.manage']);
  fireEvent.click(await screen.findByRole('button', { name: /Bracelets/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Weight bands/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Редагувати' }));

  expect(screen.getByRole('textbox', { name: 'Назва вагового діапазону 1' }).value).toBe('Light');
  expect(screen.getByRole('spinbutton', { name: 'Початкова вага діапазону 2, включно' }).value).toBe('10');
  expect(screen.getByRole('spinbutton', { name: 'Кінцева вага діапазону 2, не включно' }).value).toBe('');
  expect(screen.getByRole('button', { name: 'Видалити ваговий діапазон 2: Heavy' })).toBeTruthy();
});

it('reports a created catalog item honestly when the following refresh fails', async () => {
  let created = false;
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') {
      if (created) throw new Error('refresh unavailable');
      return response(config);
    }
    throw new Error(`Unexpected GET ${url}`);
  });
  vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/admin/category') {
      created = true;
      return response({ code: 'NM' });
    }
    throw new Error(`Unexpected POST ${url}`);
  });
  renderPage('catalog', ['catalog.view', 'catalog.manage']);
  await screen.findByRole('button', { name: /Bracelets/ });
  fireEvent.click(screen.getAllByRole('button', { name: 'Категорія', exact: true })[0]);
  fireEvent.change(screen.getByRole('textbox', { name: 'Код' }), { target: { value: 'NM' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва' }), { target: { value: 'Necklaces' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти категорію' }));

  expect(await screen.findByText('Категорію створено, але дані не оновлено')).toBeTruthy();
  expect(screen.queryByText('Не вдалося створити категорію')).toBeNull();
});


it('waits for loaded catalog to focus the exact archived zero option without writing', async () => {
  const linked = { categories: config.categories, extraConfig: {}, questions: { BR: [{ id: 'kind', q_db_id: 77,
    label: 'Вид', input_type: 'options', required: 1, include_in_sku: 0, display_order: 1, sku_index: 0,
    options: [{ id: 0, db_id: 88, label: 'Історичний нуль', archived: 1, sku_code: null }] }] } };
  let resolveConfig;
  vi.spyOn(api, 'get').mockImplementation((url) => {
    if (url === '/admin/config') return new Promise((resolve) => { resolveConfig = resolve; });
    if (url === '/admin/sku-schema/BR') return Promise.resolve(response({ active: null, draftChanged: false }));
    throw new Error(`Unexpected GET ${url}`);
  });
  const post = vi.spyOn(api, 'post'); const patch = vi.spyOn(api, 'patch');
  renderPage('catalog', ['catalog.view', 'catalog.manage'], '/admin/catalog?category=BR&question=kind&value=0&action=edit-option&returnTo=%2Fattention%3Fitem%3D9');
  await waitFor(() => expect(resolveConfig).toBeTypeOf('function'));
  resolveConfig(response(linked));
  const label = await screen.findByRole('textbox', { name: /Назва українською/ });
  expect(label.value).toBe('Історичний нуль');
  await waitFor(() => expect(document.activeElement).toBe(label));
  expect(screen.getByRole('link', { name: /Повернутися до задач/ }).getAttribute('href')).toBe('/attention?item=9');
  expect(post).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
});

it('does not choose an unknown semantic value from an edit-option link', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return response({ categories: config.categories, extraConfig: {}, questions: { BR: [{ id: 'kind', q_db_id: 77, label: 'Вид', input_type: 'options', options: [{ id: 0, db_id: 88, label: 'Нуль' }] }] } });
    if (url === '/admin/sku-schema/BR') return response({ active: null, draftChanged: false });
    throw new Error(`Unexpected GET ${url}`);
  });
  const post = vi.spyOn(api, 'post');
  renderPage('catalog', ['catalog.view', 'catalog.manage'], '/admin/catalog?category=BR&question=kind&value=99&action=edit-option');
  expect(await screen.findByText('Елемент каталогу не знайдено')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: /Назва українською/ })).toBeNull();
  expect(post).not.toHaveBeenCalled();
});


it('returns to the same Attention context only after an explicit successful catalog save', async () => {
  const linked = { categories: config.categories, extraConfig: {}, questions: { BR: [{ id: 'kind', q_db_id: 77,
    label: 'Вид', input_type: 'options', required: 1, include_in_sku: 0, display_order: 1, sku_index: 0,
    options: [{ id: 0, db_id: 88, label: 'Нуль', archived: 0, sku_code: null }] }] } };
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return response(linked);
    if (url === '/admin/sku-schema/BR') return response({ active: null, draftChanged: false });
    throw new Error(`Unexpected GET ${url}`);
  });
  const put = vi.spyOn(api, 'put').mockRejectedValueOnce(new Error('Збереження недоступне')).mockResolvedValue(response({ success: true }));
  const router = createMemoryRouter([
    { path: '/admin/catalog', element: <AdminPage mode="catalog" /> },
    { path: '/attention', element: <div>Повернулися до Attention</div> },
  ], { initialEntries: ['/admin/catalog?category=BR&question=kind&value=0&action=edit-option&returnTo=%2Fattention%3Fitem%3D9'] });
  render(<AuthContext.Provider value={authValue(['catalog.view', 'catalog.manage'])}><RouterProvider router={router} /></AuthContext.Provider>);
  const label = await screen.findByRole('textbox', { name: /Назва українською/ });
  fireEvent.change(label, { target: { value: 'Узгоджений нуль' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  expect(await screen.findByText('Не вдалося зберегти варіант')).toBeTruthy();
  expect(router.state.location.pathname).toBe('/admin/catalog');
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  expect(await screen.findByText('Повернулися до Attention')).toBeTruthy();
  expect(router.state.location.search).toBe('?item=9');
  expect(put).toHaveBeenCalledTimes(2);
});
it('creates an exact local variant and returns to the preserved preparation only after a successful save', async () => {
  const linked = { categories: config.categories, extraConfig: {}, questions: { BR: [{ id: 'kind', q_db_id: 77,
    label: 'Вид', input_type: 'options', required: 1, include_in_sku: 0, options: [] }] } };
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return response(linked);
    if (url === '/admin/sku-schema/BR') return response({ active: null, draftChanged: false });
    throw new Error(`Unexpected GET ${url}`);
  });
  const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new Error('not saved')).mockResolvedValue(response({ success: true }));
  const back = '/admin/magento/prepare?category=BR&draft=kept&step=1&intent=option&question=kind&productId=42&returnTo=%2Fattention%3Fproblem%3D42';
  const router = createMemoryRouter([
    { path: '/admin/catalog', element: <AdminPage mode="catalog" /> },
    { path: '/admin/magento/prepare', element: <div>Повернулися до підготовки</div> },
  ], { initialEntries: [`/admin/catalog?${new URLSearchParams({ category: 'BR', question: 'kind', action: 'new-option', returnTo: back })}`] });
  render(<AuthContext.Provider value={authValue(['catalog.view', 'catalog.manage'])}><RouterProvider router={router} /></AuthContext.Provider>);
  const label = await screen.findByRole('textbox', { name: 'Назва українською' });
  expect(post).not.toHaveBeenCalled();
  fireEvent.change(label, { target: { value: 'Новий вид' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти варіант' }));
  expect(await screen.findByText('Не вдалося створити варіант')).toBeTruthy();
  expect(router.state.location.pathname).toBe('/admin/catalog');
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти варіант' }));
  expect(await screen.findByText('Повернулися до підготовки')).toBeTruthy();
  expect(router.state.location.pathname + router.state.location.search).toBe(back);
  expect(post).toHaveBeenCalledTimes(2);
  expect(post).toHaveBeenLastCalledWith('/admin/option', expect.objectContaining({ question_id: 77, label: 'Новий вид', sku_code: null }));
});
