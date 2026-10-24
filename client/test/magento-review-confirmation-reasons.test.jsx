import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoWorkspaceReview from '../src/components/workspace/MagentoWorkspaceReview.jsx';
import MagentoBindingReview from '../src/components/workspace/MagentoBindingReview.jsx';
import MagentoCategoryWorkspace from '../src/components/workspace/MagentoCategoryWorkspace.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
const draft = { id: 'draft', state: 'draft', revision: '1', schema: { attributes: [], attributeSets: [] }, bindings: { attributes: [] } };
const entry = (extra = {}) => ({ id: 'policy:field:all', kind: 'policy', group: 'BR', routeKey: 'BR:all', row: 'base', target: 'product_online', label: 'all', identity: 'magento_managed', reviewState: 'review_required', exact: false, ...extra });
const exact = (extra = {}) => entry({ id: 'attribute:field', kind: 'attribute', target: 'kolir', label: 'Колір', identity: 'kolir', exact: true, ...extra });
const data = (entries, revision = draft) => ({ revision, entries, validation: { valid: false, diagnostics: [] } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function primary(entries, extra = {}, revision = draft) {
  api.get.mockResolvedValue({ data: data(entries, revision) });
  const callbacks = { onChanged: vi.fn(), onPendingChange: vi.fn(), onReadyChange: vi.fn() };
  const props = { revision: draft, categoryCode: 'BR', questions: [], selections: {}, ...callbacks, ...extra };
  return { ...render(<MagentoWorkspaceReview {...props} />), props, ...callbacks };
}
function advanced(entries, extra = {}, revision = draft, permissions = ['export_templates.manage']) {
  api.get.mockResolvedValue({ data: data(entries, revision) });
  const onChanged = vi.fn();
  return { ...render(<AuthContext.Provider value={{ permissions }}><MemoryRouter><MagentoBindingReview revision={revision} mode="review" onChanged={onChanged} {...extra} /></MemoryRouter></AuthContext.Provider>), onChanged };
}
function parent(state) {
  const published = { ...draft, id: 'published', state: 'published', templateVersionId: 'version' };
  const revision = { ...draft, templateVersionId: 'version', ...(state === 'retired' ? { catalogAvailability: { publicationBlocked: true, resources: [{ attributeCode: 'kolir', attributeId: '17', optionId: null }] } } : {}) };
  const category = { code: 'BR', name: 'Браслети', unboundCount: 0, operational: { count: 0 } };
  const definition = { evaluatorVersion: 'magento-declarative-4', outputContract: 'magento-products-columns-v2', sources: {}, tables: {}, bindings: [], groups: [{ route: 'BR', columns: ['product_online'], rows: [{ id: 'base', cells: { product_online: { op: 'literal', value: '2' } } }, { id: 'english', cells: { product_online: { op: 'literal', value: '' } } }] }] };
  const projection = (value) => ({ category, revision: value, template: { definition }, groupIndex: 0, rowIndex: 0, routeKey: 'BR:all', routes: [{ routeKey: 'BR:all', setName: 'Прикраси' }], attributes: [], questions: [], observedAt: null });
  const finalRead = state === 'busy' ? deferred() : null;
  api.get.mockImplementation(async (url, config) => {
    if (url === '/admin/magento-integration/categories/BR' && config?.params?.bindingRevisionId === 'draft' && finalRead) return finalRead.promise;
    if (url === '/admin/magento-integration/categories/BR') return { data: projection(config?.params?.bindingRevisionId === 'draft' ? revision : published) };
    if (url === '/admin/export-templates/sources') return { data: { productFields: [], references: { questions: [], schemas: [] } } };
    if (url === '/admin/magento-integration/bindings/draft') return { data: data([entry()], revision) };
    throw new Error(`Unexpected GET ${url}`);
  });
  if (state === 'busy') api.post.mockImplementation(async (url) => {
    if (url === '/admin/magento-integration/successor/prepare') return { data: { previewToken: 'reviewed-successor' } };
    if (url === '/admin/magento-integration/successor/apply') return { data: revision };
    throw new Error(`Unexpected POST ${url}`);
  });
  const router = createMemoryRouter([{ path: '/admin/catalog', element: <MagentoCategoryWorkspace categories={[category]} activePublication={state === 'stale' ? { ...published, id: 'new-publication' } : published} onPublished={vi.fn()} /> }], { initialEntries: [state === 'busy' ? '/admin/catalog?category=BR' : '/admin/catalog?category=BR&binding=draft&source=published'] });
  render(<AuthContext.Provider value={{ permissions: state === 'permission' ? ['export_templates.view'] : ['export_templates.view', 'export_templates.manage', ...(state === 'busy' ? ['export_templates.publish', 'exports.view'] : [])], principalLifetime: { valid: state !== 'expired' }, roles: [] }}><RouterProvider router={router} /></AuthContext.Provider>);
  return { finishRead: () => finalRead.resolve({ data: projection(revision) }) };
}
function hint(button) {
  const id = button.getAttribute('aria-describedby');
  expect(id).toBeTypeOf('string');
  const node = document.getElementById(id);
  expect(node).not.toBeNull(); expect(node.hidden).toBe(false);
  return node;
}
function reason(value) { fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value } }); }
async function completed(view, revision) {
  await waitFor(() => expect(view.onChanged).toHaveBeenCalledWith(expect.objectContaining({ revision })));
  if (view.onPendingChange) await waitFor(() => expect(view.onPendingChange).toHaveBeenLastCalledWith(false));
}
beforeEach(() => { vi.resetAllMocks(); api.post.mockRejectedValue(new Error('Unexpected POST')); api.put.mockRejectedValue(new Error('Unexpected PUT')); });
afterEach(cleanup);

