import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { exportsApi } from '../src/api/exports-api.js';
import { ProductMagentoNameReview } from '../src/components/app/ProductMagentoNameReview.jsx';
import { ProductMagentoAttention } from '../src/components/app/ProductMagentoAttention.jsx';
import { WorkspaceNav } from '../src/components/app/WorkspaceNav.jsx';
import { RecountConfirmDialog } from '../src/components/app/RecountConfirmDialog.jsx';
import { ExportTools } from '../src/components/app/ExportTools.jsx';
import { AdminStructureEditor } from '../src/components/admin/AdminStructureEditor.jsx';
import { workspaceNavigation, allowedWorkspaceNavigation, isWorkspaceDestination } from '../src/lib/workspace-navigation.js';

vi.mock('../src/api/exports-api.js', () => ({ exportsApi: { previewMagentoName: vi.fn(), applyMagentoName: vi.fn(), suggestMagentoName: vi.fn() } }));
const product = { productId: 7, sku: 'SV227002', publicSku: 'AG-000002', categoryCode: 'SV', status: 'active', magentoNameReviewRequired: true };
const original = { subjectUa: ' Тест 2 ', subjectEn: ' Test 2 ', canConfirmUnchanged: true, reviewRequired: true, previewToken: 'loaded-proof' };
const auth = (permissions) => ({ permissions, identity: { name: 'Very long administrator name '.repeat(10) }, logout: vi.fn(), principalLifetime: { id: '1', valid: true } });
beforeEach(() => { vi.resetAllMocks(); exportsApi.previewMagentoName.mockResolvedValue({ data: original }); exportsApi.applyMagentoName.mockResolvedValue({ data: {} }); });
afterEach(cleanup);

