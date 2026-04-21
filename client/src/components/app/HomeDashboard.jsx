import { formatDateTime, formatDecodedSuffix } from '../../lib/formatters';

export function HomeDashboard({
  config,
  exportStatus,
  skuToDecode,
  decodeData,
  decodeError,
  onStart,
  onDecode,
  onDecodeInputChange,
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
      <section className="card p-6 sm:p-8 fade-up stagger-1">
        <div className="section-title mb-6">
          <div>
            <h2 className="section-title-text">Категорії виробів</h2>
            <p className="section-subtitle">Оберіть групу для старту розрахунку артикула.</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Object.values(config.categories).map((category) => (
            <button
              key={category.code}
              onClick={() => onStart(category.code)}
              className="category-card"
            >
              <div className="text-xs uppercase tracking-[0.28em] text-slate-500">{category.code}</div>
              <div className="mt-2 text-lg font-semibold text-slate-900">{category.name}</div>
              <div className="mt-3 text-xs text-slate-500">
                {category.requires_weight === 1 ? 'Потрібна вага' : 'Вага не потрібна'}
              </div>
            </button>
          ))}
        </div>
      </section>

      <div className="space-y-6 fade-up stagger-2">
        <div className="card p-6 sm:p-8">
          <p className="eyebrow">Експорт</p>
          <h3 className="section-title-text">
            {exportStatus
              ? `З останнього експорту додано ${exportStatus.countSinceLastExport} артикулів`
              : 'Завантаження статусу експорту...'}
          </h3>
          <p className="section-subtitle mt-2">
            {exportStatus
              ? (exportStatus.hasExport
                ? `Останній експорт: ${formatDateTime(exportStatus.lastExport?.createdAt)}`
                : 'Експортів ще не було')
              : 'Підтягуємо дані...'}
          </p>
          {exportStatus && (
            <div className="mt-4">
              <span className="chip">Всього в базі: {exportStatus.totalProducts}</span>
            </div>
          )}
        </div>

        <div className="card p-6 sm:p-8">
          <p className="eyebrow">Decoder</p>
          <h3 className="section-title-text">Розшифрувати артикул</h3>
          <p className="section-subtitle mt-2">
            Введіть готовий SKU, щоб побачити категорію та вибрані характеристики.
          </p>
          <div className="mt-5 flex flex-col gap-3">
            <input
              type="text"
              value={skuToDecode}
              onChange={(event) => onDecodeInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onDecode();
              }}
              placeholder="Наприклад, BN123456001"
              className="input"
            />
            <button onClick={() => onDecode()} className="btn btn-primary">
              Розшифрувати
            </button>
          </div>

          {decodeError && (
            <div className="danger-panel p-4 mt-4 text-sm">
              {decodeError}
            </div>
          )}

          {decodeData && (
            <div className="info-panel mt-4 p-4 space-y-4">
              <div className="flex flex-wrap gap-2">
                <span className="chip">{decodeData.category.code}</span>
                <span className="chip">{decodeData.category.name}</span>
                <span className="chip">
                  {decodeData.existsInDb ? 'Є в базі' : 'Не знайдено в базі'}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 text-sm text-slate-700">
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Базовий SKU</div>
                  <div className="mt-1 font-mono font-semibold text-slate-900">{decodeData.baseSku}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-500">
                    {decodeData.variation ? 'Варіація' : decodeData.suffix.type === 'weight' ? 'Вага' : decodeData.suffix.type === 'sequence' ? 'Порядковий номер' : 'Суфікс'}
                  </div>
                  <div className="mt-1 font-semibold text-slate-900">
                    {decodeData.variation ? decodeData.variation.suffix : formatDecodedSuffix(decodeData.suffix)}
                  </div>
                </div>
              </div>
              {decodeData.variation && (
                <div className="text-sm text-slate-600">
                  Основний артикул: <span className="font-mono font-semibold text-slate-900">{decodeData.baseSku}{decodeData.suffix.raw || ''}</span>
                </div>
              )}
              <div className="rounded-2xl border border-slate-200 bg-white/80">
                {decodeData.decodedAnswers.map((item) => (
                  <div key={item.key} className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-200 last:border-b-0">
                    <div className="text-sm font-medium text-slate-700">{item.label}</div>
                    <div className="text-sm text-right text-slate-900">
                      {item.value_label}
                      {item.value_id !== null && (
                        <span className="block text-xs font-mono text-slate-500">{item.value_id}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
