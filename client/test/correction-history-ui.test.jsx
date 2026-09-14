import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CorrectionHistoryPage from '../src/pages/CorrectionHistoryPage.jsx';
import { api } from '../src/lib/api.js';

afterEach(cleanup);

describe('correction history report presentation', () => {
  it('keeps one record with aligned changes and price details without nested cards', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        items: [{
          id: 12,
          categoryCode: 'BR',
          createdAt: '2026-09-10T10:00:00.000Z',
          weight: 10,
          reason: 'Планова перевірка',
          sourceSku: 'BR-OLD',
          correctedSku: 'BR-NEW',
          oldPriceUah: 1000,
          newPriceUah: 1250,
          oldPricePerGram: null,
          newPricePerGram: null,
          priceDeltaUah: 250,
          oldMatrixName: 'Матриця A',
          newMatrixName: 'Матриця B',
          changes: [{
            key: 'size', questionLabel: 'Розмір',
            fromLabel: 'Малий розмір зі старої конфігурації',
            toLabel: 'Великий розмір після перевірки',
          }],
        }],
        summary: {
          totalCount: 1,
          increasedCount: 1,
          decreasedCount: 0,
          unchangedCount: 0,
          netPriceDeltaUah: 250,
        },
        categories: [{ code: 'BR', name: 'Браслети', count: 1 }],
      },
    });

    render(
      <MemoryRouter initialEntries={['/admin/corrections/history?mode=report']}>
        <CorrectionHistoryPage />
      </MemoryRouter>,
    );

    const record = (await screen.findByText('BR-OLD')).closest('article');
    expect(record.textContent).toContain('BR-NEW');
    expect(record.textContent).toContain('Розмір');
    expect(record.textContent).toContain('Матриця B');
    const changeList = record.querySelector('.history-change-list');
    expect(changeList).toBeTruthy();
    const comparison = changeList.querySelector('.change-record-row');
    expect([...comparison.children].map((child) => [...child.classList].find((name) => name.startsWith('change-record-')))).toEqual([
      'change-record-label', 'change-record-old', 'change-record-arrow', 'change-record-new',
    ]);
    expect(comparison.querySelector('.change-record-old').textContent).toBe('Малий розмір зі старої конфігурації');
    expect(comparison.querySelector('.change-record-new').textContent).toBe('Великий розмір після перевірки');
    expect(record.querySelector('.history-price-details')).toBeTruthy();
    expect(record.querySelector('.history-price-details').className).not.toContain('bg-slate');
    expect(record.querySelector('a.btn-compact-md')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'CSV' })).toBeTruthy();
  });
});
