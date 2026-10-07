import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HistoricalReactivationReview } from '../src/components/app/HistoricalReactivationReview.jsx';
import { validateReviewOperation, storeOperation, readStoredOperation, operationStorageKey } from '../src/lib/historical-review-operation.js';
import { batchId, capability, makeAuth, makeReview, makeReceipt } from './historical-fixtures.js';
const previewId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let auth, client;
vi.mock('../src/auth/auth-context.js', () => ({ useAuth: () => auth }));
const envelope = (kind, state, result = null, extra = {}) => ({ format: 'historical-review-operation-v1', operationId: kind === 'preview' ? previewId : batchId,
  kind, state, skus: makeReview().skus, selectedSkus: kind === 'confirm' ? ['AR-000001'] : null,
  deadlineAt: new Date(Date.now() + 300000).toISOString(), progress: { phase: state, completed: state === 'ready' ? 3 : 0, total: 3 },
  result, failureCode: null, ...extra });
beforeEach(() => {
  sessionStorage.clear(); auth = { ...makeAuth(), applicationUser: { id: 49 } };
  client = { preview: vi.fn().mockResolvedValue({ data: envelope('preview', 'queued') }),
    confirm: vi.fn().mockResolvedValue({ data: envelope('confirm', 'queued') }),
    operation: vi.fn().mockResolvedValue({ data: envelope('preview', 'running') }),
    status: vi.fn().mockResolvedValue({ data: makeReceipt() }) };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); sessionStorage.clear(); });
const mount = (props = {}) => render(<HistoricalReactivationReview open config={capability} apiClient={client}
  createRequestId={() => client.preview.mock.calls.length ? batchId : previewId} {...props} />);
