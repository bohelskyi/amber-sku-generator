import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoPreparationWorkspace from '../src/components/workspace/MagentoPreparationWorkspace.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../src/components/workspace/MagentoBindingReview.jsx', () => ({ default: ({ mode, revision, categoryCode, onChanged }) => <section aria-label={`Binding ${mode}`}>
  <p>{mode}:{revision.id}:{categoryCode}</p>
  {mode === 'successor' && <button onClick={() => onChanged({ id: 'fresh', revision: '1', state: 'draft' })}>Test fresh successor</button>}
  {mode === 'review' && <button onClick={() => onChanged({ ...revision, revision: '8' })}>Test changed decision</button>}
</section> }));
vi.mock('../src/components/workspace/MagentoCategoryActions.jsx', () => ({ default: ({ onResourceChanged }) => <button onClick={onResourceChanged}>Test created resource</button> }));
vi.mock('../src/components/workspace/MagentoAttributeActions.jsx', () => ({ default: () => <p>Attribute creation panel</p> }));
vi.mock('../src/components/workspace/MagentoOptionActions.jsx', () => ({ default: () => <p>Option preparation panel</p> }));
vi.mock('../src/components/workspace/MagentoProductChecks.jsx', () => ({ default: ({ categoryCode, onRepresentative }) => <div>
  {[1, 2].map((route) => <button key={route} onClick={() => onRepresentative({ routeKey: `${categoryCode}:${route}`, group: categoryCode,
    input: { product: { categoryCode, answers: { route } } } })}>Test capture {route}</button>)}
</div> }));
vi.mock('../src/components/workspace/MagentoPublicationActions.jsx', () => ({ default: ({ representatives, revision, onPublished }) => <section aria-label="Publication panel">
  <p>Publication examples: {representatives.length}</p>
  <button onClick={() => onPublished({ ...revision, state: 'published' })}>Test published</button>
</section> }));

const active = { id: 'active', revision: '4', versionNumber: 3, state: 'published' };
const existingDraft = { id: 'draft', revision: '7', state: 'draft' };
const context = { revision: active, currentPublishedId: 'active', templateVersions: [],
  revisions: [{ id: 'draft', state: 'draft', revision: '7', observed_at: '2026-10-02T10:00:00Z' }],
  categories: [{ code: 'BR', name: 'Браслети' }, { code: 'SV', name: 'Сувеніри' }] };
const permissions = ['export_templates.view', 'export_templates.manage', 'exports.view'];
beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockImplementation((_path, { params }) => Promise.resolve({ data: { ...context,
    revision: params.bindingRevisionId === 'draft' ? existingDraft : params.bindingRevisionId === 'fresh'
      ? { id: 'fresh', revision: '1', state: 'draft' } : active } }));
});
afterEach(cleanup);
function shell(props = {}, grants = permissions, path = '/admin/magento/prepare?category=SV') {
  return render(<AuthContext.Provider value={{ permissions: grants }}><MemoryRouter initialEntries={[path]}>
    <MagentoPreparationWorkspace activePublication={active} onPublished={vi.fn()} onDiscover={vi.fn()} observation={null} {...props} />
  </MemoryRouter></AuthContext.Provider>);
}

it('resumes an exact repair step and preserves the original product return through resource refresh', async () => {
  function Location() { const location = useLocation(); return <output aria-label="Task address">{location.search}</output>; }
  render(<AuthContext.Provider value={{ permissions }}><MemoryRouter initialEntries={[
    '/admin/magento/prepare?category=SV&draft=draft&intent=option&step=1&field=kamin&question=stone&value=0&productId=42&returnTo=%2Fattention%3Fproblem%3D42%26reason%3Ddata',
  ]}><MagentoPreparationWorkspace activePublication={active} onPublished={vi.fn()} onDiscover={vi.fn()} /><Location /></MemoryRouter></AuthContext.Provider>);
  await screen.findByText('Option preparation panel');
  expect(screen.queryByText('Test created resource')).toBeNull();
  expect(screen.getByRole('link', { name: 'Повернутися до товару' }).getAttribute('href')).toBe('/attention?problem=42&reason=data');
  fireEvent.click(screen.getByRole('button', { name: '3. Підключення' }));
  expect(screen.getByLabelText('Task address').textContent).toContain('step=2');
  expect(screen.getByLabelText('Task address').textContent).toContain('value=0');
  expect(api.post).not.toHaveBeenCalled();
});

