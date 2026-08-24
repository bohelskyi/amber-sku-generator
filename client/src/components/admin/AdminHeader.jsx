import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

export function AdminHeader() {
  return (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between fade-up">
      <div>
        <p className="eyebrow">Admin Workspace</p>
        <h1 className="page-title">Адмін-панель</h1>
        <p className="mt-2 text-sm sm:text-base text-slate-600 max-w-2xl">
          Керуйте структурою категорій, питаннями та прайсами в одному місці.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link to="/admin/repricing" className="btn btn-outline gap-2">
          <RefreshCw size={16} />
          Переоцінка
        </Link>
        <Link to="/" className="btn btn-primary">Назад до калькулятора</Link>
      </div>
    </header>
  );
}
