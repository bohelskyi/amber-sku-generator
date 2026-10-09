import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import AttentionProblemDetail from '../src/components/attention/AttentionProblemDetail.jsx';
import { attentionProblemGroups, isFirstSyncFieldsProblem, nextAction, problemImpact, problemTitle } from '../src/components/attention/sync-problem-presentation.js';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const permissions = ['products.view', 'export_templates.manage', 'export_templates.publish', 'exports.view'];
const auth = { permissions, roles: [{ key: 'administrator' }], principalLifetime: { id: '1', valid: true } };
const bindingRevisionId = 'fed6b54b-88ae-4bfb-ad52-bc84db493e34';
const problem = { code: 'FIRST_SYNC_FIELDS_REVIEW_REQUIRED', resolutionKind: 'first_sync_fields', resolution: 'administrator', target: 'weight', scope: 'all', reason: 'POPULATED_VALUES_DIFFER', message: 'Обидві системи мають різні значення.' };
const product = { productId: 5012, article: 'SV60,6-1', category: 'SV', productStatus: 'active', bindingRevisionId, problems: [problem] };
const token = 'b'.repeat(64);
const field = { target: 'weight', scope: 'all', status: 'conflict', reason: 'POPULATED_VALUES_DIFFER', local: { known: true, present: true, value: '12' }, remote: { known: true, present: true, value: '15' }, canAcceptRemote: true, canKeepLocal: true };
const preview = (sku = product.article) => ({ mode: 'first', sku, previewToken: token, fields: [field], blockers: [], readyForOutbound: false, complete: false });
const shell = (item = product, principal = auth, onSaved = vi.fn()) => <AuthContext.Provider value={principal}><MemoryRouter><AttentionProblemDetail product={item} productUrl="/products?product=5012" returnTo="/attention?problem=5012" onSaved={onSaved} /></MemoryRouter></AuthContext.Provider>;
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it.each([
  { ...problem }, { ...problem, resolution: 'first_sync_fields', resolutionKind: undefined },
])('mounts one manual panel for normalized or wire first-sync resolution without reading on open', (diagnostic) => {
  render(shell({ ...product, problems: [diagnostic] }));
  expect(screen.getByRole('region', { name: `Перше отримання полів ${product.article}` })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Перевірити актуальні поля' })).toBeTruthy();
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: 'Перевірити правило або відповідність' })).toBeNull();
});

