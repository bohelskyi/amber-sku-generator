import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCopyFeedback } from '../src/hooks/product/useCopyFeedback.js';

let writeText;
beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

it('copies exact text and expires success feedback after 1500ms', async () => {
  const { result } = renderHook(() => useCopyFeedback());
  await act(() => result.current.handleCopyText('  AG-000042  ', 'Артикул'));
  expect(writeText).toHaveBeenCalledExactlyOnceWith('  AG-000042  ');
  expect(result.current.copyMessage).toBe('Артикул скопійовано');
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(1499));
  expect(result.current.copyMessage).toBe('Артикул скопійовано');
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.copyMessage).toBe('');
  expect(vi.getTimerCount()).toBe(0);
});

it('expires clipboard failure feedback without retrying the copy', async () => {
  writeText.mockRejectedValue(new Error('Clipboard denied'));
  const { result } = renderHook(() => useCopyFeedback());
  await act(() => result.current.handleCopyText('AG-000042', 'Артикул'));
  expect(result.current.copyMessage).toBe('Не вдалося скопіювати');
  expect(writeText).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(1500));
  expect(result.current.copyMessage).toBe('');
  expect(vi.getTimerCount()).toBe(0);
});

it('removes the pending reset before component and DOM teardown', async () => {
  const { result, unmount } = renderHook(() => useCopyFeedback());
  await act(() => result.current.handleCopyText('AG-000042', 'Артикул'));
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('repeated copy gives the latest feedback its full lifetime and one reset', async () => {
  const { result } = renderHook(() => useCopyFeedback());
  await act(() => result.current.handleCopyText('AG-000042', 'Артикул'));
  act(() => vi.advanceTimersByTime(1000));
  await act(() => result.current.handleCopyText('1200', 'Ціну'));
  expect(result.current.copyMessage).toBe('Ціну скопійовано');
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(500));
  expect(result.current.copyMessage).toBe('Ціну скопійовано');
  act(() => vi.advanceTimersByTime(999));
  expect(result.current.copyMessage).toBe('Ціну скопійовано');
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.copyMessage).toBe('');
  expect(writeText.mock.calls).toEqual([['AG-000042'], ['1200']]);
});

it.each(['resolve', 'reject'])('does not schedule feedback when clipboard %s arrives after unmount', async (settle) => {
  const pending = deferred(); writeText.mockReturnValue(pending.promise);
  const { result, unmount } = renderHook(() => useCopyFeedback());
  let operation;
  act(() => { operation = result.current.handleCopyText('AG-000042', 'Артикул'); });
  unmount();
  await act(async () => {
    pending[settle](settle === 'reject' ? new Error('Late denial') : undefined);
    await operation;
  });
  expect(writeText).toHaveBeenCalledExactlyOnceWith('AG-000042');
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['resolve', 'reject'])('a superseded clipboard %s cannot replace or extend newer feedback', async (settle) => {
  const old = deferred(); writeText.mockReturnValueOnce(old.promise);
  const { result } = renderHook(() => useCopyFeedback());
  let operation;
  act(() => { operation = result.current.handleCopyText('AG-000042', 'Артикул'); });
  await act(() => result.current.handleCopyText('1200', 'Ціну'));
  act(() => vi.advanceTimersByTime(1000));
  await act(async () => {
    old[settle](settle === 'reject' ? new Error('Old denial') : undefined);
    await operation;
  });
  expect(result.current.copyMessage).toBe('Ціну скопійовано');
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(499));
  expect(result.current.copyMessage).toBe('Ціну скопійовано');
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.copyMessage).toBe('');
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps copying and cleanup valid after StrictMode effect replay', async () => {
  const { result, unmount } = renderHook(() => useCopyFeedback(), { wrapper: StrictMode });
  await act(() => result.current.handleCopyText('AG-000042', 'Артикул'));
  expect(result.current.copyMessage).toBe('Артикул скопійовано');
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('ignores empty text without clipboard access or a timer', async () => {
  const { result } = renderHook(() => useCopyFeedback());
  await act(() => result.current.handleCopyText('', 'Артикул'));
  expect(writeText).not.toHaveBeenCalled();
  expect(result.current.copyMessage).toBe('');
  expect(vi.getTimerCount()).toBe(0);
});
