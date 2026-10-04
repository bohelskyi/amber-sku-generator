import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api.js';
import MagentoProductChecks from '../src/components/workspace/MagentoProductChecks.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const root = '/admin/magento-integration';
const revision = { id: 'draft', revision: '7', state: 'draft' };
const config = {
  categories: { SV: { code: 'SV', name: 'Сувеніри', requires_weight: 0, sku_schema_version_id: 17 } },
  questions: { SV: [
    { id: 'souvenir', label: 'Вид сувеніра', required: 1, options: [{ id: 1, label: 'Фігурка' }, { id: 6, label: 'Брелок' }, { id: 9, label: 'Архівний вид', archived: 1 }] },
    { id: 'size', label: 'Розмір', input_type: 'text' },
    { id: 'weight', label: 'Вага сувеніра', input_type: 'text' },
    { id: 'is_calibrated', label: 'Калібрування', options: [{ id: 0, label: 'Ні' }, { id: 2, label: 'Напів' }] },
    { id: 'finish', label: 'Обробка фігурки', visible_if_json: { souvenir: 1 }, options: [{ id: 1, label: 'Полірована' }] },
  ] },
  productCreateRequirements: { SV: { requiredAnswers: ['size', 'weight'], optionalAnswersWhen: { size: { question: 'souvenir', values: ['6'] } }, automaticName: { question: 'souvenir', values: ['6'] } } },
};
const result = { hypothetical: true, article: 'AG-PREVIEW', routeKey: 'SV:normal', sendable: true, blockers: [] };
beforeEach(() => { vi.resetAllMocks(); api.get.mockResolvedValue({ data: config }); api.post.mockResolvedValue({ data: result }); });
afterEach(cleanup);
const shell = (props = {}) => render(<MagentoProductChecks revision={revision} categoryCode="SV" onRepresentative={vi.fn()} {...props} />);
it('accepts the exact product repair context without a search or automatic preview', async () => {
  api.post.mockResolvedValue({ data: { ...result, productId: 42, article: 'AG-000042', hypothetical: false } });
  shell({ initialProductId: 42 }); await screen.findByLabelText('Вид сувеніра');
  expect(screen.getByText('товар із черги проблем')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити поточний товар' }));
  await screen.findByText('Цей приклад пройшов перевірку доставки');
  expect(api.post).toHaveBeenCalledWith(`${root}/product-preview`, { productId: 42, bindingRevisionId: 'draft' });
});
it('keychain CREATE check leaves size optional and sends decimal comma weight without fabricating size', async () => {
  shell(); fireEvent.change(await screen.findByLabelText('Вид сувеніра'), { target: { value: '6' } });
  expect(screen.getByLabelText('Розмір').required).toBe(false);
  fireEvent.change(screen.getByLabelText('Вага сувеніра'), { target: { value: '12,7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити приклад CREATE' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(api.post.mock.calls[0][1].product.answers).toEqual({ souvenir: 6, weight: '12,7' });
});
async function fillCreate() {
  fireEvent.change(await screen.findByLabelText('Вид сувеніра'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Розмір'), { target: { value: '3/2' } });
  fireEvent.change(screen.getByLabelText('Вага сувеніра'), { target: { value: '12.5' } });
  fireEvent.change(screen.getByLabelText('Калібрування'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Назва українською'), { target: { value: 'Птах' } });
  fireEvent.change(screen.getByLabelText('Назва англійською'), { target: { value: 'bird' } });
}

it('loads published creation inputs and performs no automatic remote product check', async () => {
  shell(); await screen.findByLabelText('Вид сувеніра');
  expect(api.get).toHaveBeenCalledWith(`${root}/creation-inputs`, expect.objectContaining({ params: { categoryCode: 'SV' } }));
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Розмір').required).toBe(true);
  expect(screen.getByLabelText('Вага сувеніра').required).toBe(true);
  expect(screen.queryByRole('option', { name: 'Архівний вид' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Копіювати/ })).toBeNull();
});

it('cannot check hypothetical creation without a published SKU schema', async () => {
  api.get.mockResolvedValue({ data: { ...config, categories: { SV: { ...config.categories.SV, sku_schema_version_id: null } } } });
  shell(); await screen.findByText('Спочатку потрібна опублікована схема SKU цієї категорії.');
  expect(screen.getByRole('button', { name: 'Перевірити приклад CREATE' }).disabled).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

it('captures only an explicitly saved sendable CREATE example with exact fields and calibration state 2', async () => {
  const captured = vi.fn(); shell({ onRepresentative: captured }); await fillCreate();
  fireEvent.change(screen.getByLabelText('Ручна ціна прикладу, грн (за потреби)'), { target: { value: '1200.50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити приклад CREATE' }));
  await screen.findByText('Цей приклад пройшов перевірку доставки');
  const input = { product: { categoryCode: 'SV', answers: { souvenir: 1, size: '3/2', weight: '12.5', is_calibrated: 2 },
    isCalibrated: 2, weight: 0, magentoNameSubjectUa: 'Птах', magentoNameSubjectEn: 'bird' },
  pricingDecision: { mode: 'manual_uah', manualPriceUah: '1200.50' } };
  expect(api.post).toHaveBeenCalledWith(`${root}/create-preview`, { bindingRevisionId: revision.id, ...input });
  expect(captured).not.toHaveBeenCalled();
  expect(screen.queryByText('AG-PREVIEW')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти перевірений приклад' }));
  expect(captured).toHaveBeenCalledWith({ routeKey: result.routeKey, input, group: 'SV' });
  fireEvent.change(screen.getByLabelText('Розмір'), { target: { value: '9/9' } });
  expect(screen.queryByText('Цей приклад пройшов перевірку доставки')).toBeNull();
  expect(captured.mock.calls[0][0].input.product.answers.size).toBe('3/2');
  expect(captured).toHaveBeenCalledTimes(1);
});

it('prunes hidden answers and omits paired names on the automatic-name route', async () => {
  shell(); await fillCreate();
  fireEvent.change(screen.getByLabelText('Обробка фігурки'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Вид сувеніра'), { target: { value: '6' } });
  expect(screen.queryByLabelText('Обробка фігурки')).toBeNull();
  expect(screen.queryByLabelText('Назва українською')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити приклад CREATE' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  const product = api.post.mock.calls[0][1].product;
  expect(product.answers.souvenir).toBe(6);
  expect(product.answers).not.toHaveProperty('finish');
  expect(product).not.toHaveProperty('magentoNameSubjectUa');
  expect(product).not.toHaveProperty('magentoNameSubjectEn');
});

it('keeps a blocked example scoped to that product and cannot save it for publication', async () => {
  const captured = vi.fn(); api.post.mockResolvedValue({ data: { ...result, sendable: false, blockers: [{ message: 'Немає відповідності значення' }] } });
  shell({ onRepresentative: captured }); await fillCreate();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити приклад CREATE' }));
  await screen.findByText('Цей приклад потребує уваги');
  expect(screen.getByText('Немає відповідності значення')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Зберегти перевірений приклад' })).toBeNull();
  expect(captured).not.toHaveBeenCalled();
});

it.each(['success', 'failure'])('ignores a late preview %s after fields change', async (outcome) => {
  let resolve; let reject;
  api.post.mockImplementation(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  shell(); await fillCreate(); fireEvent.click(screen.getByRole('button', { name: 'Перевірити приклад CREATE' }));
  fireEvent.change(screen.getByLabelText('Розмір'), { target: { value: '4/4' } });
  await act(async () => { if (outcome === 'success') resolve({ data: result }); else reject({ response: { data: { error: 'Old preview failed' } } }); });
  expect(screen.queryByText('Цей приклад пройшов перевірку доставки')).toBeNull();
  expect(screen.queryByText('Old preview failed')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Зберегти перевірений приклад' })).toBeNull();
});

it('discards pending evidence when the binding counter changes', async () => {
  let complete; api.post.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const view = shell(); await fillCreate(); fireEvent.click(screen.getByRole('button', { name: 'Перевірити приклад CREATE' }));
  view.rerender(<MagentoProductChecks revision={{ ...revision, revision: '8' }} categoryCode="SV" onRepresentative={vi.fn()} />);
  await screen.findByLabelText('Вид сувеніра');
  await act(async () => complete({ data: result }));
  expect(screen.queryByRole('button', { name: 'Зберегти перевірений приклад' })).toBeNull();
  expect(screen.getByLabelText('Розмір').value).toBe('');
});

it('searches bounded product pages by public article and checks only the explicitly selected product', async () => {
  const captured = vi.fn();
  const product = (id) => ({ id, public_sku: `LEGACY-${id}`, full_sku: `SV-INTERNAL-${id}`, category: 'SV', status: 'active' });
  api.get.mockImplementation((path, { params } = {}) => Promise.resolve({ data: path.endsWith('creation-inputs') ? config
    : { products: [product(params.offset ? 21 : 1)], nextOffset: params.offset ? null : 20 } }));
  api.post.mockResolvedValue({ data: { ...result, hypothetical: false, article: 'LEGACY-21' } });
  shell({ onRepresentative: captured }); await screen.findByLabelText('Вид сувеніра');
  fireEvent.change(screen.getByLabelText('Пошук за артикулом'), { target: { value: 'LEGACY' } });
  fireEvent.click(screen.getByRole('button', { name: 'Знайти товар' }));
  await screen.findByRole('button', { name: 'Обрати LEGACY-1' });
  fireEvent.click(screen.getByRole('button', { name: 'Наступні товари' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Обрати LEGACY-21' }));
  expect(api.get).toHaveBeenLastCalledWith('/admin/export-templates/sample-products', { params: { q: 'LEGACY', offset: 20 } });
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити поточний товар' }));
  await screen.findByText('Цей приклад пройшов перевірку доставки');
  expect(api.post).toHaveBeenCalledWith(`${root}/product-preview`, { productId: 21, bindingRevisionId: 'draft' });
  expect(screen.queryByRole('button', { name: 'Зберегти перевірений приклад' })).toBeNull();
  expect(captured).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Пошук за артикулом'), { target: { value: 'OTHER' } });
  expect(screen.getByRole('button', { name: 'Перевірити поточний товар' }).disabled).toBe(true);
  expect(screen.queryByText('Цей приклад пройшов перевірку доставки')).toBeNull();
});

it('labels an internal SKU fallback without presenting it as the public article', async () => {
  api.get.mockImplementation((path) => Promise.resolve({ data: path.endsWith('creation-inputs') ? config
    : { products: [{ id: 31, public_sku: null, full_sku: 'SV-INTERNAL-31', category: 'SV', status: 'active' }], nextOffset: null } }));
  shell(); await screen.findByLabelText('Вид сувеніра');
  fireEvent.change(screen.getByLabelText('Пошук за артикулом'), { target: { value: 'SV-INTERNAL' } });
  fireEvent.click(screen.getByRole('button', { name: 'Знайти товар' }));
  const option = await screen.findByRole('button', { name: 'Обрати внутрішній SKU SV-INTERNAL-31' });
  expect(option.closest('li').textContent).toContain('Внутрішній SKU: SV-INTERNAL-31');
  expect(option.closest('li').textContent).not.toContain('Артикул: SV-INTERNAL-31');
  fireEvent.click(option);
  expect(screen.getByText((_, element) => element.tagName === 'P'
    && element.textContent === 'Обрано: Внутрішній SKU: SV-INTERNAL-31')).toBeTruthy();
});

it('ignores an earlier search result after the public-article query changes', async () => {
  let complete;
  api.get.mockImplementation((path) => path.endsWith('creation-inputs') ? Promise.resolve({ data: config })
    : new Promise((resolve) => { complete = resolve; }));
  shell(); await screen.findByLabelText('Вид сувеніра');
  fireEvent.change(screen.getByLabelText('Пошук за артикулом'), { target: { value: 'OLD' } });
  fireEvent.click(screen.getByRole('button', { name: 'Знайти товар' }));
  fireEvent.change(screen.getByLabelText('Пошук за артикулом'), { target: { value: 'NEW' } });
  await act(async () => complete({ data: { products: [{ id: 1, public_sku: 'OLD-1', full_sku: 'SV-INTERNAL', category: 'SV', status: 'active' }], nextOffset: null } }));
  expect(screen.queryByRole('button', { name: 'Обрати OLD-1' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити поточний товар' }).disabled).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});
