import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProductBuilder } from '../src/components/app/ProductBuilder.jsx';
import { useSkuManager } from '../src/hooks/useSkuManager.js';
import { api } from '../src/lib/api.js';

const nativeConfig = {
  categories: { BR: { code: 'BR', name: 'Браслети', requires_weight: 1, marketing_rounding_enabled: 1 } },
  questions: { BR: [
    { id: 'weight', label: 'Вага менеджера', input_type: 'text', required: 1, numeric_validation: { kind: 'decimal', min: 0, minInclusive: false, unit: 'г', maxFractionDigits: 3 } },
    { id: 'count', label: 'Кількість', input_type: 'text', required: 1, numeric_validation: { kind: 'integer', min: 0, minInclusive: true } },
    { id: 'dimension', label: 'Позначення розміру', input_type: 'text', required: 0 },
  ] },
  productCreation: { identityMode: 'public_identity', pricingDecision: { available: true, modes: ['system_auto', 'manual_uah', 'usd_per_gram'] } },
  productPhotoRequirements: { available: true },
  extraConfig: {},
};
const nativePreview = { mode: 'public_identity', identityMode: 'public_identity', fullProposedSku: null, internalSku: null, skuSchemaVersionId: null,
  characteristicConfigHash: 'a'.repeat(64), normalizedAnswers: { weight: 12.7, count: 0, dimension: '12,3mm' }, weightVal: 12.7,
  previewToken: 'native-reviewed', totalPriceUah: 1200, calculatedPriceUah: 1200, totalPrice: 30, uahRate: 40 };
