import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProductBuilder } from '../src/components/app/ProductBuilder.jsx';
import { useSkuManager } from '../src/hooks/useSkuManager.js';
import { api } from '../src/lib/api.js';

const config = {
  categories: { BR: { code: 'BR', name: 'Браслети', requires_weight: 1 } },
  questions: { BR: [{ id: 'weight', label: 'Вага', input_type: 'text', required: 1,
    numeric_validation: { kind: 'decimal', min: 0, minInclusive: false, unit: 'г', maxFractionDigits: 3 } }] },
  productCreation: { identityMode: 'public_identity' },
  productPhotoRequirements: { available: true }, extraConfig: {},
};
const preview = { mode: 'public_identity', identityMode: 'public_identity', characteristicConfigHash: 'a'.repeat(64),
  normalizedAnswers: { weight: 12.7 }, weightVal: 12.7, previewToken: 'synthetic-photo-review',
  totalPriceUah: 1200, calculatedPriceUah: 1200, totalPrice: 30, uahRate: 40 };
let post;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({ data: url === '/config' ? config : [] }));
  post = vi.spyOn(api, 'post');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Harness() {
  const sku = useSkuManager();
  return sku.config ? <><button onClick={() => sku.resetProductFlow('BR')}>Новий товар</button>{sku.selectedCat && <ProductBuilder {...sku}
    getVisibleOptionsForQuestion={sku.getVisibleOptions} isQuestionVisible={sku.getQuestionVisibility}
    onAnswer={sku.handleAnswer} onTextAnswer={sku.handleTextAnswer} onPreview={sku.handlePreview}
    onSave={sku.handleSave} onCancel={() => sku.resetProductFlow(null)} />}</> : null;
}
async function reviewed() {
  render(<Harness />);
  fireEvent.click(await screen.findByRole('button', { name: 'Новий товар' }));
  fireEvent.change(screen.getByLabelText(/Вага/), { target: { value: '12,7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
}
const selectPhoto = (name) => fireEvent.change(screen.getByLabelText('Додати фото'), {
  target: { files: [new File([new Uint8Array(40)], name, { type: 'image/png' })] },
});

it('separates validated data from failed media and leads to the exact retry before renewed review and explicit save', async () => {
  let stages = 0;
  post.mockImplementation(async (url, body) => {
    if (url === '/product-photos/stage') {
      if (++stages === 1) throw new Error('Lost photo response');
      return { data: { id: 'recovered-photo', name: body.name } };
    }
    return { data: url === '/save' ? { id: 42, publicSku: 'AG-000042' } : preview };
  });
  await reviewed(); selectPhoto('recover.png');
  const blocker = await screen.findByText('Фото не збережені. Повторіть збереження цих фото або приберіть їх зі спроби.');
  const save = screen.getByRole('button', { name: 'Зберегти товар' });
  expect(save.disabled).toBe(true);
  expect(save.getAttribute('aria-describedby')).toBe(blocker.parentElement.id);
  expect(screen.getByText('Фото потребують уваги').classList.contains('is-error')).toBe(true);
  expect(screen.queryByText('Перевірено')).toBeNull();
  expect(screen.getByText('Дані товару перевірено.')).toBeTruthy();
  expect(post.mock.calls.filter(([url]) => url === '/product-photos/stage')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Перейти до фото' }));
  expect(document.activeElement.contains(screen.getByLabelText('Додати фото'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Повторити збереження цих фото' }));
  await screen.findByText('Головне');
  const sent = post.mock.calls.filter(([url]) => url === '/product-photos/stage');
  expect(sent).toHaveLength(2); expect(sent[1][1]).toEqual(sent[0][1]);
  await screen.findByRole('button', { name: 'Перевірити дані' });
  expect(screen.queryByRole('button', { name: 'Зберегти товар' })).toBeNull();
  expect(screen.queryByText('Фото потребують уваги')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  expect(screen.getByText('Дані перевірено').classList.contains('is-success')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  await waitFor(() => expect(post.mock.calls.some(([url]) => url === '/save')).toBe(true));
  expect(post.mock.calls.find(([url]) => url === '/save')[1].photoIds).toEqual(['recovered-photo']);
});

it('keeps the summary neutral and the save blocked until a pending photo upload settles', async () => {
  let settlePhoto;
  post.mockImplementation((url) => url === '/product-photos/stage'
    ? new Promise(resolve => { settlePhoto = resolve; }) : Promise.resolve({ data: preview }));
  await reviewed(); selectPhoto('uploading.png');
  const pendingState = await screen.findByText('Очікуємо фото');
  expect(pendingState.classList.contains('is-success')).toBe(false);
  expect(screen.getByRole('button', { name: 'Зберегти товар' }).disabled).toBe(true);
  expect(screen.getByText('Зачекайте завершення збереження фото. Товар поки не можна зберегти.')).toBeTruthy();
  expect(post.mock.calls.some(([url]) => url === '/save')).toBe(false);
  await waitFor(() => expect(post.mock.calls.filter(([url]) => url === '/product-photos/stage')).toHaveLength(1));
  await act(async () => settlePhoto({ data: { id: 'uploaded-photo', name: 'uploading.png' } }));
  await screen.findByRole('button', { name: 'Перевірити дані' });
  expect(screen.queryByText('Очікуємо фото')).toBeNull();
});


it('makes the chosen second photo primary and binds the reviewed order and visibility intent to explicit creation', async () => {
  let staged = 0;
  post.mockImplementation(async (url, body) => ({ data: url === '/product-photos/stage'
    ? { id: `ordered-photo-${++staged}`, name: body.name }
    : url === '/save' ? { id: 42, publicSku: 'AG-000042' } : preview }));
  await reviewed();
  fireEvent.change(screen.getByLabelText('Додати фото'), { target: { files: [
    new File([new Uint8Array(40)], 'front.png', { type: 'image/png' }),
    new File([new Uint8Array(40)], 'back.png', { type: 'image/png' }),
  ] } });
  await screen.findByRole('img', { name: 'back.png' });
  const drag = screen.getByRole('button', { name: 'Перемістити back.png' });
  fireEvent.keyDown(drag, {key:' '}); fireEvent.keyDown(drag, {key:'ArrowLeft'}); fireEvent.keyDown(drag, {key:'Enter'});
  expect(within(screen.getByRole('img', { name: 'back.png' }).closest('li')).getByText('Головне')).toBeTruthy();
  await screen.findByRole('button', { name: 'Перевірити дані' });
  expect(post.mock.calls.some(([url]) => url === '/save')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  const checked = post.mock.calls.filter(([url]) => url === '/preview').at(-1)[1];
  expect(checked).toMatchObject({ photoIds: ['ordered-photo-2', 'ordered-photo-1'], enableWhenPhotosVerified: true });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Увімкнути товар у Magento після перевірки всіх фото' }));
  await screen.findByRole('button', { name: 'Перевірити дані' });
  expect(screen.queryByRole('button', { name: 'Зберегти товар' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  await waitFor(() => expect(post.mock.calls.some(([url]) => url === '/save')).toBe(true));
  const saved = post.mock.calls.find(([url]) => url === '/save')[1];
  expect(saved).toMatchObject({ photoIds: ['ordered-photo-2', 'ordered-photo-1'], enableWhenPhotosVerified: false });
  expect(post.mock.calls.filter(([url]) => url === '/product-photos/stage')).toHaveLength(2);
});
