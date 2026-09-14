import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      details: {
        latestProposal: { sourceSku: 'SKU-B', proposedSku: 'SKU-C', changes: [] },
      }, changes: [], groupKey: 'business-action-1',
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
        kind: 'answer', fieldKey: 'discount', fieldLabel: 'Знижка',
        before: { value: 3, label: '50%' }, after: { value: 0, label: 'Не вказано' },
      }, {
        kind: 'answer', fieldKey: 'material', fieldLabel: 'Матеріал',
        before: { value: 7, label: 'Бурштин' }, after: { value: 8, label: null },
      }, {
        kind: 'answer', fieldKey: 'is_calibrated', fieldLabel: 'Калібрування',
        before: { value: 0, label: 'Некалібрована' }, after: { value: 2, label: 'Напівкалібрована' },
      }, {
        kind: 'answer', fieldKey: 'future_field', fieldLabel: null,
        before: { value: 9, label: null }, after: { value: 10, label: null },
      }],
    },
    {
      id: 'timeline-4', type: 'product.archived', occurredAt: null,
      timestampStatus: 'not_recorded', actor: { status: 'not_recorded' }, sku: 'SKU-C',
      details: {}, changes: [], groupKey: null,
    },
  ],
  configurationEvolution: {
    status: 'complete',
    warnings: [],
    snapshots: [{
      id: 'configuration-1',
      ordinal: 1,
      isInitial: true,
      isCurrent: false,
      productStatus: 'corrected',
      establishingSku: 'SKU-A',
      establishingSchemaVersion: { id: 4, version: 1, marker: '' },
      currentSku: null,
      currentSchemaVersion: null,
      occurredAt: '2026-01-01T10:00:00Z',
      timestampStatus: 'recorded',
      source: 'product_created',
      completeness: 'complete',
      fields: [{
        key: 'kind', fieldLabel: 'Вид', value: { value: 1, label: 'Перший' },
        labelStatus: 'historical_schema', evidence: 'product_details', changed: false,
      }, {
        key: 'material', fieldLabel: 'Матеріал', value: { value: 7, label: 'Бурштин' },
        labelStatus: 'historical_schema', evidence: 'product_details', changed: false,
      }, {
        key: 'is_calibrated', fieldLabel: 'Калібрування',
        value: { value: 0, label: 'Некалібрована' },
        labelStatus: 'stable_domain', evidence: 'product_details', changed: false,
      }],
      changes: [],
    }, {
      id: 'configuration-2',
      ordinal: 2,
      isInitial: false,
      isCurrent: true,
      productStatus: 'archived',
      establishingSku: 'SKU-B',
      establishingSchemaVersion: { id: 4, version: 1, marker: '' },
      currentSku: 'SKU-C',
      currentSchemaVersion: { id: 5, version: 2, marker: '2/' },
      occurredAt: '2026-01-02T10:00:00Z',
      timestampStatus: 'recorded',
      source: 'correction_request',
      completeness: 'complete',
      fields: [{
        key: 'kind', fieldLabel: 'Вид', value: { value: 2, label: 'Другий' },
        previous: { value: 1, label: 'Перший' },
        labelStatus: 'historical_schema', evidence: 'product_details', changed: true,
      }, {
        key: 'material', fieldLabel: 'Матеріал', value: { value: 7, label: 'Бурштин' },
        labelStatus: 'historical_schema', evidence: 'product_details', changed: false,
      }, {
        key: 'is_calibrated', fieldLabel: 'Калібрування',
        value: { value: 2, label: 'Напівкалібрована' },
        previous: { value: 0, label: 'Некалібрована' },
        labelStatus: 'stable_domain', evidence: 'product_details', changed: true,
      }],
      changes: [{
        kind: 'answer', fieldKey: 'kind', fieldLabel: 'Вид',
        before: { value: 1, label: 'Перший' }, after: { value: 2, label: 'Другий' },
        labelStatus: 'historical_schema',
      }, {
        kind: 'answer', fieldKey: 'is_calibrated', fieldLabel: 'Калібрування',
        before: { value: 0, label: 'Некалібрована' },
        after: { value: 2, label: 'Напівкалібрована' }, labelStatus: 'stable_domain',
      }],
    }],
  },
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
    expect(screen.getAllByText('Калібрування').length).toBeGreaterThan(0);
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('Не вказано')).toBeTruthy();
    expect(screen.getAllByText('Бурштин').length).toBeGreaterThan(0);
    expect(screen.getByText('8')).toBeTruthy();
    expect(screen.getAllByText('Некалібрована').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Напівкалібрована').length).toBeGreaterThan(0);
    expect(screen.getByText('future_field')).toBeTruthy();
    expect(screen.getByText('9')).toBeTruthy();
    expect(screen.getByText('останній')).toBeTruthy();
    const transitions = screen.getAllByTestId('sku-transition');
    expect(document.querySelectorAll('.timeline-card')).toHaveLength(3);
    expect(document.querySelectorAll('.timeline-snapshot')).toHaveLength(2);
    expect(document.querySelector('.timeline-card').className).not.toContain('shadow');
    expect(document.querySelector('.timeline-snapshot').className).not.toContain('shadow');
    expect(document.querySelector('.timeline-change-list')).toBeTruthy();
    expect(transitions).toHaveLength(2);
    for (const transition of transitions) {
      expect(transition.textContent).toBe('SKU-BSKU-C');
      expect(transition.className).toContain('justify-start');
      expect(transition.querySelectorAll('.flex-1')).toHaveLength(0);
      expect(transition.querySelectorAll('.text-right')).toHaveLength(0);
    }
  });

  it('normalizes exact SKU searches into the URL-driven request', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: timeline });
    render(<MemoryRouter initialEntries={['/admin/corrections/history']}><ProductTimeline /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText('Введіть точний SKU'), { target: { value: ' sku-b ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Показати історію' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/product-timeline', { params: { sku: 'SKU-B' } }));
  });

  it('renders a vertical logical evolution with changes-only default and full-state toggle', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: timeline });
    render(<MemoryRouter initialEntries={['/admin/corrections/history?sku=SKU-B']}><ProductTimeline /></MemoryRouter>);

    const evolution = await screen.findByRole('region', { name: 'Еволюція характеристик' });
    const cards = within(evolution).getAllByTestId('configuration-snapshot');
    expect(cards).toHaveLength(2);
    expect(cards[0].compareDocumentPosition(cards[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(evolution.querySelector('[data-horizontal-scroll]')).toBeNull();

    const changesButton = within(evolution).getByRole('button', { name: 'Лише зміни' });
    const fullButton = within(evolution).getByRole('button', { name: 'Повний стан' });
    expect(changesButton.getAttribute('aria-pressed')).toBe('true');
    expect(within(cards[0]).getByText('Бурштин')).toBeTruthy();
    expect(within(cards[1]).queryByText('Бурштин')).toBeNull();
    expect(within(cards[1]).getByText('Останній')).toBeTruthy();
    expect(within(cards[1]).getByText('SKU-B')).toBeTruthy();
    expect(within(cards[1]).getByText(/Поточний SKU:/)).toBeTruthy();
    expect(within(cards[1]).getByText('SKU-C')).toBeTruthy();
    expect(within(cards[1]).getByText('Схема V1')).toBeTruthy();
    expect(within(cards[1]).getByText(/Поточна схема: V2/)).toBeTruthy();
    expect(within(cards[1]).getByText('Некалібрована')).toBeTruthy();
    expect(within(cards[1]).getByText('Напівкалібрована')).toBeTruthy();

    fireEvent.click(fullButton);
    expect(fullButton.getAttribute('aria-pressed')).toBe('true');
    expect(within(cards[1]).getByText('Бурштин')).toBeTruthy();
    expect(within(cards[1]).getByTestId('configuration-field-kind').dataset.changed).toBe('true');

    const skuChain = screen.getByLabelText('Ланцюжок версій SKU').closest('section');
    const eventTimeline = screen.getByLabelText('Хронологія подій');
    expect(skuChain.compareDocumentPosition(evolution) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(evolution.compareDocumentPosition(eventTimeline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Запит виконано та товар виправлено')).toBeTruthy();
  });

  it('renders explicit partial and unavailable evolution states', async () => {
    const partialTimeline = {
      ...timeline,
      configurationEvolution: {
        status: 'partial',
        warnings: [{ code: 'LEGACY_CONFIGURATION_PARTIAL', message: 'Показано лише підтверджені значення.' }],
        snapshots: [{
          ...timeline.configurationEvolution.snapshots[0],
          isCurrent: true,
          currentSku: 'SKU-C',
          completeness: 'partial',
        }],
      },
    };
    const get = vi.spyOn(api, 'get').mockResolvedValueOnce({ data: partialTimeline });
    const { unmount } = render(
      <MemoryRouter initialEntries={['/admin/corrections/history?sku=SKU-B']}><ProductTimeline /></MemoryRouter>
    );
    expect(await screen.findByText('Показано лише підтверджені значення.')).toBeTruthy();
    unmount();

    get.mockResolvedValueOnce({
      data: {
        ...timeline,
        configurationEvolution: {
          status: 'unavailable',
          warnings: [{ code: 'AMBIGUOUS_CONFIGURATION_ORDER', message: 'Неможливо надійно впорядкувати конфігурації.' }],
          snapshots: [],
        },
      },
    });
    render(<MemoryRouter initialEntries={['/admin/corrections/history?sku=SKU-B']}><ProductTimeline /></MemoryRouter>);
    expect(await screen.findByText('Неможливо надійно впорядкувати конфігурації.')).toBeTruthy();
  });
});
