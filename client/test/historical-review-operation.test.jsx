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
  fireEvent.click(screen.getByRole('button', { name: 'Прочитати прогрес цієї самої операції' }));
  await screen.findByText(/Операцію за цим номером ще не знайдено/);
  expect(client.preview).toHaveBeenCalledTimes(1); expect(client.confirm).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Точні артикули, по одному в рядку').disabled).toBe(true);
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
