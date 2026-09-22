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

it('shows one Magento product workflow and keeps download separate from confirmation', () => {
  const onDownloadMagentoArtifact = vi.fn();
  const onConfirmSnapshot = vi.fn();
  const onPreviewExport = vi.fn();
  render(<ExportTools
    exportFromSku=""
    setExportFromSku={vi.fn()}
    exportToSku=""
    setExportToSku={vi.fn()}
    exportStatus={{ countSinceLastExport: 1 }}
    exportPreview={{ mode: 'new', representedCount: 1, readyCount: 1,
      errors: [], artifacts: [
      { groupCode: 'BR', fileName: 'bracelets.csv' },
    ] }}
    exportSnapshot={{ id: 'snapshot-1', status: 'generated', artifacts: [
      { groupCode: 'BR', fileName: 'bracelets.csv' },
    ] }}
    setExportError={vi.fn()}
    onPreviewExport={onPreviewExport}
    onCreateSnapshot={vi.fn()}
    onDownloadMagentoArtifact={onDownloadMagentoArtifact}
    onConfirmSnapshot={onConfirmSnapshot}
    onPriceExportCsv={vi.fn()}
    onDelete={vi.fn()}
    setSkuToDelete={vi.fn()}
  />);
  fireEvent.click(screen.getByText('Експорт та коригування'));
  expect(screen.getByText('Файли Magento готові')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Створити файли' })).toBeNull();
  expect(screen.getByText('Технічні дані').closest('details').open).toBe(false);
  expect(screen.getByText('ID експорту: snapshot-1').closest('details')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Підготувати експорт' }));
  expect(onPreviewExport).toHaveBeenCalledWith('new');
  expect(screen.queryByRole('button', { name: /старий|legacy/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Завантажити CSV: Браслети' }));
  expect(onDownloadMagentoArtifact).toHaveBeenCalledWith('BR');
  expect(onConfirmSnapshot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Завершити експорт' }));
  expect(onConfirmSnapshot).toHaveBeenCalledOnce();
});

it('shows an empty new-product state while keeping the manual re-export section available', () => {
  const onPreviewExport = vi.fn();
  render(<ExportTools
    exportFromSku="BR123"
    setExportFromSku={vi.fn()}
    exportToSku=""
    setExportToSku={vi.fn()}
    exportStatus={{ countSinceLastExport: 0 }}
    setExportError={vi.fn()}
    onPreviewExport={onPreviewExport}
    onCreateSnapshot={vi.fn()}
    onDownloadMagentoArtifact={vi.fn()}
    onConfirmSnapshot={vi.fn()}
    onPriceExportCsv={vi.fn()}
    onDelete={vi.fn()}
    setSkuToDelete={vi.fn()}
  />);
  fireEvent.click(screen.getByText('Експорт та коригування'));
  expect(screen.getByText('Нових товарів для експорту немає')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /нових товарів/ })).toBeNull();
  fireEvent.click(screen.getByText('Повторний / вибірковий експорт'));
  expect(screen.getByLabelText('Початковий SKU для повторного експорту')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити діапазон' }));
  expect(onPreviewExport).toHaveBeenCalledWith('manual');
});

it('edits the EN suggestion when translation is configured, then refreshes readiness', async () => {
  exportsApi.suggestMagentoName.mockResolvedValue({ data: { subjectEn: 'bird figurine' } });
  exportsApi.previewMagentoName.mockResolvedValue({ data: { previewToken: 'token' } });
  exportsApi.applyMagentoName.mockResolvedValue({ data: { productId: 14 } });
  const onPreviewExport = vi.fn();
  render(<ExportTools
    exportFromSku="SV-14" setExportFromSku={vi.fn()}
    exportToSku="" setExportToSku={vi.fn()}
    exportStatus={{ countSinceLastExport: 0, translationSuggestionAvailable: true }}
    exportPreview={{ mode: 'manual', representedCount: 1, readyCount: 0,
      errors: [{ productId: 14, sku: 'SV-14', fields: [{
        field: 'name', code: 'manual_name_required', message: 'Потрібна назва.',
      }] }], artifacts: [] }}
    setExportError={vi.fn()} onPreviewExport={onPreviewExport}
    onCreateSnapshot={vi.fn()} onDownloadMagentoArtifact={vi.fn()}
    onConfirmSnapshot={vi.fn()} onPriceExportCsv={vi.fn()}
    onDelete={vi.fn()} setSkuToDelete={vi.fn()}
  />);
  fireEvent.click(screen.getByText('Експорт та коригування'));
  fireEvent.click(screen.getByRole('button', { name: 'Заповнити назву' }));
  fireEvent.change(screen.getByLabelText('Українська назва'), {
    target: { value: 'Фігурка птаха' },
  });
  expect(screen.getByRole('button', { name: 'Запропонувати переклад' })).toBeTruthy();
  await waitFor(() => expect(exportsApi.suggestMagentoName).toHaveBeenCalledWith({
    productId: 14, subjectUa: 'Фігурка птаха',
  }));
  await waitFor(() => expect(screen.getByLabelText('English name').value).toBe('bird figurine'));
  fireEvent.change(screen.getByLabelText('English name'), {
    target: { value: 'bird statue' },
  });
  expect(screen.getByText('UA: Фігурка птаха з бурштину. Арт: SV-14')).toBeTruthy();
  expect(screen.getByText('EN: Amber bird statue. Art: SV-14')).toBeTruthy();
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
  render(<ExportTools
    exportFromSku="SV-15" setExportFromSku={vi.fn()}
    exportToSku="" setExportToSku={vi.fn()}
    exportStatus={{ countSinceLastExport: 0, translationSuggestionAvailable: false }}
    exportPreview={{ mode: 'manual', representedCount: 1, readyCount: 0,
      errors: [{ productId: 15, sku: 'SV-15', fields: [{
        field: 'name', code: 'manual_name_required', message: 'Потрібна назва.',
      }] }], artifacts: [] }}
    setExportError={vi.fn()} onPreviewExport={onPreviewExport}
    onCreateSnapshot={vi.fn()} onDownloadMagentoArtifact={vi.fn()}
    onConfirmSnapshot={vi.fn()} onPriceExportCsv={vi.fn()}
    onDelete={vi.fn()} setSkuToDelete={vi.fn()}
  />);
  fireEvent.click(screen.getByText('Експорт та коригування'));
  fireEvent.click(screen.getByRole('button', { name: 'Заповнити назву' }));
  fireEvent.change(screen.getByLabelText('Українська назва'), {
    target: { value: 'Камінь' },
  });
  expect(screen.queryByRole('button', { name: 'Запропонувати переклад' })).toBeNull();
  fireEvent.change(screen.getByLabelText('English name'), {
    target: { value: 'stone' },
  });
  expect(screen.getByText('EN: Amber stone. Art: SV-15')).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 650));
  expect(exportsApi.suggestMagentoName).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти назви' }));
  await waitFor(() => expect(exportsApi.applyMagentoName).toHaveBeenCalledWith({
    productId: 15, subjectUa: 'Камінь', subjectEn: 'stone',
    previewToken: 'manual-token',
  }));
  expect(onPreviewExport).toHaveBeenCalledWith('manual');
});

const baseProps = {
  exportFromSku: '', exportToSku: '', skuToDelete: '',
  setExportFromSku: vi.fn(), setExportToSku: vi.fn(), setSkuToDelete: vi.fn(),
  setExportError: vi.fn(), onPreviewExport: vi.fn(), onCreateSnapshot: vi.fn(),
  onDownloadMagentoArtifact: vi.fn(), onConfirmSnapshot: vi.fn(),
  onPriceExportCsv: vi.fn(), onDelete: vi.fn(),
  exportStatus: { countSinceLastExport: 87 },
};

function openExport(props = {}) {
  const result = render(<ExportTools {...baseProps} {...props} />);
  fireEvent.click(screen.getByText('Експорт та коригування'));
  return result;
}

it('presents pending products with collapsed secondary controls', () => {
  openExport();
  expect(screen.getByRole('heading', { name: 'Експорт товарів у Magento' })).toBeTruthy();
  expect(screen.getByText('87 нових товарів очікують експорту')).toBeTruthy();
  expect(screen.getByText('Повторний / вибірковий експорт').closest('details').open).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Підготувати експорт' }));
  expect(baseProps.onPreviewExport).toHaveBeenCalledWith('new');
  expect(screen.queryByRole('button', { name: 'Створити файли' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Експорт змін цін' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Архівування' })).toBeTruthy();
});

it('presents a successful preview and creates files from the ready state', () => {
  const props = { exportPreview: { mode: 'new', representedCount: 40, readyCount: 40, errors: [] } };
  const { rerender } = openExport(props);
  expect(screen.getByText('40 товарів готові до експорту')).toBeTruthy();
  expect(screen.getByText('Усі дані заповнені та пройшли перевірку.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Створити файли' }));
  expect(baseProps.onCreateSnapshot).toHaveBeenCalledOnce();
  rerender(<ExportTools {...baseProps} {...props} isExportLoading />);
  expect(screen.getByRole('button', { name: 'Створити файли' }).disabled).toBe(true);
});

it('makes readiness problems dominant, keeps fixes and prevents file creation', () => {
  openExport({ exportPreview: { mode: 'new', representedCount: 87, readyCount: 84,
    errors: [1, 2, 3].map((id) => ({ productId: id, sku: `SV-${id}`,
      fields: [{ field: 'name', code: 'manual_name_required', message: 'Потрібна назва.' }],
    })),
  } });
  expect(screen.getByRole('alert').textContent).toContain('3 товари потребують виправлення');
  expect(screen.getByText('Готово: 84 із 87')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Заповнити назву' })).toHaveLength(3);
  const create = screen.getByRole('button', { name: 'Створити файли' });
  expect(create.disabled).toBe(true);
  fireEvent.click(create);
  expect(baseProps.onCreateSnapshot).not.toHaveBeenCalled();
  expect(screen.queryByText('Усі дані заповнені та пройшли перевірку.')).toBeNull();
});

it('keeps represented group downloads compact and available after completion', () => {
  const groups = { BR: 'Браслети', NM: 'Намиста', KL: 'Кулони', CH: 'Чотки', AR: 'Картини', SV: 'Сувеніри' };
  const snapshot = { id: 'uuid', status: 'generated', artifacts: Object.keys(groups).map((groupCode) => ({
    groupCode, fileName: `amber-magento-${groupCode}-magento-products-v1.csv`,
  })) };
  const { rerender } = openExport({ exportSnapshot: snapshot });
  for (const [code, label] of Object.entries(groups)) {
    const download = screen.getByRole('button', { name: `Завантажити CSV: ${label}` });
    expect(download.textContent.trim()).toBe('Завантажити CSV');
    fireEvent.click(download);
    expect(baseProps.onDownloadMagentoArtifact).toHaveBeenLastCalledWith(code);
  }
  expect(baseProps.onConfirmSnapshot).not.toHaveBeenCalled();
  expect(screen.getByText('Після завершення ці товари будуть прибрані з черги нових. Це не означає, що Magento вже імпортувала файли.')).toBeTruthy();
  rerender(<ExportTools {...baseProps} exportSnapshot={snapshot} isExportLoading />);
  expect(screen.getByRole('button', { name: 'Завершити експорт' }).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Завантажити CSV: Браслети' }).disabled).toBe(true);
  rerender(<ExportTools {...baseProps} exportSnapshot={{ ...snapshot, status: 'confirmed' }} />);
  expect(screen.getByText('Експорт завершено')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Завершити експорт' })).toBeNull();
  expect(screen.getAllByRole('button', { name: /Завантажити CSV:/ })).toHaveLength(6);
});

it('blocks empty previews and preserves permission gating', () => {
  const { rerender } = openExport({ exportPreview: { mode: 'new', representedCount: 0, readyCount: 0, errors: [] } });
  expect(screen.getByText('Немає товарів для експорту')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Створити файли' }).disabled).toBe(true);
  rerender(<ExportTools {...baseProps} canCreateExport={false} canArchive={false} />);
  expect(screen.queryByRole('heading', { name: 'Експорт товарів у Magento' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Підготувати експорт' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Архівування' })).toBeNull();
});