it('mapping intent skips resource creation and retains exact category while rule intent exposes a distinct rule step', async () => {
  shell({}, permissions, '/admin/magento/prepare?category=SV&intent=mapping');
  await screen.findByText('Переглядаємо активну версію 3');
  expect(screen.queryByRole('button', { name: /Дані Magento/ })).toBeNull();
  expect(screen.getByRole('button', { name: '2. Підключення' })).toBeTruthy();
  fireEvent.click(screen.getByText('Змінити задачу'));
  fireEvent.click(screen.getByRole('button', { name: /Змінити правило поля Назва/ }));
  expect(screen.getByRole('button', { name: '2. Правила передачі' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Дані Magento/ })).toBeNull();
  expect(screen.getByLabelText('Категорія товарів').value).toBe('SV');
  expect(api.post).not.toHaveBeenCalled();
});

it('opens the saved draft handoff without preparing a replacement or changing the active source', async () => {
  shell({}, permissions, '/admin/magento/prepare?category=SV&draft=draft&intent=values');
  await screen.findByText('Чернетка змін · ревізія 7');
  expect(screen.getByText('successor:active:SV')).toBeTruthy();
  expect(api.get).toHaveBeenCalledWith('/admin/magento-integration', expect.objectContaining({ params: { bindingRevisionId: 'draft' } }));
  expect(api.post).not.toHaveBeenCalled();
});
async function selectDraft() {
  fireEvent.change(await screen.findByLabelText('Версія для перегляду'), { target: { value: 'draft' } });
  await screen.findByText('Чернетка змін · ревізія 7');
}

it('opens a revisitable workspace without automatic writes and keeps successor source on the active publication', async () => {
  shell(); await screen.findByText('Переглядаємо активну версію 3');
  expect(screen.getByLabelText('Категорія товарів').value).toBe('SV');
  expect(screen.getByRole('navigation', { name: 'Етапи підготовки' }).querySelectorAll('button')).toHaveLength(5);
  expect(screen.queryByText('Option preparation panel')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Publication panel' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  await selectDraft();
  expect(screen.getByText('successor:active:SV')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '2. Дані Magento' }));
  fireEvent.click(screen.getByText('Як зберігаються підготовлені зміни'));
  expect(screen.getByText(/не оновлює зафіксоване спостереження/)).toBeTruthy();
  expect(screen.getByText(/Непубліковані рішення попередньої чернетки автоматично не переносяться/)).toBeTruthy();
  expect(screen.queryByText('successor:active:SV')).toBeNull();
  expect(screen.getByText('Option preparation panel')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '3. Підключення' }));
  expect(screen.getByText('review:draft:SV')).toBeTruthy();
  expect(screen.queryByText('Option preparation panel')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '1. Початок' }));
  expect(screen.getByLabelText('Версія для перегляду').value).toBe('draft');
  expect(api.post).not.toHaveBeenCalled();
});

