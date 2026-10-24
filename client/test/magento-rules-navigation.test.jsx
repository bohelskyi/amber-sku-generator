import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoCategoryWorkspace from '../src/components/workspace/MagentoCategoryWorkspace.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
const root = '/admin/magento-integration';
const grants = ['export_templates.view', 'export_templates.manage', 'export_templates.publish', 'exports.view'];
const active = { id: 'current', revision: '4', state: 'published', templateVersionId: 'version-current' };
const draft = { ...active, id: 'draft', revision: '1', state: 'draft' };
const definition = { evaluatorVersion: 'magento-declarative-4', outputContract: 'magento-products-columns-v2', sources: {}, tables: {}, bindings: [],
  groups: [{ route: 'BR', columns: ['description'], rows: [{ id: 'base', cells: { description: { op: 'literal', value: 'Опис UA' } } }, { id: 'english', cells: { description: { op: 'literal', value: 'Description EN' } } }] }] };
const policy = (patch = {}) => ({ id: 'policy:opaque:/?&:en', kind: 'policy', group: 'BR', routeKey: 'BR:all', row: 'english', target: 'description', label: 'en', identity: 'magento_managed', reviewState: 'approved', exact: false, ...patch });
let entries; let revisions; let readField; let readFamily;
function projection(revision, row = 'base') {
  return { category: { code: 'BR', name: 'Браслети' }, revision, template: { definition }, groupIndex: 0, rowIndex: row === 'english' ? 1 : 0,
    routeKey: 'BR:all', routes: [{ routeKey: 'BR:all', setName: 'Браслети' }], questions: [],
    attributes: [{ code: 'description', target: 'description', label: 'Опис товару', text: true, editable: true, configured: true, sources: [], state: 'connected', policy: 'magento_managed' }] };
}
function binding(revision) {
  return { revision: { ...revision, schema: { attributes: [{ attribute_code: 'description', default_frontend_label: 'Опис товару' }], attributeSets: [] }, bindings: { attributes: [] } }, entries, validation: { diagnostics: [] } };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function mount(path = '/admin/catalog?category=BR&binding=current&source=current&review=policies', permissions = grants) {
  const element = <MagentoCategoryWorkspace categories={[{ code: 'BR', name: 'Браслети' }]} activePublication={active} onPublished={vi.fn()} />;
  const router = createMemoryRouter([{ path: '/admin/catalog', element }, { path: '/admin/magento/categories/:categoryCode', element }], { initialEntries: [path] });
  render(<AuthContext.Provider value={{ permissions }}><RouterProvider router={router} /></AuthContext.Provider>);
  return router;
}
async function rules() { const dialog = await screen.findByRole('dialog', { name: 'Правила передавання полів' }); await within(dialog).findByRole('table'); await act(async () => {}); return dialog; }
beforeEach(() => {
  vi.resetAllMocks(); entries = [policy(), policy({ id: 'policy:ua:all', row: 'base', label: 'all', reviewState: 'blocked' })];
  revisions = { current: active, draft, old: { ...active, id: 'old' } }; readField = null; readFamily = null;
  api.get.mockImplementation(async (url, config) => {
    if (url.endsWith('/sources')) return { data: { productFields: [], references: { questions: [], schemas: [] } } };
    if (url.includes('/fields/')) return readField ? readField.promise : { data: { revision: revisions[config.params.bindingRevisionId], attribute: { code: 'description', target: 'description' }, entries: entries.filter((e) => e.row === config.params.rowId), options: [] } };
    if (url.includes('/categories/')) return { data: projection(revisions[config.params.bindingRevisionId], config.params.rowId) };
    if (url.includes('/bindings/')) return { data: binding(revisions[url.split('/').at(-1)]) };
    if (url === '/admin/export-templates/private') return readFamily.promise;
    if (url.endsWith('/handoffs')) return { data: [] };
    throw Error(`Unexpected GET ${url}`);
  });
  api.post.mockImplementation(async (url) => { throw Error(`Unexpected POST ${url}`); });
  api.put.mockImplementation(async (url) => { throw Error(`Unexpected PUT ${url}`); });
});
afterEach(() => cleanup());

it('opens the published rules table directly with all saved states and no impact or preparation', async () => {
  entries.push(policy({ id: 'policy:none:en', target: 'name', identity: null, reviewState: 'not_applicable' }));
  mount(); const dialog = await rules();
  expect(within(dialog).getAllByRole('row')).toHaveLength(4);
  expect(within(dialog).getAllByText('Вручну в Magento')).toHaveLength(2);
  expect(within(dialog).queryByRole('combobox')).toBeNull();
  expect(within(dialog).queryByRole('button', { name: 'Підтвердити' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Перевірка та застосування' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
});

it('the general behavior action navigates to the read-only table before any explicit prepare', async () => {
  const router = mount('/admin/catalog?category=BR');
  fireEvent.click(await screen.findByText('Дані Magento та додаткові налаштування'));
  fireEvent.click(screen.getByRole('link', { name: 'Змінити поведінку передавання полів' }));
  await rules();
  expect(new URLSearchParams(router.state.location.search).get('review')).toBe('policies');
  expect(api.post).not.toHaveBeenCalled();
});

it('resolves a full EN tuple to the returned opaque row, opens its page once and preserves manual paging', async () => {
  entries = Array.from({ length: 31 }, (_, i) => policy({ id: `policy:other${i}:all`, target: `field${i}`, row: 'base', label: 'all' })).concat(policy());
  mount('/admin/catalog?category=BR&binding=current&source=current&review=policies&route=BR%3Aall&language=english&reviewField=description&reviewStore=en');
  const dialog = await rules();
  const target = await within(dialog).findByText('Рядок, відкритий за посиланням');
  await waitFor(() => expect(document.activeElement).toBe(target.closest('tr')));
  expect(within(dialog).getByText('2 / 2')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Назад', exact: true }));
  expect(within(dialog).getByText('1 / 2')).toBeTruthy();
  expect(within(dialog).queryByText('Рядок, відкритий за посиланням')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('closing a same draft table and reloading its address does not reopen impact or ordinary review', async () => {
  const router = mount('/admin/catalog?category=BR&binding=draft&source=current&review=policies');
  const dialog = await rules();
  fireEvent.click(within(dialog).getByRole('button', { name: 'До категорії' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const address = router.state.location.pathname + router.state.location.search;
  expect(new URLSearchParams(router.state.location.search).get('binding')).toBe('draft');
  cleanup(); mount(address); await screen.findByRole('button', { name: 'Продовжити перевірку' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(api.post).not.toHaveBeenCalled();
});

it('waits for the exact field DTO before linking to its returned policy ID and returns to the original field', async () => {
  readField = deferred(); const router = mount('/admin/catalog?category=BR&binding=current&source=current&language=english&field=description');
  const field = await screen.findByRole('dialog', { name: 'Поле Magento' });
  await within(field).findByText('Читаємо поле…');
  expect(within(field).queryByRole('link', { name: 'Переглянути правило передавання' })).toBeNull();
  await act(async () => readField.resolve({ data: { revision: active, attribute: { code: 'description', target: 'description' }, entries: [policy()], options: [] } }));
  const link = await within(field).findByRole('link', { name: 'Переглянути правило передавання' });
  expect(new URL(link.href).searchParams.get('reviewEntry')).toBe(policy().id);
  fireEvent.click(link); const dialog = await rules();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'До поля' }));
  await screen.findByRole('dialog', { name: 'Поле Magento' });
  expect(new URLSearchParams(router.state.location.search).get('field')).toBe('description');
  expect(api.post).not.toHaveBeenCalled();
});

it.each(['old', 'draft'])('opening and revisiting %s preserves the selected binding without successor or impact', async (id) => {
  const router = mount(`/admin/catalog?category=BR&binding=${id}&source=current&review=policies`);
  const dialog = await rules();
  expect(within(dialog).queryByRole('button', { name: 'Підготувати редагування правил' })).toBeNull();
  await act(async () => router.navigate(router.state.location.pathname + router.state.location.search));
  await rules();
  expect(api.get.mock.calls.filter(([url]) => url.includes('/bindings/')).every(([url]) => url.endsWith(`/${id}`))).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

it.each([
  ['another binding', { id: 'other' }], ['published state', { state: 'published' }], ['different counter', { revision: '77' }],
])('refuses draft decisions when the returned DTO has %s', async (_name, patch) => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.endsWith('/bindings/draft')) result.data.revision = { ...result.data.revision, ...patch };
    return result;
  });
  mount('/admin/catalog?category=BR&binding=draft&source=current&review=policies');
  const dialog = await screen.findByRole('dialog', { name: 'Правила передавання полів' });
  await waitFor(() => expect(within(dialog).queryByText('Оновлюємо підтвердження…')).toBeNull());
  expect(within(dialog).queryByRole('combobox')).toBeNull();
  expect(within(dialog).queryByRole('button', { name: 'Підтвердити' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('view-only access reads the draft without a confirmation or preparation action', async () => {
  mount('/admin/catalog?category=BR&binding=draft&source=current&review=policies', ['export_templates.view']);
  const dialog = await rules();
  expect(within(dialog).queryByRole('combobox')).toBeNull();
  expect(within(dialog).queryByRole('button', { name: 'Підготувати редагування правил' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it.each(['missing', 'duplicate', 'contradictory', 'partial'])('does not highlight an unrelated row for a %s exact intent', async (kind) => {
  const query = new URLSearchParams({ category: 'BR', binding: 'current', source: 'current', review: 'policies', reviewEntry: kind === 'missing' ? 'absent' : policy().id });
  if (kind === 'duplicate') entries.push(policy());
  if (kind === 'contradictory') query.set('language', 'base');
  if (kind === 'partial') { query.delete('reviewEntry'); query.set('reviewField', 'description'); }
  mount(`/admin/catalog?${query}`); const dialog = await screen.findByRole('dialog', { name: 'Правила передавання полів' });
  expect(await within(dialog).findByText(/Точний рядок за цим посиланням не знайдено/)).toBeTruthy();
  await act(async () => {});
  expect(within(dialog).queryByText('Рядок, відкритий за посиланням')).toBeNull();
  expect(within(dialog).queryByRole('button', { name: 'Підготувати редагування правил' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it.each(['blocked', 'not_applicable'])('keeps a newly visible %s draft policy read-only and out of batch confirmation', async (state) => {
  entries = [policy({ reviewState: state }), policy({ id: 'policy:ua:all', row: 'base', label: 'all', reviewState: 'review_required' })];
  mount('/admin/catalog?category=BR&binding=draft&source=current&review=policies'); const dialog = await rules();
  const readonlyRow = within(dialog).getByText(state === 'blocked' ? 'Заблоковано' : 'Не застосовується').closest('tr');
  expect(readonlyRow.textContent).toContain('Вручну в Magento');
  expect(within(readonlyRow).queryByRole('combobox')).toBeNull();
  expect(within(readonlyRow).queryByRole('button', { name: 'Підтвердити' })).toBeNull();
  expect(readonlyRow.textContent).toContain(state === 'blocked' ? 'Заблоковано' : 'Не застосовується');
  fireEvent.change(within(dialog).getByLabelText('Пояснення перевірки'), { target: { value: 'Пояснення іншого правила' } });
  expect(within(dialog).getAllByRole('button', { name: 'Підтвердити', exact: true })).toHaveLength(1);
  expect(within(dialog).queryByRole('button', { name: 'Підтвердити показані відповідності' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('an empty policy table states absence, never claims the complete package is confirmed', async () => {
  entries = []; mount();
  const dialog = await screen.findByRole('dialog', { name: 'Правила передавання полів' });
  expect(await within(dialog).findByText('У цій версії немає збережених правил передавання для категорії.')).toBeTruthy();
  expect(within(dialog).queryByText('Усі необхідні відповідності підтверджено.')).toBeNull();
  expect(within(dialog).queryByText('Відповідності перевірено')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it.each(['pending', 'mismatched', 'failed'])('keeps a %s private template restoration read-only without publishing it', async (state) => {
  readFamily = deferred();
  mount('/admin/catalog?category=BR&binding=draft&source=current&ruleDraft=private&review=policies');
  const dialog = await rules();
  expect(within(dialog).queryByRole('combobox')).toBeNull();
  if (state === 'mismatched') {
    const other = structuredClone(definition); other.groups[0].rows[0].cells.description.value = 'Private different rule';
    await act(async () => readFamily.resolve({ data: { id: 'private', draft: { definition: other } } }));
  } else if (state === 'failed') {
    await act(async () => readFamily.resolve({ data: { id: 'private', draft: { definition: { ...definition, groups: [] } } } }));
    await within(dialog).findByText('Збережена чернетка не містить цієї категорії.');
  }
  expect(within(dialog).queryByRole('combobox')).toBeNull();
  expect(within(dialog).queryByRole('button', { name: 'Підготувати редагування правил' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('edits the same restored draft only after the exact private definition has loaded, preserving the decision payload', async () => {
  readFamily = deferred(); entries = [policy({ reviewState: 'review_required' })];
  mount('/admin/catalog?category=BR&binding=draft&source=current&ruleDraft=private&review=policies');
  const dialog = await rules(); expect(within(dialog).queryByRole('combobox')).toBeNull();
  await act(async () => readFamily.resolve({ data: { id: 'private', draft: { definition } } }));
  const select = await within(dialog).findByRole('combobox');
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: 'authoritative_create_update' } });
  fireEvent.change(within(dialog).getByLabelText('Пояснення перевірки'), { target: { value: '  Перевірено поле  ' } });
  api.post.mockImplementation(async (url) => {
    if (url !== `${root}/bindings/draft/decision`) throw Error(`Unexpected POST ${url}`);
    revisions.draft = { ...draft, revision: '2' }; entries = [policy({ identity: 'authoritative_create_update' })];
    return { data: revisions.draft };
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Підтвердити', exact: true }));
  await waitFor(() => expect(within(dialog).getByRole('combobox').value).toBe('authoritative_create_update'));
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'До категорії' }).disabled).toBe(false));
  expect(api.post.mock.calls).toEqual([[`${root}/bindings/draft/decision`, { expectedRevision: '1', binding: policy().id, action: 'approve', acceptReview: true, reason: 'Перевірено поле', policy: 'authoritative_create_update' }]]);
});

it('explicit prepare preserves source CAS and original product scope, returns to the exact successor row and never checks impact', async () => {
  const query = new URLSearchParams({ category: 'BR', binding: 'current', source: 'current', review: 'policies', reviewEntry: policy().id, productId: '42' });
  const router = mount(`/admin/catalog?${query}`); const dialog = await rules();
  const action = await within(dialog).findByRole('button', { name: 'Підготувати редагування правил' });
  const pending = deferred();
  api.post.mockImplementation(async (url) => {
    if (url.endsWith('/successor/prepare')) return pending.promise;
    if (url.endsWith('/successor/apply')) { entries = [policy({ id: 'policy:new-opaque:en', reviewState: 'review_required' })]; return { data: draft }; }
    throw Error(`Unexpected POST ${url}`);
  });
  expect(api.post).not.toHaveBeenCalled(); fireEvent.click(action);
  await waitFor(() => expect(action.disabled).toBe(true));
  fireEvent.click(action); fireEvent.click(within(dialog).getByRole('button', { name: 'До категорії' }));
  expect(api.post).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ data: { previewToken: 'exact-successor-proof' } }));
  await within(dialog).findByRole('combobox');
  const request = { sourceId: 'current', expectedSourceRevision: '4', templateVersionId: 'version-current', productIds: [42] };
  expect(api.post.mock.calls).toEqual([[`${root}/successor/prepare`, request], [`${root}/successor/apply`, { ...request, previewToken: 'exact-successor-proof' }]]);
  expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toMatchObject({ binding: 'draft', review: 'policies', reviewField: 'description', language: 'english', reviewStore: 'en' });
  expect(new URLSearchParams(router.state.location.search).has('reviewEntry')).toBe(false);
  expect(await within(dialog).findByText('Рядок, відкритий за посиланням')).toBeTruthy();
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'До категорії' }).disabled).toBe(false));
  expect(screen.queryByRole('dialog', { name: 'Перевірка та застосування' })).toBeNull();
});

it('dirty field navigation offers Stay/Escape/Discard with one active focus trap and never saves the discarded input', async () => {
  const router = mount('/admin/catalog?category=BR&binding=current&source=current&language=english&field=description');
  const field = await screen.findByRole('dialog', { name: 'Поле Magento' });
  const input = await within(field).findByLabelText('Текст для магазину');
  const link = await within(field).findByRole('link', { name: 'Переглянути правило передавання' });
  await act(async () => fireEvent.change(input, { target: { value: 'Незбережений опис' } }));
  fireEvent.click(link);
  const prompt = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(new URLSearchParams(router.state.location.search).has('review')).toBe(false);
  fireEvent.keyDown(prompt, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Незбережені зміни' })).toBeNull());
  expect(screen.getByLabelText('Текст для магазину').value).toBe('Незбережений опис');
  fireEvent.click(link); fireEvent.click(within(await screen.findByRole('dialog', { name: 'Незбережені зміни' })).getByRole('button', { name: 'Залишитися' }));
  expect(screen.getByLabelText('Текст для магазину').value).toBe('Незбережений опис');
  fireEvent.click(link); fireEvent.click(within(await screen.findByRole('dialog', { name: 'Незбережені зміни' })).getByRole('button', { name: 'Відкинути й перейти' }));
  await rules(); expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
  await act(async () => router.navigate(-1));
  expect((await screen.findByLabelText('Текст для магазину')).value).toBe('Description EN');
  expect(screen.queryByRole('dialog', { name: 'Перевірка та застосування' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('dirty policy review cannot close or go Back without a decision to retain or discard input', async () => {
  const router = mount('/admin/catalog?category=BR&binding=draft&source=current&review=closed');
  fireEvent.click(await screen.findByText('Дані Magento та додаткові налаштування'));
  fireEvent.click(screen.getByRole('link', { name: 'Змінити поведінку передавання полів' }));
  const dialog = await rules();
  await act(async () => fireEvent.change(within(dialog).getByLabelText('Пояснення перевірки'), { target: { value: 'Незбережене пояснення' } }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'До категорії' }));
  const prompt = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.click(within(prompt).getByRole('button', { name: 'Залишитися' }));
  expect(within(dialog).getByLabelText('Пояснення перевірки').value).toBe('Незбережене пояснення');
  await act(async () => router.navigate(-1));
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Незбережені зміни' })).getByRole('button', { name: 'Відкинути й перейти' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(new URLSearchParams(router.state.location.search).get('review')).toBe('closed');
  expect(api.post).not.toHaveBeenCalled();
});

it.each(['wrong revision', 'ambiguous policies', 'missing policy'])('does not invent a field policy link for %s', async (problem) => {
  readField = deferred(); mount('/admin/catalog?category=BR&binding=current&source=current&language=english&field=description');
  const field = await screen.findByRole('dialog', { name: 'Поле Magento' }); await within(field).findByText('Читаємо поле…');
  await act(async () => readField.resolve({ data: { revision: problem === 'wrong revision' ? draft : active,
    entries: problem === 'missing policy' ? [] : problem === 'ambiguous policies' ? [policy(), policy({ id: 'second' })] : [policy()], options: [] } }));
  expect(within(field).queryByRole('link', { name: 'Переглянути правило передавання' })).toBeNull();
  expect(within(field).getByText(/Точне правило передавання/)).toBeTruthy(); expect(api.post).not.toHaveBeenCalled();
});

it('an exact field link preserves original field code separately from its policy target', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.includes('/categories/') && !url.includes('/fields/')) result.data.attributes[0].code = 'seo_column';
    return result;
  });
  mount('/admin/catalog?category=BR&binding=current&source=current&language=english&field=seo_column');
  const link = await screen.findByRole('link', { name: 'Переглянути правило передавання' });
  expect(Object.fromEntries(new URL(link.href).searchParams)).toMatchObject({ field: 'seo_column', reviewField: 'description', reviewEntry: policy().id });
  fireEvent.click(link); const dialog = await rules(); fireEvent.click(within(dialog).getByRole('button', { name: 'До поля' }));
  await screen.findByRole('dialog', { name: 'Поле Magento' });
  expect(api.get.mock.calls.filter(([url]) => url.includes('/fields/')).every(([url]) => url.endsWith('/seo_column'))).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

it('policy mode suppresses action-derived and repair-inferred editors while retaining their URL context', async () => {
  const get = api.get.getMockImplementation();
  api.get.mockImplementation(async (url, config) => {
    const result = await get(url, config);
    if (url.includes('/categories/')) result.data.questions = [{ id: 'color', label: 'Колір', options: [{ id: 0, label: 'Нуль' }], uses: [{ rowId: 'base', target: 'description' }] }];
    return result;
  });
  mount('/admin/catalog?category=BR&binding=current&source=current&review=policies&question=color&value=0&action=edit-question&field=description');
  await rules(); expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(api.get.mock.calls.some(([url]) => url.includes('/fields/'))).toBe(false);
  expect(api.post).not.toHaveBeenCalled();
});

it('a readonly binding read can be retried, and a mismatched retry cannot change the selected binding', async () => {
  const get = api.get.getMockImplementation(); let attempt = 0;
  api.get.mockImplementation(async (url, config) => {
    if (url.endsWith('/bindings/current')) {
      attempt++;
      if (attempt === 1) throw Error('Temporary fixture read failure');
      if (attempt === 2) return { data: binding(revisions.old) };
    }
    return get(url, config);
  });
  const router = mount();
  const retry = await screen.findByRole('button', { name: 'Перечитати підготовку' });
  expect(retry.disabled).toBe(false); fireEvent.click(retry);
  await screen.findByText('Не вдалося перечитати підготовку. Введення залишено у формі.');
  await waitFor(() => expect(retry.disabled).toBe(false));
  expect(new URLSearchParams(router.state.location.search).get('binding')).toBe('current');
  expect(api.get.mock.calls.some(([, config]) => config?.params?.bindingRevisionId === 'old')).toBe(false);
  fireEvent.click(retry); const dialog = await rules();
  expect(within(dialog).queryByRole('combobox')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('a late field response cannot replace the returned policy identity for the new language scope', async () => {
  const english = deferred(); const base = deferred(); const get = api.get.getMockImplementation();
  api.get.mockImplementation((url, config) => url.includes('/fields/') ? (config.params.rowId === 'english' ? english.promise : base.promise) : get(url, config));
  const router = mount('/admin/catalog?category=BR&binding=current&source=current&language=english&field=description');
  await screen.findByText('Читаємо поле…');
  await act(async () => router.navigate('/admin/catalog?category=BR&binding=current&source=current&language=base&field=description'));
  await screen.findByText('Читаємо поле…');
  const ua = policy({ id: 'policy:exact-ua:all', row: 'base', label: 'all' });
  await act(async () => base.resolve({ data: { revision: active, entries: [ua], options: [] } }));
  const link = await screen.findByRole('link', { name: 'Переглянути правило передавання' });
  expect(new URL(link.href).searchParams.get('reviewEntry')).toBe(ua.id);
  await act(async () => english.resolve({ data: { revision: active, entries: [policy()], options: [] } }));
  expect(new URL(link.href).searchParams.get('reviewEntry')).toBe(ua.id);
  expect(new URL(link.href).searchParams.get('language')).toBe('base');
  expect(api.post).not.toHaveBeenCalled();
});
