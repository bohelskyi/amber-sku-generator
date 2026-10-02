import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { RecountNameFields } from '../src/components/app/RecountNameFields.jsx';
import { RecountConfirmDialog } from '../src/components/app/RecountConfirmDialog.jsx';
import { useProductRecount } from '../src/hooks/useProductRecount.js';
import { useSkuManager } from '../src/hooks/useSkuManager.js';
import AppPage from '../src/pages/AppPage.jsx';
import { HomeDashboard } from '../src/components/app/HomeDashboard.jsx';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../src/hooks/useSkuManager.js', () => ({ useSkuManager: vi.fn() }));
const names = { all: 'Точна назва. Арт: AG-000002', en: 'Exact name. Art: AG-000002' };
const permissions = ['products.view', 'products.decode', 'products.recount', 'exports.create'];
const config = { categories: { SV: { code: 'SV', name: 'Сувеніри' } }, questions: { SV: [] } };
const decoded = { existsInDb: true, sku: 'SV227001', publicSku: 'AG-000002', category: config.categories.SV,
  decodedAnswers: [], skuSchema: { version: 1 }, suffix: { type: 'sequence', value: 1 }, product: { id: 5010, status: 'active', details: { answers: {} } } };
const preview = { source: { sku: decoded.sku, publicSku: decoded.publicSku, totalPriceUah: 100, stateSignature: 'name-bound' },
  corrected: { categoryCode: 'SV', publicSku: decoded.publicSku, fullSku: 'SV227002', totalPriceUah: 100 }, changes: [], previewToken: 'reviewed' };
