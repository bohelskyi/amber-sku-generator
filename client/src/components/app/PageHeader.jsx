export function PageHeader({ config, selectedCat, historyCount }) {
  return (
    <header className="card-hero p-6 sm:p-8 fade-up">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="eyebrow">Amber Studio</p>
          <h1 className="page-title">Amber SKU Manager</h1>
          <p className="mt-2 text-sm sm:text-base text-slate-600 max-w-2xl">
            Створюйте артикули, перевіряйте унікальність і тримайте історію під рукою —
            усе в одному робочому просторі.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="chip">
              {selectedCat ? `Категорія: ${config.categories[selectedCat]?.name}` : 'Оберіть категорію'}
            </span>
            <span className="chip">Історія: {historyCount}</span>
          </div>
        </div>
        <div className="stat-tile max-w-xs">
          <div className="stat-label">Категорій</div>
          <div className="stat-value">{Object.keys(config.categories).length}</div>
        </div>
      </div>
    </header>
  );
}

export function Toast({ message }) {
  if (!message) return null;
  return <div className="toast">{message}</div>;
}
