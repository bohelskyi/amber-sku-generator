import { useEffect, useState } from 'react';
import { exportsApi } from '../../api/exports-api';
import { getApiError } from '../../lib/http-error';
import { getNewProductCopy } from '../../lib/product-export-copy';

const MAGENTO_GROUP_LABELS = {
  BR: 'Браслети', NM: 'Намиста', KL: 'Кулони',
  CH: 'Чотки', AR: 'Картини', SV: 'Сувеніри',
};

function productSummary(count, singular, plural) {
  const form = new Intl.PluralRules('uk').select(count);
  const noun = form === 'one' ? 'товар' : form === 'few' ? 'товари' : 'товарів';
  return `${count} ${noun} ${form === 'one' ? singular : plural}`;
}

function ManualMagentoNameEditor({ product, onClose, onSaved,
  translationSuggestionAvailable }) {
  const [subjectUa, setSubjectUa] = useState('');
  const [subjectEn, setSubjectEn] = useState('');
  const [enEdited, setEnEdited] = useState(false);
  const [suggestionError, setSuggestionError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestionAttempt, setSuggestionAttempt] = useState(0);

  useEffect(() => {
    const ua = subjectUa.trim();
    if (!translationSuggestionAvailable || !ua || enEdited) return undefined;
    let current = true;
    const timeout = setTimeout(async () => {
      setIsSuggesting(true);
      setSuggestionError('');
      try {
        const response = await exportsApi.suggestMagentoName({
          productId: product.productId, subjectUa: ua,
        });
        if (current) setSubjectEn(response.data.subjectEn);
      } catch (error) {
        if (current) setSuggestionError(getApiError(error));
      } finally {
        if (current) setIsSuggesting(false);
      }
    }, 500);
    return () => { current = false; clearTimeout(timeout); };
  }, [subjectUa, enEdited, product.productId, suggestionAttempt,
    translationSuggestionAvailable]);

  const save = async () => {
    setSaveError('');
    setIsSaving(true);
    try {
      const payload = { productId: product.productId,
        subjectUa: subjectUa.trim(), subjectEn: subjectEn.trim() };
      const preview = await exportsApi.previewMagentoName(payload);
      await exportsApi.applyMagentoName({ ...payload,
        previewToken: preview.data.previewToken });
      onSaved();
    } catch (error) {
      setSaveError(getApiError(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="font-semibold">Назва для {product.sku}</p>
      <p className="text-xs text-slate-600">Збереження назви не змінить SKU, ціну чи характеристики товару.</p>
      <label className="mt-3 block text-sm font-medium" htmlFor="magento-subject-ua">Українська назва</label>
      <input id="magento-subject-ua" className="input mt-1" value={subjectUa}
        onChange={(event) => {
          setSubjectUa(event.target.value);
          setSuggestionError('');
          setIsSuggesting(false);
        }}
        maxLength={200} />
      <label className="mt-3 block text-sm font-medium" htmlFor="magento-subject-en">English name</label>
      <input id="magento-subject-en" className="input mt-1" value={subjectEn}
        onChange={(event) => {
          setSubjectEn(event.target.value);
          setEnEdited(true);
          setIsSuggesting(false);
        }}
        maxLength={200} />
      {translationSuggestionAvailable && subjectUa.trim() && (
        <button className="mt-2 text-sm underline" onClick={() => {
          setEnEdited(false);
          setSuggestionAttempt((current) => current + 1);
        }}>Запропонувати переклад</button>
      )}
      {translationSuggestionAvailable && isSuggesting
        && <p className="text-xs text-slate-600">Пропонуємо переклад…</p>}
      {translationSuggestionAvailable && suggestionError && (
        <div className="text-sm text-amber-900" role="alert">
        {suggestionError} Англійську назву можна ввести вручну.
        <button className="ml-2 underline" onClick={() => {
          setEnEdited(false);
          setSuggestionAttempt((current) => current + 1);
        }}>Спробувати переклад ще раз</button>
        </div>
      )}
      <p className="mt-3 text-sm">UA: {subjectUa.trim()
        ? `${subjectUa.trim()} з бурштину. Арт: ${product.sku}` : '—'}</p>
      <p className="text-sm">EN: {subjectEn.trim()
        ? `Amber ${subjectEn.trim()}. Art: ${product.sku}` : '—'}</p>
      {saveError && <p className="mt-2 text-sm text-red-700" role="alert">{saveError}</p>}
      <div className="mt-3 flex gap-2">
        <button className="btn btn-primary px-4" onClick={save}
          disabled={isSaving || !subjectUa.trim() || !subjectEn.trim()}>
          {isSaving ? 'Зберігаємо…' : 'Зберегти назви'}
        </button>
        <button className="btn px-4" onClick={onClose}>Скасувати</button>
      </div>
    </div>
  );
}

export function ExportTools({
  exportFromSku,
  setExportFromSku,
  exportToSku,
  setExportToSku,
  exportError,
  exportStatus,
  exportPreview,
  exportSnapshot,
  setExportError,
  isExportLoading,
  isPriceExportLoading,
  priceExportError,
  priceExportStatus,
  skuToDelete,
  setSkuToDelete,
  onPreviewExport,
  onCreateSnapshot,
  onDownloadMagentoArtifact,
  onConfirmSnapshot,
  onPriceExportCsv,
  onDelete,
  canArchive = true,
  canCreateExport = true,
}) {
  const [manualNameProduct, setManualNameProduct] = useState(null);
  const newProductCount = Number(exportStatus?.countSinceLastExport || 0);
  const newProductCopy = getNewProductCopy(newProductCount);
  const hasReadinessErrors = exportPreview?.errors?.length > 0;
  return (
    <section className="fade-up stagger-2">
      <details className="collapsible">
        <summary className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="eyebrow">Додаткові дії</p>
            <h3 className="collapse-title">Експорт та коригування</h3>
            <p className="section-subtitle">Експорт нових товарів, повторний експорт і архівування артикулів.</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="collapse-toggle collapse-toggle-closed">Показати</span>
            <span className="collapse-toggle collapse-toggle-open">Сховати</span>
          </div>
        </summary>

        <div className="mt-4 space-y-6">
          {canCreateExport && <div className="min-w-0 border-t border-slate-200 pt-5">
            <div className="section-title mb-3">
              <div>
                <h4 className="section-title-text text-lg">Експорт товарів у Magento</h4>
                <p className="section-subtitle">Підготуйте товари, завантажте файли та завершіть експорт.</p>
              </div>
            </div>
            <p className={`mt-5 ${exportPreview || exportSnapshot ? 'text-sm text-slate-500' : 'text-xl font-semibold text-slate-800'}`}>
              {exportStatus
                ? (newProductCount > 0
                  ? newProductCopy.pendingLabel
                  : 'Нових товарів для експорту немає')
                : 'Завантаження статусу експорту…'}
            </p>
            {newProductCount > 0 && (
              <button
                onClick={() => onPreviewExport('new')}
                className={`btn mt-3 px-6 ${(exportPreview && !exportSnapshot) || (exportSnapshot && exportSnapshot.status !== 'confirmed') ? 'btn-outline' : 'btn-primary'}`}
                disabled={isExportLoading}
              >
                {isExportLoading ? 'Перевіряємо…'
                  : exportPreview && !exportSnapshot ? 'Перевірити ще раз' : 'Підготувати експорт'}
              </button>
            )}
            {exportError && (
              <div className="danger-panel p-3 mt-3 text-sm" role="alert">
                {exportError}
              </div>
            )}
            {exportPreview && !exportSnapshot && (
              <div className="mt-3 space-y-3 text-sm">
                {exportPreview.mode !== 'new' && (
                  <p className="text-xs text-slate-500">Повторний / вибірковий експорт</p>
                )}
                {!hasReadinessErrors && (
                  <div className="py-3" role="status">
                    <h5 className="text-xl font-semibold text-slate-800">
                      {exportPreview.representedCount
                        ? productSummary(exportPreview.readyCount, 'готовий до експорту', 'готові до експорту')
                        : 'Немає товарів для експорту'}
                    </h5>
                    {exportPreview.representedCount > 0 && (
                      <p className="mt-1 text-slate-600">Усі дані заповнені та пройшли перевірку.</p>
                    )}
                  </div>
                )}
                {hasReadinessErrors && (
                  <div className="border-l-4 border-amber-500 bg-amber-50 p-4" role="alert">
                    <h5 className="text-xl font-semibold text-slate-800">
                      {productSummary(exportPreview.errors.length, 'потребує виправлення', 'потребують виправлення')}
                    </h5>
                    <p className="mt-1 text-slate-700">Готово: {exportPreview.readyCount} із {exportPreview.representedCount}</p>
                    <ul className="mt-2 list-disc pl-5">
                      {exportPreview.errors.map((item) => (
                        <li key={`${item.productId}-${item.sku}`}>
                          <strong>{item.sku}</strong>: {item.fields.map((field) => (
                            `${field.field} — ${field.message}`
                          )).join('; ')}
                          {item.fields.some((field) => field.code === 'manual_name_required') && (
                            <button className="ml-2 underline" onClick={() => setManualNameProduct({
                              productId: item.productId, sku: item.sku,
                            })}>Заповнити назву</button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {manualNameProduct && (
                  <ManualMagentoNameEditor key={manualNameProduct.productId}
                    product={manualNameProduct}
                    translationSuggestionAvailable={
                      exportStatus?.translationSuggestionAvailable === true
                    }
                    onClose={() => setManualNameProduct(null)}
                    onSaved={() => {
                      setManualNameProduct(null);
                      onPreviewExport(exportPreview.mode);
                    }} />
                )}
                <button
                  onClick={onCreateSnapshot}
                  className="btn btn-primary px-6"
                  disabled={isExportLoading || exportPreview.errors?.length > 0
                    || !exportPreview.representedCount || Boolean(exportSnapshot)}
                >
                  Створити файли
                </button>
              </div>
            )}
            {exportSnapshot && (
              <div className="mt-5 space-y-4 text-sm">
                <div role="status">
                  <h5 className="text-xl font-semibold text-slate-800">
                    {exportSnapshot.status === 'confirmed' ? 'Експорт завершено' : 'Файли Magento готові'}
                  </h5>
                  <p className="mt-1 text-slate-600">Завантажте CSV для кожної групи товарів та імпортуйте файли в Magento.</p>
                </div>
                <ul className="divide-y divide-slate-200">
                  {(exportSnapshot.artifacts || []).map((item) => (
                    <li key={item.groupCode} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <span className="font-semibold text-slate-800">{MAGENTO_GROUP_LABELS[item.groupCode] || item.groupCode}</span>
                      <button
                        className="btn btn-outline px-4"
                        aria-label={`Завантажити CSV: ${MAGENTO_GROUP_LABELS[item.groupCode] || item.groupCode}`}
                        disabled={isExportLoading}
                        onClick={() => onDownloadMagentoArtifact(item.groupCode)}
                      >
                        Завантажити CSV
                      </button>
                    </li>
                  ))}
                </ul>
                {exportSnapshot.status !== 'confirmed' && (
                  <div className="pt-2">
                    <button
                      className="btn btn-primary px-6"
                      disabled={isExportLoading}
                      onClick={onConfirmSnapshot}
                    >
                      Завершити експорт
                    </button>
                    <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-500">Після завершення ці товари будуть прибрані з черги нових. Це не означає, що Magento вже імпортувала файли.</p>
                  </div>
                )}
                {exportSnapshot.status === 'confirmed' && (
                  <p className="text-xs text-slate-500">Завершення експорту не означає, що Magento вже імпортувала файли.</p>
                )}
                <details className="text-xs text-slate-500">
                  <summary className="cursor-pointer font-medium">Технічні дані</summary>
                  <p className="mt-2 break-all">ID експорту: {exportSnapshot.id}</p>
                  <ul className="mt-1 space-y-1 break-all">
                    {(exportSnapshot.artifacts || []).map((item) => (
                      <li key={item.groupCode}>{item.fileName}</li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
            <details className="mt-6 border-t border-slate-200 pt-4">
              <summary className="cursor-pointer text-sm font-semibold text-slate-700">
                Повторний / вибірковий експорт
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <input
                  type="text"
                  value={exportFromSku}
                  onChange={(event) => {
                    setExportFromSku(event.target.value.toUpperCase());
                    setExportError('');
                  }}
                  placeholder="Один SKU або початок діапазону"
                  aria-label="Початковий SKU для повторного експорту"
                  className="input"
                />
                <input
                  type="text"
                  value={exportToSku}
                  onChange={(event) => {
                    setExportToSku(event.target.value.toUpperCase());
                    setExportError('');
                  }}
                  placeholder="Кінцевий SKU, необов’язково"
                  aria-label="Кінцевий SKU для повторного експорту, необов’язково"
                  className="input"
                />
                <button
                  onClick={() => onPreviewExport('manual')}
                  className="btn btn-outline px-6"
                  disabled={isExportLoading}
                >
                  Перевірити діапазон
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Порожній кінцевий SKU означає повторний експорт одного товару.
                Для діапазону вкажіть обидва SKU; порядок визначають збережені товари.
              </p>
            </details>
          </div>}

          {canCreateExport && <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 sm:flex sm:flex-wrap sm:items-center sm:justify-between sm:gap-4">
            <div className="section-title mb-3">
              <div>
                <h4 className="section-title-text text-lg">Експорт змін цін</h4>
                <p className="section-subtitle">
                  Окремий файл із оновленими цінами. Очікує: {priceExportStatus?.pendingCount ?? '…'}.
                  {Number(priceExportStatus?.excludedPendingCount) > 0
                    ? ` Виключено: ${priceExportStatus.excludedPendingCount}.` : ''}
                </p>
              </div>
            </div>
            <button
              onClick={onPriceExportCsv}
              className="btn btn-outline px-6"
              disabled={isPriceExportLoading || Number(priceExportStatus?.pendingCount || 0) === 0}
            >
              {isPriceExportLoading ? 'Експортуємо ціни…' : 'Експортувати зміни цін'}
            </button>
            {priceExportError && <div className="danger-panel p-3 mt-3 text-sm">{priceExportError}</div>}
          </div>}

          {canArchive && <div className="border-t border-slate-200 pt-5">
            <div className="section-title mb-3">
              <div>
                <h4 className="section-title-text text-lg">Архівування</h4>
                <p className="section-subtitle">Архівний артикул зберігається в базі, але не потрапляє в історію та експорт.</p>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={skuToDelete}
                onChange={(event) => setSkuToDelete(event.target.value)}
                placeholder="Введіть повний артикул..."
                aria-label="SKU товару для архівування"
                className="input"
              />
              <button onClick={() => onDelete(skuToDelete)} className="btn btn-danger px-6">Архівувати</button>
            </div>
          </div>}
        </div>
      </details>
    </section>
  );
}