async function begin() {
  fireEvent.change(screen.getByLabelText('Точні артикули, по одному в рядку'), { target: { value: makeReview().skus.join('\n') } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товари' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Перевірка переліку: (у черзі|виконується)\./));
}
async function readReadyPreview() {
  client.operation.mockResolvedValueOnce({ data: envelope('preview', 'ready', makeReview()) });
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати прогрес цієї самої операції' }));
  await screen.findByText('Можна відновити: 2. Потребують уваги: 0. Пропущено: 1.');
}
it('registration locks input without selectable partial items; manual GET recovers the complete preview without another POST', async () => {
  mount(); expect(client.preview).not.toHaveBeenCalled(); await begin();
  expect(client.preview).toHaveBeenCalledExactlyOnceWith(makeReview().skus, previewId);
  expect(screen.getByLabelText('Точні артикули, по одному в рядку').disabled).toBe(true);
  expect(screen.queryByRole('checkbox', { name: 'Обрати AR-000001' })).toBeNull();
  await readReadyPreview(); expect(client.preview).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('checkbox', { name: 'Обрати AR-000001' }).checked).toBe(false);
  const stored = JSON.parse(sessionStorage.getItem(operationStorageKey(49)));
  expect(stored).toEqual({ operationId: previewId, kind: 'preview' });
  expect(JSON.stringify(stored)).not.toMatch(/signed|sku|csrf|reviewToken/i);
});
it('reload recovers the same preview by GET alone and a changed actor does not read another actor pointer', async () => {
  const view = mount(); await begin(); view.unmount();
  client.operation.mockResolvedValue({ data: envelope('preview', 'ready', makeReview()) });
  const recovered = mount(); await screen.findByRole('checkbox', { name: 'Обрати AR-000001' });
  expect(client.preview).toHaveBeenCalledTimes(1); expect(client.confirm).not.toHaveBeenCalled();
  const calls = client.operation.mock.calls.length;
  auth = { ...makeAuth(), applicationUser: { id: 50 } }; recovered.rerender(<HistoricalReactivationReview open config={capability} apiClient={client} />);
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Обрати AR-000001' })).toBeNull());
  expect(client.operation).toHaveBeenCalledTimes(calls);
});
it('lost preview reply and GET404 retain the immutable ID and never resend automatically', async () => {
  client.preview.mockRejectedValueOnce(new Error('lost reply'));
  client.operation.mockRejectedValue({ response: { status: 404 } }); mount();
  fireEvent.change(screen.getByLabelText('Точні артикули, по одному в рядку'), { target: { value: makeReview().skus.join('\n') } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товари' }));
  await screen.findByText(previewId);
  const progress = screen.getByRole('button', { name: 'Прочитати прогрес цієї самої операції' });
  await waitFor(() => expect(progress.disabled).toBe(false));
  fireEvent.click(progress);
  await waitFor(() => expect(client.operation).toHaveBeenCalledWith(previewId, {}));
  await screen.findByText(/Операцію за цим номером ще не знайдено/);
  expect(client.preview).toHaveBeenCalledTimes(1); expect(client.confirm).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Точні артикули, по одному в рядку').disabled).toBe(true);
});
it('automatic GET404 has the same recovery message and keeps manual reads busy until the pending GET settles', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let rejectPreview, rejectRead;
  client.preview.mockImplementationOnce(() => new Promise((resolve, reject) => { rejectPreview = reject; }));
  client.operation.mockImplementationOnce(() => new Promise((resolve, reject) => { rejectRead = reject; }));
  mount();
  fireEvent.change(screen.getByLabelText('Точні артикули, по одному в рядку'), { target: { value: makeReview().skus.join('\n') } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити товари' }));
  const progress = screen.getByRole('button', { name: 'Прочитати прогрес цієї самої операції' });
  expect(progress.disabled).toBe(true);
  expect(client.operation).not.toHaveBeenCalled();
  await act(async () => { rejectPreview(new Error('lost reply')); });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(client.operation).toHaveBeenCalledExactlyOnceWith(previewId, { signal: expect.any(AbortSignal) });
  const disabledDuringPolling = progress.disabled;
  fireEvent.click(progress);
  expect(client.operation).toHaveBeenCalledTimes(1);
  await act(async () => { rejectRead({ response: { status: 404 } }); });
  expect(screen.getByRole('alert').textContent).toBe('Операцію за цим номером ще не знайдено. Повторне підтвердження не надсилатиметься.');
  expect(disabledDuringPolling).toBe(true);
  expect(progress.disabled).toBe(false);
  expect(screen.getByText(previewId)).toBeTruthy();
  expect(readStoredOperation(operationStorageKey(49))).toEqual({ operationId: previewId, kind: 'preview', state: 'unknown' });
  expect(screen.getByLabelText('Точні артикули, по одному в рядку').disabled).toBe(true);
  client.operation.mockRejectedValueOnce({ response: { status: 404 } });
  await act(async () => { fireEvent.click(progress); });
  expect(client.operation).toHaveBeenCalledTimes(2);
  expect(client.operation).toHaveBeenLastCalledWith(previewId, {});
  expect(screen.getByRole('alert').textContent).toBe('Операцію за цим номером ще не знайдено. Повторне підтвердження не надсилатиметься.');
  expect(client.preview).toHaveBeenCalledTimes(1);
  expect(client.confirm).not.toHaveBeenCalled();
});
it('a late automatic read for the previous actor cannot unlock the new actor pending read', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const nextId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let rejectPrevious, rejectCurrent;
  client.operation.mockImplementationOnce(() => new Promise((resolve, reject) => { rejectPrevious = reject; }))
    .mockImplementationOnce(() => new Promise((resolve, reject) => { rejectCurrent = reject; }));
  storeOperation(operationStorageKey(49), { operationId: previewId, kind: 'preview' });
  storeOperation(operationStorageKey(50), { operationId: nextId, kind: 'preview' });
  const view = mount();
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(client.operation).toHaveBeenCalledExactlyOnceWith(previewId, { signal: expect.any(AbortSignal) });
  auth = { ...makeAuth(), applicationUser: { id: 50 } };
  view.rerender(<HistoricalReactivationReview open config={capability} apiClient={client} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(client.operation).toHaveBeenCalledTimes(2);
  expect(client.operation).toHaveBeenLastCalledWith(nextId, { signal: expect.any(AbortSignal) });
  expect(client.operation.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => { rejectPrevious({ response: { status: 404 } }); });
  expect(screen.queryByRole('alert')).toBeNull();
  const progress = screen.getByRole('button', { name: 'Прочитати прогрес цієї самої операції' });
  expect(progress.disabled).toBe(true);
  fireEvent.click(progress);
  expect(client.operation).toHaveBeenCalledTimes(2);
  expect(screen.getByText(nextId)).toBeTruthy();
  await act(async () => { rejectCurrent({ response: { status: 404 } }); });
  expect(progress.disabled).toBe(false);
  expect(screen.getByRole('alert').textContent).toBe('Операцію за цим номером ще не знайдено. Повторне підтвердження не надсилатиметься.');
  expect(client.preview).not.toHaveBeenCalled();
  expect(client.confirm).not.toHaveBeenCalled();
});
it('confirm registers once, persists only its ID, and reload reads the durable exact selection before delivery polling', async () => {
  const view = mount(); await begin(); await readReadyPreview();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Обрати AR-000001' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Погоджую/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Відновити вибране (1)' }));
  await screen.findByText('Повторна перевірка перед відновленням: у черзі.');
  expect(client.confirm).toHaveBeenCalledTimes(1);
  expect(readStoredOperation(operationStorageKey(49))).toEqual({ operationId: batchId, kind: 'confirm', state: 'unknown' });
  view.unmount(); client.operation.mockResolvedValue({ data: envelope('confirm', 'ready', makeReceipt()) }); mount();
  await screen.findByText('Результати відновлення'); expect(client.confirm).toHaveBeenCalledTimes(1);
  expect(client.preview).toHaveBeenCalledTimes(1);
});
it('terminal failure discards partial review and allows only a new explicit review; revoked authority stops polling', async () => {
  const view = mount(); await begin();
  client.operation.mockResolvedValueOnce({ data: envelope('preview', 'failed', null, { failureCode: 'HISTORICAL_OPERATION_DEADLINE' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати прогрес цієї самої операції' }));
  await screen.findByText(/Перевірку завершено без нового рішення/);
  expect(screen.queryByRole('checkbox')).toBeNull();expect(screen.getByLabelText('Точні артикули, по одному в рядку').disabled).toBe(false);
  expect(client.preview).toHaveBeenCalledTimes(1);
  auth = { ...auth, permissions: [] }; view.rerender(<HistoricalReactivationReview open config={capability} apiClient={client} />);
  const calls = client.operation.mock.calls.length; vi.useFakeTimers(); await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(client.operation).toHaveBeenCalledTimes(calls);
});
it('lost confirm reply recovers only the original immutable operation by GET, including after GET404', async () => {
  mount(); await begin(); await readReadyPreview(); client.confirm.mockRejectedValueOnce(new Error('lost confirmation reply'));
  client.operation.mockRejectedValue({ response: { status: 404 } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Обрати AR-000001' }));fireEvent.click(screen.getByRole('checkbox', { name: /Погоджую/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Відновити вибране (1)' }));
  await screen.findByText(/Результат ще не підтверджено. Список/);
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати прогрес цієї самої операції' }));
  await screen.findByText(/Операцію за цим номером ще не знайдено/);expect(client.confirm).toHaveBeenCalledTimes(1);
  client.operation.mockResolvedValueOnce({ data: envelope('confirm', 'ready', makeReceipt()) });
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати прогрес цієї самої операції' }));await screen.findByText('Результати відновлення');
  expect(client.confirm).toHaveBeenCalledTimes(1);expect(client.preview).toHaveBeenCalledTimes(1);
});
it('async standard review retains separate consent for each selected CREATE before registering confirm', async () => {
  const protocol = 'standard-rest-v1', standard = makeReview();standard.format = 'historical-reactivation-standard-v1';standard.protocol = protocol;
  standard.items = standard.items.map((item, index) => ({ ...item, protocol, ...(item.disposition === 'eligible' ? {
    deliveryMode: index ? 'create' : 'update', requiresExplicitCreate: Boolean(index), targetStatus: index ? 2 : 1, targetVisibility: 4,
    observedRemoteStatus: index ? null : 1, observedRemoteVisibility: index ? null : 4, remoteProductId: index ? null : 51,
    deliveryPlanHash: 'b'.repeat(64), prerequisites: [{ code: 'CURRENT_DELIVERY_PLAN_VALID', met: true }],
  } : {}) }));
  const config = { historicalReactivation: { ...capability.historicalReactivation, format: standard.format, protocol, createTargetStatus: 2 } };
  mount({ config });await begin();client.operation.mockResolvedValueOnce({ data: envelope('preview', 'ready', standard) });
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати прогрес цієї самої операції' }));await screen.findByRole('checkbox', { name: 'Обрати SV-000002' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Обрати SV-000002' }));fireEvent.click(screen.getByRole('checkbox', { name: /Погоджую/ }));
  expect(screen.getByRole('button', { name: 'Відновити вибране (1)' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Окремо дозволити CREATE SV-000002' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /Погоджую/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Відновити вибране (1)' }));await screen.findByText('Повторна перевірка перед відновленням: у черзі.');
  expect(client.confirm).toHaveBeenCalledTimes(1);expect(client.confirm.mock.calls[0][0].selectedCreateSkus).toEqual(['SV-000002']);
  expect(client.confirm.mock.calls[0][0].confirmCurrentFactsAndStandardDelivery).toBe(true);
});
it('a copied operation UUID recovers the server-owned preview without a browser pointer or any POST', async () => {
  client.operation.mockResolvedValue({ data: envelope('preview', 'ready', makeReview()) });mount();
  fireEvent.change(screen.getByLabelText('Номер операції UUID'), { target: { value: previewId } });
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати стан рішення' }));await screen.findByRole('checkbox', { name: 'Обрати AR-000001' });
  expect(client.operation).toHaveBeenCalledWith(previewId, {});expect(client.preview).not.toHaveBeenCalled();expect(client.confirm).not.toHaveBeenCalled();
});
it('malformed ready membership and partial running results fail closed; storage is actor scoped', () => {
  expect(() => validateReviewOperation(envelope('preview', 'running', makeReview()))).toThrow();
  expect(() => validateReviewOperation(envelope('confirm', 'ready', makeReceipt(), { selectedSkus: ['OTHER'] }))).toThrow();
  expect(() => validateReviewOperation(envelope('preview', 'ready', makeReview()), { kind: 'preview', operationId: batchId })).toThrow();
  storeOperation(operationStorageKey(49), { operationId: previewId, kind: 'preview', reviewToken: 'not-stored' });
  expect(readStoredOperation(operationStorageKey(50))).toBeNull(); expect(operationStorageKey(undefined)).toBeNull();
});
