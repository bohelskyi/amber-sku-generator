import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import AttentionProblemDetail from '../src/components/attention/AttentionProblemDetail.jsx';
import { attentionProblemGroups, isFirstSyncFieldsProblem, nextAction, problemImpact, problemTitle } from '../src/components/attention/sync-problem-presentation.js';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const permissions = ['products.view', 'export_templates.view', 'export_templates.manage', 'export_templates.publish', 'exports.view'];
const auth = { permissions, roles: [{ key: 'administrator' }], principalLifetime: { id: '1', valid: true } };
const bindingRevisionId = 'fed6b54b-88ae-4bfb-ad52-bc84db493e34';
const nextBindingRevisionId = '371b5c26-441f-47f3-a5c3-083c267e9d35';
const problem = { code: 'FIRST_SYNC_FIELDS_REVIEW_REQUIRED', resolutionKind: 'first_sync_fields', resolution: 'administrator', target: 'weight', scope: 'all', reason: 'POPULATED_VALUES_DIFFER', message: 'Обидві системи мають різні значення.' };
const evaluationProblem = { code: 'PRODUCT_EVALUATION_NOT_READY', resolution: 'product', issueFields: ['decor_weight'], evaluationIssues: [{ field: 'decor_weight', message: 'Немає додатної ваги для Magento' }] };
const nameProblem = { code: 'NAME_READ_UNAVAILABLE', resolution: 'name', message: 'Читання назв Magento недоступне.' };
const product = { productId: 5012, article: 'SV60,6-1', category: 'SV', productStatus: 'active', bindingRevisionId, problems: [problem] };
const token = 'b'.repeat(64);
const field = { target: 'weight', scope: 'all', status: 'conflict', reason: 'POPULATED_VALUES_DIFFER', local: { known: true, present: true, value: '12' }, remote: { known: true, present: true, value: '15' }, canAcceptRemote: true, canKeepLocal: true };
const preview = (sku = product.article) => ({ mode: 'first', sku, previewToken: token, fields: [field], blockers: [], readyForOutbound: false, complete: false });
const shell = (item = product, principal = auth, onSaved = vi.fn()) => <AuthContext.Provider value={principal}><MemoryRouter><AttentionProblemDetail product={item} productUrl="/products?product=5012" returnTo="/attention?problem=5012" onSaved={onSaved} /></MemoryRouter></AuthContext.Provider>;
const startReview = () => fireEvent.click(screen.getByRole('button', { name: 'Перевірити актуальні поля' }));
const pending = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { api.get.mockResolvedValue({ data: { currentPublishedId: bindingRevisionId } }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it.each([
  { ...problem }, { ...problem, resolution: 'first_sync_fields', resolutionKind: undefined }, evaluationProblem, nameProblem,
  { code: 'MAPPING_MISSING', resolutionKind: 'integration_configuration', resolution: 'integration_configuration' },
])('mounts one manual panel independently of saved diagnosis $code without reading on open', (diagnostic) => {
  render(shell({ ...product, problems: [diagnostic] }));
  expect(screen.getAllByRole('region', { name: `Перше отримання полів ${product.article}` })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Перевірити актуальні поля' })).toHaveLength(1);
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it.each([evaluationProblem, nameProblem])('fresh first-sync preview is reachable for an old $code without a saved binding', async (diagnostic) => {
  api.post.mockResolvedValue({ data: preview() });
  render(shell({ ...product, bindingRevisionId: undefined, problems: [diagnostic] }));
  startReview(); await screen.findByRole('region', { name: 'Вага · UA / основний магазин' });
  expect(api.get).toHaveBeenCalledWith('/admin/magento-integration', { signal: expect.any(AbortSignal) });
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/first-sync/preview', { sku: product.article, bindingRevisionId }, { signal: expect.any(AbortSignal) });
  expect(api.get).toHaveBeenCalledTimes(1); expect(api.post).toHaveBeenCalledTimes(1);
});

it.each(permissions.filter((permission) => permission !== 'products.view'))('does not mount without required route permission %s', (missing) => {
  render(shell(product, { ...auth, permissions: permissions.filter((permission) => permission !== missing) }));
  expect(screen.queryByRole('region', { name: /Перше отримання полів/ })).toBeNull();
  expect(screen.getByText(/Передайте артикул і причини Адміністратору/)).toBeTruthy();
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it.each([
  { ...auth, roles: [{ key: 'manager' }] }, { ...auth, principalLifetime: { id: '1', valid: false } },
  { ...auth, principalLifetime: undefined },
])('requires an actual active Administrator even with all route permissions #%#', (principal) => {
  render(shell(product, principal)); expect(screen.queryByRole('button', { name: 'Перевірити актуальні поля' })).toBeNull();
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it.each(['', ' SV60,6-1', 'SV60,6-1 ', 'SV\n1', 'x'.repeat(257), undefined])('fails closed on missing or malformed exact SKU #%#', (article) => {
  render(shell({ ...product, article })); expect(screen.queryByRole('button', { name: 'Перевірити актуальні поля' })).toBeNull();
  expect(screen.getByText(/Точний артикул/)).toBeTruthy();
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it.each([undefined, '', 'old-binding', { id: bindingRevisionId }, nextBindingRevisionId])('ignores stale or absent saved binding and preserves exact Unicode/comma/slash SKU #%#', async (savedBinding) => {
  const sku = 'SV60,6-1/Ж'; api.post.mockResolvedValue({ data: preview(sku) });
  render(shell({ ...product, article: sku, bindingRevisionId: savedBinding, problems: [{ ...problem, bindingRevisionId: nextBindingRevisionId }] }));
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled(); startReview();
  await screen.findByRole('region', { name: 'Вага · UA / основний магазин' });
  expect(api.get).toHaveBeenCalledWith('/admin/magento-integration', { signal: expect.any(AbortSignal) });
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/first-sync/preview', { sku, bindingRevisionId }, { signal: expect.any(AbortSignal) });
  expect(api.get).toHaveBeenCalledTimes(1); expect(api.post).toHaveBeenCalledTimes(1);
});

it.each([undefined, null, '', 'old-binding', ` ${bindingRevisionId}`, { id: bindingRevisionId }, []])('does not preview if current published binding is missing or malformed #%#', async (currentPublishedId) => {
  api.get.mockResolvedValue({ data: { currentPublishedId } }); render(shell()); startReview();
  await screen.findByRole('alert'); expect(api.post).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Отримати значення Magento:/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити актуальні поля' }).disabled).toBe(false);
});

it('mounts one shared panel for multiple exact field/language reasons and retains each diagnostic', () => {
  const names = { ...problem, target: 'name', scope: 'en', reason: 'REMOTE_READ_UNKNOWN', message: 'Значення Magento не підтверджено.' };
  const item = { ...product, problems: [problem, { ...problem }, names] };
  render(shell(item)); expect(screen.getAllByRole('region', { name: /Перше отримання полів/ })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Перевірити актуальні поля' })).toHaveLength(1);
  expect(screen.getByRole('heading', { name: 'Назва · EN: Значення Magento не підтверджено.' })).toBeTruthy();
  expect(screen.getAllByText(/Це поле перевіряється у спільній панелі/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByText('Дані для підтримки'));
  const support = screen.getByText('Збережена діагностика товару').parentElement;
  expect(support.textContent).toContain('REMOTE_READ_UNKNOWN'); expect(support.textContent).toContain('"scope": "en"');
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it('scope and reason keep distinct diagnostics while exact duplicates retain all evidence', () => {
  const en = { ...problem, scope: 'en' }; const another = { ...problem, reason: 'REMOTE_READ_UNKNOWN' };
  const groups = attentionProblemGroups([problem, { ...problem }, en, another]);
  expect(groups).toHaveLength(3); expect(groups[0].evidence).toHaveLength(2);
  expect(nextAction(problem)).toBe('Перевірити поля першого отримання');
  expect(problemTitle(en)).toContain('EN'); expect(problemImpact(problem)).toContain('окремо для кожного поля й мови');
  expect(isFirstSyncFieldsProblem({ resolution: 'first_sync_fields', resolutionKind: 'integration_configuration' })).toBe(false);
});

it('refreshes the published binding for every preview and discards earlier actionable evidence while loading', async () => {
  const current = pending(); api.get.mockResolvedValueOnce({ data: { currentPublishedId: bindingRevisionId } }).mockReturnValueOnce(current.promise);
  api.post.mockResolvedValue({ data: preview() }); render(shell()); startReview();
  await screen.findByRole('button', { name: /Отримати значення Magento:/ }); startReview();
  expect(screen.queryByRole('button', { name: /Отримати значення Magento:/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Читаємо актуальні поля…' }).disabled).toBe(true);
  await act(async () => current.resolve({ data: { currentPublishedId: nextBindingRevisionId } }));
  await screen.findByRole('button', { name: /Отримати значення Magento:/ });
  expect(api.get).toHaveBeenCalledTimes(2); expect(api.post).toHaveBeenCalledTimes(2);
  expect(api.post.mock.calls[1][1]).toEqual({ sku: product.article, bindingRevisionId: nextBindingRevisionId });
});

it('a verified local receipt uses the preview binding and refreshes Attention without starting delivery', async () => {
  const saved = vi.fn(); const response = { sku: product.article, target: field.target, scope: field.scope, choice: 'accept_remote', receipt: { sessionId: 'fad51b72-0d5a-4ecf-8d25-e6b7598b4e69', revision: '1', state: 'imported', alreadyApplied: false }, readyForOutbound: false, complete: false };
  api.get.mockResolvedValue({ data: { currentPublishedId: nextBindingRevisionId } });
  api.post.mockResolvedValueOnce({ data: preview() }).mockResolvedValueOnce({ data: response });
  render(shell(product, auth, saved)); startReview();
  fireEvent.click(await screen.findByRole('button', { name: 'Отримати значення Magento: Вага · UA / основний магазин' }));
  api.get.mockResolvedValue({ data: { currentPublishedId: bindingRevisionId } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти рішення цього поля' }));
  await screen.findByText(/Рішення для поля збережено/); expect(saved).toHaveBeenCalledWith('first_sync_fields');
  expect(api.post).toHaveBeenCalledTimes(2); expect(api.post.mock.calls[1][0]).toBe('/admin/magento-integration/first-sync/apply');
  expect(api.post.mock.calls[1][1]).toEqual({ sku: product.article, bindingRevisionId: nextBindingRevisionId, previewToken: token, target: 'weight', scope: 'all', choice: 'accept_remote' });
  expect(api.get).toHaveBeenCalledTimes(1); expect(screen.getByText(/Стан доставки товару не підтверджено/)).toBeTruthy();
});

it('shows the populated physical weight in a blocked SV11500004 preview without offering an import or clearing the old blocker', async () => {
  const sku = 'SV11500004'; const saved = vi.fn();
  const weight = { ...field, status: 'review_required', reason: 'CANONICAL_WEIGHT_ANSWER_INCOHERENT', local: { known: true, present: true, value: '132.300' }, remote: { known: true, present: true, value: '140' }, canAcceptRemote: false, canKeepLocal: false };
  api.post.mockResolvedValue({ data: { ...preview(sku), mode: 'review', fields: [weight], blockers: [{ code: weight.reason, target: 'weight', scope: 'all' }] } });
  render(shell({ ...product, productId: 1488, article: sku, bindingRevisionId: undefined, problems: [evaluationProblem] }, auth, saved));
  startReview(); await screen.findByText('132.300');
  expect(screen.getByRole('heading', { name: 'Немає додатної ваги для Magento' })).toBeTruthy();
  expect(screen.getByText(/Перше отримання недоступне/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Отримати значення Magento:/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Залишити значення Amber:/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Зберегти рішення цього поля' })).toBeNull();
  expect(saved).not.toHaveBeenCalled(); expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post.mock.calls[0][0]).toBe('/admin/magento-integration/first-sync/preview');
});

it.each(['GET', 'POST'])('coalesces repeated clicks throughout pending %s without starting apply', async (phase) => {
  const request = pending();
  if (phase === 'GET') api.get.mockReturnValue(request.promise); else api.post.mockReturnValue(request.promise);
  render(shell()); const button = screen.getByRole('button', { name: 'Перевірити актуальні поля' });
  fireEvent.click(button); fireEvent.click(button);
  if (phase === 'POST') await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  fireEvent.click(button); expect(button.disabled).toBe(true); expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledTimes(phase === 'GET' ? 0 : 1);
  if (phase === 'GET') { api.post.mockResolvedValue({ data: preview() }); await act(async () => request.resolve({ data: { currentPublishedId: bindingRevisionId } })); }
  else await act(async () => request.resolve({ data: preview() }));
  await screen.findByRole('region', { name: 'Вага · UA / основний магазин' });
  expect(api.get).toHaveBeenCalledTimes(1); expect(api.post).toHaveBeenCalledTimes(1);
});

const changedProducts = [
  { name: 'product identity', item: { ...product, productId: 5013 } },
  { name: 'SKU', item: { ...product, article: 'SV60,6-2' } },
  { name: 'saved binding evidence', item: { ...product, bindingRevisionId: nextBindingRevisionId } },
  { name: 'observation', item: { ...product, observedAt: '2026-10-09T10:00:00Z' } },
];
it.each(changedProducts.flatMap((change) => ['GET', 'POST'].map((phase) => ({ ...change, phase }))))('changing $name aborts pending $phase and ignores its late result', async ({ item, phase }) => {
  const request = pending();
  if (phase === 'GET') api.get.mockReturnValueOnce(request.promise); else api.post.mockReturnValueOnce(request.promise);
  const view = render(shell()); startReview();
  if (phase === 'POST') await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  const signal = phase === 'GET' ? api.get.mock.calls[0][1].signal : api.post.mock.calls[0][2].signal;
  view.rerender(shell(item)); expect(signal.aborted).toBe(true);
  await act(async () => request.resolve(phase === 'GET' ? { data: { currentPublishedId: nextBindingRevisionId } } : { data: preview() }));
  expect(screen.queryByRole('button', { name: /Отримати значення Magento:/ })).toBeNull();
  expect(api.get).toHaveBeenCalledTimes(1); expect(api.post).toHaveBeenCalledTimes(phase === 'GET' ? 0 : 1);
  api.get.mockResolvedValue({ data: { currentPublishedId: bindingRevisionId } }); api.post.mockResolvedValue({ data: preview(item.article) }); startReview();
  await screen.findByRole('button', { name: /Отримати значення Magento:/ });
  expect(api.post.mock.lastCall[1]).toEqual({ sku: item.article, bindingRevisionId });
});

it.each(['GET', 'POST'])('closing and returning aborts pending %s and requires another explicit preview', async (phase) => {
  const request = pending();
  if (phase === 'GET') api.get.mockReturnValueOnce(request.promise); else api.post.mockReturnValueOnce(request.promise);
  const view = render(shell()); startReview();
  if (phase === 'POST') await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  const signal = phase === 'GET' ? api.get.mock.calls[0][1].signal : api.post.mock.calls[0][2].signal;
  view.unmount(); expect(signal.aborted).toBe(true); render(shell());
  await act(async () => request.resolve(phase === 'GET' ? { data: { currentPublishedId: bindingRevisionId } } : { data: preview() }));
  expect(api.get).toHaveBeenCalledTimes(1); expect(api.post).toHaveBeenCalledTimes(phase === 'GET' ? 0 : 1);
  expect(screen.queryByRole('region', { name: 'Вага · UA / основний магазин' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити актуальні поля' }).disabled).toBe(false);
  api.get.mockResolvedValue({ data: { currentPublishedId: bindingRevisionId } }); api.post.mockResolvedValue({ data: preview() }); startReview();
  await screen.findByRole('region', { name: 'Вага · UA / основний магазин' }); expect(api.get).toHaveBeenCalledTimes(2);
});

const revokedPrincipals = [
  { name: 'permission', principal: { ...auth, permissions: permissions.filter((permission) => permission !== 'export_templates.view') } },
  { name: 'role', principal: { ...auth, roles: [{ key: 'manager' }] } },
  { name: 'active principal', principal: { ...auth, principalLifetime: { id: '1', valid: false } } },
];
it.each(revokedPrincipals.flatMap((change) => ['GET', 'POST'].map((phase) => ({ ...change, phase }))))('$name loss aborts pending $phase and prevents late evidence from appearing', async ({ principal, phase }) => {
  const request = pending();
  if (phase === 'GET') api.get.mockReturnValueOnce(request.promise); else api.post.mockReturnValueOnce(request.promise);
  const view = render(shell()); startReview();
  if (phase === 'POST') await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  const signal = phase === 'GET' ? api.get.mock.calls[0][1].signal : api.post.mock.calls[0][2].signal;
  view.rerender(shell(product, principal)); expect(signal.aborted).toBe(true);
  await act(async () => request.resolve(phase === 'GET' ? { data: { currentPublishedId: bindingRevisionId } } : { data: preview() }));
  expect(screen.queryByRole('region', { name: 'Вага · UA / основний магазин' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Перевірити актуальні поля' })).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(phase === 'GET' ? 0 : 1);
  view.rerender(shell()); expect(screen.getByRole('button', { name: 'Перевірити актуальні поля' })).toBeTruthy();
  expect(api.get).toHaveBeenCalledTimes(1); expect(screen.queryByRole('button', { name: /Отримати значення Magento:/ })).toBeNull();
});

it.each(['GET', 'POST'])('handles %s permission denial without displaying stale or actionable evidence', async (phase) => {
  const error = { response: { status: 403, data: { code: 'INSUFFICIENT_PERMISSION', error: 'Немає дозволу на перевірку Magento.' } } };
  api.post.mockResolvedValueOnce({ data: preview() }); render(shell()); startReview();
  await screen.findByRole('button', { name: /Отримати значення Magento:/ });
  if (phase === 'GET') api.get.mockRejectedValueOnce(error); else api.post.mockRejectedValueOnce(error);
  startReview(); await screen.findByText('Немає дозволу на перевірку Magento.');
  expect(screen.queryByRole('button', { name: /Отримати значення Magento:/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Зберегти рішення цього поля' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити актуальні поля' }).disabled).toBe(false);
  expect(api.get).toHaveBeenCalledTimes(2); expect(api.post).toHaveBeenCalledTimes(phase === 'GET' ? 1 : 2);
  expect(api.post.mock.calls.every(([url]) => url === '/admin/magento-integration/first-sync/preview')).toBe(true);
});
