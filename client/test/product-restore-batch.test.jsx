import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProductRestoreBatch } from '../src/components/app/ProductRestoreBatch.jsx';
let auth;
vi.mock('../src/auth/auth-context', () => ({ useAuth: () => auth }));
const review = { reviewNonce: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', reviewHash: 'a'.repeat(64), skus: ['KL3/LEGACY'],
  counts: { found: 1, skipped: 1, conflicts: 1 }, items: [
    { inputSku: 'kl3/legacy', article: 'KL3/LEGACY', productId: 12, disposition: 'found', confirmedMagentoId: 71 },
    { inputSku: 'missing', disposition: 'skipped', reasonCode: 'PRODUCT_RESTORE_NOT_FOUND' },
    { inputSku: 'ancestor', disposition: 'conflict', reasonCode: 'PRODUCT_RETIRED_ANCESTOR' },
  ] };
let client;
beforeEach(() => {
  auth = { permissions: ['products.view', 'products.archive'], principalLifetime: { valid: true, id: '1' } };
  client = { post: vi.fn().mockResolvedValue({ data: structuredClone(review) }), get: vi.fn() };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function checked(props = {}) {
  render(<ProductRestoreBatch apiClient={client} onClose={vi.fn()} {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'kl3/legacy\nmissing\nancestor' } });
  fireEvent.click(screen.getByText('Перевірити список'));
  await screen.findByText('Підтвердити відновлення та синхронізацію');
}
it('shows exact preview dispositions and only explicit confirmation sends the reviewed bounded command', async () => {
  await checked();
  expect(client.post).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Підтвердити відновлення та синхронізацію' }).classList.contains('btn-primary')).toBe(true);
  expect(screen.getByText('Товар не знайдено')).toBeTruthy();
  expect(screen.getByText('Є наступник або виправлена версія')).toBeTruthy();
  client.post.mockResolvedValueOnce({ data: { batchId: 'b'.repeat(64), pending: [], items: [{ productId: 12, article: 'KL3/LEGACY', state: 'error', reasonCode: 'PRODUCT_OLD_EXCLUSION_RETAINED' }] } });
  fireEvent.click(screen.getByText('Підтвердити відновлення та синхронізацію'));
  await screen.findByText('Попереднє виключення з експорту збережено');
  expect(client.post.mock.calls[1]).toEqual(['/products/restore/apply', { skus: review.skus, reviewNonce: review.reviewNonce,
    reviewHash: review.reviewHash, confirmRestoreAndSync: true }]);
});
it('input changes invalidate the review and an over-limit list cannot call the server', async () => {
  await checked();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: Array(101).fill('AG-000012').join('\n') } });
  expect(screen.queryByText('Підтвердити відновлення та синхронізацію')).toBeNull();
  fireEvent.click(screen.getByText('Перевірити список'));
  await screen.findByText('Вкажіть від 1 до 100 артикулів, по одному в рядку.');
  expect(client.post).toHaveBeenCalledTimes(1);
});
it('an unfinished photo delivery conflict explains the required action and offers no apply command when no product can restore', async () => {
  client.post.mockResolvedValueOnce({ data: { ...review, counts: { found: 0, skipped: 0, conflicts: 1 },
    items: [{ inputSku: 'KL3/LEGACY', article: 'KL3/LEGACY', productId: 12, disposition: 'conflict',
      reasonCode: 'PRODUCT_MEDIA_RECONCILIATION_REQUIRED' }] } });
  render(<ProductRestoreBatch apiClient={client} onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'KL3/LEGACY' } });
  fireEvent.click(screen.getByText('Перевірити список'));
  await screen.findByText('Спочатку завершіть або перевірте передавання фото.');
  expect(screen.getByText(/Можна відновити: 0/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Підтвердити відновлення та синхронізацію' })).toBeNull();
  expect(client.post.mock.calls).toEqual([['/products/restore/preview', { skus: ['KL3/LEGACY'] }]]);
});
it('unknown apply response retains the reviewed command and reuses it only after an explicit result check', async () => {
  const restored = vi.fn(), dirty = vi.fn();
  await checked({ onRestored: restored, onDirtyChange: dirty });
  client.post.mockRejectedValueOnce(new Error('Network fixture'));
  fireEvent.click(screen.getByText('Підтвердити відновлення та синхронізацію'));
  await screen.findByText('Перевірити результат відновлення');
  expect(screen.getByRole('textbox').disabled).toBe(true); expect(restored).not.toHaveBeenCalled();
  expect(dirty).toHaveBeenLastCalledWith(true); expect(client.post).toHaveBeenCalledTimes(2);
  client.post.mockResolvedValueOnce({ data: { batchId: 'b'.repeat(64), pending: [], items: [{ productId: 12, article: 'KL3/LEGACY', state: 'synced', restoredAt: '2026-10-01T01:00:00Z', confirmedAt: '2026-10-01T01:00:02Z' }] } });
  fireEvent.click(screen.getByText('Перевірити результат відновлення'));
  await screen.findByText(/Доставку підтверджено:/);
  expect(client.post.mock.calls[2]).toEqual(client.post.mock.calls[1]); expect(restored).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
});
it('partial permission failure keeps the same review because earlier items may already have committed', async () => {
  await checked();
  client.post.mockRejectedValueOnce({ response: { status: 403, data: { code: 'ADMIN_PERMISSION_REVOKED' } } });
  fireEvent.click(screen.getByText('Підтвердити відновлення та синхронізацію'));
  await screen.findByText('Перевірити результат відновлення');
  expect(screen.getByRole('textbox').disabled).toBe(true);
});
it('pending delivery has no success timestamp and refresh reads the durable batch without another apply', async () => {
  await checked();
  client.post.mockResolvedValueOnce({ data: { batchId: 'b'.repeat(64), pending: [], items: [{ productId: 12, article: 'KL3/LEGACY', state: 'queued', restoredAt: '2026-10-01T01:00:00Z', confirmedAt: null }] } });
  fireEvent.click(screen.getByText('Підтвердити відновлення та синхронізацію'));
  await screen.findByText(/очікує підтвердження доставки/);
  expect(screen.queryByText(/Доставку підтверджено:/)).toBeNull();
  client.get.mockResolvedValueOnce({ data: { batchId: 'b'.repeat(64), pending: [], items: [{ productId: 12, article: 'KL3/LEGACY', state: 'error', restoredAt: '2026-10-01T01:00:00Z', reasonCode: 'PRODUCT_VISIBILITY_UNCERTAIN' }] } });
  fireEvent.click(screen.getByText('Оновити стан'));
  await screen.findByText('Результат зміни видимості ще не підтверджено');
  expect(client.get).toHaveBeenCalledWith('/products/restore/batches/' + 'b'.repeat(64), { signal: undefined });
  expect(client.post).toHaveBeenCalledTimes(2);
});
it('revoked access hides restore actions and an invalidated principal cannot consume a late preview', async () => {
  auth.permissions = ['products.view'];
  const first = render(<ProductRestoreBatch apiClient={client} onClose={vi.fn()} />);
  expect(screen.queryByRole('textbox')).toBeNull(); expect(client.post).not.toHaveBeenCalled(); first.unmount();
  auth.permissions.push('products.archive');
  let resolve;
  client.post.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  render(<ProductRestoreBatch apiClient={client} onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'KL3/LEGACY' } }); fireEvent.click(screen.getByText('Перевірити список'));
  auth.principalLifetime.valid = false; resolve({ data: review });
  await new Promise((done) => setTimeout(done, 10));
  expect(screen.queryByText('Підтвердити відновлення та синхронізацію')).toBeNull();
});

