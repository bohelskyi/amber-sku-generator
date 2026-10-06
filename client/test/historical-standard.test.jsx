import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoricalReactivationReview } from '../src/components/app/HistoricalReactivationReview.jsx';
import { createHistoricalReactivationApi } from '../src/api/historical-reactivation-api.js';
import { historicalConfirmation, validateHistoricalPreview, validateHistoricalReceipt, validateHistoricalInspection, canUseHistoricalReactivation } from '../src/lib/historical-reactivation.js';
import { batchId, intentId, makeAuth, makeReceipt as atomicReceipt } from './historical-fixtures.js';

const protocol = 'standard-rest-v1';
const nativeJobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const createIntentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const config = { historicalReactivation: { available: true, administratorOnly: true, format: 'historical-reactivation-standard-v1', protocol, maxItems: 100, createTargetStatus: 2 } };
const review = () => ({ format: config.historicalReactivation.format, protocol, skus: ['UPDATE', 'CREATE', 'MISSING'], reviewNonce: batchId,
  reviewHash: 'a'.repeat(64), reviewToken: 'synthetic-signed-review', reviewExpiresAt: new Date(Date.now() + 300000).toISOString(), counts: { eligible: 2, blocked: 1, skipped: 0 },
  items: [
    { protocol, inputSku: 'UPDATE', article: 'UPDATE', productId: 1, disposition: 'eligible', priorFacts: 'unknown', remoteProductId: 51,
      observedRemoteStatus: 1, observedRemoteVisibility: 4, targetStatus: 1, targetVisibility: 4, deliveryMode: 'update', requiresExplicitCreate: false,
      deliveryPlanHash: 'b'.repeat(64), currentPriceUah: 1200, prerequisites: [{ code: 'CURRENT_DELIVERY_PLAN_VALID', met: true }], blockerCodes: [] },
    { protocol, inputSku: 'CREATE', article: 'CREATE', productId: 2, disposition: 'eligible', priorFacts: 'unknown', remoteProductId: null,
      observedRemoteStatus: null, observedRemoteVisibility: null, targetStatus: 2, targetVisibility: 1, deliveryMode: 'create', requiresExplicitCreate: true,
      deliveryPlanHash: 'c'.repeat(64), currentPriceUah: 1500, prerequisites: [{ code: 'CURRENT_DELIVERY_PLAN_VALID', met: true }], blockerCodes: [] },
    { protocol, inputSku: 'MISSING', disposition: 'blocked', priorFacts: 'unknown', reasonCode: 'HISTORICAL_PRODUCT_NOT_FOUND', prerequisites: [], blockerCodes: ['HISTORICAL_PRODUCT_NOT_FOUND'] },
  ] });
const item = (state = 'queued', create = false) => ({ protocol, intentId: create ? createIntentId : intentId, productId: create ? 2 : 1, article: create ? 'CREATE' : 'UPDATE', state,
  deliveryMode: create ? 'create' : 'update', targetStatus: create ? 2 : 1, targetVisibility: create ? 1 : 4, remoteProductId: create ? null : 51, nativeJobId,
  confirmedRemoteProductId: state === 'completed' ? create ? 52 : 51 : null, hiddenVerifiedAt: null, deliveryVerifiedAt: state === 'completed' ? '2026-10-05T10:00:00Z' : null,
  nativeConfirmedAt: state === 'completed' ? '2026-10-05T10:00:00Z' : null, localActivatedAt: state === 'completed' ? '2026-10-05T10:00:01Z' : null,
  cancelledAt: state === 'cancelled' ? '2026-10-05T10:00:00Z' : null, reasonCode: null });
const receipt = (state = 'queued', create = false) => ({ protocol, batchId, createdAt: '2026-10-05T09:00:00Z', items: [item(state, create)] });
const inspection = (permissions = {}) => ({ ...item('delivering'), canConfirm: false, canCancel: false, canContinue: false, canReconcile: false,
  recoveryReview: { jobId: nativeJobId, complete: true, steps: [], blockers: [] }, recoveryReviewHash: 'd'.repeat(64), ...permissions });
