import { ClipboardList, History } from 'lucide-react';
import { Link } from 'react-router-dom';

export function PageHeader({ config, selectedCat, historyCount }) {
  return (
    <header className="console-header fade-up">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Amber SKU Manager</h1>
          <span className="chip normal-case tracking-normal">
            {selectedCat ? config.categories[selectedCat]?.name : 'Операційна консоль'}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {Object.keys(config.categories).length} категорій · {historyCount} останніх записів
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link to="/admin/corrections?from=client" className="btn btn-outline h-9 min-h-9 gap-2 px-3">
          <ClipboardList size={15} />
          Запити
        </Link>
        <Link to="/admin/corrections/history?from=client" className="btn btn-outline h-9 min-h-9 gap-2 px-3">
          <History size={15} />
          Журнал
        </Link>
      </div>
    </header>
  );
}

export function Toast({ message }) {
  if (!message) return null;
  return <div className="toast">{message}</div>;
}
