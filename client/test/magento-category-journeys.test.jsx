import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoCategoryDetail from '../src/components/workspace/MagentoCategoryDetail.jsx';
import MagentoCategorySetup from '../src/components/workspace/MagentoCategorySetup.jsx';
import IntegrationCategoryForm from '../src/components/export-templates/IntegrationCategoryForm.jsx';
import { ObservedCategoryPicker } from '../src/components/workspace/MagentoObservedSelectors.jsx';
import { questionTargets } from '../src/components/workspace/category-journeys.js';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());
const permissions = ['export_templates.view', 'export_templates.manage', 'exports.view', 'catalog.view', 'catalog.manage', 'pricing.view'];
const category = { code: 'BR', name: 'Браслети', operational: { state: 'known', count: 1, reasons: [] }, preparation: { needed: true, reasons: [] } };
const definition = { evaluatorVersion: 'magento-declarative-4', outputContract: 'magento-products-columns-v2',
  sources: { color: { kind: 'semantic', category: 'BR', key: 'color' }, other: { kind: 'semantic', category: 'SV', key: 'color' } },
  bindings: [{ id: 'colorValue', value: { op: 'source', id: 'color' } }], tables: {},
  groups: [{ route: 'BR', rows: [{ id: 'base', cells: { product_color: { op: 'ref', id: 'colorValue' }, other: { op: 'source', id: 'other' } } }] }] };