it('explains explicit policy choice and three-character reason beside the single action without changing its payload', async () => {
  const view = primary([entry()]);
  const button = await screen.findByRole('button', { name: 'Підтвердити' });
  expect(button.disabled).toBe(true); expect(hint(button).textContent).toBe('Оберіть поведінку поля.');
  const input = screen.getByLabelText('Пояснення перевірки');
  expect(input.closest('td')).toBe(button.closest('td'));
  expect(hint(button).closest('td')).toBe(button.closest('td'));
  expect(screen.getAllByLabelText('Пояснення перевірки')).toHaveLength(1);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'initialize_create_only' } });
  expect(hint(button).textContent).toContain('щонайменше 3 символи');
  reason(' аб '); expect(button.disabled).toBe(true);
  reason(' абв '); expect(button.disabled).toBe(false); expect(button.getAttribute('aria-describedby')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  const pending = deferred(); api.post.mockImplementationOnce(() => pending.promise);
  fireEvent.click(button);
  expect(button.disabled).toBe(true); expect(hint(button).textContent).toBe('Дія виконується. Дочекайтеся результату.');
  fireEvent.click(button); expect(api.post).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ data: { ...draft, revision: '2' } })); await completed(view, '2');
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/draft/decision', { expectedRevision: '1', binding: 'policy:field:all', action: 'approve', acceptReview: true, reason: 'абв', policy: 'initialize_create_only', createValue: '2' });
});

it('identifies a saved unchanged policy before asking for reason and preserves explicit changed-policy approval', async () => {
  primary([entry({ reviewState: 'approved' })]);
  await screen.findByText('Усі необхідні відповідності підтверджено.');
  fireEvent.click(screen.getByText('Поведінка передавання полів'));
  fireEvent.click(await screen.findByRole('button', { name: 'Змінити поведінку підключених полів' }));
  const button = screen.getByRole('button', { name: 'Підтвердити' });
  expect(hint(button).textContent).toContain('Це рішення вже збережено');
  reason('Перевірено'); expect(button.disabled).toBe(true); expect(hint(button).textContent).toContain('Це рішення вже збережено');
  fireEvent.click(button); expect(api.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'authoritative_create_update' } });
  expect(button.disabled).toBe(false); expect(button.getAttribute('aria-describedby')).toBeNull();
});

it('keeps exact non-policy approval enabled without a reason or misleading disabled explanation', async () => {
  const view = primary([exact()]);
  const button = await screen.findByRole('button', { name: 'Підтвердити' });
  expect(button.disabled).toBe(false); expect(button.getAttribute('aria-describedby')).toBeNull();
  expect(screen.queryByLabelText('Пояснення перевірки')).toBeNull();
  api.post.mockResolvedValue({ data: { ...draft, revision: '2' } }); fireEvent.click(button); await completed(view, '2');
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/draft/decision', { expectedRevision: '1', binding: 'attribute:field', action: 'approve', acceptReview: true });
});