it('an uncertain attempt blocks closing and Escape until the same reviewed result is recovered', async () => {
  const close = vi.fn(), busy = vi.fn();
  await checked({ onClose: close, onBusyChange: busy });
  client.post.mockRejectedValueOnce(new Error('Synthetic outage'));
  fireEvent.click(screen.getByText('Підтвердити відновлення та синхронізацію'));
  await screen.findByText('Перевірити результат відновлення');
  expect(screen.getByRole('button', { name: 'Закрити відновлення' }).disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' }); expect(close).not.toHaveBeenCalled(); expect(busy).toHaveBeenLastCalledWith(true);
});

it('a different principal cannot consume the former user response even when the old lifetime was left valid', async () => {
  let resolve;
  client.post.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = render(<ProductRestoreBatch apiClient={client} onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'KL3/LEGACY' } }); fireEvent.click(screen.getByText('Перевірити список'));
  auth = { ...auth, principalLifetime: { id: '2', valid: true } };
  view.rerender(<ProductRestoreBatch apiClient={client} onClose={vi.fn()} />);
  await act(async () => { resolve({ data: review }); });
  expect(screen.queryByText('Підтвердити відновлення та синхронізацію')).toBeNull();
});

it('receipt polling survives a failed GET and schedules one next read after each completed request', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  render(<ProductRestoreBatch apiClient={client} onClose={vi.fn()} />);
  await act(async () => { fireEvent.change(screen.getByRole('textbox'), { target: { value: 'KL3/LEGACY' } }); });
  await act(async () => { fireEvent.click(screen.getByText('Перевірити список')); });
  client.post.mockResolvedValueOnce({ data: { batchId: 'b'.repeat(64), pending: [], items: [{ productId: 12, article: 'KL3/LEGACY', state: 'queued', restoredAt: '2026-10-01T01:00:00Z' }] } });
  await act(async () => { fireEvent.click(screen.getByText('Підтвердити відновлення та синхронізацію')); });
  client.get.mockRejectedValueOnce(new Error('Temporary read failure'));
  let resolve;
  client.get.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(client.get).toHaveBeenCalledTimes(1); expect(screen.getByRole('alert').textContent).toMatch(/оновити стан/);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(client.get).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); }); expect(client.get).toHaveBeenCalledTimes(2);
  await act(async () => { resolve({ data: { batchId: 'b'.repeat(64), pending: [], items: [{ productId: 12, article: 'KL3/LEGACY', state: 'synced', restoredAt: '2026-10-01T01:00:00Z', confirmedAt: '2026-10-01T01:00:02Z' }] } }); });
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByText(/Доставку підтверджено:/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(client.get).toHaveBeenCalledTimes(2);
});

