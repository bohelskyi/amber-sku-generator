import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AppPage from '../src/pages/AppPage.jsx';
import { HistoryTable } from '../src/components/app/HistoryTable.jsx';
import { useSkuManager } from '../src/hooks/useSkuManager.js';
import { api } from '../src/lib/api.js';

vi.mock('../src/auth/auth-context.js', async (importOriginal) => ({
  ...await importOriginal(),
  useAuth: () => ({
    permissions: ['products.view', 'products.create', 'products.decode', 'history.view'],
    roles: [],
  }),
}));

const config = {
  categories: { SV: { code: 'SV', name: 'Сувеніри', requires_weight: 0 } },
  questions: { SV: [] },
  extraConfig: {},
};
const preview = { fullProposedSku: 'SV137001', skuSchemaVersionId: 3, previewToken: 'reviewed', totalPriceUah: 1000 };
const saved = { id: 21, publicSku: 'AG-000021', fullSku: 'SV137001', internalSku: 'SV137001' };
let post;
let writeText;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({ data: url === '/config' ? config : url === '/products' ? [] : {} }));
  post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/save') return { data: saved };
    if (url === '/variation') return { data: { fullSku: 'SV137001-001', variationNumber: 1 } };
    return { data: preview };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openPreview() {
  const router = createMemoryRouter([{ path: '*', element: <AppPage /> }], { initialEntries: ['/products'] });
  render(<RouterProvider router={router} />);
  fireEvent.click(await screen.findByRole('button', { name: /Сувеніри/ }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/products/create'));
  expect(router.state.location.search).toBe('?category=SV');
  fireEvent.click(await screen.findByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
}

it('keeps the proposed encoded SKU in technical details without a normal copy action', async () => {
  await openPreview();
  const identity = screen.getByText(preview.fullProposedSku);
  expect(identity.closest('details').querySelector('summary').textContent).toBe('Технічні деталі');
  expect(identity.closest('details').textContent).toContain('Внутрішній SKU');
  expect(screen.queryByRole('button', { name: 'Копіювати SKU' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Копіювати артикул' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Копіювати ціну' })).toBeTruthy();
});

it.each(['AG-000021', 'LEGACY/21-001'])('copies the exact saved public article %s', async (publicSku) => {
  post.mockImplementation(async (url) => ({ data: url === '/save' ? { ...saved, publicSku } : preview }));
  await openPreview();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  const copy = await screen.findByRole('button', { name: 'Копіювати артикул' });
  expect(screen.getByText(publicSku)).toBeTruthy();
  expect(screen.queryByText(saved.fullSku)).toBeNull();
  fireEvent.click(copy);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(publicSku));
  expect(writeText).toHaveBeenCalledTimes(1);
});

it.each([undefined, null, ''])('does not fall back to an internal SKU when publicSku is %s', async (publicSku) => {
  post.mockImplementation(async (url) => ({ data: url === '/save' ? { ...saved, publicSku } : preview }));
  await openPreview();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  expect(await screen.findByText(/Артикул недоступний у відповіді сервера/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Копіювати артикул' })).toBeNull();
  expect(screen.queryByText(saved.fullSku)).toBeNull();
  expect(writeText).not.toHaveBeenCalled();
});

it('keeps the save receipt through the existing post-save reset and clears it at the next creation start', async () => {
  const { result } = renderHook(() => useSkuManager());
  await waitFor(() => expect(result.current.config).toBe(config));
  act(() => result.current.resetProductFlow('SV'));
  await act(() => result.current.handlePreview());
  act(() => result.current.handleSave());
  await waitFor(() => expect(result.current.savedProduct).toEqual(saved));
  expect(result.current.selectedCat).toBeNull();
  expect(result.current.finalSku).toBe('');
  act(() => result.current.resetProductFlow(null));
  expect(result.current.savedProduct).toEqual(saved);
  act(() => result.current.resetProductFlow('SV'));
  expect(result.current.savedProduct).toBeNull();
  expect(result.current.previewData).toBeNull();
});

it('removes the previous receipt when the operator selects the next category', async () => {
  await openPreview();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  await screen.findByRole('button', { name: 'Копіювати артикул' });
  fireEvent.click(screen.getByRole('button', { name: /Сувеніри/ }));
  await waitFor(() => expect(screen.queryByText(saved.publicSku)).toBeNull());
  expect(screen.queryByText(/Товар збережено/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Копіювати артикул' })).toBeNull();
});

it.each(['/preview', '/variation'])('a delayed %s response cannot restore the previous saved receipt', async (url) => {
  const { result } = renderHook(() => useSkuManager());
  await waitFor(() => expect(result.current.config).toBe(config));
  act(() => result.current.resetProductFlow('SV'));
  await act(() => result.current.handlePreview());
  act(() => result.current.handleSave());
  await waitFor(() => expect(result.current.savedProduct).toEqual(saved));
  act(() => result.current.resetProductFlow('SV'));
  if (url === '/variation') await act(() => result.current.handlePreview());
  let complete;
  post.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  act(() => {
    if (url === '/preview') result.current.handlePreview();
    else result.current.handleAddVariation();
  });
  expect(result.current.savedProduct).toBeNull();
  await act(async () => complete({ data: url === '/preview' ? preview : { fullSku: 'SV137001-001', variationNumber: 1 } }));
  expect(result.current.savedProduct).toBeNull();
  expect(result.current.finalSku).toBe(url === '/preview' ? preview.fullProposedSku : 'SV137001-001');
});

it('preserves the current preview on failed save without creating a public receipt', async () => {
  post.mockImplementation(async (url) => {
    if (url === '/save') throw new Error('Save rejected');
    return { data: preview };
  });
  await openPreview();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  expect(await screen.findByText('Save rejected')).toBeTruthy();
  expect(screen.getByText(preview.fullProposedSku)).toBeTruthy();
  expect(screen.queryByText(/Товар збережено/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Копіювати артикул' })).toBeNull();
  expect(post.mock.calls.filter(([url]) => url === '/save')).toHaveLength(1);
});

it('never exposes the variation preview as a public article to copy', async () => {
  await openPreview();
  fireEvent.click(screen.getByRole('button', { name: /варіацію/i }));
  expect(await screen.findByText('SV137001-001')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Копіювати SKU' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Копіювати артикул' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Копіювати артикул' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(saved.publicSku));
  expect(post).toHaveBeenCalledWith('/variation', { sku: preview.fullProposedSku });
  expect(post).toHaveBeenCalledWith('/save', expect.objectContaining({ useVariation: true }));
});

it('reports clipboard failure without changing or resaving the authoritative receipt', async () => {
  writeText.mockRejectedValue(new Error('Clipboard denied'));
  await openPreview();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Копіювати артикул' }));
  expect(await screen.findByText('Не вдалося скопіювати')).toBeTruthy();
  expect(screen.getByText(saved.publicSku)).toBeTruthy();
  expect(post.mock.calls.filter(([url]) => url === '/save')).toHaveLength(1);
});

it('retains public-first copy, decode and history links for existing products', () => {
  const copy = vi.fn();
  const decode = vi.fn();
  render(<MemoryRouter><HistoryTable history={[{ id: 21, public_sku: saved.publicSku, full_sku: saved.fullSku, category: 'SV' }]}
    config={config} onCopyText={copy} onDecode={decode} canArchive={false} /></MemoryRouter>);
  fireEvent.click(screen.getByText('Останні збережені'));
  fireEvent.click(screen.getByRole('button', { name: 'Копіювати артикул' }));
  fireEvent.click(screen.getByRole('button', { name: 'Розшифрувати' }));
  expect(copy).toHaveBeenCalledWith(saved.publicSku, 'Артикул');
  expect(decode).toHaveBeenCalledWith(saved.publicSku);
  expect(screen.getByRole('link', { name: 'Історія' }).getAttribute('href')).toBe(`/products/history?sku=${saved.fullSku}`);
});