it('requires the original reason after changing a semantic-zero option and preserves select then decision CAS', async () => {
  const option = exact({ id: 'option:field:zero', kind: 'option', source: 'BR.color=value_id:0', evaluated: 'Нуль', identity: '10' });
  const revision = { ...draft, bindings: { attributes: [{ bindingKey: 'field', attributeCode: 'kolir' }] }, schema: { attributes: [{ attribute_code: 'kolir', options: [{ value: '10', label: 'Нуль' }, { value: '20', label: 'Інше' }] }], attributeSets: [] } };
  const view = primary([option], {}, revision);
  const button = await screen.findByRole('button', { name: 'Підтвердити' }); expect(button.disabled).toBe(false);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '20' } });
  expect(hint(button).textContent).toContain('щонайменше 3 символи'); reason('ab'); expect(button.disabled).toBe(true);
  reason(' abc '); api.post.mockResolvedValueOnce({ data: { ...revision, revision: '2' } }).mockResolvedValueOnce({ data: { ...revision, revision: '3' } });
  fireEvent.click(button); await completed(view, '3');
  expect(api.post.mock.calls).toEqual([
    ['/admin/magento-integration/bindings/draft/select', { expectedRevision: '1', binding: option.id, identity: '20' }],
    ['/admin/magento-integration/bindings/draft/decision', { expectedRevision: '2', binding: option.id, action: 'approve', acceptReview: true, reason: 'abc' }],
  ]);
});

it('explains a missing readonly attribute identity without recommending a nonexistent selector', async () => {
  primary([exact({ identity: null, exact: false })]);
  const button = await screen.findByRole('button', { name: 'Підтвердити' });
  expect(button.disabled).toBe(true); expect(screen.queryByRole('combobox')).toBeNull();
  expect(hint(button).textContent).toBe('Відповідність Magento ще не визначена. Перевірте налаштування поля.');
  reason('Перевірено'); fireEvent.click(button); expect(api.post).not.toHaveBeenCalled();
});

it.each([false, true])('recommends a primary selection only when actual category candidates exist (%s)', async (hasCandidates) => {
  primary([entry({ id: 'category:field:path', kind: 'category', target: 'categories', identity: null, candidates: hasCandidates ? [{ categoryId: '12', path: 'Default/Браслети' }] : [] })]);
  const button = await screen.findByRole('button', { name: 'Підтвердити' });
  const select = screen.getByRole('combobox');
  expect(hint(button).textContent).toBe(hasCandidates ? 'Оберіть відповідність Magento.' : 'Відповідність Magento ще не визначена. Перевірте налаштування поля.');
  expect(within(select).getAllByRole('option')).toHaveLength(hasCandidates ? 2 : 1);
  reason('abc'); expect(button.disabled).toBe(true);
  if (hasCandidates) { fireEvent.change(select, { target: { value: '12' } }); expect(button.disabled).toBe(false); }
  expect(api.post).not.toHaveBeenCalled();
});

it('keeps one shared input for multiple rows and counts only currently unready shown decisions', async () => {
  const view = primary([exact(), entry()]);
  const bulk = await screen.findByRole('button', { name: 'Підтвердити показані відповідності' });
  const input = screen.getByLabelText('Пояснення перевірки');
  expect(screen.getAllByLabelText('Пояснення перевірки')).toHaveLength(1); expect(input.closest('td')).toBeNull();
  expect(screen.getByText('Одне пояснення для показаних відповідностей.')).not.toBeNull();
  expect(hint(bulk).textContent).toContain('Не готові до підтвердження рядки: 1');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'magento_managed' } }); reason('abc');
  expect(bulk.disabled).toBe(false); expect(bulk.getAttribute('aria-describedby')).toBeNull();
  api.post.mockResolvedValueOnce({ data: { ...draft, revision: '2' } }).mockResolvedValueOnce({ data: { ...draft, revision: '3' } });
  fireEvent.click(bulk); await completed(view, '3');
  expect(api.post.mock.calls.map(([, body]) => [body.binding, body.expectedRevision])).toEqual([['attribute:field', '1'], ['policy:field:all', '2']]);
});

it('does not count off-page blockers as a reason to disable current-page confirmation', async () => {
  const view = primary([...Array.from({ length: 30 }, (_, index) => exact({ id: `attribute:${index}` })), entry()]);
  const bulk = await screen.findByRole('button', { name: 'Підтвердити показані відповідності' });
  expect(bulk.disabled).toBe(false); expect(bulk.getAttribute('aria-describedby')).toBeNull();
  expect(view.onReadyChange).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole('button', { name: 'Далі' }));
  const button = screen.getByRole('button', { name: 'Підтвердити' }); expect(hint(button).textContent).toBe('Оберіть поведінку поля.');
  expect(screen.getByLabelText('Пояснення перевірки').closest('td')).toBe(button.closest('td')); expect(api.post).not.toHaveBeenCalled();
});

it.each([['', 'Підтвердження тимчасово недоступне.'], ['Потрібна нова перевірка.', 'Потрібна нова перевірка.']])('uses the actual external disabled reason or an honest fallback (%s)', async (disabledReason, expected) => {
  primary([entry()], { disabled: true, disabledReason });
  const button = await screen.findByRole('button', { name: 'Підтвердити' });
  expect(hint(button).textContent).toBe(expected); expect(button.disabled).toBe(true); fireEvent.click(button); expect(api.post).not.toHaveBeenCalled();
});

