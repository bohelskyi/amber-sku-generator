import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductTimeline } from '../src/components/app/ProductTimeline.jsx';
import { api } from '../src/lib/api.js';

afterEach(() => cleanup());

const timeline = {
  querySku: 'SKU-B',
  lineage: {
    integrity: 'warning',
    currentSku: 'SKU-C',
    warnings: [{ code: 'MISSING_PRODUCT_LINK', message: 'Stored history is incomplete.' }],
    products: [
      { sku: 'SKU-A', status: 'corrected' },
      { sku: 'SKU-B', status: 'corrected' },
      { sku: 'SKU-C', status: 'archived' },
    ],
  },
  events: [
    {
      id: 'timeline-1', type: 'product.created', occurredAt: '2026-01-01T10:00:00Z',
      timestampStatus: 'recorded', actor: { status: 'not_recorded' }, sku: 'SKU-A',
      details: {}, changes: [], groupKey: null,
    },
    {
      id: 'timeline-2', type: 'correction_request.completed', occurredAt: '2026-01-02T10:00:00Z',
      timestampStatus: 'recorded', actor: { status: 'recorded', displayName: 'Worker' }, sku: 'SKU-B',
      details: {}, changes: [], groupKey: 'business-action-1',
    },
    {
      id: 'timeline-3', type: 'product.corrected', occurredAt: '2026-01-02T10:00:00Z',
      timestampStatus: 'recorded', actor: { status: 'recorded', displayName: 'Worker' }, sku: 'SKU-B',
      groupKey: 'business-action-1',
      details: {
        sourceSku: 'SKU-B', correctedSku: 'SKU-C', reason: 'Checked again',
        price: { beforeUah: 1000, afterUah: 1500 },
      },
      changes: [{
        kind: 'answer', fieldKey: 'is_calibrated', fieldLabel: null,
        before: { value: 0, label: null }, after: { value: 2, label: null },
      }],
    },
    {
      id: 'timeline-4', type: 'product.archived', occurredAt: null,
      timestampStatus: 'not_recorded', actor: { status: 'not_recorded' }, sku: 'SKU-C',
      details: {}, changes: [], groupKey: null,
    },
  ],
};

describe('product timeline', () => {
  it('renders lineage, grouped correction details, warnings, and explicit legacy gaps', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: timeline });
    render(<MemoryRouter initialEntries={['/admin/corrections/history?sku=SKU-B']}><ProductTimeline /></MemoryRouter>);

    await waitFor(() => expect(screen.getAllByText('SKU-A').length).toBeGreaterThan(0));
    expect(api.get).toHaveBeenCalledWith('/product-timeline', { params: { sku: 'SKU-B' } });
    expect(screen.getByText('Stored history is incomplete.')).toBeTruthy();
    expect(screen.getByText('Запит виконано та товар виправлено')).toBeTruthy();
    expect(screen.queryByText('Запит виконано')).toBeNull();
    expect(screen.getAllByText('Виконавця не записано').length).toBeGreaterThan(0);
    expect(screen.getByText('Час не записано')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('останній')).toBeTruthy();
  });

  it('normalizes exact SKU searches into the URL-driven request', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: timeline });
    render(<MemoryRouter initialEntries={['/admin/corrections/history']}><ProductTimeline /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText('Введіть точний SKU'), { target: { value: ' sku-b ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Показати історію' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/product-timeline', { params: { sku: 'SKU-B' } }));
  });
});
