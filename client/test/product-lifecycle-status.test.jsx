import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { ProductLifecycleStatus } from '../src/components/app/ProductLifecycleStatus.jsx';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const view = (owner, permissions = ['products.view']) => <AuthContext.Provider value={{ principalLifetime: owner, permissions }}><ProductLifecycleStatus productId={42} /></AuthContext.Provider>;
const receipt = (state, hiddenAt = null) => ({ data: { productId: 42, localState: 'archived', visibility: { state, hiddenAt } } });

it('retries a failed pending read without overlapping requests and displays only verified time', async () => {
  vi.useFakeTimers();
  const owner = { valid: true };
  const get = vi.spyOn(api, 'get').mockResolvedValueOnce(receipt('queued'))
    .mockRejectedValueOnce(new Error('local read failed'))
    .mockResolvedValueOnce(receipt('verified', '2026-10-04T22:00:00.000Z'));
  await act(async () => { render(view(owner)); });
  expect(screen.getByText(/Очікуємо перевірки результату/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText(/Не вдалося оновити стан Magento/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText('Приховування в Magento підтверджено.')).toBeTruthy();
  expect(document.querySelector('time').getAttribute('datetime')).toBe('2026-10-04T22:00:00.000Z');
  expect(get).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(get).toHaveBeenCalledTimes(3);
});

it('does not disclose a stale receipt after the principal changes', async () => {
  let finishOld;
  vi.spyOn(api, 'get').mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValueOnce(receipt('blocked'));
  const oldOwner = { valid: true }, nextOwner = { valid: true };
  const rendered = render(view(oldOwner));
  await act(async () => { oldOwner.valid = false; rendered.rerender(view(nextOwner)); });
  await act(async () => { finishOld(receipt('verified', '2026-10-04T22:00:00.000Z')); });
  expect(screen.getByText(/Потрібна окрема перевірка/)).toBeTruthy();
  expect(screen.queryByText('Приховування в Magento підтверджено.')).toBeNull();
  expect(document.querySelector('time')).toBeNull();
});

it('retains the exact absence of confirmation for older archives', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { productId: 42, localState: 'archived', visibility: null, updatedAt: '2026-10-04T22:00:00.000Z' } });
  await act(async () => { render(view({ valid: true })); });
  expect(screen.getByText('Підтвердження видимості Magento для цього архівування немає.')).toBeTruthy();
  expect(document.querySelector('time')).toBeNull();
});

it('does not treat pending timestamps as proof and never calls a mutation', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue(receipt('queued', '2026-10-04T22:00:00.000Z'));
  const post = vi.spyOn(api, 'post');
  await act(async () => { render(view({ valid: true })); });
  expect(get.mock.calls[0][0]).toBe('/products/42/lifecycle');
  expect(document.querySelector('time')).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

it('does not read lifecycle without product view permission', () => {
  const get = vi.spyOn(api, 'get');
  render(view({ valid: true }, []));
  expect(get).not.toHaveBeenCalled();
  expect(screen.queryByRole('region')).toBeNull();
});
