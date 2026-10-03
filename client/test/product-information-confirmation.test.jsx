import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useProductRecount } from '../src/hooks/useProductRecount.js';
import { api } from '../src/lib/api.js';

vi.mock('../src/lib/api.js', () => ({ api: { post: vi.fn() } }));

const config = {
  categories: { BR: { code: 'BR', name: 'Браслети', requires_weight: 1 } },
  questions: { BR: [{
    id: 'braclet_size', key: 'braclet_size', label: 'Розмір', required: 1,
    include_in_sku: 0, options: [{ id: 1, label: 'Малий' }, { id: 2, label: 'Великий' }],
  }] },
};
const decoded = {
  existsInDb: true,
  sku: 'BR-INTERNAL-1',
  publicSku: 'AG-000041',
  category: config.categories.BR,
  decodedAnswers: [{ key: 'braclet_size', value_id: 1, value_label: 'Малий' }],
  product: { id: 41, weight: 5, details: { answers: { braclet_size: 1 } } },
};

function Harness() {
  const recount = useProductRecount({ config });
  return <>
    <button type="button" onClick={() => recount.handleDecode(decoded.publicSku)}>Відкрити</button>
    <button type="button" onClick={recount.handleStartRecount}>Почати</button>
    <button type="button" onClick={() => recount.handleRecountAnswer('braclet_size', 2)}>Змінити розмір</button>
    <button type="button" onClick={recount.handleApplyRecount}>Продовжити</button>
    <button type="button" onClick={recount.handleConfirmInformationUpdate}>Підтвердити оновлення</button>
    <output aria-label="Відкрита перевірка">{String(recount.isInformationConfirmOpen)}</output>
    <output aria-label="Результат">{recount.recountSuccess}</output>
  </>;
}

beforeEach(() => {
  api.post.mockReset().mockImplementation(async (url) => {
    if (url === '/decode') return { data: decoded };
    if (url === '/product-information/preview') return { data: { previewToken: 'reviewed-information' } };
    if (url === '/product-information/apply') return { data: { state: 'applied' } };
    throw new Error(`Unexpected ${url}`);
  });
});
afterEach(cleanup);

it('separates authoritative information preview from apply and reports only the public article', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/decode', { sku: decoded.publicSku }));
  fireEvent.click(screen.getByRole('button', { name: 'Почати' }));
  fireEvent.click(screen.getByRole('button', { name: 'Змінити розмір' }));
  fireEvent.click(screen.getByRole('button', { name: 'Продовжити' }));

  await waitFor(() => expect(screen.getByLabelText('Відкрита перевірка').textContent).toBe('true'));
  expect(api.post.mock.calls.filter(([url]) => url === '/product-information/apply')).toHaveLength(0);
  expect(api.post).toHaveBeenCalledWith('/product-information/preview', {
    productId: 41, answersPatch: { braclet_size: 2 },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити оновлення' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/product-information/apply', {
    productId: 41,
    answersPatch: { braclet_size: 2 },
    previewToken: 'reviewed-information',
    reason: '',
  }));
  expect(await screen.findByText(/AG-000041/)).toBeTruthy();
  expect(screen.getByLabelText('Результат').textContent).not.toContain('BR-INTERNAL-1');
});
