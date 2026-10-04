import { WorkspaceLocalNav } from './WorkspacePrimitives';

export function TemplateWorkspaceShell({ children, embedded = false }) {
  if (embedded) return <div className="et-workspace et-page integration-template-workspace">{children}</div>;
  return <main className="app-page et-workspace"><div className="et-page local-workspace">{children}</div></main>;
}

export function TemplateLocalNav({ familyId, versionId, basePath = '/admin/export-templates', context = '', integration = false }) {
  const base = `${basePath}/${encodeURIComponent(familyId)}`;
  const params = new URLSearchParams(context); if (versionId) params.set('version', versionId); else params.delete('version');
  const version = params.size ? `?${params}` : '';
  return <WorkspaceLocalNav label="Розділи шаблону" items={[
    { to: base + version, label: integration ? 'Правила полів' : 'Таблиця' },
    { to: base + '/check' + version, label: 'Перевірка' },
    { to: base + '/versions' + version, label: 'Версії' },
  ]} />;
}
