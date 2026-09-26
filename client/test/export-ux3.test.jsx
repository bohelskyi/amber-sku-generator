import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExportDataGrid } from '../src/components/exports/ExportDataGrid';
import { StoredSnapshot } from '../src/components/exports/StoredSnapshot';
import { PriceExportWorkspace } from '../src/components/exports/PriceExportWorkspace';
import { ExportTools } from '../src/components/app/ExportTools';
import ExportHistoryPage from '../src/pages/ExportHistoryPage';
import { useProductExportController } from '../src/hooks/product/useProductExportController';
import { AuthContext } from '../src/auth/auth-context';
import { exportsApi } from '../src/api/exports-api';
import { downloadBlob } from '../src/lib/download';
import { notifyExportReviewChanged } from '../src/lib/export-review-events';
vi.mock('../src/api/exports-api', () => ({ exportsApi: Object.fromEntries(['getStatus', 'getPriceStatus', 'preview', 'createSnapshot', 'getSnapshot', 'readMagentoArtifact', 'downloadMagentoArtifact', 'confirmSnapshot', 'previewPrices', 'createPriceSnapshot', 'getPriceSnapshot', 'readPriceArtifact', 'downloadPriceSnapshot', 'confirmPriceSnapshot', 'getHistory'].map((name) => [name, vi.fn()])) }));
vi.mock('../src/lib/download', () => ({ downloadBlob: vi.fn() }));
const response = (data) => ({ data, headers: {} });
const csv = 'sku,store_view_code,name,price\nBR1,,"\' =text, quoted",123\nBR1,en,English,';
const artifact = { groupCode: 'BR', groupName: 'Браслети', csvContent: csv, rowCount: 2, productCount: 1, fileName: 'stored.csv' };
const price = { id: 'price-1', stream: 'price', fileName: 'prices.csv', generatedAt: '2026-09-25T12:00:00Z', rowCount: 1, status: 'generated', artifacts: [{ groupCode: 'prices', rowCount: 1, fileName: 'prices.csv' }] };
const snapshot = { id: 'snapshot-1', status: 'generated', generatedAt: price.generatedAt, artifacts: [artifact], capturedRange: { fromSku: 'BR1', toSku: 'BR1' } };
let controller;
function Harness({ prices = false, canCreate = true, principalLifetime }) {
  const c = useProductExportController({ canCreate, principalLifetime }); useEffect(() => { controller = c; }, [c]);
  return prices ? <PriceExportWorkspace workflow={c.priceWorkflow} canCreate={canCreate} /> : <ExportTools {...c} canArchive={false} surface="products" canCreateExport={canCreate} canViewExport
    onPreviewExport={c.handlePreviewExport} onCreateSnapshot={c.handleCreateSnapshot} onConfirmSnapshot={c.handleConfirmSnapshot} onDownloadMagentoArtifact={c.handleDownloadMagentoArtifact} />;
}
const click = (name) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
beforeEach(() => {
  for (const fn of Object.values(exportsApi)) fn.mockReset();
  exportsApi.getStatus.mockResolvedValue(response({ countSinceLastExport: 1 })); exportsApi.getPriceStatus.mockResolvedValue(response({ pendingCount: 1 }));
  exportsApi.preview.mockResolvedValue(response({ mode: 'new', representedCount: 1, readyCount: 1, errors: [], tableFingerprint: 'original', previewExpectation: 'original', checkedAt: price.generatedAt, range: snapshot.capturedRange, artifacts: [artifact] }));
  exportsApi.createSnapshot.mockResolvedValue(response(snapshot)); exportsApi.getSnapshot.mockResolvedValue(response(snapshot));
  exportsApi.readMagentoArtifact.mockResolvedValue(response(csv)); exportsApi.downloadMagentoArtifact.mockResolvedValue(response(csv));
  exportsApi.previewPrices.mockResolvedValue(response({ checkedAt: price.generatedAt, rowCount: 1, csvContent: 'sku,price\nBR1,123' }));
  exportsApi.createPriceSnapshot.mockResolvedValue(response(price)); exportsApi.getPriceSnapshot.mockResolvedValue(response(price));
  exportsApi.readPriceArtifact.mockResolvedValue(response('sku,price\nBR1,456')); exportsApi.downloadPriceSnapshot.mockResolvedValue(response('sku,price\nBR1,456'));
  exportsApi.confirmPriceSnapshot.mockImplementation(async () => { exportsApi.getPriceSnapshot.mockResolvedValue(response({ ...price, status: 'confirmed' })); return response({}); });
  exportsApi.confirmSnapshot.mockImplementation(async () => { exportsApi.getSnapshot.mockResolvedValue(response({ ...snapshot, status: 'confirmed' })); return response({}); });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('ordinary preview renders exact file headers/Main EN; filters, page and widths never change request identity', async () => {
  const large = { ...artifact, csvContent: 'sku,store_view_code,name,price\n' + Array.from({ length: 104 }, (_, i) => `BR${i},${i % 2 ? 'en' : ''},Name${i},123`).join('\n') };
  exportsApi.preview.mockResolvedValue(response({ mode: 'new', representedCount: 52, readyCount: 52, errors: [], tableFingerprint: 'original', previewExpectation: 'original', range: snapshot.capturedRange, artifacts: [large, { ...artifact, groupCode: 'SV', groupName: 'Сувеніри' }] }));
  render(<Harness />); await screen.findByText(/1 новий товар очікує/); click('Перевірити 1 новий товар'); await screen.findByRole('table');
  expect(screen.getByText('ПОПЕРЕДНІЙ ПЕРЕГЛЯД')).toBeTruthy(); expect(screen.getAllByRole('row')).toHaveLength(51);
  expect(screen.getAllByRole('columnheader').map((e) => e.textContent)).toEqual(['SKU · мова · стан', 'sku', 'store_view_code', 'name', 'price']);
  click('Наступні рядки'); expect(screen.getByText(/51–100/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Пошук SKU'), { target: { value: 'BR10' } }); expect(screen.getAllByRole('row')).toHaveLength(6);
  fireEvent.change(screen.getByLabelText('Готовність'), { target: { value: 'attention' } }); expect(screen.getByText(/За цими фільтрами/)).toBeTruthy();
  click('Ширина колонок'); fireEvent.change(screen.getByLabelText('Ширина, px'), { target: { value: 420 } }); click('Готово');
  expect(exportsApi.preview).toHaveBeenCalledTimes(1);
  click('Створити файли Magento'); await screen.findByText('ЗБЕРЕЖЕНІ ФАЙЛИ');
  expect(exportsApi.createSnapshot.mock.calls[0][0]).toEqual({ mode: 'new', fromSku: 'BR1', toSku: 'BR1', previewExpectation: 'original' });
  expect(screen.queryByText('ПОПЕРЕДНІЙ ПЕРЕГЛЯД')).toBeNull(); expect(screen.queryByRole('button', { name: 'Оновити перевірку' })).toBeNull();
  expect(screen.queryByLabelText('Початковий SKU для повторного експорту')).toBeNull();
});

it('failed-only file retains canonical row and source/cell targets without fabricated CSV, with accessible exact-value handoff', () => {
  const row = { ordinal: 11, productPosition: 6, productId: 6, sku: 'SV-FAIL', language: 'main', readiness: 'attention',
    cells: [{ state: 'provisional', value: 'SV-FAIL' }, { state: 'not-evaluated', value: null }, { state: 'provisional', value: '' }],
    issues: [{ code: 'manual_name_required', field: 'name', message: 'Saved subject missing', target: { kind: 'column', column: 'name' } }, { field: 'unknown', message: 'Row only', target: { kind: 'row' } }] };
  const edit = vi.fn();
  render(<MemoryRouter><ExportDataGrid identity="failed" canDecode onEditName={edit} files={[{ groupCode: 'SV', headers: ['sku', 'name', 'description'], rows: [row] }]} /></MemoryRouter>);
  expect(screen.getByText('1 товар потребує уваги')).toBeTruthy(); expect(screen.getByText('Не обчислено')).toBeTruthy(); expect(screen.getByText('Попередньо порожньо')).toBeTruthy();
  const sku = screen.getByRole('button', { name: 'Значення sku, рядок 11' }); sku.focus(); fireEvent.keyDown(sku, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Значення name, рядок 11, потребує уваги' }));
  fireEvent.click(document.activeElement); expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Відкрити товар' }).getAttribute('href')).toBe('/?exportSku=SV-FAIL');
  click('Заповнити назву'); expect(edit).toHaveBeenCalledWith({ productId: 6, sku: 'SV-FAIL' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('stored table loads only selected file, caches bytes, downloads separately and confirms only from dialog', async () => {
  const files = [{ ...artifact, csvContent: undefined }, { ...artifact, groupCode: 'SV', groupName: 'Сувеніри', csvContent: undefined }];
  const confirm = vi.fn(); const download = vi.fn().mockResolvedValue(true);
  render(<StoredSnapshot snapshot={{ ...snapshot, artifacts: files }} canConfirm onConfirm={confirm} onDownload={download} />);
  await screen.findByRole('table'); expect(exportsApi.readMagentoArtifact.mock.calls).toEqual([['snapshot-1', 'BR']]);
  fireEvent.click(screen.getByRole('tab', { name: 'Сувеніри' })); await waitFor(() => expect(exportsApi.readMagentoArtifact).toHaveBeenCalledWith('snapshot-1', 'SV'));
  await screen.findByRole('table'); fireEvent.click(screen.getByRole('tab', { name: 'Браслети' })); expect(exportsApi.readMagentoArtifact).toHaveBeenCalledTimes(2);
  click('Завантажити CSV'); await screen.findByText('Передано браузеру для завантаження'); expect(confirm).not.toHaveBeenCalled();
  click('Завершити експорт'); expect(confirm).not.toHaveBeenCalled(); expect(screen.getByRole('dialog').textContent).toContain('Це не означає, що імпорт у Magento успішний');
  click('Підтвердити збережений експорт'); expect(confirm).toHaveBeenCalledOnce();
});

it('successful product mutation marks review stale and requires explicit recheck; stored result never offers capture retry on table failure', async () => {
  render(<Harness />); await screen.findByText(/1 новий товар очікує/); click('Перевірити 1 новий товар'); await screen.findByRole('table');
  act(notifyExportReviewChanged); expect(screen.getByText(/ЗАСТАРІЛО/)).toBeTruthy(); click('Створити файли Magento'); expect(exportsApi.createSnapshot).not.toHaveBeenCalled();
  click('Оновити перевірку'); await waitFor(() => expect(screen.queryByText(/ЗАСТАРІЛО/)).toBeNull());
  exportsApi.getSnapshot.mockRejectedValue(new Error('metadata failed')); click('Створити файли Magento');
  await screen.findByText('Файли створено, але таблицю не вдалося завантажити.'); expect(screen.getByText('ЗБЕРЕЖЕНІ ФАЙЛИ')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Створити файли Magento' })).toBeNull();
});

it('price review, create, download and confirm are separate, stored values supersede queue and no template/range appears', async () => {
  render(<Harness prices />); click('Оновити / переглянути поточну чергу'); await screen.findByText('123');
  expect(screen.getByText(/Під час створення файлу сервер повторно/)).toBeTruthy(); click('Створити файл'); await screen.findByText('456');
  expect(exportsApi.downloadPriceSnapshot).not.toHaveBeenCalled(); expect(exportsApi.confirmPriceSnapshot).not.toHaveBeenCalled();
  expect(screen.getByText(/Після попереднього перегляду дані змінилися/)).toBeTruthy(); expect(screen.queryByText('123')).toBeNull();
  click('Завантажити CSV'); await waitFor(() => expect(downloadBlob).toHaveBeenCalled()); expect(exportsApi.confirmPriceSnapshot).not.toHaveBeenCalled();
  click('Підтвердити експорт цін'); expect(exportsApi.confirmPriceSnapshot).not.toHaveBeenCalled(); click('Підтвердити збережений експорт'); await screen.findByText('Експорт завершено');
  expect(exportsApi.confirmPriceSnapshot).toHaveBeenCalledWith('price-1'); expect(exportsApi.createPriceSnapshot.mock.calls[0]).toHaveLength(1); expect(exportsApi.createSnapshot).not.toHaveBeenCalled();
  expect(screen.queryByLabelText(/SKU для повторного/)).toBeNull(); expect(screen.queryByLabelText(/публікації/)).toBeNull();
});

it('uncertain price creation retries the original key', async () => {
  exportsApi.createPriceSnapshot.mockRejectedValueOnce(new Error('unknown'));
  render(<Harness prices />); click('Оновити / переглянути поточну чергу'); await screen.findByText('123'); click('Створити файл');
  await screen.findByText('unknown'); const original = exportsApi.createPriceSnapshot.mock.calls[0];
  click('Повторити початкове створення файлу цін'); await screen.findByText('456'); expect(exportsApi.createPriceSnapshot.mock.calls[1]).toEqual(original);
  expect(controller.priceWorkflow.snapshot.id).toBe('price-1');
});

it('late stored price loading is fenced by principal lifetime and does not complete a browser download', async () => {
  let resolve;
  exportsApi.readPriceArtifact.mockReturnValue(new Promise((r) => { resolve = r; }));
  const principalLifetime = { valid: true };
  const view = render(<Harness prices principalLifetime={principalLifetime} />);
  click('Оновити / переглянути поточну чергу'); await screen.findByText('123'); click('Створити файл');
  await waitFor(() => expect(exportsApi.readPriceArtifact).toHaveBeenCalled());
  principalLifetime.valid = false; view.unmount();
  await act(async () => { resolve(response('sku,price\nPRIVATE,999')); });
  expect(downloadBlob).not.toHaveBeenCalled(); expect(exportsApi.confirmPriceSnapshot).not.toHaveBeenCalled();
});

it('price table retry reveals changed stored values without recreating, and an empty queue rejection requires a new explicit check', async () => {
  exportsApi.readPriceArtifact.mockRejectedValueOnce(new Error('read failed'));
  render(<Harness prices />); click('Оновити / переглянути поточну чергу'); await screen.findByText('123'); click('Створити файл');
  await screen.findByText('Файли створено, але таблицю не вдалося завантажити.');
  expect(screen.getByRole('button', { name: 'Підтвердити експорт цін' }).disabled).toBe(true);
  click('Повторити завантаження таблиці'); await screen.findByText('456');
  expect(screen.getByText(/Після попереднього перегляду дані змінилися/)).toBeTruthy(); expect(exportsApi.createPriceSnapshot).toHaveBeenCalledOnce();
  click('Новий експорт цін'); click('Оновити / переглянути поточну чергу'); await screen.findByText('123');
  exportsApi.createPriceSnapshot.mockRejectedValueOnce({ response: { data: { code: 'NO_PENDING_PRICE_EXPORTS', error: 'Черга порожня' } } });
  click('Створити файл'); await screen.findByText('Черга порожня');
  expect(screen.queryByRole('button', { name: 'Повторити початкове створення файлу цін' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Оновити / переглянути поточну чергу' }).disabled).toBe(false);
});

it.each(['product', 'price'])('shared history reopens generated %s snapshots after reload without creating/confirming', async (stream) => {
  const item = stream === 'price' ? price : { ...snapshot, stream: 'product' };
  exportsApi.getHistory.mockResolvedValue(response({ items: [{ ...item, productCount: 1, csvRowCount: 2, createdByUserId: null }], next: null }));
  const auth = { permissions: ['exports.view'], principalLifetime: { valid: true } };
  const tree = () => <AuthContext.Provider value={auth}><RouterProvider router={createMemoryRouter([{ path: '/exports/*', element: <Routes><Route path="history" element={<ExportHistoryPage />} /><Route path="history/:stream/:snapshotId" element={<ExportHistoryPage />} /></Routes> }], { initialEntries: ['/exports/history'] })} /></AuthContext.Provider>;
  const first = render(tree()); await screen.findByRole('link', { name: /Відкрити/ }); fireEvent.click(screen.getByRole('link', { name: /Відкрити/ })); await screen.findByText('ЗБЕРЕЖЕНІ ФАЙЛИ');
  expect(screen.queryByRole('button', { name: /Завершити експорт|Підтвердити експорт цін/ })).toBeNull(); first.unmount();
  render(tree()); await screen.findByRole('link', { name: /Відкрити/ }); fireEvent.click(screen.getByRole('link', { name: /Відкрити/ })); await screen.findByText('ЗБЕРЕЖЕНІ ФАЙЛИ');
  expect(exportsApi.createSnapshot).not.toHaveBeenCalled(); expect(exportsApi.createPriceSnapshot).not.toHaveBeenCalled(); expect(exportsApi.confirmPriceSnapshot).not.toHaveBeenCalled(); expect(exportsApi.confirmSnapshot).not.toHaveBeenCalled();
  expect(exportsApi.getHistory.mock.calls[0][0]).toEqual({ stream: 'all', scope: 'accessible', status: 'all', limit: 20 });
});

it('view-only preview has no create or confirm controls and exact long text is revealed with focus restoration', async () => {
  render(<Harness canCreate={false} />); await screen.findByText(/1 новий товар очікує/); click('Перевірити 1 новий товар'); await screen.findByRole('table');
  expect(screen.queryByRole('button', { name: 'Створити файли Magento' })).toBeNull();
  const cell = screen.getByRole('button', { name: 'Значення name, рядок 1' }); cell.focus(); fireEvent.click(cell);
  expect(within(screen.getByRole('region', { name: 'Повне значення' })).getByText("' =text, quoted")).toBeTruthy();
  fireEvent.keyDown(document.activeElement, { key: 'Escape' }); expect(document.activeElement).toBe(cell);
});
