import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoCategoryWorkspace from '../src/components/workspace/MagentoCategoryWorkspace.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() } }));
const permissions = ['catalog.view', 'catalog.manage', 'export_templates.view', 'export_templates.manage', 'export_templates.publish', 'exports.view'];
const category = { code: 'BR', name: 'Браслети', operational: { count: 0 }, requires_weight: 1 };
const active = { id: 'active', revision: '4', state: 'published', templateVersionId: 'version' };
let definition, questions, registry, entries, attributes, config;
const literal = (value) => ({ op: 'literal', value });
const source = { kind: 'semantic', category: 'BR', key: 'color', type: 'scalar' };
beforeEach(() => {
  vi.resetAllMocks();
  questions = [{ id: 'color', q_db_id: 11, label: 'Колір', input_type: 'options', include_in_sku: 1, archived: false, uses: [{ target: 'kolir', rowId: 'base' }], options: [{ id: 0, db_id: 31, label: 'Нуль' }] },
    { id: 'material', q_db_id: 12, label: 'Матеріал', input_type: 'text', include_in_sku: 0, archived: false, uses: [], options: [] }];
  definition = { evaluatorVersion: 'magento-declarative-5', sourceContractVersion: 'public-product-characteristics-v1', outputContract: 'magento-products-columns-v2',
    sources: { color: source }, tables: {}, bindings: [], groups: [{ route: 'BR', columns: ['name', 'kolir'], rows: [
      { id: 'base', cells: { name: literal('Назва'), kolir: { op: 'source', id: 'color' } } },
      { id: 'english', cells: { name: literal('Name'), kolir: literal('') } },
    ] }] };
  registry = { nativeCharacteristicsAuthoring: true, productFields: [], references: { questions: questions.map((q) => ({ ...q, category_code: 'BR', key: q.id })), schemas: [] } };
  entries = [{ id: 'option:zero', group: 'BR', routeKey: 'BR:all', row: 'base', target: 'kolir', kind: 'option', source: 'BR.color=value_id:0', evaluated: 'Нуль', identity: '10', reviewState: 'review_required' }];
  attributes = [{ code: 'name', target: 'name', label: 'Назва', text: true, configured: true, editable: true, state: 'connected', sources: [] },
    { code: 'kolir', target: 'kolir', label: 'Колір магазину', configured: true, editable: true, state: 'connected', sources: [{ label: 'Колір' }] },
    { code: 'material', target: 'material', label: 'Матеріал магазину', configured: false, editable: true, state: 'unmapped', sources: [] }];
  config = { categories: { BR: category }, questions: { BR: questions }, extraConfig: {}, catalogWorkflow: { identityMode: 'public_identity', serverGeneratedQuestionKeys: true } };
  api.get.mockImplementation(async (url, request) => {
    if (url === '/admin/config') return { data: structuredClone(config) };
    if (url.endsWith('/sources')) return { data: registry };
    if (url.endsWith('/source-details')) return { data: { current: [{ label: 'Колір', options: questions[0].options.map((o) => ({ value_id: String(o.id), label: o.label })) }], historical: [] } };
    if (url.includes('/fields/')) return { data: { entries, options: [{ value: '10', label: 'Перше' }, { value: '20', label: 'Друге' }] } };
    if (url.endsWith('/categories/BR')) return { data: { category, revision: active, template: { definition }, groupIndex: 0, rowIndex: request?.params?.rowId === 'english' ? 1 : 0, routeKey: 'BR:all', routes: [{ routeKey: 'BR:all', setName: 'Прикраси' }], attributes, questions } };
    if (url === '/admin/magento-integration') return { data: { revision: { bindings: { routes: [{ routeKey: 'BR:all', setId: 5 }] }, schema: { attributeSets: [{ attribute_set_id: 5, attribute_set_name: 'Прикраси', attributeCodes: ['material'] }], attributes: [{ attribute_code: 'material', default_frontend_label: 'Матеріал магазину', frontend_input: 'text' }] } } } };
    throw Error(`Unexpected GET ${url}`);
  });
});
afterEach(cleanup);
function mount(path = '/admin/catalog?category=BR', grants = permissions, principalLifetime, integrationAvailable = true) {
  const router = createMemoryRouter([{ path: '/admin/catalog', element: <MagentoCategoryWorkspace categories={[category]} activePublication={active} localConfig={config} integrationAvailable={integrationAvailable} onPublished={vi.fn()} /> }], { initialEntries: [path] });
  render(<AuthContext.Provider value={{ permissions: grants, roles: [], principalLifetime }}><RouterProvider router={router} /></AuthContext.Provider>);
  return router;
}
async function connectMaterial() {
  const sourceRow = await screen.findByRole('row', { name: /Матеріал.*Лише Менеджер/ });
  fireEvent.click(within(sourceRow).getByRole('button', { name: 'Пов’язати з Magento' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Вибрати наявний атрибут' }));
  fireEvent.change(screen.getByLabelText('Атрибут магазину'), { target: { value: 'material' } });
  fireEvent.click(screen.getByRole('button', { name: 'Продовжити налаштування' }));
}

it('shows direct links only for the selected language and opens that exact language rule', async () => {
  definition.groups[0].rows[0].cells.kolir = literal('UA manual');
  definition.groups[0].rows[1].cells.kolir = { op: 'source', id: 'color' };
  mount();
  const row = await screen.findByRole('row', { name: /Колір.*Лише Менеджер/ });
  expect(within(row).queryByRole('button', { name: 'Колір магазину' })).toBeNull();
  fireEvent.click(within(row).getByRole('button', { name: 'Пов’язати з Magento' }));
  expect(screen.queryByRole('button', { name: 'Налаштувати «Колір магазину»' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Залишити без змін' }));
  fireEvent.change(screen.getByLabelText('Мова полів'), { target: { value: 'english' } });
  const englishField = await screen.findByRole('button', { name: 'Колір магазину' });
  await waitFor(() => expect(englishField.disabled).toBe(false)); fireEvent.click(englishField);
  const field = await screen.findByRole('dialog', { name: 'Поле Magento' });
  expect(field.textContent).toContain('EN · англійською');
  expect(api.get).toHaveBeenCalledWith('/admin/magento-integration/categories/BR/fields/kolir', expect.objectContaining({ params: expect.objectContaining({ rowId: 'english' }) }));
  expect(api.post).not.toHaveBeenCalled();
});

it('preselects a current authorized source absent from the definition and keeps the target and other language unchanged', async () => {
  const before = structuredClone(definition); mount(); await connectMaterial();
  const dialog = await screen.findByRole('dialog', { name: 'Додати поле передачі' });
  expect(within(dialog).getByRole('combobox', { name: 'Характеристика' }).value).toContain('Матеріал');
  expect(within(dialog).getByLabelText('Код поля Magento').value).toBe('material');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Додати поле до чернетки' }));
  await screen.findByText('Передавання додано до чернетки. Наступний крок — перевірити зміни.');
  expect(definition).toEqual(before); expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Матеріал магазину' }));
  expect((await screen.findByRole('combobox', { name: 'Характеристика' })).value).toContain('Матеріал');
  fireEvent.click(screen.getByRole('button', { name: 'Закрити налаштування' }));
  fireEvent.change(screen.getByLabelText('Мова полів'), { target: { value: 'english' } });
  await waitFor(() => expect(screen.getByLabelText('Мова полів').value).toBe('english'));
  expect(screen.queryByRole('button', { name: 'Матеріал магазину' })).toBeNull();
});

it('keeps an unresolvable source in the connection dialog rather than silently creating a literal rule', async () => {
  registry.references.questions = registry.references.questions.filter((question) => question.key !== 'material');
  mount(); await connectMaterial();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Ця характеристика ще недоступна'));
  expect(screen.queryByRole('dialog', { name: 'Додати поле передачі' })).toBeNull();
  expect(screen.getByLabelText('Атрибут магазину').value).toBe('material');
  expect(api.post).not.toHaveBeenCalled();
});

it('reaches all 60 mappings and preserves explicit zero and later-page decisions without writes', async () => {
  const ids = [...Array.from({ length: 59 }, (_, index) => index + 1), 0];
  questions[0].options = ids.map((id) => ({ id, db_id: id + 100, label: `Варіант ${id}` }));
  entries = ids.map((id) => ({ ...entries[0], id: `option:${id}`, source: `BR.color=value_id:${id}`, evaluated: `Варіант ${id}` }));
  mount('/admin/catalog?category=BR&question=color&value=0');
  const zero = await screen.findByLabelText('Magento для Варіант 0');
  expect(zero.closest('tr').classList.contains('is-repair-target')).toBe(true);
  fireEvent.change(zero, { target: { value: '20' } });
  const mapping = screen.getByRole('region', { name: 'Менеджер — Magento: значення' });
  fireEvent.click(within(mapping).getByRole('button', { name: 'Далі' }));
  fireEvent.click(within(mapping).getByRole('button', { name: 'Далі' }));
  fireEvent.change(screen.getByLabelText('Magento для Варіант 59'), { target: { value: '20' } });
  fireEvent.change(screen.getByLabelText('Пошук значення'), { target: { value: 'Варіант 0' } });
  expect(screen.getByLabelText('Magento для Варіант 0').value).toBe('20');
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
  fireEvent.click(screen.getByRole('button', { name: 'Колір магазину' }));
  expect((await screen.findByLabelText('Magento для Варіант 0')).value).toBe('20');
  fireEvent.change(screen.getByLabelText('Пошук значення'), { target: { value: 'Варіант 59' } });
  expect(screen.getByLabelText('Magento для Варіант 59').value).toBe('20');
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
});

it.each([true, false])('guards exact contextual option-row navigation with integration available=%s and never opens a second Magento editor for a local edit', async (integrationAvailable) => {
  questions[0].options = [{ id: 0, db_id: 31, label: 'Перша назва' }, { id: 0, db_id: 32, label: 'Друга назва' }];
  const first = '/admin/catalog?category=BR&action=edit-option&question=color&value=0&optionId=31';
  const next = first.replace('optionId=31', 'optionId=32'); const router = mount(first, permissions, undefined, integrationAvailable);
  const input = await screen.findByRole('textbox', { name: 'Назва українською' });
  expect(input.value).toBe('Перша назва'); expect(screen.queryByRole('dialog', { name: 'Поле Magento' })).toBeNull();
  fireEvent.change(input, { target: { value: 'Незбережена перша' } });
  await act(() => router.navigate(next));
  const guard = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  fireEvent.click(within(guard).getByRole('button', { name: 'Залишитися' }));
  expect(screen.getByRole('textbox', { name: 'Назва українською' }).value).toBe('Незбережена перша');
  await act(() => router.navigate(next));
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Незбережені зміни' })).getByRole('button', { name: 'Відкинути й перейти' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Назва українською' }).value).toBe('Друга назва'));
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
});

it('does not expose local or connection writes to a read-only or invalidated principal', async () => {
  mount('/admin/catalog?category=BR', permissions, { id: 'expired', valid: false });
  await screen.findByRole('region', { name: 'Характеристики Менеджера' });
  expect(screen.queryByRole('button', { name: 'Додати характеристику' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Пов’язати з Magento' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps dirty local input mounted when the shop becomes available after an outage', async () => {
  function ConnectionHarness() {
    const [available, setAvailable] = useState(false);
    return <AuthContext.Provider value={{ permissions, roles: [] }}><button onClick={() => setAvailable(true)}>Відновити підключення</button><MagentoCategoryWorkspace categories={[category]} activePublication={active} localConfig={config} integrationAvailable={available} onPublished={vi.fn()} /></AuthContext.Provider>;
  }
  const router = createMemoryRouter([{ path: '/admin/catalog', element: <ConnectionHarness /> }], { initialEntries: ['/admin/catalog?category=BR&action=edit-option&question=color&value=0&optionId=31'] });
  render(<RouterProvider router={router} />);
  const input = await screen.findByRole('textbox', { name: 'Назва українською' });
  fireEvent.change(input, { target: { value: 'Збережіть це введення' } });
  fireEvent.click(screen.getByRole('button', { name: 'Відновити підключення' }));
  await waitFor(() => expect(api.get.mock.calls.some(([url]) => url.endsWith('/categories/BR'))).toBe(true));
  expect(screen.getByRole('textbox', { name: 'Назва українською' })).toBe(input);
  expect(input.value).toBe('Збережіть це введення');
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
});

it('retains an exact safe return to the product task in the local-only fallback and rejects external returns', async () => {
  const page = <AuthContext.Provider value={{ permissions, roles: [] }}><MagentoCategoryWorkspace categories={[category]} activePublication={active} localConfig={config} integrationAvailable={false} /></AuthContext.Provider>;
  const router = createMemoryRouter([{ path: '/admin/catalog', element: page }], { initialEntries: ['/admin/catalog?category=BR&returnTo=%2Fattention%3Fproblem%3D7%26category%3DBR'] });
  render(<RouterProvider router={router} />);
  expect(screen.getByRole('link', { name: 'Повернутися до попередньої задачі' }).getAttribute('href')).toBe('/attention?problem=7&category=BR');
  await act(() => router.navigate('/admin/catalog?category=BR&returnTo=https%3A%2F%2Fexample.com'));
  expect(screen.queryByRole('link', { name: 'Повернутися до попередньої задачі' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled(); expect(api.get).not.toHaveBeenCalled();
});