it('retains captured examples across stages, permits explicit removal, and invalidates them after resource creation', async () => {
  shell(); await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test capture 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test capture 2' }));
  expect(screen.getByText('Збережені приклади нових товарів: 2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '5. Застосування' }));
  expect(screen.getByText('Publication examples: 2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  fireEvent.click(screen.getByRole('button', { name: 'Прибрати приклад 1' }));
  expect(screen.getByText('Збережені приклади нових товарів: 1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '2. Дані Magento' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test created resource' }));
  fireEvent.click(screen.getByRole('button', { name: '3. Підключення' }));
  expect(screen.queryByRole('region', { name: 'Binding review' })).toBeNull();
  expect(screen.getByText(/Підготуйте нову чернетку після створення ресурсів/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '5. Застосування' }));
  expect(screen.queryByRole('region', { name: 'Publication panel' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '2. Дані Magento' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test fresh successor' }));
  await screen.findByText('Чернетка змін · ревізія 1');
  expect(api.get).toHaveBeenLastCalledWith('/admin/magento-integration', expect.objectContaining({ params: { bindingRevisionId: 'fresh' } }));
  fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  expect(screen.queryByText(/Збережені приклади нових товарів:/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Test capture 1' })).toBeTruthy();
});

it('clears captured examples when a mapping decision advances the inspected revision', async () => {
  shell(); await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test capture 1' }));
  fireEvent.click(screen.getByRole('button', { name: '3. Підключення' }));
  api.get.mockResolvedValueOnce({ data: { ...context, revision: { ...existingDraft, revision: '8' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Test changed decision' }));
  await screen.findByText('Чернетка змін · ревізія 8');
  fireEvent.click(screen.getByRole('button', { name: '5. Застосування' }));
  expect(screen.getByText('Publication examples: 0')).toBeTruthy();
});

it('keeps the fresh-successor requirement when the operator switches away from and back to a draft', async () => {
  shell(); await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '2. Дані Magento' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test created resource' }));
  fireEvent.click(screen.getByRole('button', { name: '1. Початок' }));
  fireEvent.change(screen.getByLabelText('Версія для перегляду'), { target: { value: '' } });
  await screen.findByText('Переглядаємо активну версію 3');
  await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '3. Підключення' }));
  expect(screen.queryByRole('region', { name: 'Binding review' })).toBeNull();
  expect(screen.getByText(/Підготуйте нову чернетку після створення ресурсів/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  expect(screen.queryByRole('button', { name: 'Test capture 1' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '5. Застосування' }));
  expect(screen.queryByRole('region', { name: 'Publication panel' })).toBeNull();
  expect(screen.getByText(/Підготуйте нову чернетку зі свіжим спостереженням перед публікацією/)).toBeTruthy();
});

it('keeps the old draft marked after a fresh successor is prepared', async () => {
  shell(); await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '2. Дані Magento' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test created resource' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test fresh successor' }));
  await screen.findByText('Чернетка змін · ревізія 1');
  fireEvent.click(screen.getByRole('button', { name: '3. Підключення' }));
  expect(screen.getByText('review:fresh:SV')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '1. Початок' }));
  await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '3. Підключення' }));
  expect(screen.queryByRole('region', { name: 'Binding review' })).toBeNull();
  expect(screen.getByText(/Підготуйте нову чернетку після створення ресурсів/)).toBeTruthy();
});

it('blocks continuation when the lightweight active publication differs from the loaded preparation context', async () => {
  api.get.mockResolvedValue({ data: { ...context, currentPublishedId: 'different-active' } });
  shell(); await screen.findByText(/Активні відповідності змінилися/);
  expect(screen.queryByLabelText('Версія для перегляду')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '5. Застосування' }));
  expect(screen.queryByRole('region', { name: 'Publication panel' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('requires effective product-preview capabilities and invokes discovery only explicitly', async () => {
  const discover = vi.fn(); shell({ onDiscover: discover }, ['export_templates.view', 'export_templates.manage']);
  await selectDraft(); fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  expect(screen.getByText(/Для перевірки товарів потрібні права/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Test capture 1' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '2. Дані Magento' }));
  expect(discover).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити структуру' }));
  await waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
});

it('does not invent a successor source when there is no active publication', async () => {
  api.get.mockResolvedValue({ data: { ...context, revision: null, currentPublishedId: null } });
  shell({ activePublication: null });
  await screen.findByText(/Потрібна початкова опублікована інтеграція/);
  expect(screen.queryByRole('button', { name: 'Test fresh successor' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps new attribute work focused without unrelated category or option creation panels', async () => {
  shell({}, permissions, '/admin/magento/prepare?category=SV&draft=draft&intent=attribute&step=1');
  await screen.findByText('Attribute creation panel');
  expect(screen.queryByText('Option preparation panel')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Test created resource' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('reuses an existing Magento resource through the original review instead of mounting creation controls', async () => {
  shell({}, permissions, '/admin/magento/prepare?category=SV&draft=draft&intent=attribute&step=1');
  await screen.findByText('Attribute creation panel');
  fireEvent.click(screen.getByRole('button', { name: 'Використати наявний' }));
  expect(screen.queryByText('Attribute creation panel')).toBeNull();
  expect(screen.getByText(/Новий ресурс Magento не створюється/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Вибрати наявну відповідність' }));
  await screen.findByRole('region', { name: 'Binding review' });
  expect(screen.getByText('review:draft:SV')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it('shows explicit structure-check results and failures beside the task action', async () => {
  const comparison = { state: 'checked', bindingRevisionId: 'active', routesChecked: 1, attributesChecked: 2, findings: [] };
  const view = shell({ observation: { comparison } }, permissions, '/admin/magento/prepare?category=SV&draft=draft&intent=attribute&step=1');
  await screen.findByText('Attribute creation panel');
  expect(screen.getByText(/У перевірених налаштуваннях розбіжностей не знайдено/)).toBeTruthy();
  view.unmount();
  shell({ observation: { comparison }, checkError: 'Magento недоступний' }, permissions, '/admin/magento/prepare?category=SV&draft=draft&intent=attribute&step=1');
  await screen.findByText('Attribute creation panel');
  expect(screen.getByText('Magento недоступний')).toBeTruthy();
  expect(screen.queryByText(/розбіжностей не знайдено/)).toBeNull();
});

it('does not substitute another category for a removed exact repair target', async () => {
  shell({}, permissions, '/admin/magento/prepare?category=REMOVED&intent=mapping&productId=42');
  await screen.findByText(/Категорію цієї задачі не знайдено/);
  expect(screen.queryByRole('button', { name: 'Test fresh successor' })).toBeNull();
  expect(screen.queryByLabelText('Категорія товарів')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('retains the subcategory task when authoring its exact placement rule', async () => {
  api.get.mockResolvedValue({ data: { ...context, revision: { ...existingDraft, templateId: 'family', templateVersionId: 'v3' } } });
  shell({}, permissions, '/admin/magento/prepare?category=SV&draft=draft&intent=subcategory&step=1&productId=42');
  const link = await screen.findByRole('link', { name: 'Вибрати розділ і товари для підкатегорії' });
  const target = new URL(link.getAttribute('href'), 'http://fixture');
  expect(target.searchParams.get('intent')).toBe('subcategory');
  expect(target.searchParams.get('field')).toBe('categories');
  expect(target.searchParams.get('version')).toBe('v3');
  expect(target.searchParams.get('productId')).toBe('42');
});

it.each(['rules', 'attribute'])('continues a published %s rule handoff to connections after explicit successor preparation', async (intent) => {
  shell({}, permissions, `/admin/magento/prepare?category=SV&intent=${intent}&templateVersion=new-version`);
  fireEvent.click(await screen.findByRole('button', { name: 'Test fresh successor' }));
  expect(await screen.findByText('review:fresh:SV')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps resource creation available after a published subcategory rule handoff', async () => {
  shell({}, permissions, '/admin/magento/prepare?category=SV&intent=subcategory&templateVersion=new-version');
  fireEvent.click(await screen.findByRole('button', { name: 'Test fresh successor' }));
  expect(await screen.findByRole('button', { name: 'Test created resource' })).toBeTruthy();
  expect(screen.queryByText('Option preparation panel')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('selects an exact active options question before a generic variant task and preserves its preparation return', async () => {
  const catalog = { questions: { SV: [
    { id: 'kind', label: 'Вид сувеніра', input_type: 'options', archived: 0 },
    { id: 'old', label: 'Архівне питання', input_type: 'options', archived: 1 },
    { id: 'weight', label: 'Вага', input_type: 'text' },
  ] } };
  api.get.mockResolvedValue({ data: { ...context, catalog, revision: existingDraft } });
  shell({}, [...permissions, 'catalog.view'], '/admin/magento/prepare?category=SV&draft=draft&intent=option&step=1&productId=42&returnTo=%2Fattention%3Fproblem%3D42');
  const selector = await screen.findByLabelText('Характеристика для нового варіанта');
  expect(screen.queryByRole('link', { name: 'Додати варіант характеристики' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'Архівне питання' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'Вага' })).toBeNull();
  fireEvent.change(selector, { target: { value: 'kind' } });
  const url = new URL(screen.getByRole('link', { name: 'Додати варіант характеристики' }).href);
  expect(url.searchParams.get('action')).toBe('new-option');
  expect(url.searchParams.get('question')).toBe('kind');
  const back = new URL(url.searchParams.get('returnTo'), 'https://manager.local');
  expect(back.pathname).toBe('/admin/magento/prepare');
  expect(back.searchParams.get('draft')).toBe('draft');
  expect(back.searchParams.get('productId')).toBe('42');
  expect(back.searchParams.get('returnTo')).toBe('/attention?problem=42');
  expect(api.post).not.toHaveBeenCalled();
});
it('retains an exact repair question and zero value without automatic local writes', async () => {
  api.get.mockResolvedValue({ data: { ...context, revision: existingDraft, catalog: { questions: { SV: [{ id: 'kind', label: 'Вид', input_type: 'options', archived: 0 }] } } } });
  shell({}, [...permissions, 'catalog.view'], '/admin/magento/prepare?category=SV&draft=draft&intent=option&step=1&question=kind&value=0&productId=42');
  expect((await screen.findByLabelText('Характеристика для нового варіанта')).value).toBe('kind');
  const back = new URL(new URL(screen.getByRole('link', { name: 'Додати варіант характеристики' }).href).searchParams.get('returnTo'), 'https://manager.local');
  expect(back.searchParams.get('value')).toBe('0');
  expect(api.post).not.toHaveBeenCalled();
});

it('exposes the selected resource choice and one explicit existing-alignment action', async () => {
  shell({}, permissions, '/admin/magento/prepare?category=SV&draft=draft&intent=attribute&step=1');
  await screen.findByText('Attribute creation panel');
  const existing = screen.getByRole('button', { name: 'Використати наявний' });
  const create = screen.getByRole('button', { name: 'Створити відсутній' });
  expect(create.getAttribute('aria-pressed')).toBe('true');
  expect(existing.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(existing);
  expect(existing.getAttribute('aria-pressed')).toBe('true');
  expect(create.getAttribute('aria-pressed')).toBe('false');
  expect(screen.getAllByRole('button', { name: 'Вибрати наявну відповідність' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Перевірити підключення' })).toBeNull();
  expect(screen.queryByText('Attribute creation panel')).toBeNull();
  fireEvent.click(create);
  expect(create.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText('Attribute creation panel')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Перевірити підключення' })).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it('does not advance existing alignment with the old observation after a created resource', async () => {
  shell({}, permissions, '/admin/magento/prepare?category=SV&draft=draft&intent=subcategory&step=1');
  fireEvent.click(await screen.findByRole('button', { name: 'Test created resource' }));
  fireEvent.click(screen.getByRole('button', { name: 'Використати наявний' }));
  const alignment = screen.getByRole('button', { name: 'Вибрати наявну відповідність' });
  expect(alignment.disabled).toBe(true);
  fireEvent.click(alignment);
  expect(screen.queryByRole('region', { name: 'Binding review' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Test fresh successor' }));
  expect(await screen.findByText('review:fresh:SV')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps the exact catalog handoff contextual and unavailable without catalog permission', async () => {
  api.get.mockResolvedValue({ data: { ...context, revision: existingDraft, catalog: { questions: { SV: [{ id: 'kind', label: 'Вид', input_type: 'options', archived: 0 }] } } } });
  const path = '/admin/magento/prepare?category=SV&draft=draft&intent=option&step=1&question=kind&value=0&productId=42';
  const view = shell({}, [...permissions, 'catalog.view'], path);
  const link = await screen.findByRole('link', { name: 'Додати варіант характеристики' });
  const target = new URL(link.href);
  expect(target.searchParams.get('category')).toBe('SV');
  expect(target.searchParams.get('question')).toBe('kind');
  expect(target.searchParams.get('action')).toBe('new-option');
  const back = new URL(target.searchParams.get('returnTo'), 'https://fixture.local');
  expect(back.searchParams.get('value')).toBe('0');
  expect(back.searchParams.get('productId')).toBe('42');
  view.unmount();
  shell({}, permissions, path);
  await screen.findByText('Option preparation panel');
  expect(screen.queryByRole('link', { name: 'Додати варіант характеристики' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
