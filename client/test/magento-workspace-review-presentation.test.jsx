import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { deliveryPolicies } from '../src/lib/magento-category-workspace.js';
import MagentoWorkspaceReview from '../src/components/workspace/MagentoWorkspaceReview.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const revision = { id: 'review-draft', revision: '1', schema: { attributes: [], attributeSets: [] }, bindings: { attributes: [] } };
const policy = (id, target = 'name', extra = {}) => ({ id, kind: 'policy', target, group: 'BR', routeKey: 'BR:all', row: 'base', label: 'all', identity: 'magento_managed', reviewState: 'review_required', exact: false, ...extra });
const attribute = (id, target, extra = {}) => ({ ...policy(id, target), kind: 'attribute', label: target, identity: target, exact: true, ...extra });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function setup(entries, props = {}, snapshot = revision) {
  api.get.mockResolvedValue({ data: { revision: snapshot, entries, validation: { diagnostics: [] } } });
  const callbacks = { onChanged: vi.fn(), onReadyChange: vi.fn(), onPendingChange: vi.fn(), onScopeChange: vi.fn() };
  render(<MagentoWorkspaceReview revision={revision} categoryCode="BR" categories={[{ code: 'BR', name: 'Браслети' }]} questions={[]} selections={{}} {...callbacks} {...props} />);
  return callbacks;
}
async function table() { return screen.findByRole('table'); }
function decisionRows() { return within(screen.getByRole('table')).getAllByRole('row').filter((row) => within(row).queryByRole('button', { name: 'Підтвердити' })); }
function description(element) { return element.getAttribute('aria-describedby').split(' ').map((id) => document.getElementById(id).textContent).join(' '); }
function search(value) { fireEvent.change(screen.getByRole('searchbox', { name: 'Пошук поля або значення' }), { target: { value } }); }
beforeEach(() => { vi.resetAllMocks(); api.post.mockRejectedValue(new Error('Unexpected write')); });
afterEach(cleanup);