let auth, client;
vi.mock('../src/auth/auth-context.js', () => ({ useAuth: () => auth }));
beforeEach(() => { auth = makeAuth(); client = { preview: vi.fn().mockResolvedValue({ data: review() }), confirm: vi.fn().mockResolvedValue({ data: receipt() }),
  status: vi.fn().mockResolvedValue({ data: receipt() }), inspect: vi.fn().mockResolvedValue({ data: inspection() }), reconcile: vi.fn().mockResolvedValue({ data: item('completed') }),
  cancel: vi.fn().mockResolvedValue({ data: item('cancelled') }) }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const mount = (props = {}) => render(<HistoricalReactivationReview open config={config} apiClient={client} createRequestId={() => batchId} {...props} />);
async function preview() { fireEvent.change(screen.getByLabelText('Точні артикули, по одному в рядку'), { target: { value: 'UPDATE\nCREATE\nMISSING' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товари' })); await screen.findByText('Можна відновити: 2. Потребують уваги: 1.'); }
async function confirmUpdate() { fireEvent.click(screen.getByRole('checkbox', { name: 'Обрати UPDATE' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Погоджую/ })); fireEvent.click(screen.getByRole('button', { name: 'Відновити вибране (1)' })); }

it('accepts the new closed capability only with actual Administrator and each effective permission', () => {
  expect(canUseHistoricalReactivation(auth, config)).toBe(true);
  expect(canUseHistoricalReactivation({ ...auth, roles: [{ key: 'manager' }] }, config)).toBe(false);
  for (const permission of auth.permissions) expect(canUseHistoricalReactivation({ ...auth, permissions: auth.permissions.filter((value) => value !== permission) }, config)).toBe(false);
  expect(canUseHistoricalReactivation(auth, { historicalReactivation: { ...config.historicalReactivation, protocol: 'unknown' } })).toBe(false);
});
it('preserves independent UPDATE status/visibility and requires exact separate CREATE consent', () => {
  const value = review(); expect(validateHistoricalPreview(value)).toBe(value);
  const command = historicalConfirmation(value, ['UPDATE'], batchId);
  expect(command).toMatchObject({ selectedSkus: ['UPDATE'], selectedCreateSkus: [], confirmCurrentFactsAndStandardDelivery: true });
  expect(command.confirmCurrentFactsAndHiddenUpdate).toBeUndefined();
  expect(() => historicalConfirmation(value, ['CREATE'], batchId)).toThrow(/Окремо підтвердіть CREATE/);
  expect(historicalConfirmation(value, ['CREATE'], batchId, Date.now(), ['CREATE']).selectedCreateSkus).toEqual(['CREATE']);
  for (const change of [(r) => { r.items[0].targetStatus = 2; }, (r) => { r.items[0].targetVisibility = 1; },
    (r) => { r.items[1].requiresExplicitCreate = false; }, (r) => { r.items[1].remoteProductId = 9; }]) { const r = review(); change(r); expect(() => validateHistoricalPreview(r)).toThrow(); }
});
it('keeps old atomic receipts readable but rejects fabricated standard hidden/remote/job completion proof', () => {
  expect(validateHistoricalReceipt(atomicReceipt('completed')).items[0].hiddenVerifiedAt).toBeTruthy();
  expect(validateHistoricalReceipt(receipt('completed')).items[0].hiddenVerifiedAt).toBeNull();
  for (const change of [(r) => { r.items[0].hiddenVerifiedAt = '2026-10-05T10:00:00Z'; }, (r) => { r.items[0].nativeJobId = null; },
    (r) => { r.items[0].confirmedRemoteProductId = 52; }, (r) => { r.items[0].deliveryVerifiedAt = null; }]) { const r = receipt('completed'); change(r); expect(() => validateHistoricalReceipt(r)).toThrow(); }
  expect(() => validateHistoricalInspection(inspection({ canReconcile: true, recoveryReview: { jobId: batchId } }), item())).toThrow();
});
it('opening is inert; UPDATE preserves reviewed status and visibility and submits only exact selected membership', async () => {
  mount(); expect(client.preview).not.toHaveBeenCalled(); await preview();
  expect(screen.getByText(/Оновимо наявний товар у Magento. Він залишиться увімкненим; видимість — каталог і пошук./)).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'Обрати MISSING' }).disabled).toBe(true);
  await confirmUpdate(); await screen.findByText('Результати відновлення');
  expect(client.confirm.mock.calls[0][0]).toMatchObject({ selectedSkus: ['UPDATE'], selectedCreateSkus: [], confirmCurrentFactsAndStandardDelivery: true, idempotencyKey: batchId });
  expect(screen.getByText(nativeJobId)).toBeTruthy(); expect(screen.queryByText(/Прихований стан 2 перевірено/)).toBeNull();
});
it('select all never implies CREATE consent; only explicit per-article consent enables submission', async () => {
  client.confirm.mockResolvedValue({ data: receipt('queued', true) }); mount(); await preview();
  fireEvent.click(screen.getByRole('button', { name: 'Обрати всі дозволені (2)' }));
  expect(screen.getByRole('checkbox', { name: 'Окремо дозволити CREATE CREATE' }).checked).toBe(false);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Обрати UPDATE' })); fireEvent.click(screen.getByRole('checkbox', { name: /Погоджую/ }));
  expect(screen.getByRole('button', { name: 'Відновити вибране (1)' }).disabled).toBe(true); expect(client.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Окремо дозволити CREATE CREATE' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Погоджую/ })); fireEvent.click(screen.getByRole('button', { name: 'Відновити вибране (1)' }));
  await screen.findByText('Результати відновлення'); expect(client.confirm.mock.calls[0][0].selectedCreateSkus).toEqual(['CREATE']);
});
it('lost confirmation and GET404 preserve original UUID and never resend or allow cancellation/reset', async () => {
  client.confirm.mockRejectedValueOnce(new Error('lost')); client.status.mockRejectedValueOnce({ response: { status: 404 } }); mount(); await preview(); await confirmUpdate();
  await screen.findByText(/Результат ще не підтверджено. Список/); fireEvent.click(screen.getByRole('button', { name: 'Перевірити стан цього самого рішення' }));
  await screen.findByText(/Операцію за цим номером ще не знайдено/); expect(client.confirm).toHaveBeenCalledTimes(1); expect(client.cancel).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Новий перелік для окремої перевірки' })).toBeNull();
});
it('exact fresh inspection and consent record GET-only reconciliation using the original native job review', async () => {
  client.inspect.mockResolvedValue({ data: inspection({ canReconcile: true }) }); mount(); await preview(); await confirmUpdate();
  await screen.findByText('Результати відновлення'); fireEvent.click(screen.getByRole('button', { name: 'Перевірити первісну доставку для UPDATE' }));
  const button = await screen.findByRole('button', { name: 'Записати перевірений результат і завершити локальне рішення' }); expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /Підтверджую локальне завершення/ })); fireEvent.click(button);
  await screen.findByText('Первісну доставку та окрему локальну активацію підтверджено.');
  expect(client.reconcile).toHaveBeenCalledExactlyOnceWith(intentId, { review: inspection().recoveryReview, reviewHash: 'd'.repeat(64), reason: expect.any(String) });
  expect(client.confirm).toHaveBeenCalledTimes(1); expect(client.cancel).not.toHaveBeenCalled();
});
it('only exact canCancel plus acknowledgement cancels before dispatch; cancellation permits a separate fresh review', async () => {
  client.confirm.mockResolvedValue({ data: receipt('blocked') }); client.inspect.mockResolvedValue({ data: { ...inspection({ canCancel: true }), state: 'blocked' } });
  mount(); await preview(); await confirmUpdate(); await screen.findByText('Результати відновлення');
  expect(screen.queryByRole('button', { name: 'Новий перелік для окремої перевірки' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити первісну доставку для UPDATE' }));
  const button = await screen.findByRole('button', { name: 'Скасувати ненадіслане рішення' }); expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /Скасувати тільки первісне рішення/ })); fireEvent.click(button);
  await screen.findByText(/Рішення скасовано до початку доставки/); expect(client.cancel).toHaveBeenCalledExactlyOnceWith(intentId);
  expect(screen.getByRole('button', { name: 'Новий перелік для окремої перевірки' })).toBeTruthy();
});
it('started or uncertain delivery exposes only original-job inspection; no cancellation or retry/reset is invented', async () => {
  client.confirm.mockResolvedValue({ data: receipt('delivering') }); client.inspect.mockResolvedValue({ data: inspection({ canContinue: true }) });
  mount(); await preview(); await confirmUpdate(); await screen.findByText('Результати відновлення');
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити первісну доставку для UPDATE' })); await screen.findByText(/Потрібне окреме перевірене продовження/);
  expect(screen.queryByRole('button', { name: 'Скасувати ненадіслане рішення' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Новий перелік для окремої перевірки' })).toBeNull();
  expect(client.cancel).not.toHaveBeenCalled(); expect(client.reconcile).not.toHaveBeenCalled(); expect(client.confirm).toHaveBeenCalledTimes(1);
});
it('lost cancel reply holds uncertainty and recovers only the same original batch with GET', async () => {
  client.confirm.mockResolvedValue({ data: receipt('blocked') }); client.inspect.mockResolvedValue({ data: { ...inspection({ canCancel: true }), state: 'blocked' } });
  client.cancel.mockRejectedValueOnce(new Error('lost cancellation')); client.status.mockResolvedValueOnce({ data: receipt('cancelled') });
  mount(); await preview(); await confirmUpdate(); await screen.findByText('Результати відновлення'); fireEvent.click(screen.getByRole('button', { name: 'Перевірити первісну доставку для UPDATE' }));
  await screen.findByRole('button', { name: 'Скасувати ненадіслане рішення' }); fireEvent.click(screen.getByRole('checkbox', { name: /Скасувати тільки первісне рішення/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати ненадіслане рішення' })); await screen.findByText(/Результат ще не підтверджено. Список/);
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити стан цього самого рішення' })); await screen.findByText(/Рішення скасовано до початку доставки/);
  expect(client.cancel).toHaveBeenCalledTimes(1); expect(client.status).toHaveBeenCalledWith(batchId, {});
});
it('standard transport separates explicit confirmation, GET inspection, local reconciliation and no-dispatch cancel', async () => {
  const transport = { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn().mockResolvedValue({ data: {} }) }; const api = createHistoricalReactivationApi(transport);
  await api.status(batchId); await api.inspect(intentId); const checked = { review: inspection().recoveryReview, reviewHash: 'd'.repeat(64), reason: 'Exact original result' };
  await api.reconcile(intentId, checked); await api.cancel(intentId);
  expect(transport.get.mock.calls).toEqual([['/products/historical-reactivation/batches/' + batchId, {}], ['/products/historical-reactivation/intents/' + intentId + '/inspection', {}]]);
  expect(transport.post.mock.calls).toEqual([['/products/historical-reactivation/reconcile', { intentId, ...checked }], ['/products/historical-reactivation/cancel', { intentId, confirmNoDispatchCancellation: true }]]);
  await waitFor(() => expect(transport.post).toHaveBeenCalledTimes(2));
});

it('a mismatched native job cannot authorize reconciliation or cancellation', async () => {
  client.inspect.mockResolvedValue({ data: inspection({ nativeJobId: batchId, canReconcile: true }) });
  mount(); await preview(); await confirmUpdate(); await screen.findByText('Результати відновлення');
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити первісну доставку для UPDATE' }));
  await screen.findByText(/Сервер повернув неповну перевірку/);
  expect(screen.queryByRole('button', { name: 'Записати перевірений результат і завершити локальне рішення' })).toBeNull();
  expect(client.reconcile).not.toHaveBeenCalled(); expect(client.cancel).not.toHaveBeenCalled();
});
it('failed fresh inspection discards an earlier no-dispatch cancellation acknowledgement', async () => {
  client.confirm.mockResolvedValue({ data: receipt('blocked') }); client.inspect.mockResolvedValueOnce({ data: { ...inspection({ canCancel: true }), state: 'blocked' } });
  mount(); await preview(); await confirmUpdate(); await screen.findByText('Результати відновлення');
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити первісну доставку для UPDATE' }));
  await screen.findByRole('button', { name: 'Скасувати ненадіслане рішення' }); fireEvent.click(screen.getByRole('checkbox', { name: /Скасувати тільки первісне рішення/ }));
  client.inspect.mockRejectedValueOnce(new Error('fresh check failed')); fireEvent.click(screen.getByRole('button', { name: 'Перевірити первісну доставку для UPDATE' }));
  await screen.findByText('fresh check failed'); expect(screen.queryByRole('button', { name: 'Скасувати ненадіслане рішення' })).toBeNull(); expect(client.cancel).not.toHaveBeenCalled();
});
it('a changed immutable job in status recovery stays uncertain and cannot replace the accepted original receipt', async () => {
  client.confirm.mockResolvedValue({ data: receipt('blocked') }); const changed = receipt('blocked'); changed.items[0].nativeJobId = batchId;
  client.status.mockResolvedValueOnce({ data: changed }); mount(); await preview(); await confirmUpdate(); await screen.findByText('Результати відновлення');
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити стан цього самого рішення' }));
  await screen.findByText(/Первісний план або номер задачі доставки не збігається/);
  expect(screen.getByText(/Результат ще не підтверджено. Список/)).toBeTruthy();
  expect(screen.getByText(nativeJobId)).toBeTruthy(); expect(client.confirm).toHaveBeenCalledTimes(1); expect(client.cancel).not.toHaveBeenCalled();
});
it('a failed status read clears prior cancellation approval and requires another explicit inspection', async () => {
  client.confirm.mockResolvedValue({ data: receipt('blocked') }); client.inspect.mockResolvedValue({ data: { ...inspection({ canCancel: true }), state: 'blocked' } });
  mount(); await preview(); await confirmUpdate(); await screen.findByText('Результати відновлення');
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити первісну доставку для UPDATE' }));
  await screen.findByRole('button', { name: 'Скасувати ненадіслане рішення' }); fireEvent.click(screen.getByRole('checkbox', { name: /Скасувати тільки первісне рішення/ }));
  client.status.mockRejectedValueOnce(new Error('status unavailable')); fireEvent.click(screen.getByRole('button', { name: 'Перевірити стан цього самого рішення' }));
  await screen.findByText('status unavailable'); expect(screen.queryByRole('button', { name: 'Скасувати ненадіслане рішення' })).toBeNull(); expect(client.cancel).not.toHaveBeenCalled();
});
it('permission revocation during cancellation reveals no result and permits only original GET recovery after regrant', async () => {
  client.confirm.mockResolvedValue({ data: receipt('blocked') }); client.inspect.mockResolvedValue({ data: { ...inspection({ canCancel: true }), state: 'blocked' } });
  let resolve; client.cancel.mockImplementationOnce(() => new Promise((done) => { resolve = done; })); client.status.mockResolvedValue({ data: receipt('cancelled') });
  const view = mount(); await preview(); await confirmUpdate(); await screen.findByText('Результати відновлення');
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити первісну доставку для UPDATE' }));
  await screen.findByRole('button', { name: 'Скасувати ненадіслане рішення' }); fireEvent.click(screen.getByRole('checkbox', { name: /Скасувати тільки первісне рішення/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати ненадіслане рішення' })); await waitFor(() => expect(client.cancel).toHaveBeenCalledTimes(1));
  auth = { ...auth, permissions: [] }; view.rerender(<HistoricalReactivationReview open config={config} apiClient={client} createRequestId={() => batchId} />);
  await act(async () => resolve({ data: item('cancelled') })); expect(screen.queryByText(/Рішення скасовано до початку доставки/)).toBeNull();
  auth = { ...auth, permissions: makeAuth().permissions }; view.rerender(<HistoricalReactivationReview open config={config} apiClient={client} createRequestId={() => batchId} />);
  await screen.findByText(/Результат ще не підтверджено. Список/); fireEvent.click(screen.getByRole('button', { name: 'Перевірити стан цього самого рішення' }));
  await screen.findByText(/Рішення скасовано до початку доставки/); expect(client.cancel).toHaveBeenCalledTimes(1); expect(client.status).toHaveBeenCalledWith(batchId, {});
});
it('original UUID lookup under the new capability renders the old atomic receipt and its own protocol facts', async () => {
  client.status.mockResolvedValueOnce({ data: atomicReceipt('completed') }); mount();
  fireEvent.click(screen.getByText('Знайти попередню операцію'));
  fireEvent.change(screen.getByLabelText('Номер операції UUID'), { target: { value: batchId } });
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати стан рішення' }));
  await screen.findByText('Приховування, локальне рішення та UPDATE підтверджено. Новий бажаний стан — прихований 2.');
  const protocolDetails = screen.getByText('Правила й історія цієї операції').closest('details');
  expect(protocolDetails.open).toBe(false); fireEvent.click(protocolDetails.querySelector('summary'));
  expect(screen.getByText(/Дозволений лише UPDATE точного існуючого відповідника Magento/)).toBeTruthy();
  expect(screen.queryByText(/Передавання використовує звичайну доставку Magento/)).toBeNull();
  expect(client.preview).not.toHaveBeenCalled(); expect(client.confirm).not.toHaveBeenCalled(); expect(client.cancel).not.toHaveBeenCalled();
});


it('compact review keeps the exact decision visible and evidence closed without inferring an unknown title', async () => {
  const checked = review(); checked.items[0].currentName = 'Підтверджена назва';
  client.preview.mockResolvedValueOnce({ data: checked }); mount(); await preview();
  expect(screen.getByText('Підтверджена назва')).toBeTruthy();
  expect(screen.getAllByText('Назву не підтверджено')).toHaveLength(2);
  expect(screen.getByText(/У Magento товар не знайдено. Створимо його під тим самим артикулом, вимкненим для продажу/)).toBeTruthy();
  const detail = screen.getByText(/Точний Magento ID: 51/).closest('details');
  expect(detail.open).toBe(false);
  expect(screen.getByLabelText('Точні артикули, по одному в рядку').closest('details').open).toBe(false);
  expect(screen.getByText('Умови відновлення та історія').closest('details').open).toBe(false);
  fireEvent.click(detail.querySelector('summary')); expect(detail.open).toBe(true);
  expect(client.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Обрати CREATE' }));
  expect(screen.getByRole('button', { name: 'Відновити вибране (1)' }).disabled).toBe(true);
  expect(screen.getByRole('checkbox', { name: 'Окремо дозволити CREATE CREATE' }).checked).toBe(false);
});

it('optional reviewed name is text evidence and cannot turn missing or blocked products into selectable targets', () => {
  for (const badName of [42, {}, [], '   ']) {
    const checked = review(); checked.items[0].currentName = badName;
    expect(() => validateHistoricalPreview(checked)).toThrow();
  }
  const checked = review(); checked.items[2].currentName = 'Назва зі старої перевірки';
  expect(validateHistoricalPreview(checked).items[2].disposition).toBe('blocked');
});
