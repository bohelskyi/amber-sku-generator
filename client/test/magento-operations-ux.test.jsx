import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { checkedExactSkuResponse, exactSkuInput } from '../src/lib/magento-controlled-selection.js';
import MagentoControlledActions from '../src/components/workspace/MagentoControlledActions.jsx';
import MagentoPublicationActions from '../src/components/workspace/MagentoPublicationActions.jsx';
import AttentionProblemDetail from '../src/components/attention/AttentionProblemDetail.jsx';
import SyncProblemsPage from '../src/pages/SyncProblemsPage.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const permissions = ['products.view', 'export_templates.view', 'export_templates.manage', 'export_templates.publish', 'exports.view', 'exports.create'];
const auth = { permissions, roles: [{ key: 'administrator' }], principalLifetime: { id: '1', valid: true } };
const revision = { id: 'current', revision: '3', state: 'published' };
const product = (id, article = `SV${id}`, blockers = [], changed = true) => ({ productId: id, article, before: { all: 'Назва', en: 'Name' }, after: { all: 'Нова', en: 'New' }, blockers, changed });
const report = (products, results) => ({ products, results, nextCursor: null });
const shell = (element, principal = auth) => <AuthContext.Provider value={principal}><MemoryRouter>{element}</MemoryRouter></AuthContext.Provider>;
const controlled = (props = {}) => <MagentoControlledActions revision={revision} currentPublishedId="current" kind="broader_resync" {...props} />;
const paste = (text) => fireEvent.change(screen.getByLabelText('Точні артикули, до 100'), { target: { value: text } });
const resolve = () => fireEvent.click(screen.getByRole('button', { name: 'Перевірити точні артикули й додати до вибору' }));
const eligible = (item) => ({ sku: item.article, productId: item.productId, state: 'eligible', blockers: item.blockers });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers(); });

it('keeps literal commas, case, zero and repeats; rejects an oversized list without truncation', () => {
  expect(exactSkuInput(' SV60,6-1\n0\tSV60,6-1\nsv10 ').skus).toEqual(['SV60,6-1', '0', 'SV60,6-1', 'sv10']);
  expect(exactSkuInput(Array.from({ length: 101 }, () => 'SV1').join('\n')).error).toContain('100');
  expect(exactSkuInput('SV' + String.fromCharCode(1)).error).toContain('керівних');
  expect(exactSkuInput('x'.repeat(101)).error).toContain('100');
  expect(exactSkuInput(' '.repeat(20001) + 'SV1')).toEqual({ skus: [], error: expect.stringContaining('введення не обрізано') });
});

it('rejects foreign, partial, contradictory identities and hardblocked eligible responses', () => {
  const item = product(1); const good = report([item], [eligible(item)]);
  expect(checkedExactSkuResponse(good, ['SV1'])).toBe(good);
  for (const bad of [report([product(2)], [eligible(item)]), report([item], []),
    report([item], [{ ...eligible(item), productId: 2 }]),
    report([item], [{ ...eligible(item), blockers: ['RECONCILIATION_REQUIRED'] }]),
    report([item], [{ ...eligible(item), state: 'duplicate' }])]) {
    expect(() => checkedExactSkuResponse(bad, ['SV1'])).toThrow();
  }
});

