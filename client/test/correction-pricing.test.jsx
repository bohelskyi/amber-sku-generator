import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RecountConfirmDialog } from '../src/components/app/RecountConfirmDialog.jsx';

const preview = {
  source: { sku: 'BR1001', totalPriceUah: 1000 },
  corrected: { fullSku: 'BR1002', totalPriceUah: 4020, autoPriceUah: 4020 },
  priceDeltaUah: 3020,
};

afterEach(cleanup);

function renderDialog(overrides = {}) {
  const handlers = {
    onPricingModeChange: vi.fn(),
    onUsdPerGramChange: vi.fn(),
    onMarketingRoundingChange: vi.fn(),
    onManualPriceChange: vi.fn(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
  };
  render(<RecountConfirmDialog
    canPriceOverride
    isOpen
    isApplying={false}
    preview={preview}
    previewCurrent
    reason=""
    mode="request"
    pricingMode="system_auto"
    usdPerGram=""
    manualPriceUah=""
    marketingRoundingEnabled
    {...handlers}
    {...overrides}
  />);
  return handlers;
}

it('shows all three request pricing modes only with override permission', () => {
  const handlers = renderDialog();
  const selector = screen.getByLabelText('Режим ціни');
  expect([...selector.options].map((option) => option.value)).toEqual([
    'system_auto', 'usd_per_gram', 'manual_uah',
  ]);
  fireEvent.change(selector, { target: { value: 'usd_per_gram' } });
  expect(handlers.onPricingModeChange).toHaveBeenCalledWith('usd_per_gram');

  cleanup();
  render(<RecountConfirmDialog isOpen isApplying={false} preview={preview}
    reason="" mode="request" manualPriceUah="" onManualPriceChange={vi.fn()}
    onCancel={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.queryByLabelText('Режим ціни')).toBeNull();
});

it('edits USD per gram and its explicit marketing-rounding choice', () => {
  const handlers = renderDialog({
    pricingMode: 'usd_per_gram', usdPerGram: '10.05', marketingRoundingEnabled: true,
  });
  fireEvent.change(screen.getByLabelText('USD за грам'), { target: { value: '11.25' } });
  fireEvent.click(screen.getByLabelText('Маркетингове округлення'));
  expect(handlers.onUsdPerGramChange).toHaveBeenCalledWith('11.25');
  expect(handlers.onMarketingRoundingChange).toHaveBeenCalledWith(false);
});

it('edits an exact manual UAH request decision', () => {
  const handlers = renderDialog({ pricingMode: 'manual_uah', manualPriceUah: '4020.25' });
  fireEvent.change(screen.getByLabelText('Точна ціна UAH'), { target: { value: '4021.50' } });
  expect(handlers.onManualPriceChange).toHaveBeenCalledWith('4021.50');
});
