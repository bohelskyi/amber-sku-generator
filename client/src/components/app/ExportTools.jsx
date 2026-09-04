export function ExportTools({
  exportFromSku,
  setExportFromSku,
  exportToSku,
  setExportToSku,
  exportError,
  setExportError,
  isExportLoading,
  skuToDelete,
  setSkuToDelete,
  onExportCsv,
  onDelete,
}) {
  return (
    <section className="fade-up stagger-2">
      <details className="collapsible">
        <summary className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="eyebrow">Додаткові дії</p>
            <h3 className="collapse-title">Експорт та коригування</h3>
            <p className="section-subtitle">CSV-експорт по діапазону збережень і архівування помилкових артикулів.</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="collapse-toggle collapse-toggle-closed">Показати</span>
            <span className="collapse-toggle collapse-toggle-open">Сховати</span>
          </div>
        </summary>

        <div className="mt-4 space-y-6">
          <div className="field-group">
            <div className="section-title mb-3">
              <div>
                <h4 className="section-title-text text-lg">Експорт CSV</h4>
                <p className="section-subtitle">Перша колонка: артикул. Друга: зафіксована ціна в гривні.</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <input
                type="text"
                value={exportFromSku}
                onChange={(event) => {
                  setExportFromSku(event.target.value.toUpperCase());
                  setExportError('');
                }}
                placeholder="З якого SKU"
                className="input"
              />
              <input
                type="text"
                value={exportToSku}
                onChange={(event) => {
                  setExportToSku(event.target.value.toUpperCase());
                  setExportError('');
                }}
                placeholder="По який SKU або пусто"
                className="input"
              />
              <button onClick={onExportCsv} className="btn btn-primary px-6" disabled={isExportLoading}>
                {isExportLoading ? 'Експортуємо...' : 'Експорт CSV'}
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Якщо поле "по який SKU" порожнє, експорт піде від вказаного артикула до останнього збереженого.
            </p>
            {exportError && (
              <div className="danger-panel p-3 mt-3 text-sm">
                {exportError}
              </div>
            )}
          </div>

          <div className="field-group">
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
                className="input"
              />
              <button onClick={() => onDelete(skuToDelete)} className="btn btn-danger px-6">Архівувати</button>
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}