it('independently reports exact missing, duplicate and blocked SKUs without preview or dispatch; tray survives another search', async () => {
  const a = product(1, 'SV60,6-1'); const b = product(2, 'SV2', ['RECONCILIATION_REQUIRED']);
  api.post.mockImplementation(async (url) => ({ data: url.endsWith('/resolve') ? report([a, b], [eligible(a),
    { sku: 'MISSING', state: 'missing', blockers: [] }, { sku: 'SV2', productId: 2, state: 'blocked', blockers: b.blockers },
    { sku: a.article, state: 'duplicate', blockers: ['DUPLICATE_SKU_INPUT'] }]) : { previewToken: 'review', products: [a], blockers: [] } }));
  api.get.mockResolvedValue({ data: { products: [product(9)], nextCursor: null } });
  render(shell(controlled({ categoryCode: 'SV' })));
  paste('SV60,6-1\nMISSING\nSV2\nSV60,6-1'); resolve();
  const tray = await screen.findByRole('region', { name: 'Вибрані товари' });
  expect(within(tray).getByText(a.article)).toBeTruthy(); expect(tray.textContent).not.toContain('SV2');
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/bindings/current/controlled-products/resolve', { skus: JSON.stringify([a.article, 'MISSING', 'SV2', a.article]), categoryCode: 'SV' });
  expect(screen.getByText(/Точний артикул не знайдено/)).toBeTruthy(); expect(screen.getByText(/Повтор у вставленому/)).toBeTruthy();
  expect(api.post.mock.calls.filter(([url]) => !url.endsWith('/controlled-products/resolve'))).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Пошук за частиною артикулу'), { target: { value: 'SV9' } });
  fireEvent.submit(screen.getByLabelText('Пошук за частиною артикулу').closest('form'));
  await screen.findByRole('checkbox', { name: /SV9/ });
  expect(within(tray).getByText(a.article)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Пояснення контрольованої дії'), { target: { value: 'Exact selection' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити вибрану дію' }));
  await screen.findByText('Вибрано товарів: 1.');
  expect(api.post.mock.calls.find(([url]) => url.endsWith('/controlled/preview'))[1].productIds).toEqual([1]);
  fireEvent.click(screen.getByRole('button', { name: 'Прибрати SV60,6-1 з вибору' }));
  expect(screen.queryByRole('button', { name: 'Підтвердити контрольовану дію' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Вибрані товари' })).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(2);
});

it('name-rule only blockers and unchanged names remain unselected, while broad resync keeps its existing semantics', async () => {
  const a = product(1, 'SV1', ['NAME_CONFLICT_OR_BASELINE_REQUIRED']); const b = product(2, 'SV2', [], false);
  api.post.mockResolvedValue({ data: report([a, b], [eligible(a), eligible(b)]) });
  render(shell(controlled({ kind: 'name_rule' }))); paste('SV1\nSV2'); resolve();
  await screen.findByText(/Потрібне попереднє рішення/); expect(screen.getByText(/Правило не змінює/)).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Вибрані товари' })).toBeNull();
  cleanup(); render(shell(controlled())); paste('SV1\nSV2'); resolve();
  await screen.findByRole('heading', { name: 'Вибрано 2 / 100' }); expect(api.post.mock.calls.filter(([url]) => !url.endsWith('/controlled-products/resolve'))).toHaveLength(0);
});

it('bounds the selected tray at 100 and explains additional exact entries without silently adding them', async () => {
  const list = Array.from({ length: 100 }, (_, index) => product(index + 1));
  api.post.mockResolvedValueOnce({ data: report(list, list.map(eligible)) }).mockResolvedValueOnce({ data: report([product(101)], [eligible(product(101))]) });
  render(shell(controlled())); paste(list.map((item) => item.article).join('\n')); resolve();
  await screen.findByRole('heading', { name: 'Вибрано 100 / 100' });
  paste('SV101'); resolve(); await screen.findByText(/Не додано: у виборі вже 100 товарів/);
  expect(within(screen.getByRole('region', { name: 'Вибрані товари' })).queryByText('SV101')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Очистити вибір' }));
  expect(screen.queryByRole('region', { name: 'Вибрані товари' })).toBeNull(); expect(api.post.mock.calls.filter(([url]) => !url.endsWith('/controlled-products/resolve'))).toHaveLength(0);
});

it('guards duplicate resolve clicks and ignores late results after role or publication changes', async () => {
  let complete; api.post.mockReturnValue(new Promise((resolveRequest) => { complete = resolveRequest; }));
  const view = render(shell(controlled())); paste('SV1'); resolve(); resolve(); expect(api.post).toHaveBeenCalledTimes(1);
  view.rerender(shell(controlled(), { ...auth, permissions: ['export_templates.view'], roles: [] }));
  await act(async () => complete({ data: report([product(1)], [eligible(product(1))]) }));
  expect(screen.queryByRole('region', { name: 'Вибрані товари' })).toBeNull(); expect(api.post.mock.calls.filter(([url]) => !url.endsWith('/controlled-products/resolve'))).toHaveLength(0);
});

it('malformed exact results keep the previous selection and cannot authorize a preview', async () => {
  api.post.mockResolvedValueOnce({ data: report([product(1)], [eligible(product(1))]) }).mockResolvedValueOnce({ data: report([product(9)], [eligible(product(2))]) });
  render(shell(controlled())); paste('SV1'); resolve(); await screen.findByRole('heading', { name: 'Вибрано 1 / 100' });
  paste('SV2'); resolve(); await screen.findByText(/Недостовірний товар/);
  expect(within(screen.getByRole('region', { name: 'Вибрані товари' })).getByText('SV1')).toBeTruthy(); expect(api.post.mock.calls.filter(([url]) => !url.endsWith('/controlled-products/resolve'))).toHaveLength(0);
});

it('preview displays the exact delivery set; only one separate explicit apply uses that token', async () => {
  const proof = { previewToken: 'reviewed', totalProducts: 3, affected: [product(1)], preservedNames: [], lostRoutes: [], lostProducts: [], checked: [], blockers: [] };
  let finishApply; api.post.mockResolvedValueOnce({ data: proof }).mockReturnValueOnce(new Promise((done) => { finishApply = done; }));
  const applied = vi.fn(); render(shell(<MagentoPublicationActions revision={{ ...revision, state: 'draft' }} currentPublishedId="old" onPublished={applied} compact />));
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити вплив на товари' }));
  const list = await screen.findByRole('region', { name: 'Точний перелік товарів для доставки' }); expect(list.textContent).toContain('SV1');
  expect(api.post).toHaveBeenCalledTimes(1);
  const apply = screen.getByRole('button', { name: 'Застосувати правила й передати 1 товарів' }); fireEvent.click(apply); fireEvent.click(apply);
  expect(api.post).toHaveBeenCalledTimes(2); expect(api.post.mock.calls[1][1].previewToken).toBe('reviewed');
  expect(screen.getByRole('button', { name: 'Застосовуємо правила й передачу…' }).disabled).toBe(true);
  await act(async () => finishApply({ data: { revision } })); expect(applied).toHaveBeenCalledTimes(1);
});

it('handoff focus refresh reads Amber; aborted older responses cannot replace fresh progress or claim Magento confirmation', async () => {
  let oldRead; let count = 0;
  const handoff = (synced) => [{ id: 'delivery', kind: 'publication', created_at: '2026-10-08T23:00:00Z', total: 152, synced, waiting: 62, pending_handoff: 0, needs_attention: 0, protected: 0, retired: 0 }];
  api.get.mockImplementation(() => { count += 1; return count === 1 ? new Promise((done) => { oldRead = done; }) : Promise.resolve({ data: handoff(90) }); });
  render(shell(<MagentoPublicationActions revision={revision} currentPublishedId="current" />));
  fireEvent.click(screen.getByRole('button', { name: 'Оновити стан передачі' }));
  await screen.findByText(/Magento: 90 \/ 152 синхронізовано/);
  await act(async () => oldRead({ data: handoff(0) }));
  expect(screen.queryByText(/Magento: 0 \/ 152/)).toBeNull();
  expect(screen.getByText(/Ще не поставлено в чергу доставки/)).toBeTruthy(); expect(screen.getByText(/Час підтвердження недоступний/)).toBeTruthy();
  fireEvent(window, new Event('focus')); await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
  expect(api.post.mock.calls.filter(([url]) => !url.endsWith('/controlled-products/resolve'))).toHaveLength(0);
});

it('unexpected failure explains uncertainty and a viewer receives an exact Administrator handoff', () => {
  const item = { productId: 1, article: 'SV1', category: 'SV', problems: [{ code: 'unexpected_failure', resolution: 'integration_configuration', message: 'Потрібно перевірити відповідності.' }] };
  render(shell(<AttentionProblemDetail product={item} returnTo="/attention?problem=1" onSaved={vi.fn()} />, { ...auth, permissions: ['products.view'], roles: [] }));
  expect(screen.getByRole('heading', { name: 'Не вдалося завершити синхронізацію' })).toBeTruthy();
  expect(screen.getByText(/Причину помилки ще не підтверджено/)).toBeTruthy(); expect(screen.getByText(/Передайте артикул і опис Адміністратору/)).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Перевірити правило або відповідність' })).toBeNull(); expect(api.get).not.toHaveBeenCalled(); expect(api.post.mock.calls.filter(([url]) => !url.endsWith('/controlled-products/resolve'))).toHaveLength(0);
});

it('unresolved dispatch takes precedence over unexpected failure and never offers a resend before reconciliation', () => {
  const item = { productId: 1, article: 'SV1', category: 'SV', problems: [{ code: 'unexpected_failure', resolution: 'integration_configuration' }, { code: 'reconciliation_required', resolution: 'administrator' }] };
  render(shell(<AttentionProblemDetail product={item} returnTo="/attention?problem=1" onSaved={vi.fn()} />));
  expect(within(screen.getByRole('region', { name: 'З чого почати' })).getByRole('button', { name: 'Перевірити товар у Magento' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Перевірити можливість повторної доставки' })).toBeNull(); expect(api.post.mock.calls.filter(([url]) => !url.endsWith('/controlled-products/resolve'))).toHaveLength(0);
});

it('admin opens only a local exact-product retry review and unresolved dispatch remains disabled', async () => {
  const item = { productId: 1, article: 'SV1', category: 'SV', problems: [{ code: 'unexpected_failure', resolution: 'administrator' }] };
  api.get.mockResolvedValueOnce({ data: { revision, currentPublishedId: 'current' } }).mockResolvedValueOnce({ data: { products: [product(1, 'SV1', ['RECONCILIATION_REQUIRED'])], nextCursor: null } });
  render(shell(<AttentionProblemDetail product={item} returnTo="/attention?problem=1" onSaved={vi.fn()} />));
  expect(api.get).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити можливість повторної доставки' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити готовність цього товару' }));
  expect((await screen.findByRole('checkbox', { name: /SV1/ })).disabled).toBe(true);
  expect(api.get).toHaveBeenLastCalledWith('/admin/magento-integration/bindings/current/controlled-products', { params: { after: 0, search: '', categoryCode: 'SV', productId: 1 } });
  expect(screen.getByRole('button', { name: 'Перевірити оновлення перед надсиланням' }).disabled).toBe(true);
  expect(api.post.mock.calls.filter(([url]) => !url.endsWith('/controlled-products/resolve'))).toHaveLength(0);
});

it('saved diagnostics are historical while current delivery is pending, without suggesting another resend', async () => {
  const item = { productId: 1, article: 'SV1', category: 'SV', state: 'pending', problems: [{ code: 'unexpected_failure', resolution: 'administrator' }] };
  api.get.mockResolvedValue({ data: { items: [item], pageInfo: { total: 1 }, categories: [] } });
  render(shell(<SyncProblemsPage />, { ...auth, permissions: ['products.view'], roles: [] }));
  await screen.findByText('Magento: Очікує синхронізації');
  expect(screen.getByText('Попередні причини цього товару (1)')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'З чого почати' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Перевірити можливість повторної доставки' })).toBeNull();
  expect(api.post.mock.calls.filter(([url]) => !url.endsWith('/controlled-products/resolve'))).toHaveLength(0);
});

it('sends all 100 maximum-length Unicode SKUs in a bounded POST body without putting them in a GET URL', async () => {
  const items = Array.from({ length: 100 }, (_, index) => product(index + 1, 'Ж'.repeat(97) + String(index).padStart(3, '0')));
  api.post.mockResolvedValue({ data: report(items, items.map(eligible)) });
  render(shell(controlled())); paste(items.map((item) => item.article).join('\n')); resolve();
  await screen.findByRole('heading', { name: 'Вибрано 100 / 100' });
  expect(api.get).not.toHaveBeenCalled();
  const [url, body] = api.post.mock.calls[0];
  expect(url).toBe('/admin/magento-integration/bindings/current/controlled-products/resolve');
  expect(JSON.parse(body.skus)).toEqual(items.map((item) => item.article));
  expect(url.length).toBeLessThan(120); expect(body.skus.length).toBeLessThan(11000);
});
