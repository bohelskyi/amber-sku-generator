import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExportTools } from '../src/components/app/ExportTools.jsx';

vi.mock('../src/api/exports-api', () => ({ exportsApi: {
  suggestMagentoName: vi.fn(),
  previewMagentoName: vi.fn(),
  applyMagentoName: vi.fn(),
} }));

import { exportsApi } from '../src/api/exports-api';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const defaults = {
  exportFromSku: '',
  setExportFromSku: vi.fn(),
  exportToSku: '',
  setExportToSku: vi.fn(),
  exportError: '',
  exportStatus: { countSinceLastExport: 0, translationSuggestionAvailable: false },
  exportPreview: null,
  exportSnapshot: null,
  setExportError: vi.fn(),
  isExportLoading: false,
  isPriceExportLoading: false,
  priceExportError: '',
  priceExportStatus: { pendingCount: 0, excludedPendingCount: 0 },
  skuToDelete: '',
  setSkuToDelete: vi.fn(),
  onPreviewExport: vi.fn(),
  onCreateSnapshot: vi.fn(),
  onDownloadMagentoArtifact: vi.fn(),
  onConfirmSnapshot: vi.fn(),
  onPriceExportCsv: vi.fn(),
  onDelete: vi.fn(),
};

function renderTools(overrides = {}) {
  const props = { ...defaults, ...overrides };
  return { props, ...render(<ExportTools {...props} />) };
}

function issue(productId, field, code) {
  return {
    productId,
    sku: `SV${String(productId).padStart(8, '0')}`,
    fields: [{ field, ...(code ? { code } : {}), message: `internal ${field}` }],
  };
}

it('shows the initial pending state with one clear next action', () => {
  const onPreviewExport = vi.fn();
  renderTools({ exportStatus: { countSinceLastExport: 3 }, onPreviewExport });

  expect(screen.getByText('Експорт товарів у Magento')).toBeTruthy();
  expect(screen.getByText('3 нові товари очікують експорту')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити 3 нові товари' }));
  expect(onPreviewExport).toHaveBeenCalledWith('new');
  expect(screen.queryByRole('button', { name: /Створити файли/ })).toBeNull();
});

it('summarizes blocked readiness with human labels and expands products on demand', () => {
  const onPreviewExport = vi.fn();
  renderTools({
    exportStatus: { countSinceLastExport: 3 },
    exportPreview: {
      mode: 'new', representedCount: 3, readyCount: 1, artifacts: [],
      errors: [
        { ...issue(1, 'name', 'manual_name_required'), fields: [
          { field: 'name', code: 'manual_name_required', message: 'internal name' },
          { field: 'decor_weight', message: 'internal decor_weight' },
        ] },
        issue(2, 'decor_weight'),
      ],
    },
    onPreviewExport,
  });

  expect(screen.getByText('3').parentElement.textContent).toContain('всього');
  expect(screen.getByText('2 товари потребують виправлення')).toBeTruthy();
  expect(screen.getByText((_, element) => element.tagName === 'LI'
    && element.textContent === '1 — потрібно вказати назву')).toBeTruthy();
  expect(screen.getByText((_, element) => element.tagName === 'LI'
    && element.textContent === '2 — відсутня вага')).toBeTruthy();
  expect(screen.queryByText('SV00000001')).toBeNull();
  expect(screen.queryByText(/decor_weight|internal name/)).toBeNull();
  expect(screen.queryByRole('button', { name: /Створити файли/ })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Показати проблемні товари' }));
  expect(screen.getByText('SV00000001')).toBeTruthy();
  expect(screen.getByText('Потрібно вказати назву · Відсутня вага')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Заповнити назву' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Оновити перевірку' }));
  expect(onPreviewExport).toHaveBeenCalledWith('new');
});

