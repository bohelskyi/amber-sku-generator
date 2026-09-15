import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProductPriceChangeDialog } from '../src/components/app/ProductPriceChangeDialog.jsx';
import { useSkuManager } from '../src/hooks/useSkuManager.js';
import { api } from '../src/lib/api.js';

function response(data) {
  return { data, status: 200, statusText: 'OK', headers: {}, config: {} };
}

const config = {
  categories: {
    LN: { code: 'LN', name: 'Намисто', requires_weight: 1, marketing_rounding_enabled: 1 },
  },
  questions: { LN: [] },
  extraConfig: {},
};

const decodedProduct = {
  existsInDb: true,
  sku: 'LN136021',
  category: config.categories.LN,
  decodedAnswers: [],
  product: { id: 71, weight: 10, details: { answers: {} } },
  pricing: { totalPriceUah: 2300 },
};

function PriceChangeWorkflowHarness() {
  const sku = useSkuManager({ canChangeProductPrice: true });
  if (!sku.config) return <div>loading</div>;

  return <>
    <button type="button" onClick={() => sku.handleDecode(decodedProduct.sku)}>Decode</button>
    <button type="button" onClick={sku.handleStartRecount}>Start recount</button>
    <button type="button" onClick={sku.handleApplyRecount}>Open price change</button>
    <ProductPriceChangeDialog
      currentPriceUah={sku.decodeData?.pricing?.totalPriceUah}
      isApplying={sku.isPriceChangeApplying}
      isLoading={sku.isPriceChangeLoading}
      isOpen={sku.isPriceChangeOpen}
      manualPriceUah={sku.priceChangeManualUah}
      manualMarketingRoundingEnabled={sku.priceChangeManualRounding}
      marketingRoundingEnabled={sku.priceChangeMarketingRounding}
      mode={sku.priceChangeMode}
      preview={sku.priceChangePreview}
      sku={sku.decodeData?.sku}
      usdPerGram={sku.priceChangeUsdPerGram}
      onCancel={sku.handleCancelPriceChange}
      onConfirm={sku.handleConfirmPriceChange}
      onManualPriceChange={sku.setPriceChangeManualUah}
      onManualMarketingRoundingChange={sku.setPriceChangeManualRounding}
      onMarketingRoundingChange={sku.setPriceChangeMarketingRounding}
      onModeChange={sku.setPriceChangeMode}
      onUsdPerGramChange={sku.setPriceChangeUsdPerGram}
    />
  </>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('refreshes the authoritative Manual UAH result when marketing rounding is toggled', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/config') return response(config);
    if (url === '/products') return response([]);
    if (url === '/export/status') return response({});
    throw new Error(`Unexpected GET ${url}`);
  });
  const post = vi.spyOn(api, 'post').mockImplementation(async (url, body) => {
    if (url === '/decode') return response(decodedProduct);
    if (url === '/product-price-change/preview') {
      const rounded = body.pricingDecision.marketingRoundingEnabled;
      return response({
        currentPriceUah: 2300,
        resultingPriceUah: rounded ? 2400 : 2390,
        priceDifferenceUah: rounded ? 100 : 90,
        previewToken: rounded ? 'rounded-token' : 'exact-token',
        unchanged: false,
      });
    }
    if (url === '/product-price-change/apply') {
      return response({ productId: 71, sku: decodedProduct.sku, resultingPriceUah: 2400 });
    }
    throw new Error(`Unexpected POST ${url}`);
  });

  render(<PriceChangeWorkflowHarness />);
  fireEvent.click(await screen.findByText('Decode'));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/decode', { sku: 'LN136021' }));
  fireEvent.click(screen.getByText('Start recount'));
  fireEvent.click(screen.getByText('Open price change'));

  vi.useFakeTimers();
  expect(screen.getByLabelText('Маркетингове округлення').checked).toBe(false);
  fireEvent.change(screen.getByLabelText('Нова ціна UAH'), { target: { value: '2390' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
  expect(screen.getByText('2390 ₴')).toBeTruthy();
  expect(post).toHaveBeenLastCalledWith('/product-price-change/preview', {
    productId: 71,
    pricingDecision: {
      mode: 'manual_uah',
      manualPriceUah: '2390',
      marketingRoundingEnabled: false,
    },
  });

  fireEvent.click(screen.getByLabelText('Маркетингове округлення'));
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });

  expect(screen.getByText('2400 ₴')).toBeTruthy();
  expect(post).toHaveBeenLastCalledWith('/product-price-change/preview', {
    productId: 71,
    pricingDecision: {
      mode: 'manual_uah',
      manualPriceUah: '2390',
      marketingRoundingEnabled: true,
    },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Змінити ціну' }));
  expect(post).toHaveBeenLastCalledWith('/product-price-change/apply', {
    productId: 71,
    pricingDecision: {
      mode: 'manual_uah',
      manualPriceUah: '2390',
      marketingRoundingEnabled: true,
    },
    previewToken: 'rounded-token',
  });
});

it('requests and applies automatic pricing without override fields', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/config') return response(config);
    if (url === '/products') return response([]);
    if (url === '/export/status') return response({});
    throw new Error(`Unexpected GET ${url}`);
  });
  const post = vi.spyOn(api, 'post').mockImplementation(async (url, body) => {
    if (url === '/decode') return response(decodedProduct);
    if (url === '/product-price-change/preview') {
      expect(body.pricingDecision).toEqual({ mode: 'system_auto' });
      return response({
        currentPriceUah: 2300,
        resultingPriceUah: 2400,
        priceDifferenceUah: 100,
        previewToken: 'automatic-token',
        unchanged: false,
      });
    }
    if (url === '/product-price-change/apply') {
      return response({ productId: 71, sku: decodedProduct.sku, resultingPriceUah: 2400 });
    }
    throw new Error(`Unexpected POST ${url}`);
  });

  render(<PriceChangeWorkflowHarness />);
  fireEvent.click(await screen.findByText('Decode'));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/decode', { sku: 'LN136021' }));
  fireEvent.click(screen.getByText('Start recount'));
  fireEvent.click(screen.getByText('Open price change'));

  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('radio', { name: 'Автоматична' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });

  expect(screen.getByText('2400 ₴')).toBeTruthy();
  expect(screen.queryByLabelText('Маркетингове округлення')).toBeNull();
  expect(post).toHaveBeenLastCalledWith('/product-price-change/preview', {
    productId: 71,
    pricingDecision: { mode: 'system_auto' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Змінити ціну' }));
  expect(post).toHaveBeenLastCalledWith('/product-price-change/apply', {
    productId: 71,
    pricingDecision: { mode: 'system_auto' },
    previewToken: 'automatic-token',
  });
});