it.each(permissions.filter((permission) => permission !== 'products.view'))('does not mount without required route permission %s', (missing) => {
  render(shell(product, { ...auth, permissions: permissions.filter((permission) => permission !== missing) }));
  expect(screen.queryByRole('region', { name: /Перше отримання полів/ })).toBeNull();
  expect(screen.getByText(/Передайте артикул і причини Адміністратору/)).toBeTruthy();
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it.each([
  { ...auth, roles: [{ key: 'manager' }] }, { ...auth, principalLifetime: { id: '1', valid: false } },
])('requires an actual active Administrator even with all three route permissions #%#', (principal) => {
  render(shell(product, principal)); expect(screen.queryByRole('button', { name: 'Перевірити актуальні поля' })).toBeNull();
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it.each([
  { ...product, article: '' }, { ...product, article: ' SV60,6-1' }, { ...product, article: 'SV\n1' },
  { ...product, bindingRevisionId: undefined, problems: [{ ...problem, bindingRevisionId: 'stale-diagnostic' }] },
  { ...product, bindingRevisionId: '' }, { ...product, bindingRevisionId: { id: bindingRevisionId } },
])('fails closed on missing or malformed exact product context without borrowing a diagnostic binding #%#', (item) => {
  render(shell(item)); expect(screen.queryByRole('button', { name: 'Перевірити актуальні поля' })).toBeNull();
  expect(screen.getByText(/Точний артикул або чинну версію правил ще не підтверджено/)).toBeTruthy();
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it('preserves exact Unicode/comma/slash SKU and current published binding only when manually reading', async () => {
  const sku = 'SV60,6-1/Ж'; api.post.mockResolvedValue({ data: preview(sku) });
  render(shell({ ...product, article: sku, problems: [{ ...problem, bindingRevisionId: 'old-binding' }] }));
  expect(api.post).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Перевірити актуальні поля' }));
  await screen.findByRole('region', { name: 'Вага · UA / основний магазин' });
  expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/first-sync/preview', { sku, bindingRevisionId }, { signal: expect.any(AbortSignal) });
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).toHaveBeenCalledTimes(1);
});

it('mounts one shared panel for multiple exact field/language reasons and retains each diagnostic', () => {
  const names = { ...problem, target: 'name', scope: 'en', reason: 'REMOTE_READ_UNKNOWN', message: 'Значення Magento не підтверджено.' };
  const item = { ...product, problems: [problem, { ...problem }, names] };
  render(shell(item)); expect(screen.getAllByRole('region', { name: /Перше отримання полів/ })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Перевірити актуальні поля' })).toHaveLength(1);
  expect(screen.getByRole('heading', { name: 'Назва · EN: Значення Magento не підтверджено.' })).toBeTruthy();
  expect(screen.getByText(/Це поле перевіряється у спільній панелі/)).toBeTruthy();
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

it('a verified local receipt refreshes Attention with its specific cause without starting delivery', async () => {
  const saved = vi.fn(); const response = { sku: product.article, target: field.target, scope: field.scope, choice: 'accept_remote', receipt: { sessionId: 'fad51b72-0d5a-4ecf-8d25-e6b7598b4e69', revision: '1', state: 'imported', alreadyApplied: false }, readyForOutbound: false, complete: false };
  api.post.mockResolvedValueOnce({ data: preview() }).mockResolvedValueOnce({ data: response });
  render(shell(product, auth, saved)); fireEvent.click(screen.getByRole('button', { name: 'Перевірити актуальні поля' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Отримати значення Magento: Вага · UA / основний магазин' }));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти рішення цього поля' }));
  await screen.findByText(/Рішення для поля збережено/); expect(saved).toHaveBeenCalledWith('first_sync_fields');
  expect(api.post).toHaveBeenCalledTimes(2); expect(api.post.mock.calls[1][1]).toEqual({ sku: product.article, bindingRevisionId, previewToken: token, target: 'weight', scope: 'all', choice: 'accept_remote' });
  expect(api.get).not.toHaveBeenCalled(); expect(screen.getByText(/Стан доставки товару не підтверджено/)).toBeTruthy();
});

it('permission loss unmounts the panel and prevents late preview evidence from appearing', async () => {
  let finish; api.post.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const view = render(shell()); fireEvent.click(screen.getByRole('button', { name: 'Перевірити актуальні поля' }));
  const signal = api.post.mock.calls[0][2].signal;
  view.rerender(shell(product, { ...auth, permissions: ['products.view'] })); expect(signal.aborted).toBe(true);
  await act(async () => finish({ data: preview() }));
  expect(screen.queryByRole('region', { name: 'Вага · UA / основний магазин' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Перевірити актуальні поля' })).toBeNull();
});

it('ordinary mapping diagnostics do not accidentally mount the adoption panel', () => {
  render(shell({ ...product, problems: [{ ...problem, resolutionKind: 'integration_configuration', resolution: 'integration_configuration' }] }));
  expect(screen.queryByRole('button', { name: 'Перевірити актуальні поля' })).toBeNull(); expect(api.post).not.toHaveBeenCalled();
});

it('current binding change aborts the old panel and never authorizes its earlier preview', async () => {
  let finish; api.post.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const view = render(shell()); fireEvent.click(screen.getByRole('button', { name: 'Перевірити актуальні поля' }));
  const signal = api.post.mock.calls[0][2].signal;
  const next = '371b5c26-441f-47f3-a5c3-083c267e9d35';
  view.rerender(shell({ ...product, bindingRevisionId: next })); expect(signal.aborted).toBe(true);
  await act(async () => finish({ data: preview() }));
  expect(screen.queryByRole('button', { name: /Отримати значення Magento:/ })).toBeNull();
  api.post.mockResolvedValue({ data: preview() }); fireEvent.click(screen.getByRole('button', { name: 'Перевірити актуальні поля' }));
  await screen.findByRole('button', { name: /Отримати значення Magento:/ }); expect(api.post.mock.calls[1][1]).toEqual({ sku: product.article, bindingRevisionId: next });
});
