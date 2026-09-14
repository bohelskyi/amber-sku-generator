import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProductPriceChangeDialog } from '../src/components/app/ProductPriceChangeDialog.jsx';

afterEach(cleanup);

function renderDialog(overrides = {}) {
  const handlers = {
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    onManualPriceChange: vi.fn(),
    onManualMarketingRoundingChange: vi.fn(),
    onMarketingRoundingChange: vi.fn(),
    onModeChange: vi.fn(),
    onUsdPerGramChange: vi.fn(),
  };
  render(<ProductPriceChangeDialog
    currentPriceUah={2400}
    isOpen
    manualPriceUah="2500"
    mode="manual_uah"
    preview={{
      currentPriceUah: 2400,
      resultingPriceUah: 2500,
      priceDifferenceUah: 100,
      previewToken: 'token',
      unchanged: false,
    }}
    sku="LN136021"
    {...handlers}
    {...overrides}
  />);
  return handlers;
}

it('defaults to the Manual UAH presentation and shows SKU and authoritative price comparison', () => {
  const handlers = renderDialog();
  const choices = within(screen.getByRole('radiogroup', { name: 'Режим зміни ціни' }))
    .getAllByRole('radio');
  expect(choices.map((choice) => choice.value)).toEqual(['manual_uah', 'usd_per_gram']);
  expect(screen.getByRole('radio', { name: 'Ручна UAH' }).checked).toBe(true);
  expect(screen.getByText('LN136021')).toBeTruthy();
  expect(screen.getByText('2400 ₴')).toBeTruthy();
  expect(screen.getByText('2500 ₴')).toBeTruthy();
  expect(screen.getByText('+100 ₴')).toBeTruthy();
  const rounding = screen.getByLabelText('Маркетингове округлення');
  expect(rounding.checked).toBe(false);
  fireEvent.click(rounding);
  expect(handlers.onManualMarketingRoundingChange).toHaveBeenCalledWith(true);
  expect(screen.getByRole('button', { name: 'Змінити ціну' }).disabled).toBe(false);
});

it('switches to USD/g and exposes the rounding control', () => {
  const handlers = renderDialog();
  fireEvent.click(screen.getByRole('radio', { name: 'USD/г' }));
  expect(handlers.onModeChange).toHaveBeenCalledWith('usd_per_gram');

  cleanup();
  renderDialog({ mode: 'usd_per_gram', manualPriceUah: '', usdPerGram: '7.125' });
  expect(screen.getByLabelText('USD за грам')).toBeTruthy();
  expect(screen.getByLabelText('Маркетингове округлення')).toBeTruthy();
  expect(screen.queryByLabelText('Нова ціна UAH')).toBeNull();
});

it('keeps the single primary action disabled for invalid, loading, or unchanged results', () => {
  const { rerender } = render(<ProductPriceChangeDialog
    currentPriceUah={2400}
    isOpen
    manualPriceUah=""
    mode="manual_uah"
    onCancel={vi.fn()}
    onConfirm={vi.fn()}
    onManualPriceChange={vi.fn()}
    onModeChange={vi.fn()}
    sku="LN136021"
  />);
  expect(screen.getByRole('button', { name: 'Змінити ціну' }).disabled).toBe(true);

  rerender(<ProductPriceChangeDialog
    currentPriceUah={2400}
    isOpen
    manualPriceUah="2400"
    mode="manual_uah"
    onCancel={vi.fn()}
    onConfirm={vi.fn()}
    onManualPriceChange={vi.fn()}
    onModeChange={vi.fn()}
    preview={{ resultingPriceUah: 2400, priceDifferenceUah: 0, unchanged: true }}
    sku="LN136021"
  />);
  expect(screen.getByText('Результуюча ціна не відрізняється від поточної.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Змінити ціну' }).disabled).toBe(true);
});
