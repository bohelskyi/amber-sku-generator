import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { MagentoRecovery } from '../src/components/attention/MagentoRecovery.jsx';
import MagentoFirstSyncFields from '../src/components/attention/MagentoFirstSyncFields.jsx';
import MagentoPublicationProblems from '../src/components/workspace/MagentoPublicationProblems.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const permissions = ['exports.reconcile', 'export_templates.view', 'export_templates.manage', 'export_templates.publish', 'exports.view'];
const auth = { permissions, roles: [{ key: 'administrator' }], principalLifetime: { id: 'operator', valid: true } };
const binding = 'fed6b54b-88ae-4bfb-ad52-bc84db493e34';
const token = 'a'.repeat(64);
const recoveryRecord = { productId: 7, article: 'AG-000007', job: null,
  lifecycle: { suggestedKind: 'stable_recount_exposure', availableKinds: ['stable_recount_exposure'], legacyDeliveryEnabled: false },
  actions: { lifecycleRecovery: true, jobRecovery: false } };
const recoveryPlan = (blockers, problems = []) => ({ eligible: false, blockers, reviewHash: 'original-read-proof',
  review: { kind: 'stable_recount_exposure', payload: { productId: 7, sync: { problems } } } });
const firstPlan = (overrides = {}) => ({ mode: 'review', sku: 'AG-000007', fields: [], blockers: [],
  coverage: { fullProductAdoption: false }, readyForOutbound: false, complete: false, ...overrides });
