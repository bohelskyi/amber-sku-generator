import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { WorkspaceNav } from '../src/components/app/WorkspaceNav.jsx';
import { ProductNameConflict } from '../src/components/app/ProductNameConflict.jsx';
import { RepricingSyncProgress } from '../src/components/repricing/RepricingSyncProgress.jsx';
import { RepricingSummary } from '../src/components/repricing/RepricingSummary.jsx';
import SyncProblemsPage from '../src/pages/SyncProblemsPage.jsx';
import { WorkspaceDialog } from '../src/components/workspace/WorkspaceDialog.jsx';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
beforeEach(() => { vi.resetAllMocks(); api.get.mockResolvedValue({ data: { enabled: true, problemCount: 3 } }); });
afterEach(cleanup);
const auth = { identity: { name: 'Богдан' }, logout: vi.fn(), permissions: ['products.view', 'products.decode', 'products.recount', 'exports.create', 'exports.view', 'export_templates.view', 'corrections.create', 'corrections.view', 'repricing.view', 'catalog.view'] };
const shell = (element, value = auth) => render(<AuthContext.Provider value={value}><MemoryRouter>{element}</MemoryRouter></AuthContext.Provider>);

it('daily navigation exposes the task-oriented destinations without reading global counts', () => {
  shell(<WorkspaceNav />);
  expect([...document.querySelectorAll('.app-navigation-link')].map((link) => link.textContent)).toEqual([
    'Товари', 'Потребує уваги', 'Переоцінка', 'Налаштування',
  ]);
  expect(api.get).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: 'Експорт' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Розділи/ })).toBeNull();
});
it('request-only compatibility uses existing capabilities', () => {
  shell(<WorkspaceNav />, { ...auth, permissions: ['products.view', 'corrections.create', 'corrections.view'] });
  expect(screen.getByRole('link', { name: 'Потребує уваги' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Запити на виправлення' })).toBeNull();
});
it('dialog keeps its original opener when the confirmation focus target changes while the opener is disabled', () => {
  function DialogModes() {
    const [open, setOpen] = useState(false); const [confirming, setConfirming] = useState(false);
    const cancel = useRef(null);
    return <><button disabled={confirming} onClick={() => setOpen(true)}>Відкрити</button>
      {open && <WorkspaceDialog title="Перевірка" initialFocusRef={confirming ? cancel : undefined} onClose={() => setOpen(false)}>
        <button onClick={() => setConfirming(true)}>Підтвердити</button>
        <button ref={cancel} onClick={() => setConfirming(false)}>Назад</button>
        <button onClick={() => setOpen(false)}>Закрити</button>
      </WorkspaceDialog>}</>;
  }
  render(<DialogModes />); const opener = screen.getByRole('button', { name: 'Відкрити' });
  opener.focus(); fireEvent.click(opener);
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити' }));
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  fireEvent.click(screen.getByRole('button', { name: 'Закрити' }));
  expect(document.activeElement).toBe(opener);
});
it('name conflict choice uses exact fresh preview and stale apply requires another review', async () => {
  const preview = { amber: { all: 'Amber', en: 'Amber EN' }, magento: { all: 'Magento', en: 'Magento EN' }, previewToken: 'proof' };
  api.post.mockResolvedValue({ data: preview });
  shell(<ProductNameConflict productId={7} />);
  fireEvent.click(screen.getByRole('button', { name: 'Вибрати актуальну назву' }));
  await screen.findByText(/UA: Amber/);
  fireEvent.click(screen.getByRole('radio', { name: /^Magento/ }));
  await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/magento/name-resolution/preview', { productId: 7, choice: 'magento' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Підтвердити вибір' }).disabled).toBe(false));
  api.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Назви змінилися' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити вибір' }));
  await screen.findByText('Назви змінилися');
  expect(api.post).toHaveBeenLastCalledWith('/magento/name-resolution/apply', { productId: 7, choice: 'magento', previewToken: 'proof' });
  expect(screen.getByRole('button', { name: 'Підтвердити вибір' }).disabled).toBe(true);
});
it('uncertain write is a resolution queue entry without a retry action', async () => {
  api.get.mockResolvedValue({ data: {
    items: [{ productId: 7, article: 'AG-000002', problems: [{ message: 'Amber надіслав зміну, але кінцевий стан не підтверджено.', resolution: 'administrator' }] }],
    pageInfo: { limit: 20, offset: 0, total: 1, hasPrevious: false, hasNext: false },
  } });
  shell(<SyncProblemsPage />);
  await screen.findAllByText(/кінцевий стан не підтверджено/);
  expect(screen.queryByRole('button', { name: /Повтор|Retry/ })).toBeNull();
  expect(screen.getByRole('link', { name: 'Відкрити товар' }).getAttribute('href')).toBe('/products/open?article=AG-000002');
});
it('product readiness shows local repair guidance, human fields and unchanged raw diagnostics', async () => {
  api.get.mockResolvedValue({ data: {
    items: [{ productId: 1368, article: 'SV5111010', category: 'SV', problems: [
      { code: 'NAME_READ_UNAVAILABLE', message: 'Назви товару в Amber потрібно заповнити або виправити.', resolution: 'product' },
      { code: 'PRODUCT_EVALUATION_NOT_READY', message: 'Товар не готовий до синхронізації. Потрібно доповнити або виправити дані товару.',
        resolution: 'product', issueFields: ['kamin_obrobka', 'name', 'rozmir_suveniriv'] },
    ] }],
    pageInfo: { limit: 20, offset: 0, total: 1, hasPrevious: false, hasNext: false },
  } });
  shell(<SyncProblemsPage />);
  await screen.findAllByText(/Товар не готовий до синхронізації/);
  expect(screen.getByRole('button', { name: 'Виправити характеристики' })).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.queryByText(/Не вдалося прочитати назву Magento/)).toBeNull();
  for (const label of ['Розмір', 'Назва українською та англійською', 'Обробка каменю']) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Заповнити розмір' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Заповнити назви' })).toBeTruthy();
  fireEvent.click(screen.getByText('Дані для підтримки'));
  const evidence = JSON.parse(screen.getByText(/"code": "PRODUCT_EVALUATION_NOT_READY"/).textContent);
  expect(evidence).toHaveLength(2);
  expect(evidence[1]).toMatchObject({ code: 'PRODUCT_EVALUATION_NOT_READY', issueFields: ['kamin_obrobka', 'name', 'rozmir_suveniriv'] });
  expect(screen.queryByRole('button', { name: /Повтор|Надіслати|Retry/ })).toBeNull();
});
it('view-only readiness gives a truthful handoff and no repair action', async () => {
  api.get.mockResolvedValue({ data: {
    items: [{ productId: 1368, article: 'SV5111010', category: 'SV', problems: [{
      code: 'PRODUCT_EVALUATION_NOT_READY', message: 'Товар не готовий до синхронізації.', resolution: 'product', issueFields: ['name', 'rozmir_suveniriv'],
    }] }], pageInfo: { limit: 20, offset: 0, total: 1, hasPrevious: false, hasNext: false },
  } });
  shell(<SyncProblemsPage />, { ...auth, permissions: ['products.view'] });
  await screen.findAllByText(/Товар не готовий/);
  expect(screen.getByText('Передайте виправлення оператору з дозволом на відповідну зміну даних товару.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Виправити дані товару' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Відкрити товар' })).toBeNull();
});
it('readiness action requires permission for a field that is actually repairable', async () => {
  api.get.mockResolvedValue({ data: {
    items: [{ productId: 1368, article: 'SV5111010', category: 'SV', problems: [{
      code: 'PRODUCT_EVALUATION_NOT_READY', message: 'Товар не готовий до синхронізації.', resolution: 'product', issueFields: ['name'],
    }] }], pageInfo: { limit: 20, offset: 0, total: 1, hasPrevious: false, hasNext: false },
  } });
  shell(<SyncProblemsPage />, { ...auth, permissions: ['products.view', 'products.decode', 'products.recount'] });
  await screen.findAllByText(/Товар не готовий/);
  expect(screen.queryByRole('link', { name: 'Виправити дані товару' })).toBeNull();
  expect(screen.getByText('Передайте виправлення оператору з дозволом на відповідну зміну даних товару.')).toBeTruthy();
});
it('repricing summary shows only changed categories and preserved manual products', () => {
  render(<RepricingSummary config={{ categories: { BR: { name: 'Браслети' } } }} controller={{ currentCalculationRate: null,
    effectiveSummary: { changedCount: 4, categories: [{ code: 'BR', count: 4 }], manualPreservedCount: 8, currentCount: 2, errorCount: 1 } }} />);
  expect(screen.getByText('Буде змінено 4 товарів')).toBeTruthy();
  expect(screen.getByText('Браслети — 4')).toBeTruthy();
  expect(screen.getByText('Ручні ціни збережено: 8')).toBeTruthy();
});
it('returning to a repricing batch reads real durable Magento progress', async () => {
  api.get.mockResolvedValue({ data: { status: 'completed', total: 184, synced: 97, pending: 84, needsAttention: 3, notTracked: 0 } });
  render(<RepricingSyncProgress batchId={42} />);
  await screen.findByText('97 / 184 синхронізовано');
  expect(screen.getByText('84 очікують · 3 потребують уваги')).toBeTruthy();
  expect(api.get.mock.calls[0][0]).toBe('/admin/repricing/batches/42/sync-status');
});