it('separates language from Ukrainian field labels, groups rows, and retains technical and route/store identities', async () => {
  setup([policy('seo', 'meta_title'), policy('price', 'price'), policy('color', 'kolir'), policy('status', 'product_online'), policy('english', 'meta_title', { row: 'english', label: 'en', routeKey: 'BR.color=value_id:0' })], {}, { ...revision, schema: { ...revision.schema, attributes: [{ attribute_code: 'meta_title', default_frontend_label: 'Meta Title' }] } });
  const grid = await table();
  expect(screen.getByRole('table', { name: 'Підготовлені відповідності' })).toBe(grid);
  expect(within(grid).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Поле / значення менеджера', 'Мова', 'Відповідність Magento', 'Підтвердження']);
  expect(within(grid).getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['Назви та SEO', 'Ціна', 'Характеристики', 'Службові']);
  const bodies = [...grid.querySelectorAll('tbody')];
  expect(bodies.map((body) => [within(body).getByRole('rowheader').textContent, within(body).getAllByRole('button', { name: 'Підтвердити' }).length]))
    .toEqual([['Назви та SEO', 2], ['Ціна', 1], ['Характеристики', 1], ['Службові', 1]]);
  expect(bodies.every((body) => body.firstElementChild.firstElementChild.getAttribute('scope') === 'rowgroup')).toBe(true);
  const rows = decisionRows();
  expect((within(rows[0]).getAllByRole('cell')[0]).textContent).toContain('SEO заголовок');
  expect((within(rows[0]).getAllByRole('cell')[0]).textContent).not.toContain('· UA');
  expect((within(rows[0]).getAllByRole('cell')[1]).textContent).toMatch(/^UA$/);
  expect((within(rows[1]).getAllByRole('cell')[1]).textContent).toMatch(/^EN$/);
  expect((rows[1]).textContent).toContain('meta_title');
  const selects = within(grid).getAllByRole('combobox');
  expect(new Set(selects.map((select) => select.id)).size).toBe(selects.length);
  expect(description(selects[1])).toMatch(/BR.color=value_id:0.*en/);
  expect(api.post).not.toHaveBeenCalled();
});

it('preserves observed custom labels including prototype-like codes, semantic zero, historical values, and category paths', async () => {
  const questions = [{ id: 'color', label: 'Колір', options: [{ id: 0, label: 'Нуль' }] }];
  setup([policy('custom', 'constructor'), policy('unknown', 'unobserved_field'), { ...attribute('zero', 'kolir'), kind: 'option', source: 'BR.color=value_id:0', evaluated: '0' }, { ...attribute('old', 'kolir'), kind: 'option', source: 'BR.color=value_id:9', evaluated: '' }, { ...attribute('category', 'categories'), kind: 'category', evaluated: 'Default/Прикраси/Браслети', candidates: [] }], { questions }, { ...revision, schema: { ...revision.schema, attributes: [{ attribute_code: 'constructor', default_frontend_label: 'Власна характеристика' }] } });
  const grid = await table();
  expect((grid).textContent).toContain('Власна характеристика');
  expect((grid).textContent).not.toContain('function Object');
  expect((grid).textContent).toContain('Колір: Нуль');
  expect((grid).textContent).toContain('Невідоме локальне значення (ID 9)');
  expect((grid).textContent).toContain('Default/Прикраси/Браслети');
  const fallbackCell = within(screen.getByRole('combobox', { name: 'Відповідність: unobserved_field · UA' }).closest('tr')).getAllByRole('cell')[0];
  expect(fallbackCell.textContent.match(/unobserved_field/g)).toHaveLength(1); expect(fallbackCell.querySelector('code')).toBeNull();
});

it('filters by actual row language while keeping shared routes and explicitly unknown language', async () => {
  setup([attribute('ua', 'ua'), attribute('en', 'en', { row: 'english', label: 'not-a-language' }), attribute('unknown', 'unknown', { row: undefined }), { ...attribute('route', 'attribute_set_code', { row: undefined, evaluated: 'Прикраси' }), kind: 'route' }]);
  await table();
  expect(screen.getByText('Спільне')).not.toBeNull(); expect(screen.getByText('Не визначено')).not.toBeNull();
  fireEvent.change(screen.getByRole('combobox', { name: 'Мова' }), { target: { value: 'EN' } });
  expect(decisionRows()).toHaveLength(2); expect(decisionRows()[0].textContent).toContain('en'); expect(decisionRows()[1].textContent).toContain('Прикраси');
  fireEvent.change(screen.getByRole('combobox', { name: 'Мова' }), { target: { value: 'UA' } });
  expect(decisionRows()).toHaveLength(2); expect(decisionRows()[0].textContent).toContain('ua');
  expect(api.get).toHaveBeenCalledTimes(1); expect(api.post).not.toHaveBeenCalled();
});

it('keeps complete unresolved scope and readiness when search hides blockers and names the limited search scope', async () => {
  const entries = [policy('visible'), policy('other-category', 'price', { group: 'OT' })];
  const callbacks = setup(entries);
  await table(); search('немає збігів');
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.getByText(/За цими фільтрами немає відповідностей/)).not.toBeNull();
  expect(screen.getByText(/Пошук у поточному переліку невирішених відповідностей/)).not.toBeNull();
  expect(screen.getByText(/Підтверджені правила передавання відкриваються/)).not.toBeNull();
  expect(callbacks.onReadyChange).toHaveBeenLastCalledWith(false);
  expect(callbacks.onScopeChange).toHaveBeenLastCalledWith({ unresolved: entries });
  expect(screen.getByText(/Залишилося підтвердити: 2/)).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Скинути пошук і мову' }));
  expect(decisionRows()).toHaveLength(1); expect(api.get).toHaveBeenCalledTimes(1);
});

