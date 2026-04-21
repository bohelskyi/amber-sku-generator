export function HistoryTable({ history, config, selectedCat, onCopyText, onDecode, onDelete }) {
  return (
    <section className="card p-6 sm:p-8 fade-up">
      <div className="section-title mb-4">
        <div>
          <h3 className="section-title-text">Останні збережені</h3>
          <p className="section-subtitle">Швидкий доступ до останніх 15 записів.</p>
        </div>
      </div>
      <div className="table-wrap">
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
                  <td className="table-cell whitespace-nowrap text-sm text-slate-500">{item.weight > 0 ? `${item.weight}г` : '-'}</td>
                  <td className="table-cell whitespace-nowrap text-sm text-slate-500">
                    {item.total_price_uah ? `${item.total_price_uah} ₴` : item.total_price ? `$${item.total_price}` : '-'}
                  </td>
                  <td className="table-cell whitespace-nowrap text-sm">
                    {!selectedCat && (
                      <div className="flex flex-wrap gap-2">
                        <button onClick={() => onCopyText(item.full_sku, 'SKU')} className="btn btn-outline text-xs px-2 py-1">Копіювати SKU</button>
                        <button onClick={() => onDecode(item.full_sku)} className="btn btn-outline text-xs px-2 py-1">Розшифрувати</button>
                        <button
                          onClick={() => item.total_price_uah
                            ? onCopyText(`${item.total_price_uah} ₴`, 'Ціну')
                            : item.total_price && onCopyText(`$${item.total_price}`, 'Ціну')}
                          className="btn btn-outline text-xs px-2 py-1"
                        >
                          Копіювати ціну
                        </button>
                        <button onClick={() => onDelete(item.full_sku)} className="btn btn-danger text-xs px-2 py-1">Видалити</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
