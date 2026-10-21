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
  expect(choices.map((choice) => choice.value)).toEqual([
    'system_auto', 'manual_uah', 'usd_per_gram',
  ]);
  expect(screen.getByRole('radio', { name: 'Вказати суму' }).checked).toBe(true);
  const dialog = screen.getByRole('dialog', { name: 'Змінити ціну' });
  expect(document.getElementById(dialog.getAttribute('aria-describedby')).textContent)
    .toBe('Зміна ціни без переобліку · LN136021');
  expect(screen.getByText('2400 ₴')).toBeTruthy();
  expect(screen.getByText('2500 ₴')).toBeTruthy();
  expect(screen.getByText('Різниця: +100 ₴')).toBeTruthy();
  const rounding = screen.getByLabelText('Маркетингове округлення');
  expect(rounding.checked).toBe(false);
  fireEvent.click(rounding);
  expect(handlers.onManualMarketingRoundingChange).toHaveBeenCalledWith(true);
  expect(screen.getByRole('button', { name: 'Змінити ціну' }).disabled).toBe(false);
});

it('shows authoritative automatic pricing without override controls', () => {
  renderDialog({
    currentPriceUah: 2500,
    manualPriceUah: '',
    mode: 'system_auto',
    preview: {
      currentPriceUah: 2500,
      resultingPriceUah: 2400,
      priceDifferenceUah: -100,
      previewToken: 'automatic-token',
      unchanged: false,
    },
  });

  expect(screen.getByRole('radio', { name: 'За правилами' }).checked).toBe(true);
  expect(screen.queryByLabelText('Нова ціна UAH')).toBeNull();
  expect(screen.queryByRole('spinbutton', { name: 'USD за грам' })).toBeNull();
  expect(screen.queryByLabelText('Маркетингове округлення')).toBeNull();
  expect(screen.getByText('2400 ₴')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Змінити ціну' }).disabled).toBe(false);
});

it('surfaces unavailable automatic pricing and keeps apply disabled', () => {
  renderDialog({
    error: 'Автоматична ціна для цього товару зараз недоступна.',
    manualPriceUah: '',
    mode: 'system_auto',
    preview: null,
  });

  expect(screen.getByRole('alert').textContent).toContain('Автоматична ціна');
  expect(screen.getByRole('button', { name: 'Змінити ціну' }).disabled).toBe(true);
});

it('switches to USD/g and exposes the rounding control', () => {
  const handlers = renderDialog();
  fireEvent.click(screen.getByRole('radio', { name: 'USD за грам' }));
  expect(handlers.onModeChange).toHaveBeenCalledWith('usd_per_gram');

  cleanup();
  renderDialog({ mode: 'usd_per_gram', manualPriceUah: '', usdPerGram: '7.125' });
  expect(screen.getByRole('spinbutton', { name: 'USD за грам' })).toBeTruthy();
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
  expect(screen.getByText('Ціна залишається без змін.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Змінити ціну' }).disabled).toBe(true);
});
