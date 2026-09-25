import { WorkspaceLocalNav } from './WorkspacePrimitives';

export function TemplateWorkspaceShell({ children }) {
  return <main className="app-page et-workspace"><div className="et-page local-workspace">{children}</div></main>;
}

export function TemplateLocalNav({ familyId, versionId }) {
  const base = `/admin/export-templates/${encodeURIComponent(familyId)}`;
  const version = versionId ? `?version=${encodeURIComponent(versionId)}` : '';
  return <WorkspaceLocalNav label="Розділи шаблону" items={[
    { to: base + version, label: 'Таблиця' },
    { to: base + '/check' + version, label: 'Перевірка' },
    { to: base + '/versions' + version, label: 'Версії' },
  ]} />;
}
