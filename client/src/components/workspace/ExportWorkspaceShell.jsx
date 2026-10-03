import { WorkspaceHeader, WorkspaceLocalNav } from './WorkspacePrimitives';
import { useLocation } from 'react-router-dom';

const destinations = [
  { to: '/exports', label: 'Огляд' },
  { to: '/exports/sessions', label: 'Робочі експорти', activePaths: ['/exports/sessions', '/exports/shared', '/exports/invitations', '/exports/new/template'] },
  { to: '/exports/prices', label: 'Експорт цін (сумісність)' },
  { to: '/exports/history', label: 'Історія файлів' },
];

export function ExportWorkspaceShell({ children }) {
  const { pathname } = useLocation();
  const sessions = ['/exports/sessions', '/exports/shared', '/exports/invitations', '/exports/new/template'].some((path) => pathname.startsWith(path));
  return <main className="app-page"><div className="local-workspace">
    <WorkspaceHeader title="Історичний експорт" description="Файли, сесії та сумісні процедури попереднього експорту товарів і цін." />
    <WorkspaceLocalNav label="Розділи експорту" items={destinations} />
    {sessions && <WorkspaceLocalNav label="Робочі експорти" items={[
      { to: '/exports/sessions', label: 'Мої експорти', end: false },
      { to: '/exports/shared', label: 'Спільні зі мною' },
      { to: '/exports/invitations', label: 'Запрошення' },
    ]} />}
    <div className="local-workspace-content">{children}</div>
  </div></main>;
}
