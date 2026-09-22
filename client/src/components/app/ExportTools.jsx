import { useEffect, useState } from 'react';
import { exportsApi } from '../../api/exports-api';
import { getApiError } from '../../lib/http-error';
import { getNewProductCopy } from '../../lib/product-export-copy';

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
          {canCreateExport && <div className="field-group">
            <div className="section-title mb-3">
              <div>
                <h4 className="section-title-text text-lg">Magento Products v1</h4>
                <p className="section-subtitle">Один незмінний знімок і файли Magento для представлених груп.</p>
              </div>
            </div>
            <p className="text-sm text-slate-700">
              {exportStatus
                ? (newProductCount > 0
                  ? newProductCopy.pendingLabel
                  : 'Нових товарів для експорту немає')
                : 'Завантаження статусу експорту…'}
            </p>
            {newProductCount > 0 && (
              <button
                onClick={() => onPreviewExport('new')}
                className="btn btn-primary mt-3 px-6"
                disabled={isExportLoading}
              >
                {isExportLoading ? 'Перевіряємо…'
                  : newProductCopy.previewLabel}
              </button>
            )}
            <details className="mt-4 rounded-lg border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-semibold text-slate-700">
                Повторний експорт або власний діапазон
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
                  className="btn btn-primary px-6"
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
            {exportError && (
              <div className="danger-panel p-3 mt-3 text-sm">
                {exportError}
              </div>
            )}
            {exportPreview && (
              <div className="mt-3 space-y-3 text-sm">
                <p className="font-semibold">{exportPreview.mode === 'new'
                  ? 'Нові товари після останнього прийнятого знімка'
                  : 'Повторний експорт або власний діапазон'}</p>
                <p>Представлено: <strong>{exportPreview.representedCount}</strong>.
                  Готові до Magento: <strong>{exportPreview.readyCount}</strong>.</p>
                {exportPreview.errors?.length > 0 && (
                  <div className="danger-panel p-3">
                    <p className="font-semibold">Потрібно виправити перед створенням знімка:</p>
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
                <p>Файли: {exportPreview.artifacts?.length
                  ? exportPreview.artifacts.map((item) => item.fileName).join(', ')
                  : 'немає представлених готових груп'}.</p>
                <button
                  onClick={onCreateSnapshot}
                  className="btn btn-primary px-6"
                  disabled={isExportLoading || exportPreview.errors?.length > 0
                    || !exportPreview.representedCount || Boolean(exportSnapshot)}
                >
                  Створити знімок
                </button>
              </div>
            )}
            {exportSnapshot && (
              <div className="mt-3 space-y-3 text-sm">
                <p>Знімок {exportSnapshot.id}: {exportSnapshot.status === 'confirmed'
                  ? 'прийнятий як використаний' : 'створений, очікує прийняття'}.</p>
                <div className="flex flex-wrap gap-2">
                  {(exportSnapshot.artifacts || []).map((item) => (
                    <button
                      key={item.groupCode}
                      className="btn btn-primary px-4"
                      disabled={isExportLoading}
                      onClick={() => onDownloadMagentoArtifact(item.groupCode)}
                    >
                      Завантажити {item.fileName}
                    </button>
                  ))}
                </div>
                {exportSnapshot.status !== 'confirmed' && (
                  <button
                    className="btn btn-primary px-6"
                    disabled={isExportLoading}
                    onClick={onConfirmSnapshot}
                  >
                    Прийняти знімок як використаний
                  </button>
                )}
                <p className="text-xs text-slate-500">Прийняття знімка не означає успішний імпорт у Magento.</p>
              </div>
            )}
          </div>}

          {canCreateExport && <div className="field-group">
            <div className="section-title mb-3">
              <div>
                <h4 className="section-title-text text-lg">Експорт змін цін</h4>
                <p className="section-subtitle">
                  Окремий CSV <span className="font-mono">sku,price</span>. Очікує: {priceExportStatus?.pendingCount ?? '…'}.
                  {Number(priceExportStatus?.excludedPendingCount) > 0
                    ? ` Виключено: ${priceExportStatus.excludedPendingCount}.` : ''}
                </p>
              </div>
            </div>
            <button
              onClick={onPriceExportCsv}
              className="btn btn-primary px-6"
              disabled={isPriceExportLoading || Number(priceExportStatus?.pendingCount || 0) === 0}
            >
              {isPriceExportLoading ? 'Експортуємо ціни…' : 'Експортувати зміни цін'}
            </button>
            {priceExportError && <div className="danger-panel p-3 mt-3 text-sm">{priceExportError}</div>}
          </div>}

          {canArchive && <div className="field-group">
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
