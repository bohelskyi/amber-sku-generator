import { Link } from 'react-router-dom';

export function AdminHeader() {
  return (
    <header className="console-header fade-up">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Каталог і ціни</h1>
        <p className="mt-1 text-xs text-slate-500">Структура SKU, варіанти, матриці та модифікатори.</p>
      </div>
      <Link to="/" className="btn btn-outline btn-compact-md">До робочої області</Link>
    </header>
  );
}