function show(child, principal = auth) {
  return render(<AuthContext.Provider value={principal}><MemoryRouter>{child}</MemoryRouter></AuthContext.Provider>);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function openRecovery(plan) {
  const pending = deferred();
  api.get.mockResolvedValue({ data: recoveryRecord });
  api.post.mockImplementation(url => {
    if (url === '/admin/magento-recovery/products/7/lifecycle-preview') return pending.promise;
    throw new Error(`Unexpected POST ${url}`);
  });
  show(<MagentoRecovery productId={7} categoryCode="KL" guided />);
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-recovery/products/7/lifecycle-preview', { kind: 'stable_recount_exposure' }));
  await act(async () => { pending.resolve({ data: plan }); });
  await screen.findByText('Застосування заблоковане:');
}
beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockImplementation(url => { throw new Error(`Unexpected GET ${url}`); });
  api.post.mockImplementation(url => { throw new Error(`Unexpected POST ${url}`); });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([
  ['DURABLE_REMOTE_ID_REQUIRED', 'Не підтверджено ідентичність товару Magento', 'Передайте артикул відповідальному за інтеграцію'],
  ['PREDECESSOR_NOT_RETIRED', 'Попередню версію ще не виведено з обігу', 'Передайте її відповідальному оператору'],
  ['LOCAL_EVIDENCE_CHANGED', 'Дані Amber змінилися під час перевірки', 'Повторіть перевірку й перегляньте новий результат'],
  ['UPDATE_NOT_SENDABLE', 'Оновлення товару ще не готове', 'Перегляньте наведені нижче причини'],
])('explains actual lifecycle string blocker %s without authorizing a write', async (code, title, next) => {
  const plan = recoveryPlan([code]); const original = JSON.stringify(plan);
  await openRecovery(plan);
  const item = screen.getByText(title, { exact: false }).closest('li');
  expect(item.textContent).toContain(next);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Дозволити оновлення після переобліку' })).toBeNull();
  expect(screen.queryByText(code)).toBeNull();
  fireEvent.click(screen.getByText('Дані перевірки доставки для підтримки'));
  expect(screen.getByText(/"blockers":/).textContent).toContain(code);
  expect(JSON.stringify(plan)).toBe(original);
  expect(api.post).toHaveBeenCalledTimes(1);
});

it.each(['FUTURE_RECOVERY_CODE', 'constructor', 'toString', 'LOCAL_EVIDENCE_CHANGED: detail'])('keeps unknown lifecycle code %s neutral and available as technical evidence', async code => {
  await openRecovery(recoveryPlan([code]));
  expect(screen.getByText(/Наявних підтверджень недостатньо для цього рішення/)).toBeTruthy();
  expect(screen.queryByText(/Повторіть перевірку й перегляньте новий результат/)).toBeNull();
  fireEvent.click(screen.getByText('Дані перевірки доставки для підтримки'));
  expect(screen.getByText(/"blockers":/).textContent).toContain(code);
  expect(api.post).toHaveBeenCalledTimes(1);
});

it.each([{}, { message: 'PRODUCT_EVALUATION_NOT_READY' }])('uses the raw nested sync.problems fallback while retaining concrete messages, exact links and original evidence %#', async rawMessage => {
  const problems = [
    { code: 'PRODUCT_EVALUATION_NOT_READY', target: 'weight', ...rawMessage },
    { code: 'PRODUCT_EVALUATION_NOT_READY', target: 'name', message: 'Потрібна ручна назва для цього конкретного товару.' },
    { code: 'UNKNOWN_PRODUCT_PROBLEM', target: 'price' },
  ];
  const plan = recoveryPlan(['UPDATE_NOT_SENDABLE'], problems); const original = JSON.stringify(plan);
  await openRecovery(plan);
  const section = screen.getByRole('region', { name: 'Що виправити перед підтвердженням' });
  expect(within(section).getByText(/Дані товару не готові до синхронізації/).textContent).toContain('Перевірте зазначені поля товару та їхні правила.');
  expect(within(section).getByText(problems[1].message)).toBeTruthy();
  expect(within(section).getByText('Перевірте відповідність цього поля.')).toBeTruthy();
  const links = within(section).getAllByRole('link', { name: 'Переглянути збережені підтвердження' });
  expect(links.map(link => link.getAttribute('href'))).toEqual([
    '/admin/catalog?view=attributes&productId=7&category=KL&field=weight&returnTo=%2Fattention%3Fproblem%3D7',
    '/admin/catalog?view=text&productId=7&category=KL&field=name&returnTo=%2Fattention%3Fproblem%3D7',
    '/admin/catalog?view=attributes&productId=7&category=KL&field=price&returnTo=%2Fattention%3Fproblem%3D7',
  ]);
  fireEvent.click(screen.getByText('Дані перевірки доставки для підтримки'));
  const raw = JSON.parse(screen.getByText(/"blockers":/).textContent);
  expect(raw.review.payload.sync.problems).toEqual(problems);
  expect(JSON.stringify(plan)).toBe(original); expect(api.post).toHaveBeenCalledTimes(1);
});

it('explains a real reconciliation 409 without treating it as an automatic retry or applying a new decision', async () => {
  api.get.mockResolvedValue({ data: recoveryRecord });
  api.post.mockRejectedValue({ response: { status: 409, data: { code: 'EXPOSURE_RECONCILIATION_CONFLICT', error: 'Conflict' } } });
  show(<MagentoRecovery productId={7} guided />);
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товар у Magento' }));
  const error = await screen.findByRole('alert');
  expect(error.textContent).toContain('Не вдалося підтвердити історію доставки');
  expect(error.textContent).toContain('Прочитайте актуальний стан і перевірте підставу рішення заново.');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Оновити перевірку товару' }).disabled).toBe(false));
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-recovery/products/7/lifecycle-preview', { kind: 'stable_recount_exposure' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each([
  [{ blockers: [{ code: 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED' }] }, 'Потрібна перевірка історії товару', 'Перегляньте наведені причини'],
  [{ historyReviewAssessment: { status: 'blocked', code: 'FIRST_SYNC_HISTORY_COMPONENT_UNSUPPORTED' } }, 'Потрібне окреме узгодження історії', 'Історія або стан товару не відповідають умовам цієї перевірки.'],
])('explains the actual first-sync history DTO without inventing an admission action %#', async (details, title, explanation) => {
  const plan = firstPlan(details); const original = JSON.stringify(plan);
  api.get.mockResolvedValue({ data: { currentPublishedId: binding } }); api.post.mockResolvedValue({ data: plan });
  show(<MagentoFirstSyncFields sku="AG-000007" />);
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити актуальні поля' }));
  const text = await screen.findByText(title, { exact: false });
  expect(text.textContent).toContain(explanation);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Перевірити актуальні поля' }).disabled).toBe(false));
  expect(screen.queryByRole('button', { name: 'Переглянути допуск до полів' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/first-sync/preview', { sku: 'AG-000007', bindingRevisionId: binding }, { signal: expect.any(AbortSignal) });
  expect(screen.queryByText(details.historyReviewAssessment?.code || details.blockers[0].code)).toBeNull();
  fireEvent.click(screen.getByText('Межі перевірки й технічні причини'));
  const evidence = JSON.parse(screen.getByText(/"coverage":/).textContent);
  expect(evidence).toEqual({ mode: plan.mode, blockers: plan.blockers, coverage: plan.coverage, ...('historyReviewAssessment' in plan ? { historyReviewAssessment: plan.historyReviewAssessment } : {}) });
  expect(JSON.stringify(plan)).toBe(original);
});

it('retains explicit history admission, the original token and the separate follow-up read', async () => {
  api.get.mockResolvedValue({ data: { currentPublishedId: binding } });
  api.post.mockResolvedValueOnce({ data: firstPlan({ blockers: [{ code: 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED' }],
    historyReview: { sku: 'AG-000007', remoteProductId: 3732, scope: 'first_sync_review_only', doesNotAcknowledgeExport: true, previewToken: token } }) })
    .mockResolvedValueOnce({ data: { sku: 'AG-000007', scope: 'first_sync_review_only', doesNotAcknowledgeExport: true, receipt: { auditEventId: '4615', alreadyApplied: false } } });
  show(<MagentoFirstSyncFields sku="AG-000007" />);
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити актуальні поля' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Переглянути допуск до полів' }));
  expect(api.post).toHaveBeenCalledTimes(1);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Дозволити перегляд полів' }));
  await screen.findByText(/Тепер повторіть перевірку актуальних полів/);
  expect(api.post).toHaveBeenLastCalledWith('/admin/magento-integration/first-sync/history-apply', { sku: 'AG-000007', bindingRevisionId: binding, previewToken: token }, { signal: expect.any(AbortSignal) });
  expect(api.post).toHaveBeenCalledTimes(2); expect(api.get).toHaveBeenCalledTimes(1);
});

it('keeps first-sync history decisions unavailable without the actual Administrator role', () => {
  show(<MagentoFirstSyncFields sku="AG-000007" />, { ...auth, roles: [{ key: 'manager' }] });
  expect(screen.queryByRole('button', { name: 'Перевірити актуальні поля' })).toBeNull();
  expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});

it.each([
  [{ code: 'PRODUCT_EVALUATION_NOT_READY' }, 'Дані товару не готові до синхронізації'],
  [{ code: 'PRODUCT_EVALUATION_NOT_READY', evaluationIssues: [{ message: 'Вага вставки має бути додатною.' }] }, 'Вага вставки має бути додатною.'],
])('renders real structured publication diagnostics and copies unchanged raw reports %#', async (diagnostic, title) => {
  const writeText = vi.fn().mockResolvedValue(); vi.stubGlobal('navigator', { clipboard: { writeText } });
  const review = { blockers: [{ code: 'AFFECTED_CURRENT_PREVIEW_BLOCKED', productId: 7 }],
    checked: [{ kind: 'current', productId: 7, article: 'AG-000007', blockers: [diagnostic] }], affected: [{ productId: 7, article: 'AG-000007' }] };
  const revision = { id: binding, revision: 3, bindings: {} }; const original = JSON.stringify(review);
  show(<MagentoPublicationProblems review={review} revision={revision} currentPublishedId="published" />);
  expect(screen.getByText(title)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Відкрити проблему цього товару' }).getAttribute('href')).toBe('/attention?problem=7');
  fireEvent.click(screen.getByRole('button', { name: 'Копіювати причини блокування' }));
  await screen.findByText('Причини блокування скопійовано.');
  expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({ bindingRevisionId: binding, expectedRevision: 3, expectedCurrentId: 'published', blockers: review.blockers, checked: review.checked });
  expect(JSON.stringify(review)).toBe(original); expect(api.get).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});