it('uses neutral busy wording during a reread and preserves the existing stale-handler refusal', async () => {
  const view = primary([exact()], {}, { ...draft, revision: '2' });
  const button = await screen.findByRole('button', { name: 'Підтвердити' });
  expect(button.disabled).toBe(false); expect(button.getAttribute('aria-describedby')).toBeNull();
  fireEvent.click(button); expect(api.post).not.toHaveBeenCalled();
  const pending = deferred(); api.get.mockImplementationOnce(() => pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Перечитати підготовку' }));
  expect(hint(button).textContent).toBe('Дія виконується. Дочекайтеся результату.');
  await act(async () => pending.resolve({ data: data([exact()]) })); await completed(view, '1');
  expect(button.disabled).toBe(false); expect(button.getAttribute('aria-describedby')).toBeNull(); expect(api.post).not.toHaveBeenCalled();
});

it('retains advanced nonempty-only validation, raw reason, busy protection and exact approval body', async () => {
  const view = advanced([entry()]); const button = await screen.findByRole('button', { name: 'Підтвердити зв’язок' });
  expect(hint(button).textContent).toBe('Додайте пояснення перевірки.'); reason('  '); expect(button.disabled).toBe(true);
  reason(' a '); expect(button.disabled).toBe(false); expect(button.getAttribute('aria-describedby')).toBeNull(); expect(api.post).not.toHaveBeenCalled();
  const pending = deferred(); api.post.mockImplementationOnce(() => pending.promise); fireEvent.click(button);
  expect(hint(button).textContent).toBe('Дія виконується. Дочекайтеся результату.'); fireEvent.click(button); expect(api.post).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ data: { ...draft, revision: '2' } })); await completed(view, '2');
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/draft/decision', { expectedRevision: '1', binding: 'policy:field:all', action: 'approve', acceptReview: true, reason: ' a ', policy: 'magento_managed' });
});

it('does not invent an advanced approved-unchanged prohibition', async () => {
  const view = advanced([entry({ reviewState: 'approved' })], { field: 'product_online' });
  const button = await screen.findByRole('button', { name: 'Підтвердити зв’язок' }); expect(hint(button).textContent).toBe('Додайте пояснення перевірки.');
  expect(screen.queryByText(/Повторне підтвердження не потрібне/)).toBeNull(); reason('x'); expect(button.disabled).toBe(false);
  api.post.mockResolvedValue({ data: { ...draft, revision: '2' } }); fireEvent.click(button); await completed(view, '2');
  await waitFor(() => expect(button.disabled).toBe(false)); expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post.mock.calls[0][1]).toMatchObject({ binding: 'policy:field:all', policy: 'magento_managed', reason: 'x' });
});

it.each([true, false])('explains missing advanced identity using only available candidate actions (%s)', async (hasCandidates) => {
  const revision = { ...draft, schema: { ...draft.schema, attributeSets: hasCandidates ? [{ attribute_set_id: 151, attribute_set_name: 'Прикраси' }] : [] } };
  advanced([entry({ id: 'route:BR:all', kind: 'route', identity: null })], {}, revision);
  const button = await screen.findByRole('button', { name: 'Підтвердити зв’язок' });
  expect(hint(button).textContent).toBe(hasCandidates ? 'Оберіть кандидата й натисніть «Вибрати кандидата».' : 'Відповідність Magento ще не визначена. Перевірте налаштування поля.');
  reason('a');
  if (hasCandidates) { fireEvent.change(screen.getByLabelText('Кандидат'), { target: { value: '151' } }); expect(screen.getByRole('button', { name: 'Вибрати кандидата' }).disabled).toBe(false); }
  else expect(screen.queryByRole('button', { name: 'Вибрати кандидата' })).toBeNull();
  expect(button.disabled).toBe(true); fireEvent.click(button); expect(api.post).not.toHaveBeenCalled();
});

it('explains an unsupported advanced policy before the missing explanation without selecting a default', async () => {
  advanced([entry({ identity: 'future_policy' })]);
  const button = await screen.findByRole('button', { name: 'Підтвердити зв’язок' }); expect(hint(button).textContent).toBe('Оберіть поведінку поля.');
  expect(screen.getByLabelText('Доставка поля').value).toBe(''); reason('a'); expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Доставка поля'), { target: { value: 'magento_managed' } }); expect(button.disabled).toBe(false); expect(api.post).not.toHaveBeenCalled();
});