it('truncates a long problem list and reveals all rows only after request', () => {
  const errors = Array.from({ length: 9 }, (_, index) => issue(index + 1, 'decor_weight'));
  renderTools({ exportPreview: {
    mode: 'new', representedCount: 9, readyCount: 0, errors, artifacts: [],
  } });

  fireEvent.click(screen.getByRole('button', { name: 'Показати проблемні товари' }));
  expect(screen.getByText('SV00000006')).toBeTruthy();
  expect(screen.queryByText('SV00000007')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Показати всі 9' }));
  expect(screen.getByText('SV00000009')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Показати всі 9' })).toBeNull();
});

it('shows the fully ready state and creates files with the existing action', () => {
  const onCreateSnapshot = vi.fn();
  renderTools({
    exportPreview: {
      mode: 'new', representedCount: 87, readyCount: 87, errors: [], artifacts: [],
    },
    onCreateSnapshot,
  });

  expect(screen.getByText('87 товарів готові до експорту')).toBeTruthy();
  expect(screen.getByText('Усі необхідні дані заповнені та пройшли перевірку.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Створити файли Magento' }));
  expect(onCreateSnapshot).toHaveBeenCalledOnce();
});

it('presents snapshot downloads by group and keeps completion separate', () => {
  const onDownloadMagentoArtifact = vi.fn();
  const onConfirmSnapshot = vi.fn();
  renderTools({ exportSnapshot: {
    id: 'snapshot-1', status: 'generated', artifacts: [
      { groupCode: 'BR', fileName: 'amber-magento-BR-magento-products-v1.csv',
        profileVersion: 'magento-products-v1', productCount: 2 },
      { groupCode: 'SV', fileName: 'amber-magento-SV-magento-products-v1.csv',
        profileVersion: 'magento-products-v1', productCount: 30 },
    ],
  }, onDownloadMagentoArtifact, onConfirmSnapshot });

  expect(screen.getByText('Файли Magento готові')).toBeTruthy();
  expect(screen.getByText('Браслети')).toBeTruthy();
  expect(screen.getByText('2 товари')).toBeTruthy();
  expect(screen.getByText('Сувеніри')).toBeTruthy();
  expect(screen.getByText('30 товарів')).toBeTruthy();
  const downloadButtons = screen.getAllByRole('button', { name: 'Завантажити CSV' });
  fireEvent.click(downloadButtons[0]);
  expect(onDownloadMagentoArtifact).toHaveBeenCalledWith('BR');
  expect(onConfirmSnapshot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Завершити експорт' }));
  expect(onConfirmSnapshot).toHaveBeenCalledOnce();
  expect(screen.getByText(/Це не означає, що Magento вже імпортувала файли/)).toBeTruthy();

  const technicalDetails = screen.getByText('Технічні дані').closest('details');
  expect(technicalDetails.open).toBe(false);
  fireEvent.click(screen.getByText('Технічні дані'));
  expect(technicalDetails.open).toBe(true);
  expect(screen.getByText('snapshot-1')).toBeTruthy();
  expect(screen.getByText('amber-magento-BR-magento-products-v1.csv')).toBeTruthy();
});

it('keeps custom export collapsed by default and submits the manual range after expansion', () => {
  const onPreviewExport = vi.fn();
  renderTools({ exportFromSku: 'BR123', onPreviewExport });

  const summary = screen.getByText('Повторний або вибірковий експорт');
  const details = summary.closest('details');
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  expect(screen.getByLabelText('Початковий SKU для повторного експорту').value).toBe('BR123');
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити діапазон' }));
  expect(onPreviewExport).toHaveBeenCalledWith('manual');
});

it('shows compact zero and pending price-export states without a disabled zero-state action', () => {
  const onPriceExportCsv = vi.fn();
  const view = renderTools({ priceExportStatus: { pendingCount: 0 } });
  expect(screen.getByText('Оновлення цін Magento')).toBeTruthy();
  expect(screen.getByText('Немає змін цін для експорту.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Експортувати зміни цін' })).toBeNull();

  view.rerender(<ExportTools {...defaults}
    priceExportStatus={{ pendingCount: 4, excludedPendingCount: 1 }}
    onPriceExportCsv={onPriceExportCsv} />);
  expect(screen.getByText('4 зміни цін очікують експорту.')).toBeTruthy();
  expect(screen.getByText('Виключено з експорту: 1.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Експортувати зміни цін' }));
  expect(onPriceExportCsv).toHaveBeenCalledOnce();
});

it('shows loading states and hides export workflows without create permission', () => {
  const view = renderTools({ exportStatus: null, priceExportStatus: null });
  expect(screen.getByText('Завантаження статусу експорту…')).toBeTruthy();
  expect(screen.getByText('Завантаження стану цін…')).toBeTruthy();

  view.rerender(<ExportTools {...defaults} canCreateExport={false} canArchive />);
  expect(screen.queryByText('Експорт товарів у Magento')).toBeNull();
  expect(screen.queryByText('Оновлення цін Magento')).toBeNull();
  expect(screen.getByRole('button', { name: 'Архівувати' })).toBeTruthy();
});

