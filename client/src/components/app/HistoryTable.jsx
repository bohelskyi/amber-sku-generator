import { formatDecimal, formatUah, formatUsd } from '../../lib/formatters';

export function HistoryTable({ history, config, selectedCat, onCopyText, onDecode, onDelete }) {
  return (
    <section className="fade-up">
      <details className="collapsible">
        <summary className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="collapse-title">Останні збережені</h3>
            <p className="section-subtitle">Швидкий доступ до останніх 15 записів.</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="collapse-toggle collapse-toggle-closed">Показати</span>
            <span className="collapse-toggle collapse-toggle-open">Сховати</span>
          </div>
        </summary>

        <div className="table-wrap mt-4">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="table-cell text-left">Артикул</th>
                  <th className="table-cell text-left">Категорія</th>
                  <th className="table-cell text-left">Вага</th>
                  <th className="table-cell text-left">Ціна</th>
                  <th className="table-cell text-left">Дія</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {history.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="table-cell whitespace-nowrap text-sm font-mono font-semibold text-slate-800">{item.full_sku}</td>
                    <td className="table-cell whitespace-nowrap text-sm text-slate-500">{config.categories[item.category]?.name}</td>
                    <td className="table-cell whitespace-nowrap text-sm text-slate-500">{item.weight > 0 ? `${formatDecimal(item.weight)}г` : '-'}</td>
                    <td className="table-cell whitespace-nowrap text-sm text-slate-500">
                      {item.total_price_uah ? formatUah(item.total_price_uah) : item.total_price ? formatUsd(item.total_price) : '-'}
                    </td>
                    <td className="table-cell whitespace-nowrap text-sm">
                      {!selectedCat && (
                        <div className="flex flex-wrap gap-2">
                          <button onClick={() => onCopyText(item.full_sku, 'SKU')} className="btn btn-outline text-xs px-2 py-1">Копіювати SKU</button>
                          <button onClick={() => onDecode(item.full_sku)} className="btn btn-outline text-xs px-2 py-1">Розшифрувати</button>
                          <button
                            onClick={() => item.total_price_uah
                              ? onCopyText(formatUah(item.total_price_uah), 'Ціну')
                              : item.total_price && onCopyText(formatUsd(item.total_price), 'Ціну')}
                            className="btn btn-outline text-xs px-2 py-1"
                          >
                            Копіювати ціну
                          </button>
                          <button onClick={() => onDelete(item.full_sku)} className="btn btn-danger text-xs px-2 py-1">Архівувати</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </section>
  );
}
