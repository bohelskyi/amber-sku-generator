import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
function shell(props = {}, grants = permissions) {
  return render(<AuthContext.Provider value={{ permissions: grants }}><MemoryRouter initialEntries={['/admin/magento/prepare?category=SV']}>
    <MagentoPreparationWorkspace activePublication={active} onPublished={vi.fn()} onDiscover={vi.fn()} observation={null} {...props} />
  </MemoryRouter></AuthContext.Provider>);
}
async function selectDraft() {
  fireEvent.change(await screen.findByLabelText('Версія для перегляду'), { target: { value: 'draft' } });
  await screen.findByText('Чернетка змін · ревізія 7');
}

it('opens a revisitable workspace without automatic writes and keeps successor source on the active publication', async () => {
  shell(); await screen.findByText('Переглядаємо активну версію 3');
  expect(screen.getByLabelText('Категорія Amber').value).toBe('SV');
  expect(screen.getByRole('navigation', { name: 'Етапи підготовки' }).querySelectorAll('button')).toHaveLength(5);
  expect(screen.queryByText('Option preparation panel')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Publication panel' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  await selectDraft();
  expect(screen.getByText('successor:active:')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '2. Ресурси Magento' }));
  expect(screen.getByText(/не оновлює зафіксоване спостереження/)).toBeTruthy();
  expect(screen.getByText(/Непубліковані рішення попередньої чернетки автоматично не переносяться/)).toBeTruthy();
  expect(screen.getByText('successor:active:')).toBeTruthy();
  expect(screen.getByText('Option preparation panel')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '3. Відповідності' }));
  expect(screen.getByText('review:draft:SV')).toBeTruthy();
  expect(screen.queryByText('Option preparation panel')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '1. Що змінюємо?' }));
  expect(screen.getByLabelText('Версія для перегляду').value).toBe('draft');
  expect(api.post).not.toHaveBeenCalled();
});

it('retains captured examples across stages, permits explicit removal, and invalidates them after resource creation', async () => {
  shell(); await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test capture 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test capture 2' }));
  expect(screen.getByText('Збережені приклади CREATE: 2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '5. Публікація' }));
  expect(screen.getByText('Publication examples: 2')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  fireEvent.click(screen.getByRole('button', { name: 'Прибрати приклад 1' }));
  expect(screen.getByText('Збережені приклади CREATE: 1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '2. Ресурси Magento' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test created resource' }));
  fireEvent.click(screen.getByRole('button', { name: '3. Відповідності' }));
  expect(screen.queryByRole('region', { name: 'Binding review' })).toBeNull();
  expect(screen.getByText(/Підготуйте нову чернетку після створення ресурсів/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '5. Публікація' }));
  expect(screen.queryByRole('region', { name: 'Publication panel' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '2. Ресурси Magento' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test fresh successor' }));
  await screen.findByText('Чернетка змін · ревізія 1');
  expect(api.get).toHaveBeenLastCalledWith('/admin/magento-integration', expect.objectContaining({ params: { bindingRevisionId: 'fresh' } }));
  fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  expect(screen.queryByText(/Збережені приклади CREATE:/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Test capture 1' })).toBeTruthy();
});

it('clears captured examples when a mapping decision advances the inspected revision', async () => {
  shell(); await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test capture 1' }));
  fireEvent.click(screen.getByRole('button', { name: '3. Відповідності' }));
  api.get.mockResolvedValueOnce({ data: { ...context, revision: { ...existingDraft, revision: '8' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Test changed decision' }));
  await screen.findByText('Чернетка змін · ревізія 8');
  fireEvent.click(screen.getByRole('button', { name: '5. Публікація' }));
  expect(screen.getByText('Publication examples: 0')).toBeTruthy();
});

it('keeps the fresh-successor requirement when the operator switches away from and back to a draft', async () => {
  shell(); await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '2. Ресурси Magento' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test created resource' }));
  fireEvent.click(screen.getByRole('button', { name: '1. Що змінюємо?' }));
  fireEvent.change(screen.getByLabelText('Версія для перегляду'), { target: { value: '' } });
  await screen.findByText('Переглядаємо активну версію 3');
  await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '3. Відповідності' }));
  expect(screen.queryByRole('region', { name: 'Binding review' })).toBeNull();
  expect(screen.getByText(/Підготуйте нову чернетку після створення ресурсів/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  expect(screen.queryByRole('button', { name: 'Test capture 1' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '5. Публікація' }));
  expect(screen.queryByRole('region', { name: 'Publication panel' })).toBeNull();
  expect(screen.getByText(/Підготуйте нову чернетку зі свіжим спостереженням перед публікацією/)).toBeTruthy();
});

it('keeps the old draft marked after a fresh successor is prepared', async () => {
  shell(); await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '2. Ресурси Magento' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test created resource' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test fresh successor' }));
  await screen.findByText('Чернетка змін · ревізія 1');
  fireEvent.click(screen.getByRole('button', { name: '3. Відповідності' }));
  expect(screen.getByText('review:fresh:SV')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '1. Що змінюємо?' }));
  await selectDraft();
  fireEvent.click(screen.getByRole('button', { name: '3. Відповідності' }));
  expect(screen.queryByRole('region', { name: 'Binding review' })).toBeNull();
  expect(screen.getByText(/Підготуйте нову чернетку після створення ресурсів/)).toBeTruthy();
});

it('blocks continuation when the lightweight active publication differs from the loaded preparation context', async () => {
  api.get.mockResolvedValue({ data: { ...context, currentPublishedId: 'different-active' } });
  shell(); await screen.findByText(/Активні відповідності змінилися/);
  expect(screen.queryByLabelText('Версія для перегляду')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '5. Публікація' }));
  expect(screen.queryByRole('region', { name: 'Publication panel' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('requires effective product-preview capabilities and invokes discovery only explicitly', async () => {
  const discover = vi.fn(); shell({ onDiscover: discover }, ['export_templates.view', 'export_templates.manage']);
  await selectDraft(); fireEvent.click(screen.getByRole('button', { name: '4. Перевірка товарів' }));
  expect(screen.getByText(/Для перевірки товарів потрібні права/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Test capture 1' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '2. Ресурси Magento' }));
  expect(discover).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити Magento' }));
  await waitFor(() => expect(discover).toHaveBeenCalledTimes(1));
});

it('does not invent a successor source when there is no active publication', async () => {
  api.get.mockResolvedValue({ data: { ...context, revision: null, currentPublishedId: null } });
  shell({ activePublication: null });
  await screen.findByText(/Потрібна початкова опублікована інтеграція/);
  expect(screen.queryByRole('button', { name: 'Test fresh successor' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
