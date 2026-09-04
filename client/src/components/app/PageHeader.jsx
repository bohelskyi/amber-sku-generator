import { ClipboardList, History } from 'lucide-react';
import { Link } from 'react-router-dom';

export function PageHeader({ config, selectedCat, historyCount }) {
  return (
    <header className="card-hero p-5 sm:p-6 fade-up">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
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
        <div className="flex w-full flex-col gap-3 lg:w-auto lg:items-end">
          <div className="flex w-full flex-wrap gap-2 lg:justify-end">
            <Link to="/admin/corrections?from=client" className="btn btn-outline flex-1 gap-2 sm:flex-none">
              <ClipboardList size={16} />
              Запити
            </Link>
            <Link to="/admin/corrections/history?from=client" className="btn btn-outline flex-1 gap-2 sm:flex-none">
              <History size={16} />
              Журнал
            </Link>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 lg:w-72">
            <div className="stat-tile">
              <div className="stat-label">Категорій</div>
              <div className="stat-value">{Object.keys(config.categories).length}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Записів</div>
              <div className="stat-value">{historyCount}</div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

export function Toast({ message }) {
  if (!message) return null;
  return <div className="toast">{message}</div>;
}