const revision = { id: 'binding', templateId: 'template', templateVersionId: 'version', schema: {}, bindings: { attributes: [
  { routeKey: 'BR:all', rowId: 'base', target: 'product_color', attributeCode: 'kolir' },
  { routeKey: 'BR:all', rowId: 'base', target: 'categories', bindingKey: 'placement', evidence: { categories: [{ normalizedPath: 'Default/Прикраси/Браслети', categoryId: '12', reviewState: 'approved' }] } },
] } };
const values = [
  { questionKey: 'color', questionLabel: 'Колір', valueId: '1', label: 'Світлий', state: 'missing', mappings: [] },
  { questionKey: 'size', questionLabel: 'Розмір', valueId: '2', label: 'Великий', state: 'missing', mappings: [] },
];
function detailShell(path) {
  api.get.mockImplementation((url) => Promise.resolve({ data: url.includes('export-templates') ? { versions: [{ id: 'version', definition }] } : { revision, currentPublishedId: 'binding', categories: [{ ...category, values }] } }));
  return render(<AuthContext.Provider value={{ permissions }}><MemoryRouter initialEntries={[path]}><Routes><Route path="/admin/magento/categories/:categoryCode" element={<MagentoCategoryDetail categories={[category]} activeId="binding" canManage canViewProducts />} /></Routes></MemoryRouter></AuthContext.Provider>);
}
it('keeps unmapped values under an exact target filter using stored source relationships, without unrelated lookalikes', async () => {
  expect(questionTargets(definition, revision, 'BR')).toEqual({ color: ['product_color', 'kolir'] });
  detailShell('/admin/magento/categories/BR?field=kolir&productId=21&returnTo=%2Fattention%3Fproblem%3D21%26category%3DBR');
  const group = await screen.findByRole('button', { name: 'Колір · color → kolir, product_color · 1' });
  fireEvent.click(group);
  expect(screen.getByText('Колір: Світлий')).toBeTruthy();
  expect(screen.queryByText('Розмір: Великий')).toBeNull();
  const link = new URL(screen.getByRole('link', { name: 'Налаштувати відповідність' }).href);
  expect(link.searchParams.get('productId')).toBe('21');
  expect(link.searchParams.get('question')).toBe('color');
  expect(link.searchParams.get('value')).toBe('1');
  expect(link.searchParams.get('returnTo')).toBe('/attention?problem=21&category=BR');
  expect(api.post).not.toHaveBeenCalled();
});
it('opens placement for category-path problems and preserves exact repair context across tabs and tasks', async () => {
  detailShell('/admin/magento/categories/BR?field=categories&path=Default%2FПрикраси%2FБраслети&productId=21');
  await screen.findByText('Default › Прикраси › Браслети');
  expect(screen.getByRole('link', { name: 'Розміщення в магазині' }).getAttribute('aria-current')).toBe('page');
  const href = new URL(screen.getByRole('link', { name: 'Додати підкатегорію тут' }).href);
  expect(href.searchParams.get('intent')).toBe('subcategory');
  expect(href.searchParams.get('path')).toBe('Default/Прикраси/Браслети');
  expect(href.searchParams.get('productId')).toBe('21');
  expect(screen.queryByRole('heading', { name: 'Відповідності категорії' })).toBeNull();
  expect(api.get.mock.calls.some(([url]) => url.endsWith('creation-inputs'))).toBe(false);
});
it('does not attribute a branch guard or another category source to the produced option field', () => {
  const next = structuredClone(definition);
  next.sources.guard = { kind: 'semantic', category: 'BR', key: 'kind' };
  next.groups[0].rows[0].cells.product_color = { op: 'when', if: { op: 'eq', left: { op: 'source', id: 'guard' }, right: { op: 'literal', value: 1 } }, then: { op: 'source', id: 'color' }, else: { op: 'literal', value: '' } };
  expect(questionTargets(next, revision, 'BR')).toEqual({ color: ['product_color', 'kolir'] });
});
it('can open a newly created category before the shell overview is refreshed, without inventing a healthy delivery state', async () => {
  api.get.mockResolvedValue({ data: { categories: [{ code: 'NEW', name: 'Новий тип', values: [] }], catalog: { questions: { NEW: [] } } } });
  render(<AuthContext.Provider value={{ permissions }}><MemoryRouter initialEntries={['/admin/magento/categories/NEW']}><Routes><Route path="/admin/magento/categories/:categoryCode" element={<MagentoCategoryDetail categories={[]} canManage canViewProducts />} /></Routes></MemoryRouter></AuthContext.Provider>);
  await screen.findByRole('heading', { name: 'Новий тип' });
  expect(screen.getByText('Стан доставки невідомий')).toBeTruthy();
  expect(screen.queryByText('Категорію не знайдено.')).toBeNull();
});
it('bounds observed tree choices, preserves selected path during search, and disables ambiguous names', () => {
  const nodes = Array.from({ length: 60 }, (_, id) => ({ categoryId: String(id), normalizedPath: `Default/Розділ ${id}`, comparable: true }));
  nodes.push({ categoryId: 'other', normalizedPath: 'Default/Розділ 0', comparable: true });
  render(<ObservedCategoryPicker categories={nodes} value="Default/Розділ 59" onChange={vi.fn()} />);
  expect(within(screen.getByRole('group', { name: 'Розділ магазину: варіанти' })).getAllByRole('button')).toHaveLength(50);
  expect(screen.getByRole('button', { name: 'Default › Розділ 0 — неоднозначний шлях' }).disabled).toBe(true);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Пошук розділу' }), { target: { value: '59' } });
  expect(screen.getByText('Обрано: Default › Розділ 59')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Default › Розділ 59' }).getAttribute('aria-pressed')).toBe('true');
});
it('adds catalog names and observed selections to a local rules draft with no remote create or automatic discovery', async () => {
  const change = vi.fn(); const base = { ...definition, evaluatorVersion: 'magento-declarative-3', groups: [{ route: 'SV' }] };
  api.get.mockResolvedValue({ data: { categories: [category] } });
  api.post.mockResolvedValue({ data: { categories: [{ categoryId: '12', normalizedPath: 'Default/Прикраси', comparable: true }], schema: { attributeSets: [{ attribute_set_id: 4, attribute_set_name: 'Прикраси' }] } } });
  render(<IntegrationCategoryForm definition={base} onChange={change} />);
  expect(api.get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Додати категорію до правил' }));
  await screen.findByRole('option', { name: 'Браслети' });
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Категорія товару'), { target: { value: 'BR' } });
  fireEvent.change(screen.getByLabelText('Основна назва товару українською'), { target: { value: 'Браслет' } });
  fireEvent.change(screen.getByLabelText('Основна назва товару англійською'), { target: { value: 'Bracelet' } });
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати структуру магазину' }));
  await screen.findByRole('button', { name: 'Default › Прикраси' });
  fireEvent.change(screen.getByLabelText('Набір характеристик'), { target: { value: 'Прикраси' } });
  fireEvent.click(screen.getByRole('button', { name: 'Default › Прикраси' }));
  fireEvent.click(screen.getByRole('button', { name: 'Додати категорію до чернетки' }));
  expect(change).toHaveBeenCalledOnce();
  const next = change.mock.calls[0][0];
  expect(next.evaluatorVersion).toBe('magento-declarative-4');
  expect(next.groups[1]).toMatchObject({ route: 'BR', name: 'Браслети' });
  expect(next.groups[1].rows[0].cells.categories).toEqual({ op: 'literal', value: 'Default/Прикраси' });
  expect(api.post.mock.calls).toEqual([['/admin/magento-integration/discovery', {}]]);
});
it('requires an explicit discard before closing a partly filled category rule form', async () => {
  api.get.mockResolvedValue({ data: { categories: [category] } });
  const pending = vi.fn();
  render(<IntegrationCategoryForm definition={{ ...definition, groups: [{ route: 'SV' }] }} onChange={vi.fn()} onPendingChange={pending} />);
  fireEvent.click(screen.getByRole('button', { name: 'Додати категорію до правил' }));
  await screen.findByRole('option', { name: 'Браслети' });
  fireEvent.change(screen.getByLabelText('Основна назва товару українською'), { target: { value: 'Браслет' } });
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole('button', { name: 'Додати категорію до правил' }));
  expect(screen.getByLabelText('Основна назва товару українською').value).toBe('Браслет');
  fireEvent.click(screen.getByRole('button', { name: 'Відкинути заповнення' }));
  expect(screen.queryByLabelText('Основна назва товару українською')).toBeNull();
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
});
it('opens the missing category handoff with its catalog name already selected but no implicit dirty change', async () => {
  const pending = vi.fn(); api.get.mockResolvedValue({ data: { categories: [category] } });
  render(<IntegrationCategoryForm definition={{ ...definition, groups: [{ route: 'SV' }] }} initialCategory="BR" onChange={vi.fn()} onPendingChange={pending} />);
  await screen.findByRole('option', { name: 'Браслети' });
  expect(screen.getByLabelText('Категорія товару').value).toBe('BR');
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(api.post).not.toHaveBeenCalled();
});
function setupShell(path, granted = permissions) {
  const router = createMemoryRouter([{ path: '/admin/magento/categories/new', element: <MagentoCategorySetup /> }], { initialEntries: [path] });
  return render(<AuthContext.Provider value={{ permissions: granted }}><RouterProvider router={router} /></AuthContext.Provider>);
}
it('resumes a persisted category with truthful checkpoints and does not claim pricing or delivery readiness', async () => {
  api.get.mockResolvedValue({ data: { categories: [{ ...category, schema: { version: 1 }, ready: false }], revision, catalog: { questions: { BR: [] } } } });
  setupShell('/admin/magento/categories/new?category=BR');
  await screen.findByText('Схема внутрішнього SKU');
  expect(screen.getByText('Розрахунок ціни нового товару ще потрібно перевірити')).toBeTruthy();
  expect(screen.getByText('Підключення ще потребує перевірки')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Налаштувати ціну' }).getAttribute('href')).toContain('category=BR');
  expect(api.post).not.toHaveBeenCalled();
});
it('keeps a successful category receipt when the following read fails and cannot create without permission', async () => {
  api.get.mockResolvedValueOnce({ data: { categories: [] } }).mockRejectedValue(new Error('read failed'));
  api.post.mockResolvedValue({ data: { id: 'BR', name: 'Браслети' } });
  setupShell('/admin/magento/categories/new');
  fireEvent.change(screen.getByLabelText('Код'), { target: { value: 'BR' } });
  fireEvent.change(screen.getByLabelText('Назва'), { target: { value: 'Браслети' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти категорію' }));
  await screen.findByText('Категорію створено');
  await screen.findByText('Не вдалося прочитати стан категорії.');
  expect(api.post).toHaveBeenCalledOnce();
  expect(api.post).toHaveBeenCalledWith('/admin/category', { code: 'BR', name: 'Браслети', requires_weight: 1, skip_hidden_sku_questions: 0, marketing_rounding_enabled: 1 });
  expect(screen.queryByRole('button', { name: 'Зберегти категорію' })).toBeNull();
  cleanup(); api.get.mockResolvedValue({ data: { categories: [] } }); api.post.mockClear();
  setupShell('/admin/magento/categories/new', ['export_templates.view']);
  expect(screen.queryByRole('button', { name: 'Зберегти категорію' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
it('opens a clean creation form when starting another category after a successful save', async () => {
  api.get.mockResolvedValue({ data: { categories: [category], catalog: { questions: { BR: [] } } } });
  api.post.mockResolvedValue({ data: { id: 'BR', name: 'Браслети' } });
  setupShell('/admin/magento/categories/new');
  fireEvent.change(screen.getByLabelText('Код'), { target: { value: 'BR' } });
  fireEvent.change(screen.getByLabelText('Назва'), { target: { value: 'Браслети' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти категорію' }));
  await screen.findByText('Категорію створено');
  fireEvent.change(screen.getByLabelText('Продовжити налаштування наявної категорії'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Зберегти категорію' })).toBeTruthy();
  expect(screen.getByLabelText('Код').value).toBe('');
  expect(screen.queryByText('Категорію створено')).toBeNull();
});
