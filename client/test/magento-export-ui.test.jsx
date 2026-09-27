import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExportTools, ManualMagentoNameEditor } from '../src/components/app/ExportTools.jsx';

vi.mock('../src/api/exports-api', () => ({ exportsApi: {
  suggestMagentoName: vi.fn(),
  previewMagentoName: vi.fn(),
  applyMagentoName: vi.fn(),
} }));

import { exportsApi } from '../src/api/exports-api';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('phase2 loads inherited names and confirms the exact displayed pair with its original lifecycle proof', async () => {
  exportsApi.previewMagentoName.mockResolvedValue({ data: { subjectUa: ' Фігура ', subjectEn: ' Figurine ',
    reviewRequired: true, canConfirmUnchanged: true, previewToken: 'reviewed-pair-proof' } });
  exportsApi.applyMagentoName.mockResolvedValue({ data: { reviewRequired: false, fullRevision: '1' } });
  const onSaved = vi.fn();
  render(<ManualMagentoNameEditor product={{ productId: 70, sku: 'SV70', reviewRequired: true }} onSaved={onSaved} onClose={vi.fn()} />);
  const confirm = await screen.findByRole('button', { name: 'Підтвердити без змін' });
  expect(screen.getByLabelText('Українська назва').value).toBe(' Фігура ');
  expect(screen.getByLabelText('English name').value).toBe(' Figurine ');
  expect(screen.getByText('Потрібна перевірка успадкованих назв')).toBeTruthy();
  fireEvent.click(confirm);
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(exportsApi.previewMagentoName).toHaveBeenCalledTimes(1);
  expect(exportsApi.applyMagentoName).toHaveBeenCalledWith({ productId: 70, subjectUa: ' Фігура ', subjectEn: ' Figurine ',
    confirmUnchanged: true, previewToken: 'reviewed-pair-proof' });
});

it('phase2 editing the inherited pair hides unchanged confirmation and saves through normal name preview', async () => {
  exportsApi.previewMagentoName.mockResolvedValueOnce({ data: { subjectUa: 'Фігура', subjectEn: 'Figurine',
    reviewRequired: true, canConfirmUnchanged: true, previewToken: 'old-proof' } }).mockResolvedValue({ data: { previewToken: 'edit-proof' } });
  exportsApi.applyMagentoName.mockResolvedValue({ data: {} });
  render(<ManualMagentoNameEditor product={{ productId: 71, sku: 'SV71', reviewRequired: true }} onSaved={vi.fn()} onClose={vi.fn()} />);
  await screen.findByRole('button', { name: 'Підтвердити без змін' });
  fireEvent.change(screen.getByLabelText('English name'), { target: { value: 'New figurine' } });
  expect(screen.queryByRole('button', { name: 'Підтвердити без змін' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти назви' }));
  await waitFor(() => expect(exportsApi.applyMagentoName).toHaveBeenCalledWith({ productId: 71, subjectUa: 'Фігура', subjectEn: 'New figurine', previewToken: 'edit-proof' }));
});

it('phase2 stale review confirmation requires operator refresh and never silently renews proof', async () => {
  exportsApi.previewMagentoName.mockResolvedValue({ data: { subjectUa: 'Фігура', subjectEn: 'Figurine',
    reviewRequired: true, canConfirmUnchanged: true, previewToken: 'old-proof' } });
  exportsApi.applyMagentoName.mockRejectedValue({ response: { status: 409, data: { error: 'Назви змінилися. Оновіть дані.' } } });
  const onSaved = vi.fn();
  render(<ManualMagentoNameEditor product={{ productId: 72, sku: 'SV72', reviewRequired: true }} onSaved={onSaved} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Підтвердити без змін' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Назви змінилися. Оновіть дані.');
  expect(onSaved).not.toHaveBeenCalled(); expect(exportsApi.previewMagentoName).toHaveBeenCalledTimes(1);
});

it('phase2 inherited-review readiness offers the existing name workflow', () => {
  renderTools({ exportPreview: { mode: 'manual', representedCount: 1, readyCount: 0,
    errors: [issue(73, 'name', 'manual_name_review_required')], artifacts: [] } });
  fireEvent.click(screen.getByRole('button', { name: 'Показати проблемні товари' }));
  expect(screen.getByRole('button', { name: 'Перевірити назви' })).toBeTruthy();
});

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
  markExportReviewStale: vi.fn(),
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

  expect(screen.getByText(/Товарів: 3 · Готові: 1/)).toBeTruthy();
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

it('presents selected stored download and explicit confirmation dialog, freezing input', async () => {
  const onDownloadMagentoArtifact = vi.fn(); const onConfirmSnapshot = vi.fn();
  renderTools({ exportSnapshot: { id: 'snapshot-1', status: 'generated', artifacts: [
    { groupCode: 'BR', groupName: 'Браслети', csvContent: 'sku,price\nBR,2', fileName: 'br.csv', rowCount: 1 },
    { groupCode: 'SV', groupName: 'Сувеніри', csvContent: 'sku,price\nSV,3', fileName: 'sv.csv', rowCount: 1 },
  ] }, onDownloadMagentoArtifact, onConfirmSnapshot });
  expect(screen.getByText('ЗБЕРЕЖЕНІ ФАЙЛИ')).toBeTruthy(); expect(screen.queryByText('Повторний або вибірковий експорт')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Завантажити CSV' })); expect(onDownloadMagentoArtifact).toHaveBeenCalledWith('BR'); expect(onConfirmSnapshot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'Сувеніри' })); fireEvent.click(screen.getByRole('button', { name: 'Завантажити CSV' })); expect(onDownloadMagentoArtifact).toHaveBeenCalledWith('SV');
  fireEvent.click(screen.getByRole('button', { name: 'Завершити експорт' })); expect(onConfirmSnapshot).not.toHaveBeenCalled();
  expect(screen.getByText(/Це не означає, що імпорт у Magento успішний/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити збережений експорт' })); await waitFor(() => expect(onConfirmSnapshot).toHaveBeenCalledOnce());
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

it('product export surface contains no price create/download/confirm orchestration', () => {
  renderTools({ priceExportStatus: { pendingCount: 4 } });
  expect(screen.queryByText('Оновлення цін Magento')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Експортувати зміни цін' })).toBeNull();
});

it('shows loading states and hides export workflows without create permission', () => {
  const view = renderTools({ exportStatus: null, priceExportStatus: null });
  expect(screen.getByText('Завантаження статусу експорту…')).toBeTruthy();

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
  expect(onPreviewExport).not.toHaveBeenCalled(); expect(defaults.markExportReviewStale).toHaveBeenCalled();
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
  expect(onPreviewExport).not.toHaveBeenCalled(); expect(defaults.markExportReviewStale).toHaveBeenCalled();
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

  await waitFor(() => expect(defaults.markExportReviewStale).toHaveBeenCalled());
  expect(onPreviewExport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Оновити перевірку' }));
  await waitFor(() => expect(onPreviewExport).toHaveBeenCalledWith('manual'));
  await waitFor(() => expect(screen.getByText('8 товарів потребують виправлення')).toBeTruthy());
  expect(screen.getByRole('button', { name: 'Сховати проблемні товари' })).toBeTruthy();
  expect(screen.getByText('SV00000009')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Показати всі 8' })).toBeNull();
  expect(screen.queryByText('SV00000001')).toBeNull();
  expect(screen.queryByLabelText('Українська назва')).toBeNull();
  expect(customDetails.open).toBe(true);
});