it('confirms the exact inherited pair using the displayed token and never silently re-previews', async () => {
  const saved = vi.fn(); render(<ProductMagentoNameReview product={product} onSaved={saved} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Підтвердити без змін' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(exportsApi.previewMagentoName).toHaveBeenCalledTimes(1);
  expect(exportsApi.applyMagentoName).toHaveBeenCalledWith({ productId: 7, subjectUa: ' Тест 2 ', subjectEn: ' Test 2 ', confirmUnchanged: true, previewToken: 'loaded-proof' });
});

it('requires review of server-rendered edited names and invalidates that preview on further editing', async () => {
  exportsApi.previewMagentoName.mockResolvedValueOnce({ data: original }).mockResolvedValue({ data: { previewToken: 'edited-proof', nameUa: 'Серверна назва UA', nameEn: 'Server EN' } });
  render(<ProductMagentoNameReview product={product} onSaved={vi.fn()} onClose={vi.fn()} />);
  await screen.findByRole('button', { name: 'Підтвердити без змін' });
  fireEvent.change(screen.getByLabelText('Українська назва'), { target: { value: 'Нова назва' } });
  expect(screen.queryByRole('button', { name: 'Підтвердити без змін' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Переглянути зміни' }));
  await screen.findByText('UA: Серверна назва UA');
  expect(exportsApi.applyMagentoName).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Англійська назва (EN)'), { target: { value: 'Changed' } });
  expect(screen.queryByRole('button', { name: 'Зберегти назви' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Переглянути зміни' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Зберегти назви' }));
  await waitFor(() => expect(exportsApi.applyMagentoName).toHaveBeenCalledWith({ productId: 7, subjectUa: 'Нова назва', subjectEn: 'Changed', previewToken: 'edited-proof' }));
});

it.each([409, 500])('keeps a failed apply (%s) explicit without automatic confirmation or retry', async (status) => {
  exportsApi.applyMagentoName.mockRejectedValue({ response: { status, data: { error: 'Потрібно перевірити актуальні дані' } } });
  const saved = vi.fn(); render(<ProductMagentoNameReview product={product} onSaved={saved} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Підтвердити без змін' }));
  await screen.findByText('Потрібно перевірити актуальні дані');
  expect(saved).not.toHaveBeenCalled(); expect(exportsApi.applyMagentoName).toHaveBeenCalledTimes(1);
  if (status === 409) expect(screen.queryByRole('button', { name: 'Підтвердити без змін' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Завантажити актуальні назви' })).toBeTruthy();
});

it('shows inherited-name guidance without granting the existing exports.create permission', () => {
  render(<AuthContext.Provider value={auth(['products.recount'])}><ProductMagentoAttention product={product} /></AuthContext.Provider>);
  expect(screen.getByText('Потрібно перевірити назву для Magento')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Перевірити назви' })).toBeNull(); expect(exportsApi.previewMagentoName).not.toHaveBeenCalled();
});

it('keeps legacy routes but exposes current daily destinations with permission visibility', () => {
  expect(new Set(workspaceNavigation.map((entry) => entry.to)).size).toBe(workspaceNavigation.length);
  expect(allowedWorkspaceNavigation(['history.view']).map((entry) => entry.to)).toEqual(['/products', '/admin/corrections/history']);
  expect(isWorkspaceDestination(workspaceNavigation.find((entry) => entry.to === '/admin/corrections'), '/admin/corrections/history')).toBe(false);
  render(<AuthContext.Provider value={auth(['history.view', 'exports.view'])}><MemoryRouter initialEntries={['/products/history']}><WorkspaceNav /></MemoryRouter></AuthContext.Provider>);
  expect(screen.getByRole('link', { name: 'Товари' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('link', { name: 'Експорт' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Розділи/ })).toBeNull();
});

it('direct recount shows the stable article and permanent internal transition without a legacy choice', () => {
  render(<RecountConfirmDialog isOpen mode="apply" canPriceOverride previewCurrent preview={{ source: { publicSku: 'AG-000002', internalSku: 'SV227001', totalPriceUah: 100 }, corrected: { publicSku: 'AG-000002', internalSku: 'SV227002', totalPriceUah: 120 } }} onCancel={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Застосувати переоблік' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Створити запит' })).toBeNull();
  expect(screen.queryByText(/Внутрішній SKU/)).toBeNull(); expect(screen.queryByText(/Артикул товару збережеться/)).toBeNull();
  expect(screen.getByRole('radio', { name: 'Ручна UAH' })).toBeTruthy();
  expect(screen.getAllByText('AG-000002')).toHaveLength(2);
  expect(screen.queryByText(/коригувальний артикул|не потрапить.*експорт|ручного оновлення сайту/)).toBeNull();
});

it.each([null, false])('does not offer product CSV creation for an unknown or retired delivery gate (%s)', (gate) => {
  render(<ExportTools surface="products" exportStatus={gate === null ? null : { delivery: { legacyProductCsvEnabled: false, automaticSyncEnabled: true } }} onPreviewExport={vi.fn()} onCreateSnapshot={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /Створити файли|Перевірити.*товар|Перевірити діапазон/ })).toBeNull();
  expect(screen.getByText('Історичні файли та окремий експорт цін залишаються доступними.')).toBeTruthy();
});

it.each([true, false])('catalog keyboard ordering respects the existing management capability (%s)', (canManage) => {
  const category = { code: 'SV', name: 'Сувеніри' };
  const questions = [{ id: 'material', q_db_id: 1, label: 'Матеріал' }, { id: 'color', q_db_id: 2, label: 'Колір' }];
  const reorder = vi.fn(); const select = vi.fn();
  render(<AdminStructureEditor canManage={canManage} config={{ categories: { SV: category } }} selectedCat={category}
    selectedQuestion={null} currentCatQuestions={questions} currentOptions={[]} schemaStatus={{ draftChanged: true, nextVersion: 2 }}
    schemaPublishState={{ loading: false }} reorderQuestions={reorder} onSelectQuestion={select} setEditOpt={vi.fn()} />);
  const item = screen.getByText('Матеріал').closest('[role="button"]');
  item.focus(); fireEvent.keyDown(item, { key: 'Enter' });
  expect(select).toHaveBeenCalledWith(questions[0]);
  fireEvent.keyDown(item, { key: 'ArrowDown', altKey: true });
  if (canManage) expect(reorder).toHaveBeenCalledWith([questions[1], questions[0]]);
  else expect(reorder).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Опублікувати V2' }).disabled).toBe(!canManage);
  expect(item.draggable).toBe(canManage);
});