let post;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({ data: url === '/config' ? nativeConfig : [] }));
  post = vi.spyOn(api, 'post').mockImplementation(async (url, body) => ({ data: url === '/save' ? { id: 42, publicSku: 'AG-000042', fullSku: null, internalSku: null } : url === '/product-photos/stage' ? { id: 'photo-one', name: body.name } : nativePreview }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function BuilderHarness() {
  const sku = useSkuManager();
  return sku.config ? <><button onClick={() => sku.resetProductFlow('BR')}>Почати товар</button>{sku.selectedCat && <ProductBuilder {...sku}
    getVisibleOptionsForQuestion={sku.getVisibleOptions} isQuestionVisible={sku.getQuestionVisibility}
    onAnswer={sku.handleAnswer} onTextAnswer={sku.handleTextAnswer} onNameSubject={sku.handleNameSubject}
    onPreview={sku.handlePreview} onSave={sku.handleSave} onManualPriceChange={sku.handleManualPriceChange}
    onCreationPricingMode={sku.handleCreationPricingMode} onCreationUsdPerGram={sku.handleCreationUsdPerGram}
    onCreationMarketingRounding={sku.handleCreationMarketingRounding} onCancel={() => sku.resetProductFlow(null)} />}</> : <p>Читаємо…</p>;
}
async function fillBuilder() {
  render(<BuilderHarness />);
  fireEvent.click(await screen.findByRole('button', { name: 'Почати товар' }));
  fireEvent.change(screen.getByLabelText(/Вага менеджера/), { target: { value: '12,7' } });
  fireEvent.change(screen.getByLabelText(/Кількість/), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText(/Позначення розміру/), { target: { value: '12,3mm' } });
}

it('renders one strict Manager weight input, preserves real text, and saves native proof without encoded identity', async () => {
  await fillBuilder();
  expect(screen.queryByText('Внутрішній SKU')).toBeNull();
  expect(screen.queryByLabelText(/Вага виробу/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  expect(screen.queryByRole('button', { name: 'Додати варіацію' })).toBeNull();
  expect(post).toHaveBeenCalledWith('/preview', expect.objectContaining({ answers: { weight: 12.7, count: 0, dimension: '12,3mm' }, weight: 12.7 }));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  await waitFor(() => expect(post.mock.calls.some(([url]) => url === '/save')).toBe(true));
  const save = post.mock.calls.find(([url]) => url === '/save')[1];
  expect(save).toMatchObject({ characteristicConfigHash: nativePreview.characteristicConfigHash, previewToken: 'native-reviewed', weight: 12.7, answers: nativePreview.normalizedAnswers });
  expect(Object.hasOwn(save, 'skuSchemaVersionId')).toBe(false);
  expect(Object.hasOwn(save, 'useVariation')).toBe(false);
});

it('keeps archived questions unavailable for new products without inventing values for them', async () => {
  vi.mocked(api.get).mockImplementation(async (url) => ({ data: url === '/config' ? { ...nativeConfig, questions: { BR: [...nativeConfig.questions.BR, { id: 'old', label: 'Архівна характеристика', input_type: 'text', archived: 1, required: 1 }] } } : [] }));
  await fillBuilder();
  expect(screen.queryByLabelText('Архівна характеристика')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  expect(Object.hasOwn(post.mock.calls.find(([url]) => url === '/preview')[1].answers, 'old')).toBe(false);
});

it('explains forbidden unit suffixes next to the exact integer input while preserving ordinary text', async () => {
  await fillBuilder();
  fireEvent.change(screen.getByLabelText(/Кількість/), { target: { value: '30мм' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  expect(screen.getByLabelText(/Кількість/).getAttribute('aria-invalid')).toBe('true');
  expect(screen.getAllByText('Введіть лише число без одиниць виміру та зайвих символів.').length).toBeGreaterThan(0);
  expect(post.mock.calls.some(([url]) => url === '/preview')).toBe(false);
});

it('binds backend fieldErrors directly to the exact input rather than guessing from the error sentence', async () => {
  post.mockRejectedValue({ response: { data: { error: 'Каталог змінився.', fieldErrors: { count: 'Не більше 4 одиниць.' } } } });
  await fillBuilder(); fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await waitFor(() => expect(screen.getByLabelText(/Кількість/).getAttribute('aria-invalid')).toBe('true'));
  expect(screen.getAllByText('Не більше 4 одиниць.').length).toBeGreaterThan(0);
  expect(screen.getByLabelText(/Вага менеджера/).getAttribute('aria-invalid')).toBeNull();
});

it('offers direct price modes and invalidates the signed review after a USD basis or rounding change', async () => {
  await fillBuilder();
  fireEvent.change(screen.getByLabelText('Як визначити ціну'), { target: { value: 'usd_per_gram' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'USD за грам' }), { target: { value: '2,5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  expect(post).toHaveBeenCalledWith('/preview', expect.objectContaining({ pricingDecision: { mode: 'usd_per_gram', usdPerGram: '2.5', marketingRoundingEnabled: true } }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Маркетингове округлення' }));
  await screen.findByRole('button', { name: 'Перевірити дані' });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  await waitFor(() => expect(post.mock.calls.some(([url]) => url === '/save')).toBe(true));
  const save = post.mock.calls.find(([url]) => url === '/save')[1];
  expect(save.pricingDecision).toEqual({ mode: 'usd_per_gram', usdPerGram: '2.5', marketingRoundingEnabled: false });
  expect(Object.hasOwn(save, 'manualPriceUah')).toBe(false);
});

it('invalidates product review after photo selection and signs ordered IDs plus enable intent in preview/save', async () => {
  await fillBuilder(); fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  const file = new File([new Uint8Array(40)], 'bracelet.png', { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('Додати фото'), { target: { files: [file] } });
  await screen.findByText('Головне');
  await screen.findByRole('button', { name: 'Перевірити дані' });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  expect(post.mock.calls.filter(([url]) => url === '/preview').at(-1)[1]).toMatchObject({ photoIds: ['photo-one'], enableWhenPhotosVerified: true });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  await waitFor(() => expect(post.mock.calls.some(([url]) => url === '/save')).toBe(true));
  expect(post.mock.calls.find(([url]) => url === '/save')[1]).toMatchObject({ photoIds: ['photo-one'], enableWhenPhotosVerified: true });
});

it('fences a delayed native preview after characteristic edits and category cancellation', async () => {
  let resolvePreview;
  post.mockImplementation((url) => url === '/preview' ? new Promise((resolve) => { resolvePreview = resolve; }) : Promise.resolve({ data: nativePreview }));
  const { result } = renderHook(() => useSkuManager());
  await waitFor(() => expect(result.current.config).toBeTruthy());
  act(() => result.current.resetProductFlow('BR'));
  act(() => { result.current.handleTextAnswer('weight', '12,7'); result.current.handleTextAnswer('count', '0'); });
  let checking;
  act(() => { checking = result.current.handlePreview(); });
  act(() => result.current.resetProductFlow(null));
  await act(async () => { resolvePreview({ data: nativePreview }); await checking; });
  expect(result.current.previewData).toBeNull();
  expect(result.current.selectedCat).toBeNull();
});

it('blocks product verification while a photo stage result is unresolved and permits explicit discard', async () => {
  post.mockImplementation(async (url) => {
    if (url === '/product-photos/stage') throw { response: { data: { error: 'Фото ще не підтверджено.' } } };
    return { data: nativePreview };
  });
  await fillBuilder();
  fireEvent.change(screen.getByLabelText('Додати фото'), { target: { files: [new File([new Uint8Array(40)], 'pending.png', { type: 'image/png' })] } });
  await screen.findByText('Не всі фото збережені. Створити товар можна після повторного збереження або вилучення цих фото зі спроби.');
  expect(screen.getByRole('button', { name: 'Перевірити дані' }).disabled).toBe(true);
  expect(post.mock.calls.some(([url]) => url === '/preview')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Прибрати зі спроби' }));
  expect(screen.getByRole('button', { name: 'Перевірити дані' }).disabled).toBe(false);
  expect(post.mock.calls.filter(([url]) => url === '/product-photos/stage')).toHaveLength(1);
});

it('serializes repeated save clicks through one original native create request', async () => {
  let resolveSave;
  post.mockImplementation((url) => url === '/save' ? new Promise((resolve) => { resolveSave = resolve; }) : Promise.resolve({ data: nativePreview }));
  const { result } = renderHook(() => useSkuManager());
  await waitFor(() => expect(result.current.config).toBeTruthy());
  act(() => result.current.resetProductFlow('BR'));
  act(() => { result.current.handleTextAnswer('weight', '12,7'); result.current.handleTextAnswer('count', '0'); });
  await act(() => result.current.handlePreview());
  act(() => { result.current.handleSave(); result.current.handleSave(); });
  expect(post.mock.calls.filter(([url]) => url === '/save')).toHaveLength(1);
  await act(async () => resolveSave({ data: { id: 42, publicSku: 'AG-000042', fullSku: null } }));
  expect(result.current.savedProduct.publicSku).toBe('AG-000042');
});

it('retries an ambiguous native save with its immutable original key and reviewed request', async () => {
  let attempts = 0;
  post.mockImplementation(async (url) => {
    if (url === '/save') { if (++attempts === 1) throw new Error('Lost response'); return { data: { id: 42, publicSku: 'AG-000042' } }; }
    return { data: nativePreview };
  });
  const { result } = renderHook(() => useSkuManager());
  await waitFor(() => expect(result.current.config).toBeTruthy());
  act(() => result.current.resetProductFlow('BR'));
  act(() => { result.current.handleTextAnswer('weight', '12,7'); result.current.handleTextAnswer('count', '0'); });
  await act(() => result.current.handlePreview());
  act(() => result.current.handleSave());
  await waitFor(() => expect(result.current.isSaving).toBe(false));
  expect(post.mock.calls.filter(([url]) => url === '/save')).toHaveLength(1);
  expect(result.current.savedProduct).toBeNull();
  expect(result.current.isCreationSaveUncertain).toBe(true);
  act(() => { result.current.handleTextAnswer('count', '3'); result.current.resetProductFlow(null); });
  expect(result.current.answers.count).toBe('0');
  expect(result.current.selectedCat).toBe('BR');
  act(() => result.current.handleSave());
  await waitFor(() => expect(result.current.savedProduct?.publicSku).toBe('AG-000042'));
  const saves = post.mock.calls.filter(([url]) => url === '/save').map(([, body]) => body);
  expect(saves[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  expect(saves[1]).toEqual(saves[0]);
  expect(post.mock.calls.filter(([url]) => url === '/preview')).toHaveLength(1);
  expect(result.current.isCreationSaveUncertain).toBe(false);
});

it('shows an unconfirmed save result with locked input and an explicit original-attempt recovery action', async () => {
  post.mockImplementation(async (url) => {
    if (url === '/save') throw new Error('Lost response');
    return { data: nativePreview };
  });
  await fillBuilder(); fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  await screen.findByRole('button', { name: 'Перевірити результат збереження' });
  expect(screen.getByLabelText(/Кількість/).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'До категорій' }).disabled).toBe(true);
  expect(screen.getByText(/Результат збереження ще не підтверджено/)).toBeTruthy();
  expect(post.mock.calls.filter(([url]) => url === '/save')).toHaveLength(1);
});

it('keeps a malformed native save receipt uncertain and recovers the original request explicitly', async () => {
  let saves = 0;
  post.mockImplementation(async (url) => ({ data: url !== '/save' ? nativePreview
    : ++saves === 1 ? { success: true } : { id: 42, publicSku: 'AG-000042', success: true } }));
  await fillBuilder();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  const retry = await screen.findByRole('button', { name: 'Перевірити результат збереження' });
  expect(retry.disabled).toBe(false);
  expect(screen.getByLabelText(/Кількість/).disabled).toBe(true);
  expect(saves).toBe(1);
  fireEvent.click(retry);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Перевірити результат збереження' })).toBeNull());
  const requests = post.mock.calls.filter(([url]) => url === '/save');
  expect(requests).toHaveLength(2);
  expect(requests[1][1]).toEqual(requests[0][1]);
});

it('lets an uncertain native attempt recover its immutable receipt even when the response includes field errors', async () => {
  post.mockImplementation(async (url) => {
    if (url === '/save') throw { response: { status: 503, data: { fieldErrors: { count: 'Перевірку перервано.' } } } };
    return { data: nativePreview };
  });
  await fillBuilder();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти товар' }));
  const retry = await screen.findByRole('button', { name: 'Перевірити результат збереження' });
  expect(retry.disabled).toBe(false);
  fireEvent.click(retry);
  await waitFor(() => expect(post.mock.calls.filter(([url]) => url === '/save')).toHaveLength(2));
  const requests = post.mock.calls.filter(([url]) => url === '/save');
  expect(requests[1][1]).toEqual(requests[0][1]);
});

it('shows calculated USD separately from the final native manual price', async () => {
  post.mockImplementation(async () => ({ data: { ...nativePreview, calculatedPriceUah: 1200, totalPriceUah: 2000, totalPrice: 50 } }));
  await fillBuilder();
  fireEvent.change(screen.getByLabelText('Як визначити ціну'), { target: { value: 'manual_uah' } });
  fireEvent.change(screen.getByLabelText('Ручна ціна, грн'), { target: { value: '2000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити дані' }));
  await screen.findByRole('button', { name: 'Зберегти товар' });
  const calculatedRow = screen.getAllByText('Розрахункова')[0].parentElement;
  expect(within(calculatedRow).getByText('$30')).toBeTruthy();
  expect(within(calculatedRow).queryByText('$50')).toBeNull();
  expect(within(screen.getByText('Фінальна').parentElement).getByText('$50')).toBeTruthy();
});
