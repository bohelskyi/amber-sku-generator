import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useProductRecount } from '../src/hooks/useProductRecount.js';
import { RecountConfirmDialog } from '../src/components/app/RecountConfirmDialog.jsx';
import { ProductPriceChangeDialog } from '../src/components/app/ProductPriceChangeDialog.jsx';
import { api } from '../src/lib/api.js';

vi.mock('../src/lib/api.js', () => ({ api: { post: vi.fn() } }));
const config = { categories: { LN: { code: 'LN', name: 'Намисто', requires_weight: 1 } }, questions: { LN: [] } };
let product; let applied;
const preview = { source: { sku: 'LN1', publicSku: 'AG-000001', totalPriceUah: 1000, stateSignature: 'source' },
  corrected: { categoryCode: 'LN', publicSku: 'AG-000001', totalPriceUah: 1200, autoPriceUah: 1200 }, changes: [{ key: 'weight', from: 10, to: 11 }], previewToken: 'reviewed' };
function Harness() {
  const rec = useProductRecount({ config, canChangeProductPrice: true, onApplied: applied });
  return <>
    <button onClick={() => rec.handleDecode('AG-000001')}>Decode</button>
    <button onClick={rec.handleStartRecount}>Start recount</button>
    <button onClick={() => rec.handleRecountWeightChange('11')}>Change weight</button>
    <button onClick={rec.handleApplyRecount}>Continue</button>
    <button onClick={rec.handleCancelRecount}>Cancel recount</button>
    <output data-testid="product">{rec.decodeData?.pricing?.totalPriceUah || 'none'}</output>
    <output data-testid="mode">{rec.recountPricingMode}</output>
    <output data-testid="usd">{rec.recountUsdPerGram}</output>
    <output data-testid="manual">{rec.recountManualPriceUah}</output>
    <output data-testid="error">{rec.recountError}</output>
    <output data-testid="loading">{String(rec.isRecountLoading)}</output>
    <RecountConfirmDialog config={config} isOpen={rec.isRecountConfirmOpen} preview={rec.recountPreview}
      previewCurrent={rec.isRecountPreviewCurrent} pricingMode={rec.recountPricingMode}
      usdPerGram={rec.recountUsdPerGram} manualPriceUah={rec.recountManualPriceUah}
      marketingRoundingEnabled={rec.recountMarketingRounding} error={rec.recountError}
      onPricingModeChange={rec.setRecountPricingMode} onUsdPerGramChange={rec.setRecountUsdPerGram}
      onManualPriceChange={rec.setRecountManualPriceUah} onMarketingRoundingChange={rec.setRecountMarketingRounding}
      onCancel={rec.handleCancelRecountConfirmation} onConfirm={rec.handleConfirmRecount} />
    <ProductPriceChangeDialog isOpen={rec.isPriceChangeOpen} canApplyDirect canUseOverrides mode={rec.priceChangeMode}
      usdPerGram={rec.priceChangeUsdPerGram} manualPriceUah={rec.priceChangeManualUah} preview={rec.priceChangePreview}
      onModeChange={rec.setPriceChangeMode} onUsdPerGramChange={rec.setPriceChangeUsdPerGram}
      onManualPriceChange={rec.setPriceChangeManualUah} onCancel={rec.handleCancelPriceChange} />
  </>;
}
beforeEach(() => {
  vi.resetAllMocks(); applied = vi.fn();
  product = { existsInDb: true, sku: 'LN1', publicSku: 'AG-000001', category: config.categories.LN, decodedAnswers: [],
    product: { id: 71, weight: 10, details: { answers: {} } }, pricing: { totalPriceUah: 1000 } };
  api.post.mockImplementation(async (url, body) => {
    if (url === '/decode') return { data: structuredClone(product) };
    if (url === '/recount/preview') {
      const d = body.pricingDecision;
      if (d.mode === 'usd_per_gram' && !(Number(d.usdPerGram) > 0)) throw { response: { data: { error: 'Ціна USD/г має бути додатним числом з точністю до 4 знаків.' } } };
      if (d.mode === 'manual_uah' && !(Number(d.manualPriceUah) > 0)) throw { response: { data: { error: 'Вкажіть додатну ручну ціну.' } } };
      return { data: { ...preview } };
    }
    if (url === '/recount/apply') {
      product.pricing.totalPriceUah = 1200; product.product.weight = 11;
      product.product.details.customUsdPerGramBasis = { usdPerGram: body.pricingDecision.usdPerGram };
      return { data: { corrected: { publicSku: 'AG-000001' } } };
    }
    throw new Error(`Unexpected ${url}`);
  });
});
afterEach(cleanup);
async function open() {
  render(<Harness />); fireEvent.click(screen.getByRole('button', { name: 'Decode' }));
  await waitFor(() => expect(screen.getByTestId('product').textContent).toBe('1000'));
  fireEvent.click(screen.getByRole('button', { name: 'Start recount' }));
  fireEvent.click(screen.getByRole('button', { name: 'Change weight' }));
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' })); await screen.findByRole('dialog');
}
it('abandoned blank USD decision in the confirmation cannot block returning to recount', async () => {
  await open(); fireEvent.click(screen.getByRole('radio', { name: 'USD/г' }));
  expect(screen.getByLabelText('USD за грам').value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Повернутися до параметрів' }));
  expect(screen.getByTestId('mode').textContent).toBe('system_auto');
  expect(screen.getByTestId('error').textContent).toBe('');
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' })); await screen.findByRole('dialog');
  expect(screen.getByRole('radio', { name: 'Автоматична' }).checked).toBe(true);
  expect(product.pricing.totalPriceUah).toBe(1000); expect(applied).not.toHaveBeenCalled();
});
const cases = [
  ['blank USD', ['USD/г'], null],
  ['blank Manual UAH', ['Ручна UAH'], null],
  ['invalid USD', ['USD/г'], '-1'],
  ['repeated switches', ['Ручна UAH', 'USD/г', 'Автоматична', 'Ручна UAH', 'USD/г'], null],
];
for (const exit of ['confirmation', 'full recount']) for (const [label, modes, value] of cases) {
  it(`${label} is discarded on ${exit} exit and reopening is clean`, async () => {
    await open(); const before = structuredClone(product);
    for (const name of modes) fireEvent.click(screen.getByRole('radio', { name }));
    if (value !== null) fireEvent.change(screen.getByLabelText('USD за грам'), { target: { value } });
    await waitFor(() => expect(api.post.mock.calls.some(([url, body]) => url === '/recount/preview'
      && body.pricingDecision.mode !== 'system_auto')).toBe(true));
    if (exit === 'confirmation') fireEvent.click(screen.getByRole('button', { name: 'Повернутися до параметрів' }));
    else {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel recount' }));
      expect(screen.getByTestId('mode').textContent).toBe('system_auto');
      fireEvent.click(screen.getByRole('button', { name: 'Start recount' }));
      fireEvent.click(screen.getByRole('button', { name: 'Change weight' }));
    }
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('error').textContent).toBe('');
    expect(screen.getByTestId('usd').textContent).toBe(''); expect(screen.getByTestId('manual').textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })); await screen.findByRole('dialog');
    expect(screen.getByRole('radio', { name: 'Автоматична' }).checked).toBe(true);
    expect(product).toEqual(before); expect(applied).not.toHaveBeenCalled();
    expect(api.post.mock.calls.every(([url]) => ['/decode', '/recount/preview'].includes(url))).toBe(true);
  });
}
it('an abandoned USD preview cannot revive errors or decision state in a fresh session', async () => {
  await open(); let rejectOld;
  const normal = api.post.getMockImplementation();
  api.post.mockImplementation((url, body) => url === '/recount/preview' && body.pricingDecision.mode === 'usd_per_gram'
    ? new Promise((resolve, reject) => { rejectOld = reject; }) : normal(url, body));
  fireEvent.click(screen.getByRole('radio', { name: 'USD/г' })); await waitFor(() => expect(rejectOld).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel recount' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start recount' }));
  fireEvent.click(screen.getByRole('button', { name: 'Change weight' }));
  await act(async () => rejectOld(new Error('abandoned validation')));
  await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
  expect(screen.getByTestId('error').textContent).toBe(''); expect(screen.getByTestId('mode').textContent).toBe('system_auto');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' })); await screen.findByRole('dialog');
  expect(screen.getByRole('radio', { name: 'Автоматична' }).checked).toBe(true);
});
it('a valid applied decision still reaches authoritative apply and refreshes committed product pricing', async () => {
  await open(); fireEvent.click(screen.getByRole('radio', { name: 'USD/г' }));
  fireEvent.change(screen.getByLabelText('USD за грам'), { target: { value: '2' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Застосувати переоблік' }).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Застосувати переоблік' }));
  await waitFor(() => expect(screen.getByTestId('product').textContent).toBe('1200'));
  expect(api.post).toHaveBeenCalledWith('/recount/apply', expect.objectContaining({ pricingDecision: {
    mode: 'usd_per_gram', usdPerGram: '2', marketingRoundingEnabled: true }, previewToken: 'reviewed', sourceStateSignature: 'source' }));
  expect(product.product.details.customUsdPerGramBasis.usdPerGram).toBe('2'); expect(applied).toHaveBeenCalledOnce();
});
it('abandoned point-price inputs do not leak into a reopened price-change form', async () => {
  render(<Harness />); fireEvent.click(screen.getByRole('button', { name: 'Decode' }));
  await waitFor(() => expect(screen.getByTestId('product').textContent).toBe('1000'));
  fireEvent.click(screen.getByRole('button', { name: 'Start recount' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('radio', { name: 'USD/г' }));
  fireEvent.change(screen.getByLabelText('USD за грам'), { target: { value: '-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.getByRole('radio', { name: 'Ручна UAH' }).checked).toBe(true);
  expect(screen.getByLabelText('Нова ціна UAH').value).toBe('');
  expect(product.pricing.totalPriceUah).toBe(1000); expect(applied).not.toHaveBeenCalled();
});
