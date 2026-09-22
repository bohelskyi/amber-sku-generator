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
  expect(screen.getByText(/Представлено:/).textContent).toContain('Готові до Magento: 1');
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити 1 новий товар' }));
  expect(onPreviewExport).toHaveBeenCalledWith('new');
  expect(screen.queryByRole('button', { name: /старий|legacy/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Завантажити bracelets.csv' }));
  expect(onDownloadMagentoArtifact).toHaveBeenCalledWith('BR');
  expect(onConfirmSnapshot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Прийняти знімок як використаний' }));
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
  fireEvent.click(screen.getByText('Повторний експорт або власний діапазон'));
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