function shell(element, keys = permissions) { return render(<AuthContext.Provider value={{ permissions: keys }}><MemoryRouter>{element}</MemoryRouter></AuthContext.Provider>); }
beforeEach(() => { vi.resetAllMocks(); api.get.mockResolvedValue({ data: { names, nameConflict: false } }); });
afterEach(cleanup);
const formConfig = { ...config, questions: { SV: [{ id: 101, key: 'souvenir', label: 'Тип', input_type: 'text', include_in_sku: 1 }] } };
function NameRecountHarness() {
  const rec = useProductRecount({ config: formConfig, canChangeProductPrice: true });
  return <><button onClick={() => rec.handleDecode(decoded.sku)}>Decode</button><button onClick={rec.handleStartRecount}>Start</button>
    <button onClick={() => rec.handleRecountTextAnswer(101, 'Changed')}>Change characteristics</button>
    {rec.decodeData && <HomeDashboard {...rec} config={formConfig} canChangeProductPrice
      onRecountNameChange={rec.handleRecountNameChange} onApplyRecount={rec.handleApplyRecount}
      onRecountWeightChange={rec.handleRecountWeightChange} onRecountAnswer={rec.handleRecountAnswer} onCancelRecount={rec.handleCancelRecount} />}
    <output data-testid="recount-loading">{String(rec.isRecountLoading)}</output>
    <output data-testid="decoded-product">{rec.decodeData?.product?.id || 'none'}</output>
    <output data-testid="price-open">{String(rec.isPriceChangeOpen)}</output>
    <output data-testid="recount-preview">{rec.recountPreview?.previewToken || 'none'}</output>
    <RecountConfirmDialog isOpen={rec.isRecountConfirmOpen} preview={rec.recountPreview} previewCurrent={rec.isRecountPreviewCurrent} config={formConfig} />
  </>;
}
async function openNameRecount() {
  shell(<NameRecountHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Decode' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/decode', { sku: decoded.sku }));
  await waitFor(() => expect(screen.getByTestId('decoded-product').textContent).toBe('5010'));
  fireEvent.click(screen.getByRole('button', { name: 'Start' })); await screen.findByLabelText('Назва товару українською');
}
const previewCalls = () => api.post.mock.calls.filter(([url]) => url === '/recount/preview');
const settleDebounce = () => act(() => new Promise((resolve) => window.setTimeout(resolve, 450)));
it('unchanged name editing cancellation settles without a preview and keeps price change usable', async () => {
  api.post.mockResolvedValue({ data: decoded }); await openNameRecount();
  const action = screen.getByRole('button', { name: 'Змінити', exact: true });
  fireEvent.click(action); fireEvent.click(action);
  await waitFor(() => expect(screen.getByTestId('recount-loading').textContent).toBe('false'));
  expect(api.post.mock.calls.filter(([url]) => url === '/recount/preview')).toHaveLength(0);
  const price = screen.getByRole('button', { name: 'Змінити ціну' }); expect(price.disabled).toBe(false);
  fireEvent.click(price); expect(screen.getByTestId('price-open').textContent).toBe('true');
});
it('unchanged inline actions preserve a current characteristic preview and usable recount action', async () => {
  api.post.mockImplementation(async (url) => ({ data: url === '/decode' ? decoded : preview }));
  await openNameRecount(); fireEvent.click(screen.getByRole('button', { name: 'Change characteristics' }));
  await waitFor(() => expect(screen.getByTestId('recount-preview').textContent).toBe('reviewed'));
  const action = screen.getByRole('button', { name: 'Змінити', exact: true });
  fireEvent.click(action); fireEvent.click(action); await settleDebounce();
  expect(previewCalls()).toHaveLength(1); expect(screen.getByTestId('recount-loading').textContent).toBe('false');
  expect(screen.getByRole('button', { name: 'Продовжити' }).disabled).toBe(false);
});
it('cancel edited names restores originals immediately and rejects a late name preview', async () => {
  let resolveOld;
  api.post.mockImplementation((url) => url === '/decode' ? Promise.resolve({ data: decoded })
    : new Promise((resolve) => { resolveOld = resolve; }));
  await openNameRecount(); const action = screen.getByRole('button', { name: 'Змінити', exact: true });
  fireEvent.click(action); fireEvent.change(screen.getByLabelText('Назва товару українською'), { target: { value: 'Pending' } });
  await waitFor(() => expect(previewCalls()).toHaveLength(1)); fireEvent.click(action);
  expect(screen.getByLabelText('Назва товару українською').value).toBe(names.all);
  expect(screen.getByTestId('recount-loading').textContent).toBe('false');
  await act(async () => resolveOld({ data: { ...preview, nameChanges: { from: names, to: { ...names, all: 'Pending' } } } }));
  expect(screen.getByTestId('recount-preview').textContent).toBe('none');
  expect(screen.queryByText(/Назва українською:/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Змінити ціну' }).disabled).toBe(false);
});
it('cancel names restores the characteristic payload and older requests cannot replace it', async () => {
  let resolveOld; let resolveCurrent; let normalPreviews = 0;
  api.post.mockImplementation((url, payload) => url === '/decode' ? Promise.resolve({ data: decoded })
    : payload.nameChange ? new Promise((resolve) => { resolveOld = resolve; })
      : ++normalPreviews === 1 ? Promise.resolve({ data: preview }) : new Promise((resolve) => { resolveCurrent = resolve; }));
  await openNameRecount(); fireEvent.click(screen.getByRole('button', { name: 'Change characteristics' }));
  await waitFor(() => expect(previewCalls()).toHaveLength(1));
  const action = screen.getByRole('button', { name: 'Змінити', exact: true }); fireEvent.click(action);
  fireEvent.change(screen.getByLabelText('Назва товару англійською'), { target: { value: 'Pending English' } });
  await waitFor(() => expect(previewCalls()).toHaveLength(2)); fireEvent.click(action);
  await waitFor(() => expect(previewCalls()).toHaveLength(3));
  expect(previewCalls()[2][1]).toEqual(previewCalls()[0][1]);
  await act(async () => resolveOld({ data: { ...preview, previewToken: 'stale-name', nameChanges: { from: names, to: { ...names, en: 'Pending English' } } } }));
  expect(screen.getByTestId('recount-loading').textContent).toBe('true');
  await act(async () => resolveCurrent({ data: preview }));
  expect(screen.getByTestId('recount-preview').textContent).toBe('reviewed');
  expect(screen.getByTestId('recount-loading').textContent).toBe('false');
  api.post.mockResolvedValue({ data: preview });
  fireEvent.click(screen.getByRole('button', { name: 'Продовжити' })); await screen.findByRole('dialog');
  expect(screen.queryByText(/Назва українською:|Назва англійською:/)).toBeNull();
});
it('rapid inline name actions never request unchanged previews or leave recalculation running', async () => {
  api.post.mockResolvedValue({ data: decoded }); await openNameRecount();
  const action = screen.getByRole('button', { name: 'Змінити', exact: true });
  for (let i = 0; i < 4; i += 1) { fireEvent.click(action); fireEvent.click(action); }
  fireEvent.click(action); fireEvent.change(screen.getByLabelText('Назва товару українською'), { target: { value: 'Cancel before debounce' } });
  fireEvent.click(action); await settleDebounce();
  expect(previewCalls()).toHaveLength(0); expect(action.textContent).toBe('Змінити');
  expect(screen.getByTestId('recount-loading').textContent).toBe('false');
  expect(screen.getByRole('button', { name: 'Змінити ціну' }).disabled).toBe(false);
});
it('failed name preview clears loading and changed inputs can obtain a new preview', async () => {
  let fail = true;
  api.post.mockImplementation(async (url) => {
    if (url === '/decode') return { data: decoded };
    if (fail) throw new Error('Preview unavailable');
    return { data: preview };
  });
  await openNameRecount(); fireEvent.click(screen.getByRole('button', { name: 'Змінити', exact: true }));
  fireEvent.change(screen.getByLabelText('Назва товару українською'), { target: { value: 'First' } });
  await screen.findByText('Ще не визначено'); expect(screen.getByTestId('recount-loading').textContent).toBe('false');
  expect(screen.getByRole('button', { name: 'Продовжити' }).disabled).toBe(false);
  fail = false; fireEvent.change(screen.getByLabelText('Назва товару українською'), { target: { value: 'Second' } });
  await waitFor(() => expect(screen.getByTestId('recount-preview').textContent).toBe('reviewed'));
  expect(screen.getByTestId('recount-loading').textContent).toBe('false'); expect(previewCalls()).toHaveLength(2);
});
it('inline UA label action focuses editing and cancellation restores both exact names', async () => {
  const onChange = vi.fn(); shell(<RecountNameFields productId={5010} mode="apply" onChange={onChange} />);
  const ua = await screen.findByLabelText('Назва товару українською');
  expect(ua.value).toBe(names.all); expect(ua.readOnly).toBe(true); expect(onChange).not.toHaveBeenCalled();
  expect(ua.disabled).toBe(false); expect(ua.classList.contains('input-readonly')).toBe(true);
  const en = screen.getByLabelText('Назва товару англійською');
  expect(en.value).toBe(names.en); expect(en.readOnly).toBe(true); expect(en.classList.contains('input-readonly')).toBe(true);
  const action = screen.getByRole('button', { name: 'Змінити', exact: true }); expect(action.textContent).toBe('Змінити');
  expect(ua.closest('.builder-field-row').querySelector('.builder-field-label').contains(action)).toBe(true);
  expect(action.type).toBe('button'); expect(action.tabIndex).toBe(0);
  expect(action.getAttribute('aria-controls')).toBe(`${ua.id} ${en.id}`);
  expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByRole('switch')).toBeNull();
  action.focus(); expect(document.activeElement).toBe(action);
  fireEvent.click(action); expect(ua.readOnly).toBe(false); expect(ua.classList.contains('input-readonly')).toBe(false);
  expect(document.activeElement).toBe(ua); expect(en.readOnly).toBe(false); expect(en.classList.contains('input-readonly')).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(ua, { target: { value: 'Edited full name' } }); expect(onChange).toHaveBeenLastCalledWith({ ...names, all: 'Edited full name' });
  fireEvent.change(en, { target: { value: 'Edited English' } });
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати', exact: true }));
  expect(ua.value).toBe(names.all); expect(ua.readOnly).toBe(true); expect(onChange).toHaveBeenLastCalledWith(null);
  expect(ua.classList.contains('input-readonly')).toBe(true);
  expect(en.value).toBe(names.en); expect(en.readOnly).toBe(true); expect(en.classList.contains('input-readonly')).toBe(true);
  expect(action.textContent).toBe('Змінити');
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText(/Підтвердити без змін/)).toBeNull();
});
it('inline name action retains the existing busy guard', async () => {
  const onChange = vi.fn(); const view = shell(<RecountNameFields productId={5010} mode="apply" busy onChange={onChange} />);
  const ua = await screen.findByLabelText('Назва товару українською');
  expect(screen.getByRole('button', { name: 'Змінити', exact: true }).disabled).toBe(true);
  view.rerender(<AuthContext.Provider value={{ permissions }}><MemoryRouter><RecountNameFields productId={5010} mode="apply" onChange={onChange} /></MemoryRouter></AuthContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Змінити', exact: true })); expect(ua.readOnly).toBe(false);
  view.rerender(<AuthContext.Provider value={{ permissions }}><MemoryRouter><RecountNameFields productId={5010} mode="apply" busy onChange={onChange} /></MemoryRouter></AuthContext.Provider>);
  expect(screen.getByRole('button', { name: 'Скасувати', exact: true }).disabled).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});
it('invalid names are clear and existing conflicts disable editing with a resolution link', async () => {
  const onChange = vi.fn(); const view = shell(<RecountNameFields productId={5010} mode="apply" onChange={onChange} />);
  await screen.findByLabelText('Назва товару українською'); fireEvent.click(screen.getByRole('button', { name: 'Змінити', exact: true }));
  fireEvent.change(screen.getByLabelText('Назва товару англійською'), { target: { value: '' } }); expect(screen.getByRole('alert')).toBeTruthy();
  view.unmount(); api.get.mockResolvedValue({ data: { names, nameConflict: true } });
  shell(<RecountNameFields productId={5010} mode="apply" onChange={onChange} />);
  await screen.findByRole('link', { name: 'Проблеми синхронізації' });
  expect(screen.queryByRole('button', { name: 'Змінити', exact: true })).toBeNull();
  expect(screen.getByLabelText('Назва товару українською').readOnly).toBe(true);
});
it('request-only and users without name-change permission retain read-only names', async () => {
  for (const keys of [['products.decode', 'corrections.create'], ['products.decode', 'products.recount']]) {
    const view = shell(<RecountNameFields productId={5010} mode={keys.includes('products.recount') ? 'apply' : 'request'} onChange={vi.fn()} />, keys);
    expect((await screen.findByLabelText('Назва товару українською')).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Змінити', exact: true })).toBeNull();
    view.unmount();
  }
});
it('exact edits participate in authoritative recount preview and apply payload', async () => {
  let resolveDecode;
  const decodeResponse = new Promise((resolve) => { resolveDecode = resolve; });
  api.post.mockImplementation(async (url) => {
    if (url === '/decode') return decodeResponse;
    return { data: url === '/recount/apply' ? { corrected: { publicSku: decoded.publicSku } } : preview };
  });
  function Harness() {
    const rec = useProductRecount({ config });
    return <><button onClick={() => rec.handleDecode(decoded.sku)}>Decode</button><button onClick={rec.handleStartRecount}>Start</button>
      {rec.decodeData && <HomeDashboard {...rec} config={config} onRecountNameChange={rec.handleRecountNameChange}
        onRecountWeightChange={rec.handleRecountWeightChange} onRecountAnswer={rec.handleRecountAnswer} onCancelRecount={rec.handleCancelRecount} />}
      <output data-testid="decoded-product">{rec.decodeData?.product?.id || 'none'}</output>
      <output>{rec.isRecountPreviewCurrent ? 'Ready' : 'Waiting'}</output><button onClick={() => rec.handleConfirmRecount('apply')}>Apply</button></>;
  }
  shell(<Harness />); fireEvent.click(screen.getByRole('button', { name: 'Decode' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/decode', { sku: decoded.sku }));
  expect(screen.getByTestId('decoded-product').textContent).toBe('none');
  expect(screen.queryByLabelText('Назва товару українською')).toBeNull();
  await act(async () => resolveDecode({ data: decoded }));
  await waitFor(() => expect(screen.getByTestId('decoded-product').textContent).toBe('5010'));
  fireEvent.click(screen.getByRole('button', { name: 'Start' })); await screen.findByLabelText('Назва товару українською');
  fireEvent.click(screen.getByRole('button', { name: 'Змінити', exact: true }));
  fireEvent.change(screen.getByLabelText('Назва товару українською'), { target: { value: 'Новий точний текст' } }); await screen.findByText('Ready');
  expect(api.post).toHaveBeenCalledWith('/recount/preview', expect.objectContaining({ nameChange: { ...names, all: 'Новий точний текст' } }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/recount/apply', expect.objectContaining({ nameChange: { ...names, all: 'Новий точний текст' }, sourceStateSignature: 'name-bound', previewToken: 'reviewed' })));
});
it('confirmation shows old to new names only for an actual explicit change', () => {
  const view = render(<RecountConfirmDialog isOpen preview={preview} config={config} />);
  expect(screen.queryByText(/Назва українською:/)).toBeNull();
  view.rerender(<RecountConfirmDialog isOpen preview={{ ...preview, nameChanges: { from: names, to: { all: 'New UA', en: 'New EN' } } }} config={config} />);
  expect(screen.getByText(`Назва українською: ${names.all} → New UA`)).toBeTruthy();
  view.rerender(<RecountConfirmDialog isOpen preview={{ ...preview, nameChanges: { from: names, to: { ...names, all: 'New UA' } } }} config={config} />);
  expect(screen.queryByText(/Назва англійською:/)).toBeNull();
});
for (const keys of [['products.recount'], ['products.recount', 'corrections.create'], ['corrections.create']]) {
  it(`daily Products visibility follows ${keys.join('+')}`, () => {
    const onStart = vi.fn();
    useSkuManager.mockReturnValue({ config, decodeData: decoded, handleDecode: vi.fn(), handleStartRecount: onStart });
    shell(<AppPage />, ['products.view', 'products.decode', ...keys]);
    expect(screen.queryByRole('button', { name: 'Передати зміни на розгляд' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: keys.includes('products.recount') ? 'Переоблікувати' : 'Підготувати запит' }));
    expect(onStart).toHaveBeenCalledOnce();
    expect(useSkuManager).toHaveBeenCalledWith(expect.objectContaining({ submitMode: keys.includes('products.recount') ? 'apply' : 'request' }));
  });
}
