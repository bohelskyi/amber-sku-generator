import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context';
import { ExportLanding } from '../src/components/exports/ExportLanding';
import ExportHistoryPage from '../src/pages/ExportHistoryPage';
import { useProductExportController } from '../src/hooks/product/useProductExportController';
import { exportsApi } from '../src/api/exports-api';

vi.mock('../src/api/exports-api', () => ({ exportsApi: Object.fromEntries([
  'getStatus', 'getPriceStatus', 'getHistory', 'previewPrices', 'createPriceSnapshot',
  'getPriceSnapshot', 'confirmPriceSnapshot',
].map((name) => [name, vi.fn()])) }));
const response = (data) => ({ data });
beforeEach(() => {
  Object.values(exportsApi).forEach((mock) => mock.mockReset());
  exportsApi.getStatus.mockResolvedValue(response({ delivery: { legacyProductCsvEnabled: false } }));
  exportsApi.getPriceStatus.mockResolvedValue(response({ pendingCount: 2 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('reads status only while exports are observed, without recreating the workflow state', async () => {
  const { result, rerender } = renderHook(({ observeStatus }) => useProductExportController({ observeStatus }), {
    initialProps: { observeStatus: false },
  });
  expect(exportsApi.getStatus).not.toHaveBeenCalled();
  expect(exportsApi.getPriceStatus).not.toHaveBeenCalled();
  act(() => result.current.setExportFromSku('LEGACY-PUBLIC'));
  rerender({ observeStatus: true });
  await waitFor(() => expect(result.current.priceExportStatus?.pendingCount).toBe(2));
  expect(exportsApi.getStatus).toHaveBeenCalledTimes(1);
  rerender({ observeStatus: false });
  await act(async () => result.current.fetchExportStatus());
  expect(exportsApi.getStatus).toHaveBeenCalledTimes(1);
  expect(result.current.exportFromSku).toBe('LEGACY-PUBLIC');
  rerender({ observeStatus: true });
  await waitFor(() => expect(exportsApi.getStatus).toHaveBeenCalledTimes(2));
  expect(result.current.exportFromSku).toBe('LEGACY-PUBLIC');
});

it('keeps price and product status failures independent and unknown counts distinct from zero', async () => {
  exportsApi.getStatus.mockRejectedValue(new Error('product status offline'));
  const { result } = renderHook(() => useProductExportController());
  await waitFor(() => expect(result.current.exportStatusError).toBe('product status offline'));
  expect(result.current.priceExportStatus).toEqual({ pendingCount: 2 });
  exportsApi.getPriceStatus.mockRejectedValue(new Error('price status offline'));
  await act(async () => result.current.fetchExportStatus());
  expect(result.current.priceExportStatus).toBeNull();
  render(<MemoryRouter><ExportLanding workflow={result.current} /></MemoryRouter>);
  fireEvent.click(screen.getByText('Стан сумісного потоку цін'));
  expect(screen.getByText('Дані про чергу недоступні')).toBeTruthy();
  expect(screen.queryByText('0 змін очікують експорту')).toBeNull();
  expect(screen.getByRole('link', { name: /Історія створених файлів/ })).toBeTruthy();
});

it('keeps retired product artifacts discoverable and a pending original operation mounted', () => {
  const workflow = { exportStatus: { delivery: { legacyProductCsvEnabled: false } }, priceExportStatus: { pendingCount: 0 } };
  const view = render(<MemoryRouter><ExportLanding workflow={workflow} productTools={<p>Original operation</p>} /></MemoryRouter>);
  expect(screen.getByText('CSV товарів вимкнено')).toBeTruthy();
  expect(screen.queryByText('Original operation')).toBeNull();
  expect(document.querySelector('.export-destination-list a').getAttribute('href')).toBe('/exports/history');
  expect(screen.getByRole('link', { name: /Експорт цін \(сумісність\)/ }).classList.contains('btn-primary')).toBe(false);
  expect(screen.getByRole('link', { name: /Історія створених файлів/ })).toBeTruthy();
  view.rerender(<MemoryRouter><ExportLanding workflow={{ ...workflow, pendingCreate: { key: 'original' } }} productTools={<p>Original operation</p>} /></MemoryRouter>);
  expect(screen.getByText('Original operation')).toBeTruthy();
});

it('replaces bounded history pages and preserves the cursor through browser back', async () => {
  const row = (id) => ({ id, stream: 'price', generatedAt: '2026-10-01T09:00:00Z', status: 'generated', artifacts: [], productCount: 1 });
  exportsApi.getHistory.mockImplementation(async ({ after }) => response(after
    ? { items: [row('older')], next: null }
    : { items: Array.from({ length: 20 }, (_, index) => row(`first-${index}`)), next: 'opaque-next' }));
  const router = createMemoryRouter([{ path: '/exports/history', element: <ExportHistoryPage /> }], { initialEntries: ['/exports/history'] });
  render(<AuthContext.Provider value={{ applicationUser: { id: 1 }, permissions: ['exports.view'] }}><RouterProvider router={router} /></AuthContext.Provider>);
  await screen.findByText('На сторінці: 20');
  expect(screen.getAllByRole('row')).toHaveLength(21);
  fireEvent.click(screen.getByRole('button', { name: 'Наступні 20' }));
  await screen.findByText('На сторінці: 1');
  expect(screen.getAllByRole('row')).toHaveLength(2);
  expect(exportsApi.getHistory).toHaveBeenLastCalledWith(expect.objectContaining({ after: 'opaque-next', limit: 20 }));
  await act(async () => router.navigate(-1));
  await screen.findByText('На сторінці: 20');
  expect(screen.getAllByRole('row')).toHaveLength(21);
});

it('reports confirmation success when only the subsequent price metadata read fails', async () => {
  exportsApi.previewPrices.mockResolvedValue(response({ rowCount: 1, csvContent: 'sku,price\nAG-000001,100' }));
  exportsApi.createPriceSnapshot.mockResolvedValue(response({ id: 'price-result', rowCount: 1, status: 'generated' }));
  exportsApi.getPriceSnapshot.mockResolvedValueOnce(response({ id: 'price-result', stream: 'price', status: 'generated', artifacts: [] }))
    .mockRejectedValueOnce(new Error('read offline'));
  exportsApi.confirmPriceSnapshot.mockResolvedValue(response({ success: true }));
  const { result } = renderHook(() => useProductExportController());
  await act(async () => result.current.priceWorkflow.check());
  await act(async () => result.current.priceWorkflow.create());
  await act(async () => result.current.priceWorkflow.confirm());
  expect(result.current.priceWorkflow.snapshot.status).toBe('confirmed');
  expect(result.current.priceWorkflow.error).toBe('Експорт цін підтверджено, але відомості про результат не оновлено.');
  expect(exportsApi.confirmPriceSnapshot).toHaveBeenCalledTimes(1);
  expect(exportsApi.createPriceSnapshot).toHaveBeenCalledTimes(1);
});
