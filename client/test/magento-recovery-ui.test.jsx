import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { MagentoRecovery } from '../src/components/attention/MagentoRecovery.jsx';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const job = { id: 'job-1', state: 'uncertain', steps: [{ ordinal: 0, domain: 'coreProduct', state: 'dispatched' }] };
const record = { productId: 7, article: 'AG-000007', job, lifecycle: null, actions: { jobRecovery: true, lifecycleRecovery: false } };
const reviewed = { job, review: { jobId: 'job-1', steps: [] }, reviewHash: 'original-review', steps: [{ ...job.steps[0], matches: true }],
  blockers: [], canReconcile: true, canContinue: false, observedAt: '2026-10-04T00:00:00Z' };
function show(capabilities = ['export_templates.publish'], props = {}, roles = []) {
  return render(<AuthContext.Provider value={{ permissions: capabilities, roles, principalLifetime: { valid: true } }}><MemoryRouter><MagentoRecovery productId={7} {...props} /></MemoryRouter></AuthContext.Provider>);
}
beforeEach(() => { vi.resetAllMocks(); api.get.mockResolvedValue({ data: record }); api.post.mockResolvedValue({ data: reviewed }); });
afterEach(cleanup);

it('guided check inspects the original job in one explicit action and never records or continues automatically', async () => {
  show(['export_templates.publish'], { guided: true });
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  await screen.findByRole('button', { name: 'Підтвердити перевірений результат' });
  expect(api.get).toHaveBeenCalledExactlyOnceWith('/admin/magento-recovery/products/7');
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-recovery/jobs/job-1/inspect', {});
});

it('guided history check offers the exact server-recommended decision with a concrete result', async () => {
  api.get.mockResolvedValue({ data: { ...record, job: null, lifecycle: { suggestedKind: 'prior_exposure', availableKinds: ['prior_exposure'] }, actions: { jobRecovery: false, lifecycleRecovery: true } } });
  api.post.mockResolvedValue({ data: { review: { kind: 'prior_exposure', payload: { remote: { status: 'found', sku: 'AG-000007' } } }, eligible: true, blockers: [], reviewHash: 'exact' } });
  show(['exports.reconcile'], { guided: true });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  await screen.findByText(/У Magento знайдено товар/);
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-recovery/products/7/lifecycle-preview', { kind: 'prior_exposure' });
  expect(screen.getByRole('button', { name: 'Підтвердити наявність товару' }).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Перевірити можливість рішення' })).toBeNull();
});

it('keeps the Administrator resync in the problem context and submits only the exact reviewed product', async () => {
  const revision = { id: 'current', revision: '4', state: 'published' };
  api.get.mockImplementation(async (url) => ({ data: url.includes('/magento-recovery/')
    ? { ...record, job: null, lifecycle: { availableKinds: [] }, nextAction: { kind: 'reviewed_resync' } }
    : url.includes('/controlled-products') ? { products: [7, 8].map((productId) => ({ productId, article: `AG-${productId}`, before: { all: 'Назва' }, after: { all: 'Нова назва' }, blockers: [] })) }
      : { revision, currentPublishedId: 'current' } }));
  api.post.mockImplementation(async (url) => ({ data: url.endsWith('/preview') ? { products: [{ productId: 7, article: 'AG-7' }], blockers: [], previewToken: 'proof' } : { handoffId: 'receipt' } }));
  show(['export_templates.view', 'export_templates.manage', 'export_templates.publish', 'exports.view'], { guided: true, categoryCode: 'KL' }, [{ key: 'administrator' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Переглянути оновлення товару' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити готовність цього товару' }));
  await screen.findByText(/AG-7/);
  expect(api.get).toHaveBeenLastCalledWith('/admin/magento-integration/bindings/current/controlled-products', { params: { after: 6, search: '', categoryCode: 'KL', productId: 7 } });
  expect(screen.queryByText(/AG-8/)).toBeNull();
  expect(screen.queryByRole('link', { name: 'Перевірити відправлення виправленого товару' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Чому потрібно оновити товар'), { target: { value: 'Перевірено наявність товару' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити оновлення перед надсиланням' }));
  await screen.findByRole('button', { name: 'Підтвердити надсилання цього товару' });
  expect(api.post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити надсилання цього товару' }));
  await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/admin/magento-integration/controlled/apply', {
    bindingRevisionId: 'current', expectedRevision: '4', kind: 'broader_resync', productIds: [7], reason: 'Перевірено наявність товару', previewToken: 'proof',
  }));
});

it('navigation does not inspect Magento or read administrative evidence until explicitly opened', async () => {
  show();
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити перевірку доставки' }));
  await screen.findByRole('button', { name: 'Перевірити результат у Magento' });
  expect(api.get).toHaveBeenCalledExactlyOnceWith('/admin/magento-recovery/products/7');
  expect(api.post).not.toHaveBeenCalled();
});

