import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { StoredResult } from '../src/components/exports/StoredResult.jsx';
import { api } from '../src/lib/api.js';
import { downloadBlob } from '../src/lib/download.js';

vi.mock('../src/lib/download.js', () => ({ downloadBlob: vi.fn() }));

const resultPath = '/price-export/snapshots/price-41';
const csvPath = `${resultPath}/csv`;
const response = data => ({ data });
const priceSnapshot = (extra = {}) => ({
  id: 'price-41', stream: 'price', status: 'generated', generatedAt: '2026-10-10T12:30:00Z',
  productCount: 1, fileName: 'prices-reviewed.csv',
  artifacts: [{ groupCode: 'prices', fileName: 'prices-reviewed.csv', rowCount: 1,
    csvContent: 'sku,price\nAG-000041,123.45\n' }], ...extra,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let get, post;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  get = vi.spyOn(api, 'get').mockImplementation(async (url, options) => {
    if (url === resultPath) return response(priceSnapshot());
    if (url === csvPath && options?.responseType === 'blob') return response('sku,price\nAG-000041,123.45\n');
    throw new Error(`Unexpected read: ${url}`);
  });
  post = vi.spyOn(api, 'post').mockImplementation(async url => { throw new Error(`Unexpected write: ${url}`); });
  downloadBlob.mockClear();
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function mount(props = {}, lifetime = { valid: true }) {
  const onDenied = vi.fn();
  const view = render(<AuthContext.Provider value={{ permissions: ['exports.view'], principalLifetime: lifetime }}>
    <MemoryRouter><StoredResult id="price-41" stream="price" onDenied={onDenied} {...props} /></MemoryRouter>
  </AuthContext.Provider>);
  return { ...view, onDenied, lifetime };
}
async function initialRead() { await act(async () => vi.advanceTimersByTimeAsync(0)); }
async function focus() { await act(async () => window.dispatchEvent(new Event('focus'))); }
const reads = () => get.mock.calls.filter(([url]) => url === resultPath);

it.each([401, 403, 404])('clears an already displayed private result after HTTP %s and stops further reads', async status => {
  const view = mount();
  await initialRead();
  expect(screen.getByRole('region', { name: 'Збережений результат' })).toBeTruthy();
  get.mockRejectedValueOnce({ response: { status, data: { error: 'private read refused' } } });
  await focus();
  expect(screen.getByRole('alert').textContent).toBe('Доступ до результату втрачено.');
  expect(screen.queryByRole('region', { name: 'Збережений результат' })).toBeNull();
  expect(screen.queryByText('AG-000041')).toBeNull();
  expect(view.onDenied).toHaveBeenCalledTimes(1);
  await focus();
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(reads()).toHaveLength(2);
  expect(post).not.toHaveBeenCalled();
});

it('coalesces repeated focus reads while a request is pending and then shows the returned result', async () => {
  const pending = deferred();
  get.mockReturnValueOnce(pending.promise);
  mount();
  await initialRead();
  expect(screen.getByRole('status').textContent).toBe('Завантаження збереженого результату…');
  await focus(); await focus();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(reads()).toHaveLength(1);
  await act(async () => pending.resolve(response(priceSnapshot())));
  expect(screen.getByRole('region', { name: 'Збережений результат' })).toBeTruthy();
  await focus();
  expect(reads()).toHaveLength(2);
});

it('does not poll while the document is hidden and resumes visible polling', async () => {
  mount(); await initialRead();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(reads()).toHaveLength(1);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(reads()).toHaveLength(2);
  expect(screen.getByRole('region', { name: 'Збережений результат' })).toBeTruthy();
});

it('keeps a recoverable read error separate from lost access and permits a later explicit focus read', async () => {
  get.mockRejectedValueOnce(new Error('metadata temporarily offline'));
  const view = mount(); await initialRead();
  expect(screen.getByRole('alert').textContent).toBe('metadata temporarily offline');
  expect(view.onDenied).not.toHaveBeenCalled();
  await focus();
  expect(screen.getByRole('region', { name: 'Збережений результат' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(reads()).toHaveLength(2);
  expect(post).not.toHaveBeenCalled();
});

it('downloads only on demand, coalesces pending downloads and never implicitly confirms the price snapshot', async () => {
  const pending = deferred();
  get.mockImplementation(async (url, options) => {
    if (url === resultPath) return response(priceSnapshot());
    if (url === csvPath && options?.responseType === 'blob') return pending.promise;
    throw new Error(`Unexpected read: ${url}`);
  });
  mount({ canCreate: false }); await initialRead();
  expect(downloadBlob).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Підтвердити експорт цін' })).toBeNull();
  const download = screen.getByRole('button', { name: 'Завантажити CSV' });
  fireEvent.click(download); fireEvent.click(download);
  await focus();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(get.mock.calls.filter(([url]) => url === csvPath)).toHaveLength(1);
  expect(reads()).toHaveLength(1);
  await act(async () => pending.resolve(response('sku,price\nAG-000041,123.45\n')));
  expect(downloadBlob).toHaveBeenCalledTimes(1);
  expect(downloadBlob.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect(downloadBlob.mock.calls[0][1]).toBe('prices-reviewed.csv');
  expect(screen.getByText('Передано браузеру для завантаження')).toBeTruthy();
  expect(screen.getByText(/Очікує підтвердження/)).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
});

it('does not report a failed download as delivered and permits an explicit retry', async () => {
  let attempts = 0;
  get.mockImplementation(async (url, options) => {
    if (url === resultPath) return response(priceSnapshot());
    if (url === csvPath && options?.responseType === 'blob') {
      if (++attempts === 1) throw new Error('download temporarily offline');
      return response('sku,price\nAG-000041,123.45\n');
    }
    throw new Error(`Unexpected read: ${url}`);
  });
  mount(); await initialRead();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Завантажити CSV' })));
  expect(screen.getByRole('alert').textContent).toBe('download temporarily offline');
  expect(screen.queryByText('Передано браузеру для завантаження')).toBeNull();
  expect(downloadBlob).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Завантажити CSV' })));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Передано браузеру для завантаження')).toBeTruthy();
  expect(downloadBlob).toHaveBeenCalledTimes(1);
  expect(attempts).toBe(2);
  expect(post).not.toHaveBeenCalled();
});

it.each(['principal revoked', 'component unmounted'])('discards a late download independently when %s', async boundary => {
  const pending = deferred();
  get.mockImplementation(async (url, options) => {
    if (url === resultPath) return response(priceSnapshot());
    if (url === csvPath && options?.responseType === 'blob') return pending.promise;
    throw new Error(`Unexpected read: ${url}`);
  });
  const view = mount(); await initialRead();
  fireEvent.click(screen.getByRole('button', { name: 'Завантажити CSV' }));
  expect(get.mock.calls.filter(([url]) => url === csvPath)).toHaveLength(1);
  if (boundary === 'principal revoked') {
    view.lifetime.valid = false;
    expect(screen.getByRole('region', { name: 'Збережений результат' })).toBeTruthy();
  } else {
    view.unmount();
    expect(view.lifetime.valid).toBe(true);
  }
  await act(async () => pending.resolve(response('private CSV')));
  expect(downloadBlob).not.toHaveBeenCalled();
  expect(view.onDenied).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

it('requires explicit confirmation of the stored price snapshot and fences a repeated pending submit', async () => {
  const pending = deferred();
  let confirmed = false;
  get.mockImplementation(async url => {
    if (url === resultPath) return response(priceSnapshot(confirmed ? { status: 'confirmed' } : {}));
    throw new Error(`Unexpected read: ${url}`);
  });
  post.mockImplementation(async url => {
    if (url !== `${resultPath}/confirm`) throw new Error(`Unexpected write: ${url}`);
    await pending.promise; confirmed = true; return response({ success: true });
  });
  mount({ canCreate: true }); await initialRead();
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити експорт цін' }));
  let dialog = screen.getByRole('dialog', { name: 'Підтвердження експорту цін' });
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити експорт цін' }));
  dialog = screen.getByRole('dialog', { name: 'Підтвердження експорту цін' });
  const confirm = within(dialog).getByRole('button', { name: 'Підтвердити збережений експорт' });
  fireEvent.click(confirm);
  expect(confirm.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(`${resultPath}/confirm`);
  await act(async () => pending.resolve());
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Експорт завершено')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Підтвердити експорт цін' })).toBeNull();
  expect(downloadBlob).not.toHaveBeenCalled();
});

it('clears a historical product result when the server access epoch changes without making a write', async () => {
  let epoch = 'epoch-1';
  get.mockImplementation(async (url, options) => {
    expect(url).toBe('/export/snapshots/history-41');
    expect(options).toEqual({ params: { includeRows: false } });
    return response({ id: 'history-41', stream: 'product', status: 'generated',
      generatedAt: '2026-10-10T12:30:00Z', artifacts: [], accessEpoch: epoch });
  });
  const view = mount({ id: 'history-41', stream: 'product' }); await initialRead();
  expect(screen.getByRole('region', { name: 'Збережений результат' })).toBeTruthy();
  epoch = 'epoch-2'; await focus();
  expect(screen.getByRole('alert').textContent).toBe('Доступ до результату втрачено.');
  expect(screen.queryByRole('region', { name: 'Збережений результат' })).toBeNull();
  expect(view.onDenied).toHaveBeenCalledTimes(1);
  await focus();
  expect(get).toHaveBeenCalledTimes(2);
  expect(post).not.toHaveBeenCalled();
});
