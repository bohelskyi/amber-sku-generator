import { Link } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { allowedWorkspaceNavigation } from '../lib/workspace-navigation.js';
import { AppPageHeader } from '../components/app/UiPrimitives.jsx';

export default function SettingsPage() {
  const { permissions } = useAuth();
  const destinations = new Set(['/admin', '/admin/users', '/admin/roles', '/admin/audit', '/admin/corrections/history']);
  return <main className="app-page"><div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
    <AppPageHeader title="Налаштування" description="Каталог, ціни та адміністрування доступу." />
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{allowedWorkspaceNavigation(permissions)
      .filter((item) => destinations.has(item.to)).map((item) => <Link key={item.to} to={item.to} className="card p-5 font-semibold hover:bg-amber-50">{item.label}</Link>)}</div>
  </div></main>;
}