it('inspection and recording a verified result are distinct reviewed actions, with no automatic continuation', async () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити перевірку доставки' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити результат у Magento' }));
  await screen.findByLabelText('Підстава рішення');
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-recovery/jobs/job-1/inspect', {});
  fireEvent.change(screen.getByLabelText('Підстава рішення'), { target: { value: 'Результат звірено' } });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити перевірений результат' }));
  expect(api.post).toHaveBeenCalledTimes(1);
  api.post.mockResolvedValueOnce({ data: { job: { ...job, state: 'succeeded' }, remoteWrites: 0 } });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Зберегти підтверджене рішення' }));
  await screen.findByText('Перевірений результат записано в Amber. Змін до Magento не надсилали.');
  expect(api.post).toHaveBeenLastCalledWith('/admin/magento-recovery/jobs/job-1/reconcile', {
    review: reviewed.review, reviewHash: reviewed.reviewHash, reason: 'Результат звірено',
  });
  expect(api.post.mock.calls.some(([url]) => url.endsWith('/continue'))).toBe(false);
});

it('uncertain continuation clears its old review and offers fresh inspection rather than resending', async () => {
  api.post.mockResolvedValueOnce({ data: { ...reviewed, canReconcile: false, canContinue: true,
    steps: [{ ordinal: 0, domain: 'coreProduct', state: 'not_sent', matches: false }],
    remainingCount: 1, unsentChanges: [{ ordinal: 0, label: 'Назва англійською', before: 'Old name', after: 'Amber stone' }] } });
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити перевірку доставки' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити результат у Magento' }));
  fireEvent.change(await screen.findByLabelText('Підстава рішення'), { target: { value: 'Перевірено початковий план' } });
  fireEvent.click(screen.getByRole('button', { name: 'Переглянути продовження операції' }));
  expect(within(screen.getByRole('dialog')).getByText('Зараз: Old name')).toBeTruthy();
  expect(within(screen.getByRole('dialog')).getByText('Після дії: Amber stone')).toBeTruthy();
  api.post.mockRejectedValueOnce(new Error('lost response'));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Надіслати лише ненадіслані кроки' }));
  await screen.findByText(/Не вдалося отримати підтверджений результат/);
  expect(screen.queryByRole('button', { name: 'Переглянути продовження операції' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити результат у Magento' })).toBeTruthy();
  expect(api.post.mock.calls.filter(([url]) => url.endsWith('/continue'))).toHaveLength(1);
});

it('read-only operator cannot open administrative recovery', () => {
  show(['products.view']);
  expect(screen.queryByRole('button', { name: 'Відкрити перевірку доставки' })).toBeNull();
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it('lifecycle recovery retains the exact original decision after a lost response', async () => {
  api.get.mockResolvedValue({ data: { ...record, job: null, lifecycle: { suggestedKind: 'prior_exposure' },
    actions: { jobRecovery: false, lifecycleRecovery: true } } });
  const review = { productId: 7, kind: 'prior_exposure', payload: { productId: 7 } };
  api.post.mockResolvedValueOnce({ data: { review, reviewHash: 'lifecycle-proof', eligible: true, blockers: [], requiredEvidence: null } });
  show(['exports.reconcile']);
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити перевірку доставки' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити можливість рішення' }));
  fireEvent.change(await screen.findByLabelText('Підстава рішення'), { target: { value: 'Історію перевірено' } });
  fireEvent.click(screen.getByRole('button', { name: 'Переглянути рішення щодо доставки' }));
  api.post.mockRejectedValueOnce(new Error('lost response'));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Зберегти підтверджене рішення' }));
  await screen.findByRole('button', { name: 'Отримати результат початкового рішення' });
  await screen.findByText(/Не вдалося отримати підтверджений результат/);
  expect(screen.queryByLabelText('Рішення щодо історії доставки')).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити можливість рішення' }).disabled).toBe(true);
  expect(screen.getByLabelText('Підстава рішення').disabled).toBe(true);
  const original = api.post.mock.calls[1];
  api.post.mockResolvedValueOnce({ data: { alreadyApplied: true } });
  fireEvent.click(screen.getByRole('button', { name: 'Отримати результат початкового рішення' }));
  await waitFor(() => expect(api.post.mock.calls[2]).toEqual(original));
  await screen.findByText(/Рішення щодо історії доставки збережено/);
});

it('a recovery guard failure explains the next step without exposing an internal code as its message', async () => {
  show();
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити перевірку доставки' }));
  await screen.findByRole('button', { name: 'Перевірити результат у Magento' });
  api.post.mockRejectedValueOnce({ response: { status: 409, data: { code: 'MAGENTO_SYNC_BUSY', error: 'MAGENTO_SYNC_BUSY' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити результат у Magento' }));
  await screen.findByText('Інша операція вже працює з цим товаром. Дочекайтеся її завершення та повторіть перевірку.');
  expect(screen.queryByText('MAGENTO_SYNC_BUSY')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Переглянути продовження операції' })).toBeNull();
});