it('offers the existing explicit approved-policy toggle even when search has no unresolved match', async () => {
  setup([policy('unresolved', 'price'), policy('approved', 'meta_title', { reviewState: 'approved' })]);
  await table(); search('meta_title');
  expect(screen.queryByRole('table')).toBeNull();
  fireEvent.click(screen.getByText('Поведінка передавання полів'));
  fireEvent.click(await screen.findByRole('button', { name: 'Змінити поведінку підключених полів' }));
  expect((await table()).textContent).toContain('SEO заголовок');
  expect((screen.getByRole('button', { name: 'Підтвердити' })).disabled).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

it('searches Ukrainian names, technical codes, and exact local option labels without reading again', async () => {
  setup([policy('seo', 'meta_title'), policy('color', 'kolir'), { ...attribute('zero', 'kolir'), kind: 'option', source: 'BR.color=value_id:0' }], { questions: [{ id: 'color', label: 'Колір', options: [{ id: 0, label: 'Нуль' }] }] }, { ...revision, schema: { ...revision.schema, attributes: [{ attribute_code: 'meta_title', default_frontend_label: 'Meta Title' }] } });
  await table();
  for (const query of [' SEO ЗАГОЛОВОК ', 'meta_title', 'Meta Title', 'Нуль']) { search(query); expect(decisionRows()).toHaveLength(1); }
  expect((decisionRows()[0]).textContent).toContain('Нуль'); expect(api.get).toHaveBeenCalledTimes(1);
});

it('synchronizes both pagers over exactly 30 decisions and resets the page when filters change', async () => {
  setup(Array.from({ length: 61 }, (_, index) => attribute(`row-${index}`, `field_${index}`)));
  await table();
  const top = screen.getByRole('navigation', { name: 'Сторінки перевірки — зверху' });
  const bottom = screen.getByRole('navigation', { name: 'Сторінки перевірки — знизу' });
  expect(decisionRows()).toHaveLength(30); expect(top.textContent).toContain('1 / 3'); expect(bottom.textContent).toContain('1 / 3');
  fireEvent.click(within(top).getByRole('button', { name: 'Далі' }));
  expect((decisionRows()[0]).textContent).toContain('field_30'); expect((bottom).textContent).toContain('2 / 3');
  fireEvent.click(within(bottom).getByRole('button', { name: 'Далі' }));
  expect(decisionRows()).toHaveLength(1); expect(decisionRows()[0].textContent).toContain('field_60'); expect(top.textContent).toContain('3 / 3');
  expect((within(top).getByRole('button', { name: 'Далі' })).disabled).toBe(true);
  search('field_0'); expect(decisionRows()).toHaveLength(1); expect(decisionRows()[0].textContent).toContain('field_0');
  expect(screen.queryByRole('navigation', { name: 'Сторінки перевірки — зверху' })).toBeNull();
  search(''); expect(decisionRows()).toHaveLength(30); expect(screen.getByRole('navigation', { name: 'Сторінки перевірки — зверху' }).textContent).toContain('1 / 3');
});

it('keeps the exact semantic-zero repair on the first page even when its normal group sorts last', async () => {
  setup([...Array.from({ length: 61 }, (_, index) => policy(`name-${index}`, 'name')), { ...attribute('repair', 'kolir'), kind: 'option', source: 'BR.color=value_id:0', evaluated: 'Нуль' }], { repairContext: { question: 'color', value: '0' } });
  await table(); expect(decisionRows()[0].textContent).toContain('Нуль'); expect(decisionRows()[0].classList.contains('is-repair-target')).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

it('shows the full current selected label and preserves choices/reason through search and language changes', async () => {
  const changed = setup([policy('policy', 'product_online')]);
  await table();
  const select = screen.getByRole('combobox', { name: 'Відповідність: Статус публікації товару · UA' });
  expect(within(select).getAllByRole('option').map((option) => option.value)).toEqual(['', ...Object.keys(deliveryPolicies)]);
  expect(description(select)).toMatch(/Оберіть явно/);
  fireEvent.change(select, { target: { value: 'initialize_create_only' } });
  expect(description(select)).toMatch(new RegExp(deliveryPolicies.initialize_create_only));
  fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: '  Перевірено створення  ' } });
  search('hidden'); fireEvent.change(screen.getByRole('combobox', { name: 'Мова' }), { target: { value: 'EN' } });
  fireEvent.click(screen.getByRole('button', { name: 'Скинути пошук і мову' }));
  expect((screen.getByRole('combobox', { name: 'Відповідність: Статус публікації товару · UA' })).value).toBe('initialize_create_only');
  expect((screen.getByLabelText('Пояснення перевірки')).value).toBe('  Перевірено створення  ');
  api.post.mockResolvedValue({ data: { ...revision, revision: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити' }));
  await waitFor(() => expect(changed.onChanged).toHaveBeenCalledWith(expect.objectContaining({ revision: '2' })));
  await waitFor(() => expect(changed.onPendingChange).toHaveBeenLastCalledWith(false));
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/bindings/review-draft/decision', { expectedRevision: '1', binding: 'policy', action: 'approve', acceptReview: true, reason: 'Перевірено створення', policy: 'initialize_create_only', createValue: '2' });
});

it('exposes a long selected category path as wrapping associated text, following selection rather than saved identity', async () => {
  const path = 'Default/Дуже довга назва розділу прикрас/Браслети з натурального бурштину';
  setup([{ ...attribute('category', 'categories'), kind: 'category', evaluated: 'Розміщення', identity: '1', candidates: [{ categoryId: '1', path }, { categoryId: '2', path: 'Default/Інші прикраси' }] }]);
  await table(); const select = screen.getByRole('combobox', { name: 'Відповідність: Розміщення' });
  expect(description(select)).toMatch(new RegExp(path));
  const selectedText = document.getElementById(select.getAttribute('aria-describedby').split(' ')[1]);
  expect(selectedText.classList.contains('mc-review-selected')).toBe(true); expect(selectedText.textContent).toContain(path);
  fireEvent.change(select, { target: { value: '2' } }); expect((selectedText).textContent).toContain('Default/Інші прикраси'); expect((selectedText).textContent).not.toContain(path);
});

it('approves only the filtered visible page with sequential CAS and retains the saved prefix on refusal', async () => {
  const callbacks = setup(Array.from({ length: 35 }, (_, index) => attribute(`item-${index}`, `visible_${index}`)).concat(attribute('hidden', 'hidden')));
  await table(); search('visible_');
  const pending = deferred();
  api.post.mockResolvedValueOnce({ data: { ...revision, revision: '2' } }).mockImplementationOnce(() => pending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити показані відповідності' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(api.post.mock.calls.map(([, body]) => [body.binding, body.expectedRevision])).toEqual([['item-0', '1'], ['item-1', '2']]);
  expect((screen.getByRole('searchbox')).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Підтвердити показані відповідності' })).disabled).toBe(true);
  await act(async () => pending.resolve(Promise.reject({ response: { data: { error: 'Стан змінився' } } })));
  expect(await screen.findByText('Стан змінився')).not.toBeNull();
  expect(callbacks.onChanged).toHaveBeenCalledWith(expect.objectContaining({ revision: '2' }));
  expect(api.post).toHaveBeenCalledTimes(2);
});

it('limits exact-suggestion approval to the final visible page, excluding off-page policy decisions', async () => {
  const rows = Array.from({ length: 32 }, (_, index) => attribute(`item-${index}`, `field_${index}`));
  const callbacks = setup(rows.concat(policy('policy', 'price')));
  await table(); fireEvent.click(within(screen.getByRole('navigation', { name: 'Сторінки перевірки — зверху' })).getByRole('button', { name: 'Далі' }));
  const shown = decisionRows().map((row) => within(row).getAllByRole('cell')[0].textContent);
  expect(shown).toEqual(expect.arrayContaining([expect.stringContaining('field_29'), expect.stringContaining('field_31')]));
  api.post.mockImplementation(async (_url, body) => ({ data: { ...revision, revision: String(Number(body.expectedRevision) + 1) } }));
  fireEvent.click(screen.getByText('Однозначні підказки'));
  fireEvent.click(await screen.findByRole('button', { name: 'Прийняти однозначні підказки на цій сторінці' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalledWith(expect.objectContaining({ revision: '4' })));
  await waitFor(() => expect(callbacks.onPendingChange).toHaveBeenLastCalledWith(false));
  expect(api.post.mock.calls.map(([, body]) => [body.binding, body.expectedRevision])).toEqual([['item-29', '1'], ['item-30', '2'], ['item-31', '3']]);
});

it('identifies same-language duplicate field labels by visible route/store context and separate stable controls', async () => {
  setup([policy('first', 'name', { routeKey: 'BR.color=value_id:0' }), policy('second', 'name', { routeKey: 'BR.color=value_id:1', label: 'custom' })]);
  await table(); const selects = screen.getAllByRole('combobox', { name: 'Відповідність: Назва товару · UA' });
  expect(selects).toHaveLength(2); expect(selects[0].id).not.toBe(selects[1].id);
  expect(description(selects[0])).toMatch(/BR.color=value_id:0.*all/);
  expect(description(selects[1])).toMatch(/BR.color=value_id:1.*custom/);
  const firstId = selects[0].id;
  search('value_id:0'); expect(screen.getByRole('combobox', { name: 'Відповідність: Назва товару · UA' }).id).toBe(firstId);
  expect(api.post).not.toHaveBeenCalled();
});

it('does not report focused placement as confirmed when a display filter hides its pending row', async () => {
  const callbacks = setup([{ ...attribute('placement', 'categories'), kind: 'category', label: 'Default/Браслети', candidates: [] }], { focusTarget: 'categories' });
  await table(); search('hidden');
  expect(screen.getByText(/Перевірте шлях у колонці Magento/)).not.toBeNull();
  expect(screen.queryByText(/Розділи цієї категорії підтверджено/)).toBeNull();
  expect(callbacks.onReadyChange).toHaveBeenLastCalledWith(false);
});

it('distinguishes identical option labels on the same route through their associated UA and EN language cells', async () => {
  setup(['base', 'english'].map((row) => ({ ...attribute(`option:${row}:zero`, 'kolir', { row }), kind: 'option', source: 'BR.color=value_id:0' })), { questions: [{ id: 'color', label: 'Колір', options: [{ id: 0, label: 'Нуль' }] }] });
  await table(); const selects = screen.getAllByRole('combobox', { name: 'Відповідність: Колір: Нуль' });
  expect(selects).toHaveLength(2); expect(selects[0].id).not.toBe(selects[1].id);
  expect(description(selects[0])).toMatch(/BR:all.*UA$/); expect(description(selects[1])).toMatch(/BR:all.*EN$/);
  expect(api.post).not.toHaveBeenCalled();
});

it('retains an explicit policy choice and reason when paging away and back without approving anything', async () => {
  const callbacks = setup(Array.from({ length: 31 }, (_, index) => policy(`policy-${index}`, `field_${index}`)));
  await table();
  fireEvent.change(screen.getByRole('combobox', { name: 'Відповідність: field_0 · UA' }), { target: { value: 'authoritative_create_update' } });
  fireEvent.change(screen.getByLabelText('Пояснення перевірки'), { target: { value: 'Перевірено вручну' } });
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Сторінки перевірки — зверху' })).getByRole('button', { name: 'Далі' }));
  expect(screen.getByRole('combobox', { name: 'Відповідність: field_30 · UA' }).value).toBe('');
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Сторінки перевірки — знизу' })).getByRole('button', { name: 'Назад' }));
  expect(screen.getByRole('combobox', { name: 'Відповідність: field_0 · UA' }).value).toBe('authoritative_create_update');
  expect(screen.getByLabelText('Пояснення перевірки').value).toBe('Перевірено вручну');
  expect(callbacks.onPendingChange).toHaveBeenLastCalledWith(true); expect(api.post).not.toHaveBeenCalled();
});

it.each(['disabled', 'stale'])('retains the existing %s command refusal after filtering', async (state) => {
  setup([attribute('one', 'kolir')], { disabled: state === 'disabled' }, state === 'stale' ? { ...revision, revision: '2' } : revision);
  await table(); search('kolir');
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити' }));
  expect(api.post).not.toHaveBeenCalled();
});
