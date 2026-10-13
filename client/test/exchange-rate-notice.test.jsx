import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExchangeRateNotice } from '../src/components/ExchangeRateNotice.jsx';
import { ProductBuilder } from '../src/components/app/ProductBuilder.jsx';
import { DecodeWorkspace } from '../src/components/app/HomeDashboard.jsx';
import { ProductPriceChangeDialog } from '../src/components/app/ProductPriceChangeDialog.jsx';
import { RecountConfirmDialog } from '../src/components/app/RecountConfirmDialog.jsx';
import { RepricingSummary } from '../src/components/repricing/RepricingSummary.jsx';
import { api } from '../src/lib/api.js';

const currency = { rate: 41.2345, rateDate: '2026-10-12', fetchedAt: '2026-10-12T09:00:00.000Z',
  source: 'last_known_good', stale: true, error: 'Technical provider error' };
const pricing = { totalPriceUah: 1250, calculatedPriceUah: 1250, totalPrice: 30.31, priceMode: 'per_gram_usd',
  uahRate: currency.rate, uahRateDate: currency.rateDate, uahRateFetchedAt: currency.fetchedAt,
  uahRateStale: true, uahRateError: currency.error };
const config = { categories: { NM: { code: 'NM', name: 'Намисто', requires_weight: 1 } }, questions: { NM: [] } };
const recountPreview = { source: { totalPriceUah: 1000, publicSku: 'AG-000001' },
  corrected: { ...pricing, categoryCode: 'NM', publicSku: 'AG-000001' }, changes: [], priceDeltaUah: 250 };
beforeEach(() => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('Unexpected GET'));
  vi.spyOn(api, 'post').mockRejectedValue(new Error('Unexpected POST'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function expectLastSuccessfulRate() {
  expect(screen.getByRole('alert').textContent).toContain('останній успішний курс 41.2345 ₴/$ від 12.10.2026');
  expect(screen.queryByText(/Technical provider error/)).toBeNull();
  expect(api.get).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
}

it('shows the exact used fallback rate and its date without exposing provider errors or fetching a rate', () => {
  render(<ExchangeRateNotice {...currency} />);
  expectLastSuccessfulRate();
  expect(screen.getByRole('alert').textContent).toContain('за поточний день ще не підтверджено');
});

it('does not present fresh, absent or invalid rates as usable fallback evidence', () => {
  const { rerender } = render(<ExchangeRateNotice {...currency} stale={false} />);
  expect(screen.queryByRole('alert')).toBeNull();
  for (const rate of [null, undefined, 0, -1, 'invalid', Infinity]) {
    rerender(<ExchangeRateNotice {...currency} rate={rate} />);
    expect(screen.queryByRole('alert')).toBeNull();
  }
});

it('can show a recorded retrieval date when the older response has no rate date', () => {
  render(<ExchangeRateNotice {...currency} rateDate={null} />);
  expectLastSuccessfulRate();
});

it('ordinary product pricing binds the warning to the displayed live or verified preview', () => {
  const props = { config, selectedCat: 'NM', answers: {}, weight: '10', isWeightRequired: true,
    answeredRequiredCount: 0, requiredCount: 0, isNativeCreation: true, livePriceData: pricing,
    effectiveTotalPriceUah: 1250, onSave: vi.fn() };
  const { rerender } = render(<ProductBuilder {...props} />);
  expectLastSuccessfulRate();
  rerender(<ProductBuilder {...props} previewData={{ ...pricing, uahRateStale: false }} />);
  expect(screen.queryByText(/останній успішний курс/)).toBeNull();
  expect(props.onSave).not.toHaveBeenCalled();
});

it('repricing shows fallback evidence from its preview and preserves manual price summary', () => {
  const controller = { preview: { currency }, currentCalculationRate: currency.rate,
    effectiveSummary: { changedCount: 2, manualPreservedCount: 3, currentCount: 1, errorCount: 0 } };
  const before = structuredClone(controller);
  const { rerender } = render(<RepricingSummary config={config} controller={controller} />);
  expectLastSuccessfulRate();
  expect(screen.getByText('Ручні ціни збережено: 3')).toBeTruthy();
  expect(controller).toEqual(before);
  rerender(<RepricingSummary config={config} controller={{ ...controller, currentCalculationRate: null }} />);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('point price change shows the resulting calculation metadata without applying it', () => {
  const onConfirm = vi.fn();
  const props = { isOpen: true, mode: 'system_auto', currentPriceUah: 1000, onConfirm,
    preview: { resultingPriceUah: 1250, priceDifferenceUah: 250, unchanged: false,
      resultingPricing: { uahRate: currency.rate, rateMetadata: { date: currency.rateDate,
        fetchedAt: currency.fetchedAt, stale: true } } } };
  const { rerender } = render(<ProductPriceChangeDialog {...props} />);
  expectLastSuccessfulRate();
  expect(screen.getByRole('button', { name: 'Змінити ціну', exact: true }).disabled).toBe(false);
  expect(onConfirm).not.toHaveBeenCalled();
  rerender(<ProductPriceChangeDialog {...props} isLoading />);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('recount confirmation warns only for the current resulting preview and leaves apply explicit', () => {
  const onConfirm = vi.fn();
  const props = { config, isOpen: true, preview: recountPreview, previewCurrent: true, onConfirm };
  const { rerender } = render(<RecountConfirmDialog {...props} />);
  expectLastSuccessfulRate();
  expect(screen.getByRole('button', { name: 'Застосувати переоблік' }).disabled).toBe(false);
  expect(onConfirm).not.toHaveBeenCalled();
  rerender(<RecountConfirmDialog {...props} previewCurrent={false} />);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Застосувати переоблік' }).disabled).toBe(true);
});

it('live recount displays current preview fallback rather than the stored historical rate', () => {
  const props = { config, isRecountOpen: true, isRecountPreviewCurrent: true, hasRecountChanges: true,
    recountAnswers: {}, recountWeight: '11', recountPreview,
    decodeData: { existsInDb: true, publicSku: 'AG-000001', category: config.categories.NM,
      suffix: { type: 'none' }, decodedAnswers: [], product: { id: 1, weight: 10, details: {} },
      pricing: { totalPriceUah: 1000, uahRate: 30, uahRateDate: '2020-01-01', uahRateStale: true } } };
  const { rerender } = render(<DecodeWorkspace {...props} />);
  expectLastSuccessfulRate();
  expect(screen.queryByText(/01.01.2020/)).toBeNull();
  rerender(<DecodeWorkspace {...props} isRecountPreviewCurrent={false} />);
  expect(screen.queryByRole('alert')).toBeNull();
});
