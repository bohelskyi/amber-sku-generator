import { LocalNavigation, PageHeader, StatusBadge } from '../ui/index.js';
import './workspace.css';

export function WorkspaceLocalNav({ label, items }) {
  return <LocalNavigation label={label} items={items} />;
}

export function WorkspaceHeader({ title, description, actions, status }) {
  return <div className="local-workspace-header">
    <PageHeader title={title} description={description} actions={actions} />
    {status && <StatusBadge>{status}</StatusBadge>}
  </div>;
}

export function WorkspaceToolbar({ label, children }) {
  return <div className="local-workspace-toolbar" role="group" aria-label={label}>{children}</div>;
}
