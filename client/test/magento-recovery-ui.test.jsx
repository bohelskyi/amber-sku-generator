import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { MagentoRecovery } from '../src/components/attention/MagentoRecovery.jsx';
import { downloadBlob } from '../src/lib/download.js';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../src/lib/download.js', () => ({ downloadBlob: vi.fn() }));
const job = { id: 'job-1', state: 'uncertain', steps: [{ ordinal: 0, domain: 'coreProduct', state: 'dispatched' }] };
const record = { productId: 7, article: 'AG-000007', job, lifecycle: null, actions: { jobRecovery: true, lifecycleRecovery: false } };
const reviewed = { job, review: { jobId: 'job-1', steps: [] }, reviewHash: 'original-review', steps: [{ ...job.steps[0], matches: true }],
  blockers: [], canReconcile: true, canContinue: false, observedAt: '2026-10-04T00:00:00Z' };
const history = { productId: 7, complete: true, hasRecount: true, stableRecount: false, identityChanged: true,
  products: [{ productId: 3, article: 'KL-OLD', internalSku: 'OLD', status: 'corrected', businessExclusion: 'unknown' },
    { productId: 7, article: 'KL-CURRENT', internalSku: 'CURRENT', status: 'active', businessExclusion: 'none' }],
  corrections: [{ correctionId: 10, sourceProductId: 3, successorProductId: 7, sourceInternalSku: 'OLD', successorInternalSku: 'CURRENT' }],
  issues: [{ code: 'SOURCE_CORRECTION_NOT_RECORDED', productId: 7, correctionId: 10, recordedCorrectionId: null }] };