it('the batch exposes the conflict handoff without applying or exposing command credentials', async () => {
  await checked();
  expect(screen.getByRole('region', { name: 'Передавання відновлення на перевірку' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Скопіювати звіт для Адміністратора' })).toBeTruthy();
  expect(screen.getByText('Потребують окремої перевірки: 1')).toBeTruthy();
  expect(document.body.textContent).not.toContain(review.reviewNonce);
  expect(document.body.textContent).not.toContain(review.reviewHash);
  expect(client.post.mock.calls.map(([url]) => url)).toEqual(['/products/restore/preview']);
});


it('70-item review keeps the exact eligible count and confirmation together without applying on preview',async()=>{
  const skus=Array.from({length:70},(_,index)=>'FIXTURE-'+String(index).padStart(6,'0'));
  const proof={...review,skus,counts:{found:1,conflicts:47,skipped:22},items:skus.map((sku,index)=>({inputSku:sku,article:sku,
    disposition:index===0?'found':index<48?'conflict':'skipped',reasonCode:index===0?null:index<48?'PRODUCT_ARCHIVE_PROOF_MISSING':'PRODUCT_RESTORE_NOT_FOUND'}))};
  client.post.mockResolvedValueOnce({data:proof});render(<ProductRestoreBatch apiClient={client} onClose={vi.fn()}/>);
  fireEvent.change(screen.getByRole('textbox'),{target:{value:skus.join('\n')}});fireEvent.click(screen.getByText('Перевірити список'));
  const button=await screen.findByRole('button',{name:'Підтвердити відновлення та синхронізацію'});
  const summary=screen.getByRole('region',{name:'Підсумок відновлення'});expect(summary.contains(button)).toBe(true);
  expect(summary.textContent).toContain('Можна відновити: 1. Пропущено: 22. Потребують перевірки: 47.');
  expect(client.post.mock.calls).toEqual([['/products/restore/preview',{skus}]]);
});

