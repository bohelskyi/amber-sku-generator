import { WorkspaceHeader, WorkspaceLocalNav } from './WorkspacePrimitives';

const destinations = [
  { to: '/exports', label: 'Новий експорт' },
  { to: '/exports/sessions', label: 'Мої експорти' },
  { to: '/exports/shared', label: 'Спільні зі мною' },
  { to: '/exports/invitations', label: 'Запрошення' },
  { to: '/exports/prices', label: 'Оновлення цін' },
];

export function ExportWorkspaceShell({ children }) {
  return <main className="app-page"><div className="local-workspace">
    <WorkspaceHeader title="Експорт" />
    <WorkspaceLocalNav label="Розділи експорту" items={destinations} />
    <div className="local-workspace-content">{children}</div>
  </div></main>;
}