function show(capabilities = ['export_templates.publish'], props = {}, roles = []) {
  return render(<AuthContext.Provider value={{ permissions: capabilities, roles, principalLifetime: { valid: true } }}><MemoryRouter><MagentoRecovery productId={7} {...props} /></MemoryRouter></AuthContext.Provider>);
}
beforeEach(() => { vi.resetAllMocks(); api.get.mockResolvedValue({ data: record }); api.post.mockResolvedValue({ data: reviewed }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const historicalRecord = { ...record, job: null, history: { ...history, historicalRecount: true },
  lifecycle: { suggestedKind: 'historical_recount_exposure', availableKinds: ['historical_recount_exposure'], legacyDeliveryEnabled: false },
  actions: { lifecycleRecovery: true, jobRecovery: false } };
const historicalPreview = { eligible: true, blockers: [], reviewHash: 'mixed-history-proof',
  requiredEvidence: { oldSkus: [], files: [], historicalConfirmation: true },
  review: { kind: 'historical_recount_exposure', payload: { productId: 7, sync: { remote: { id: 4256, sku: 'KL-CURRENT' },
    oldArticles: [{ sku: 'KL-OLD', status: 'not_found' }], problems: [] } } } };
it('mixed history offers an explicit current-only decision and recovers the exact original receipt after a lost response', async () => {
  api.get.mockResolvedValue({ data: historicalRecord });
  let attempts = 0;
  api.post.mockImplementation(async url => {
    if (url.endsWith('/lifecycle-preview')) return { data: historicalPreview };
    if (++attempts === 1) throw new Error('lost response');
    return { data: { nextAction: { kind: 'await_delivery' } } };
  });
  show(['exports.reconcile'], { guided: true });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  const action = await screen.findByRole('button', { name: 'Підтвердити товар і дозволити оновлення' });
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-recovery/products/7/lifecycle-preview', { kind: 'historical_recount_exposure' });
  expect(screen.getByText(/Magento №4256/)).toBeTruthy();expect(screen.getByText(/Старі артикули відсутні/)).toBeTruthy();
  expect(screen.queryByText('Далі — виправлення історії переобліку')).toBeNull();
  fireEvent.change(screen.getByLabelText('Що ви перевірили'), { target: { value: 'Перевірено: старі версії виведені з обігу, імпорти завершені' } });
  expect(action.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  expect(action.disabled).toBe(false);expect(api.post.mock.calls.some(([url]) => url.endsWith('/lifecycle-apply'))).toBe(false);
  fireEvent.click(action);
  expect(screen.getByRole('dialog').textContent).toContain('поставить її оновлення в чергу');
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Зберегти підтверджене рішення' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Отримати результат початкового рішення' }));
  await screen.findByText(/Оновлення цього товару поставлено в чергу/);
  const applies = api.post.mock.calls.filter(([url]) => url.endsWith('/lifecycle-apply'));
  expect(applies).toHaveLength(2);expect(applies[0][1]).toEqual(applies[1][1]);
  expect(applies[0][1].evidence).toEqual({ files: [], confirmation: { disposition: 'current_update_only', evidence: applies[0][1].reason } });
});
it('blocked category review gives the exact new category workspace and requires another preview after correction', async () => {
  api.get.mockResolvedValue({ data: historicalRecord });
  api.post.mockResolvedValue({ data: { ...historicalPreview, eligible: false, blockers: ['UPDATE_NOT_SENDABLE'],
    review: { ...historicalPreview.review, payload: { ...historicalPreview.review.payload, sync: { ...historicalPreview.review.payload.sync,
      problems: [{ code: 'CATEGORY_IDENTITIES_REVIEW_REQUIRED', message: 'Категорія Magento існує, але зв’язок ще не підтверджено.', target: 'categories' }] } } } } });
  show(['exports.reconcile','export_templates.view'], { guided: true, categoryCode: 'KL' });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  const link = await screen.findByRole('link', { name: 'Перевірити відповідність категорії' });
  expect(link.getAttribute('href')).toContain('/admin/magento/categories/KL?view=placement');
  expect(link.getAttribute('href')).toContain('productId=7');expect(link.getAttribute('href')).toContain('returnTo=');
  expect(screen.queryByRole('checkbox')).toBeNull();expect(screen.queryByRole('button', { name: 'Підтвердити товар і дозволити оновлення' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Повторити перевірку після виправлення' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
});
it('a surviving old Magento article is named and never offers current-only confirmation', async () => {
  api.get.mockResolvedValue({ data: historicalRecord });
  api.post.mockResolvedValue({ data: { ...historicalPreview, eligible: false, blockers: ['HISTORICAL_ARTICLE_STILL_PRESENT'],
    review: { ...historicalPreview.review, payload: { ...historicalPreview.review.payload, sync: { ...historicalPreview.review.payload.sync,
      oldArticles: [{ sku: 'KL-OLD', status: 'found', id: 41 }] } } } } });
  show(['exports.reconcile'], { guided: true });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  await screen.findByText(/також є в Magento · №41/);
  expect(screen.getByText(/Спочатку потрібно визначити, що робити зі старим товаром/)).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();expect(api.post).toHaveBeenCalledTimes(1);
});

it('historical changed articles show exact versions, Magento results and a report instead of an unsuitable confirmation', async () => {
  api.get.mockResolvedValue({ data: { ...record, job: null, history, lifecycle: { suggestedKind: null, availableKinds: [], legacyDeliveryEnabled: false }, actions: { jobRecovery: false, lifecycleRecovery: true } } });
  api.post.mockResolvedValue({ data: { history, remote: [{ article: 'KL-OLD', status: 'found', id: 42 }, { article: 'KL-CURRENT', status: 'not_found' }], observedAt: '2026-10-04T00:00:00Z', stale: false } });
  const writeText = vi.fn().mockResolvedValue(); vi.stubGlobal('navigator', { clipboard: { writeText } });
  show(['exports.reconcile', 'history.view'], { guided: true });
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  await screen.findByText('Є в Magento · ID 42');
  expect(screen.getByText('Немає в Magento')).toBeTruthy();
  expect(screen.getByText(/Переоблік №10 збережений, але для KL-CURRENT/)).toBeTruthy();
  expect(screen.getByText('Далі — виправлення історії переобліку')).toBeTruthy();
  expect(screen.getAllByRole('link', { name: 'Історія цієї версії' })).toHaveLength(2);
  expect(screen.queryByText('Підтвердити товар після переобліку')).toBeNull();
  expect(screen.queryByText('Для поточного стану немає окремого дозволеного рішення щодо історії доставки. Перевірте актуальну причину в товарі.')).toBeNull();
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-recovery/products/7/history-inspect', {});
  fireEvent.click(screen.getByRole('button', { name: 'Копіювати звіт для виправлення' }));
  await screen.findByText(/Звіт скопійовано/);
  const report = writeText.mock.calls[0][0];
  expect(report).toContain('KL-OLD'); expect(report).toContain('KL-CURRENT'); expect(report).toContain('SOURCE_CORRECTION_NOT_RECORDED');
  expect(report).toContain('Є в Magento · ID 42');
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти звіт у файл' }));
  const [blob, fileName] = downloadBlob.mock.calls[0];
  expect(fileName).toBe('magento-product-7-history.txt');
  const contents = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });
  expect(contents).toBe(report);
  expect(api.post.mock.calls.some(([url]) => url.endsWith('lifecycle-apply'))).toBe(false);
  vi.unstubAllGlobals();
});

it('a stale historical inspection retains its evidence and explicitly requires a new check', async () => {
  api.get.mockResolvedValue({ data: { ...record, job: null, history, lifecycle: { availableKinds: [], legacyDeliveryEnabled: false }, actions: { lifecycleRecovery: true } } });
  api.post.mockResolvedValue({ data: { history, stale: true, remote: [{ article: 'KL-OLD', status: 'lookup_error' }] } });
  show(['exports.reconcile'], { guided: true });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  await screen.findByText(/Дані товару змінилися під час перевірки/);
  expect(screen.getByText('Не вдалося перевірити')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Повторити перевірку артикулів у Magento' })).toBeTruthy();
  expect(api.post.mock.calls.some(([url]) => url.endsWith('/lifecycle-preview') || url.endsWith('/lifecycle-apply'))).toBe(false);
});

it('a failed history lookup leaves the exact local diagnosis and concrete report available', async () => {
  api.get.mockResolvedValue({ data: { ...record, job: null, history, lifecycle: { availableKinds: [], legacyDeliveryEnabled: false }, actions: { lifecycleRecovery: true } } });
  api.post.mockRejectedValue(new Error('unavailable'));
  show(['exports.reconcile'], { guided: true });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  await screen.findByText(/Не вдалося отримати підтверджений результат/);
  expect(screen.getByText('KL-OLD')).toBeTruthy();
  expect(screen.getByText('KL-CURRENT')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Зберегти звіт у файл' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Історія цієї версії' })).toBeNull();
});

it('an exclusion decision is separate from historical repair and does not offer a premature resync', async () => {
  api.get.mockResolvedValue({ data: { ...record, job: null, history, lifecycle: { suggestedKind: 'release_exclusion', availableKinds: ['release_exclusion'], legacyDeliveryEnabled: false }, actions: { lifecycleRecovery: true } } });
  api.post.mockImplementation(async url => ({ data: url.endsWith('/history-inspect') ? { history, remote: [], stale: false }
    : url.endsWith('/lifecycle-preview') ? { review: { kind: 'release_exclusion', payload: { productId: 7 } }, eligible: true, blockers: [], reviewHash: 'policy-proof' }
      : { nextAction: { kind: 'review_history', productId: 7 } } }));
  show(['exports.reconcile'], { guided: true });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Переглянути виключення поточного товару' }));
  fireEvent.change(await screen.findByLabelText('Підстава рішення'), { target: { value: 'Підтверджено дозвіл на синхронізацію' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зняти виключення із синхронізації' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Зберегти підтверджене рішення' }));
  await screen.findByRole('button', { name: 'Перевірити наступний крок' });
  expect(screen.queryByRole('button', { name: 'Переглянути оновлення товару' })).toBeNull();
  expect(api.post.mock.calls.filter(([url]) => url.endsWith('/lifecycle-apply'))).toHaveLength(1);
});

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