it('does not recommend selecting an advanced option while its missing evaluated value prevents that action', async () => {
  const option = entry({ id: 'option:field:zero', kind: 'option', identity: null, evaluated: '' });
  const revision = { ...draft, bindings: { attributes: [{ bindingKey: 'field', attributeCode: 'kolir' }] }, schema: { attributeSets: [], attributes: [{ attribute_code: 'kolir', options: [{ value: '10', label: 'Нуль' }] }] } };
  advanced([option], {}, revision);
  const button = await screen.findByRole('button', { name: 'Підтвердити зв’язок' });
  expect(hint(button).textContent).toBe('Відповідність Magento ще не визначена. Перевірте налаштування поля.');
  fireEvent.change(screen.getByLabelText('Кандидат'), { target: { value: '10' } }); reason('a');
  const select = screen.getByRole('button', { name: 'Вибрати кандидата' });
  expect(select.disabled).toBe(true); expect(button.disabled).toBe(true); fireEvent.click(select); fireEvent.click(button); expect(api.post).not.toHaveBeenCalled();
});

it('keeps advanced exact non-policy confirmation available without explanation', async () => {
  advanced([exact()]); const button = await screen.findByRole('button', { name: 'Підтвердити зв’язок' });
  expect(button.disabled).toBe(false); expect(button.getAttribute('aria-describedby')).toBeNull(); expect(api.post).not.toHaveBeenCalled();
});

it.each(['permission', 'published', 'retired'])('retains the advanced %s presentation gate without adding a disabled action', async (state) => {
  advanced([entry()], {}, { ...draft, state: state === 'published' ? 'published' : 'draft', ...(state === 'retired' ? { catalogAvailability: { publicationBlocked: true } } : {}) }, state === 'permission' ? [] : ['export_templates.manage']);
  await screen.findByText('Невирішених структурних питань: 0');
  expect(screen.queryByRole('button', { name: 'Підтвердити зв’язок' })).toBeNull(); expect(screen.queryByLabelText('Пояснення перевірки')).toBeNull(); expect(api.post).not.toHaveBeenCalled();
});

it.each([
  ['permission', 'Підтвердження недоступне для вашого поточного доступу.'],
  ['expired', 'Підтвердження недоступне для вашого поточного доступу.'],
  ['stale', 'Чинні правила змінилися. Потрібна нова перевірка підготовки.'],
  ['retired', 'Підготовка посилається на видалені ресурси Magento. Підготуйте нову від чинної публікації.'],
])('gets the exact %s explanation from the actual category workspace without new commands', async (state, expected) => {
  parent(state); const dialog = await screen.findByRole('dialog', { name: 'Перевірка та застосування' });
  const button = await within(dialog).findByRole('button', { name: 'Підтвердити' });
  expect(button.disabled).toBe(true); expect(hint(button).textContent).toBe(expected);
  expect(hint(button).closest('td')).toBe(button.closest('td')); fireEvent.click(button);
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
});

it('does not turn the actual parent reviewPending state into an external approval prohibition', async () => {
  parent('active'); const dialog = await screen.findByRole('dialog', { name: 'Перевірка та застосування' });
  const button = await within(dialog).findByRole('button', { name: 'Підтвердити' });
  fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'magento_managed' } }); reason('abc');
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'До редагування' }).disabled).toBe(true));
  expect(button.disabled).toBe(false); expect(button.getAttribute('aria-describedby')).toBeNull();
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
});

it('explains actual parent preparation busy state until its final category read completes', async () => {
  const view = parent('busy');
  fireEvent.click(await screen.findByText('Дані Magento та додаткові налаштування'));
  fireEvent.click(await screen.findByRole('button', { name: 'Змінити поведінку передавання полів' }));
  const dialog = await screen.findByRole('dialog', { name: 'Перевірка та застосування' });
  const button = await within(dialog).findByRole('button', { name: 'Підтвердити' });
  expect(button.disabled).toBe(true); expect(hint(button).textContent).toBe('Дія виконується. Дочекайтеся результату.');
  fireEvent.click(button); expect(api.post).toHaveBeenCalledTimes(2);
  await act(async () => view.finishRead());
  await waitFor(() => expect(hint(button).textContent).toBe('Оберіть поведінку поля.'));
  const request = { sourceId: 'published', expectedSourceRevision: '1', templateVersionId: 'version' };
  expect(api.post.mock.calls).toEqual([
    ['/admin/magento-integration/successor/prepare', request],
    ['/admin/magento-integration/successor/apply', { ...request, previewToken: 'reviewed-successor' }],
  ]);
  expect(api.put).not.toHaveBeenCalled();
});
