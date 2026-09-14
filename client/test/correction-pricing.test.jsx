import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  const choices = within(screen.getByRole('radiogroup', { name: 'Режим ціни' })).getAllByRole('radio');
  expect(choices.map((option) => option.value)).toEqual([
    'system_auto', 'usd_per_gram', 'manual_uah',
  ]);
  expect(choices.map((option) => option.parentElement.textContent)).toEqual([
    'Автоматична', 'USD/г', 'Ручна UAH',
  ]);
  expect(screen.getByRole('radio', { name: 'Автоматична' }).checked).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: 'USD/г' }));
  expect(handlers.onPricingModeChange).toHaveBeenCalledWith('usd_per_gram');

  cleanup();
  render(<RecountConfirmDialog isOpen isApplying={false} preview={preview}
    reason="" mode="request" manualPriceUah="" onManualPriceChange={vi.fn()}
    onCancel={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.queryByRole('radiogroup', { name: 'Режим ціни' })).toBeNull();
});

it('selects each pricing segment and shows only its matching inputs', () => {
  function DialogWithModes() {
    const [pricingMode, setPricingMode] = useState('system_auto');
    return <RecountConfirmDialog
      canPriceOverride isOpen isApplying={false} preview={preview}
      previewCurrent mode="request" pricingMode={pricingMode}
      usdPerGram="10" manualPriceUah="4020"
      onPricingModeChange={setPricingMode} onCancel={vi.fn()} onConfirm={vi.fn()}
    />;
  }

  render(<DialogWithModes />);
  expect(screen.getByRole('radio', { name: 'Автоматична' }).checked).toBe(true);
  expect(screen.queryByLabelText('USD за грам')).toBeNull();
  expect(screen.queryByLabelText('Точна ціна UAH')).toBeNull();

  fireEvent.click(screen.getByRole('radio', { name: 'USD/г' }));
  expect(screen.getByRole('radio', { name: 'USD/г' }).checked).toBe(true);
  expect(screen.getByLabelText('USD за грам')).toBeTruthy();
  expect(screen.getByLabelText('Маркетингове округлення')).toBeTruthy();
  expect(screen.queryByLabelText('Точна ціна UAH')).toBeNull();

  fireEvent.click(screen.getByRole('radio', { name: 'Ручна UAH' }));
  expect(screen.getByRole('radio', { name: 'Ручна UAH' }).checked).toBe(true);
  expect(screen.getByLabelText('Точна ціна UAH')).toBeTruthy();
  expect(screen.queryByLabelText('USD за грам')).toBeNull();
  expect(screen.queryByLabelText('Маркетингове округлення')).toBeNull();

  fireEvent.click(screen.getByRole('radio', { name: 'Автоматична' }));
  expect(screen.getByRole('radio', { name: 'Автоматична' }).checked).toBe(true);
  expect(screen.queryByLabelText('USD за грам')).toBeNull();
  expect(screen.queryByLabelText('Точна ціна UAH')).toBeNull();
});

it('keeps the selected native radio keyboard-focusable with a visible focus style', () => {
  renderDialog();
  const selected = screen.getByRole('radio', { name: 'Автоматична' });
  selected.focus();
  expect(document.activeElement).toBe(selected);
  expect(selected.nextElementSibling.className).toContain('peer-focus-visible:outline');
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

it.each(['usd_per_gram', 'manual_uah'])(
  'keeps direct apply visible but disabled for %s request pricing',
  (pricingMode) => {
    renderDialog({ mode: 'choice', pricingMode, usdPerGram: '10', manualPriceUah: '4020' });
    expect(screen.getByRole('button', { name: 'Створити запит' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Створити коригувальний артикул' }).disabled).toBe(true);
    expect(screen.getByText(/Індивідуальна ціна діє лише для запитів на виправлення/)).toBeTruthy();
  }
);

it('formats the UAH price difference to the stored money scale', () => {
  renderDialog({ preview: { ...preview, priceDeltaUah: 7620.5599999999995 } });
  expect(screen.getByText('7620.56 ₴')).toBeTruthy();
  expect(screen.queryByText('7620.5599999999995 ₴')).toBeNull();
});

it.each([
  { pricingMode: 'usd_per_gram', usdPerGram: '10', previewCurrent: false },
  { pricingMode: 'usd_per_gram', usdPerGram: '', previewCurrent: true },
  { pricingMode: 'manual_uah', manualPriceUah: '0', previewCurrent: true },
])('hides an unreviewed custom target price for $pricingMode', (overrides) => {
  renderDialog(overrides);
  expect(screen.queryByText('4020 ₴')).toBeNull();
  expect(screen.queryByText('3020 ₴')).toBeNull();
  expect(screen.getByRole('button', { name: 'Скопіювати нову ціну' }).disabled).toBe(true);
});

it('waits for a new preview after switching to a valid custom decision', () => {
  function DialogWithDecision() {
    const [pricingMode, setPricingMode] = useState('system_auto');
    const [currentPreview, setCurrentPreview] = useState(preview);
    return <>
      <button type="button" onClick={() => setCurrentPreview({ ...preview })}>Оновити прев’ю</button>
      <RecountConfirmDialog
        canPriceOverride isOpen isApplying={false} preview={currentPreview}
        previewCurrent mode="choice" pricingMode={pricingMode} manualPriceUah="4020"
        onPricingModeChange={setPricingMode} onManualPriceChange={vi.fn()}
        onCancel={vi.fn()} onConfirm={vi.fn()}
      />
    </>;
  }

  render(<DialogWithDecision />);
  expect(screen.getByText('4020 ₴')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'Ручна UAH' }));
  expect(screen.queryByText('4020 ₴')).toBeNull();
  expect(screen.getByRole('button', { name: 'Створити запит' }).disabled).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Оновити прев’ю' }));
  expect(screen.getByText('4020 ₴')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Створити запит' }).disabled).toBe(false);
  expect(screen.getByRole('button', { name: 'Створити коригувальний артикул' }).disabled).toBe(true);
});
