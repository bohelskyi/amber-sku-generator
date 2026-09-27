import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import { useProductRecount } from '../src/hooks/useProductRecount.js';

vi.mock('../src/lib/api.js', () => ({ api: { post: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('direct recount sends the accepted name-bound source signature and surfaces a stale-name conflict', async () => {
  const question = { id: 'kind', key: 'kind', required: 1, include_in_sku: 1,
    options: [{ id: 1, label: 'One' }, { id: 2, label: 'Two' }] };
  const decoded = { sku: 'ZZ1001', existsInDb: true, category: { code: 'ZZ', requires_weight: 0 },
    decodedAnswers: [{ key: 'kind', value_id: 1 }], product: { id: 1, weight: 0,
      details: { answers: { kind: 1 } } } };
  api.post.mockImplementation(async (url) => {
    if (url === '/decode') return { data: decoded };
    if (url === '/recount/preview') return { data: { source: { stateSignature: 'accepted-name-and-review-evidence' },
      corrected: { fullSku: 'ZZ2001', totalPriceUah: 100, answers: { kind: 2 } } } };
    if (url === '/recount/apply') throw { response: { status: 409, data: { error: 'Оновіть preview переобліку.' } } };
    throw new Error(`Unexpected ${url}`);
  });
  const { result } = renderHook(() => useProductRecount({ config: { questions: { ZZ: [question] } } }));
  await act(async () => result.current.handleDecode('ZZ1001'));
  await waitFor(() => expect(result.current.decodeData).toEqual(decoded));
  act(() => result.current.handleStartRecount());
  act(() => result.current.handleRecountAnswer('kind', 2));
  await waitFor(() => expect(result.current.isRecountPreviewCurrent).toBe(true));
  await act(async () => result.current.handleConfirmRecount());
  const applied = api.post.mock.calls.filter(([url]) => url === '/recount/apply');
  expect(applied).toHaveLength(1);
  expect(applied[0][1]).toMatchObject({ sourceSku: 'ZZ1001', answers: { kind: 2 },
    sourceStateSignature: 'accepted-name-and-review-evidence' });
  expect(result.current.recountError).toBe('Оновіть preview переобліку.');
});
