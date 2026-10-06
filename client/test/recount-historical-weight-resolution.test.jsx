import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createRequire } from 'node:module';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { useProductRecount } from '../src/hooks/useProductRecount.js';
import { HomeDashboard } from '../src/components/app/HomeDashboard.jsx';
const require = createRequire(import.meta.url);
const { resolveProductWeight } = require('../../server/src/utils/numbers.js');
vi.mock('../src/lib/api.js', () => ({ api: { post: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('resolves an inherited weight conflict through the single physical input even without a current weight question', async () => {
  const decoded = { existsInDb: true, sku: 'AG-000091', publicSku: 'AG-000091',
    category: { code: 'SV', requires_weight: 0 }, decodedAnswers: [],
    product: { id: 91, status: 'active', weight: '12.3', details: { answers: { weight: '14,2', size: '0012' } } } };
  api.post.mockImplementation(async (url, body) => {
    if (url === '/decode') return { data: decoded };
    if (url === '/recount/preview') {
      resolveProductWeight(body.weight, body.answers.weight);
      return { data: { source: { stateSignature: 'accepted-source', publicSku: decoded.publicSku },
        corrected: { publicSku: decoded.publicSku, totalPriceUah: 1200 },
        changes: [{ key: 'weight', from: '14,2', to: 12.3 }], previewToken: 'accepted-preview' } };
    }
    if (url === '/recount/apply') {
      resolveProductWeight(body.weight, body.answers.weight);
      return { data: { corrected: { publicSku: decoded.publicSku } } };
    }
    throw Error(`Unexpected ${url}`);
  });
  const { result } = renderHook(() => useProductRecount({ config: { questions: { SV: [] } } }));
  await act(async () => result.current.handleDecode(decoded.publicSku));
  await waitFor(() => expect(result.current.decodeData).toBeTruthy());
  act(() => result.current.handleStartRecount());
  expect(result.current.recountWeight).toBe('');
  act(() => result.current.handleRecountWeightChange('12,3'));
  await waitFor(() => expect(result.current.isRecountPreviewCurrent).toBe(true));
  expect(api.post.mock.calls.find(([url]) => url === '/recount/preview')[1]).toMatchObject({
    weight: 12.3, answers: { weight: 12.3, size: '0012' }, pricingDecision: { mode: 'system_auto' },
  });
  expect(api.post.mock.calls.some(([url]) => url === '/recount/apply')).toBe(false);
  await act(async () => result.current.handleConfirmRecount());
  expect(api.post.mock.calls.find(([url]) => url === '/recount/apply')[1]).toMatchObject({
    weight: 12.3, answers: { weight: 12.3, size: '0012' }, sourceStateSignature: 'accepted-source',
    previewToken: 'accepted-preview', pricingDecision: { mode: 'system_auto' },
  });
});

it('the rendered recount field leaves conflicting history unresolved until an explicit comma value produces one accepted weight', async () => {
  const decoded = { existsInDb: true, sku: 'AG-000091', publicSku: 'AG-000091',
    category: { code: 'SV', name: 'Сувеніри', requires_weight: 0 }, decodedAnswers: [],
    identityMode: 'public_identity', internalSku: null, suffix: { type: 'none' }, skuSchema: { id: null }, pricing: null,
    product: { id: 91, status: 'active', weight: '12.3', details: { answers: { weight: '14,2' } } } };
  api.post.mockImplementation(async (url, body) => {
    if (url === '/decode') return { data: decoded };
    if (url === '/recount/preview') {
      resolveProductWeight(body.weight, body.answers.weight);
      return { data: { source: { publicSku: decoded.publicSku }, corrected: { publicSku: decoded.publicSku, totalPriceUah: 1200 },
        changes: [{ key: 'weight', from: '14,2', to: body.weight }], previewToken: 'reviewed' } };
    }
    throw Error(`Unexpected ${url}`);
  });
  function Harness() {
    const config = { categories: { SV: decoded.category }, questions: { SV: [] } };
    const r = useProductRecount({ config });
    return <HomeDashboard config={config} skuToDecode={decoded.publicSku} decodeData={r.decodeData}
      onDecode={() => r.handleDecode(decoded.publicSku)} onDecodeInputChange={vi.fn()} onStart={vi.fn()}
      onStartRecount={r.handleStartRecount} onCancelRecount={r.handleCancelRecount}
      onRecountWeightChange={r.handleRecountWeightChange} onRecountReasonChange={r.setRecountReason}
      onApplyRecount={r.handleApplyRecount} onRecountNameChange={r.setRecountNameChange}
      isRecountOpen={r.isRecountOpen} recountWeight={r.recountWeight} recountAnswers={r.recountAnswers}
      recountReason={r.recountReason} recountBlockers={r.recountBlockers} recountPreview={r.recountPreview}
      hasRecountChanges={r.hasRecountChanges} isRecountLoading={r.isRecountLoading}
      isRecountPreviewCurrent={r.isRecountPreviewCurrent} isRecountPreviewUnavailable={r.isRecountPreviewUnavailable}/>;
  }
  render(<MemoryRouter><Harness/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити товар' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Переоблік' }));
  const input = screen.getByRole('textbox', { name: /Вага виробу/ });
  expect(input.value).toBe(''); expect(screen.getByRole('button', { name: 'Продовжити' }).disabled).toBe(true);
  expect(screen.getByText(/Збережена вага товару: 12.3 г; характеристика: 14,2 г/)).toBeTruthy();
  fireEvent.change(input, { target: { value: '12,3' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Продовжити' }).disabled).toBe(false));
  expect(input.value).toBe('12,3');
  expect(document.querySelectorAll('#recount-weight')).toHaveLength(1);
  expect(api.post.mock.calls.filter(([url]) => url === '/recount/preview').at(-1)[1]).toMatchObject({ weight: 12.3, answers: { weight: 12.3 } });
  expect(api.post.mock.calls.some(([url]) => url === '/recount/apply')).toBe(false);
});
