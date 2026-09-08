import { ClipboardList, History } from 'lucide-react';
import { Link } from 'react-router-dom';

export function PageHeader() {
  return (
    <header className="console-header fade-up">
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">Amber SKU Manager</h1>
      <div className="flex flex-wrap gap-2">
        <Link to="/admin/corrections?from=client" className="btn btn-outline btn-compact-md gap-2">
          <ClipboardList size={15} />
          Запити
        </Link>
        <Link to="/admin/corrections/history?from=client" className="btn btn-outline btn-compact-md gap-2">
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