it('edits the EN suggestion when translation is configured, then refreshes readiness', async () => {
  exportsApi.suggestMagentoName.mockResolvedValue({ data: { subjectEn: 'bird figurine' } });
  exportsApi.previewMagentoName.mockResolvedValue({ data: { previewToken: 'token' } });
  exportsApi.applyMagentoName.mockResolvedValue({ data: { productId: 14 } });
  const onPreviewExport = vi.fn();
  renderTools({
    exportStatus: { countSinceLastExport: 0, translationSuggestionAvailable: true },
    exportPreview: { mode: 'manual', representedCount: 1, readyCount: 0,
      errors: [issue(14, 'name', 'manual_name_required')], artifacts: [] },
    onPreviewExport,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Показати проблемні товари' }));
  fireEvent.click(screen.getByRole('button', { name: 'Заповнити назву' }));
  fireEvent.change(screen.getByLabelText('Українська назва'), {
    target: { value: 'Фігурка птаха' },
  });
  expect(screen.getByRole('button', { name: 'Запропонувати переклад' })).toBeTruthy();
  await waitFor(() => expect(exportsApi.suggestMagentoName).toHaveBeenCalledWith({
    productId: 14, subjectUa: 'Фігурка птаха',
  }));
  await waitFor(() => expect(screen.getByLabelText('English name').value).toBe('bird figurine'));
  fireEvent.change(screen.getByLabelText('English name'), { target: { value: 'bird statue' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти назви' }));
  await waitFor(() => expect(exportsApi.applyMagentoName).toHaveBeenCalledWith({
    productId: 14, subjectUa: 'Фігурка птаха', subjectEn: 'bird statue', previewToken: 'token',
  }));
  expect(onPreviewExport).toHaveBeenCalledWith('manual');
});

it('hides translation without a key and saves manually entered EN', async () => {
  exportsApi.previewMagentoName.mockResolvedValue({ data: { previewToken: 'manual-token' } });
  exportsApi.applyMagentoName.mockResolvedValue({ data: { productId: 15 } });
  const onPreviewExport = vi.fn();
  renderTools({
    exportPreview: { mode: 'manual', representedCount: 1, readyCount: 0,
      errors: [issue(15, 'name', 'manual_name_required')], artifacts: [] },
    onPreviewExport,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Показати проблемні товари' }));
  fireEvent.click(screen.getByRole('button', { name: 'Заповнити назву' }));
  fireEvent.change(screen.getByLabelText('Українська назва'), { target: { value: 'Камінь' } });
  expect(screen.queryByRole('button', { name: 'Запропонувати переклад' })).toBeNull();
  fireEvent.change(screen.getByLabelText('English name'), { target: { value: 'stone' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти назви' }));
  await waitFor(() => expect(exportsApi.applyMagentoName).toHaveBeenCalledWith({
    productId: 15, subjectUa: 'Камінь', subjectEn: 'stone', previewToken: 'manual-token',
  }));
  expect(exportsApi.suggestMagentoName).not.toHaveBeenCalled();
  expect(onPreviewExport).toHaveBeenCalledWith('manual');
});

it('preserves expanded problem, show-all, and custom-range disclosures after name save refresh', async () => {
  exportsApi.previewMagentoName.mockResolvedValue({ data: { previewToken: 'refresh-token' } });
  exportsApi.applyMagentoName.mockResolvedValue({ data: { productId: 1 } });
  const onPreviewExport = vi.fn();
  const initialErrors = [
    issue(1, 'name', 'manual_name_required'),
    ...Array.from({ length: 8 }, (_, index) => issue(index + 2, 'decor_weight')),
  ];
  const refreshedErrors = initialErrors.slice(1);

  function RefreshHarness() {
    const [preview, setPreview] = useState({
      mode: 'manual', representedCount: 9, readyCount: 0,
      errors: initialErrors, artifacts: [],
    });
    return <ExportTools {...defaults} exportPreview={preview}
      onPreviewExport={(mode) => {
        onPreviewExport(mode);
        setPreview({
          mode, representedCount: 9, readyCount: 1,
          errors: refreshedErrors, artifacts: [],
        });
      }} />;
  }

  render(<RefreshHarness />);
  fireEvent.click(screen.getByRole('button', { name: 'Показати проблемні товари' }));
  fireEvent.click(screen.getByRole('button', { name: 'Показати всі 9' }));
  expect(screen.getByText('SV00000009')).toBeTruthy();

  const customSummary = screen.getByText('Повторний або вибірковий експорт');
  const customDetails = customSummary.closest('details');
  fireEvent.click(customSummary);
  expect(customDetails.open).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Заповнити назву' }));
  fireEvent.change(screen.getByLabelText('Українська назва'), {
    target: { value: 'Фігурка' },
  });
  fireEvent.change(screen.getByLabelText('English name'), {
    target: { value: 'figurine' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти назви' }));

  await waitFor(() => expect(onPreviewExport).toHaveBeenCalledWith('manual'));
  await waitFor(() => expect(screen.getByText('8 товарів потребують виправлення')).toBeTruthy());
  expect(screen.getByRole('button', { name: 'Сховати проблемні товари' })).toBeTruthy();
  expect(screen.getByText('SV00000009')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Показати всі 8' })).toBeNull();
  expect(screen.queryByText('SV00000001')).toBeNull();
  expect(screen.queryByLabelText('Українська назва')).toBeNull();
  expect(customDetails.open).toBe(true);
});
