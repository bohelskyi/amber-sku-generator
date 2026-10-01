import { Link, NavLink, matchPath, useLocation } from 'react-router-dom';
import { AppPageHeader, StatusBadge } from '../app/UiPrimitives';
import './workspace.css';

export function WorkspaceLocalNav({ label, items }) {
  const { pathname } = useLocation();
  return <nav className="local-workspace-nav" aria-label={label}>
    {items.map(({ to, label: title, end = true, activePaths }) => {
      if (!activePaths) return <NavLink key={to} to={to} end={end}>{title}</NavLink>;
      const active = activePaths.some((path) => matchPath({ path, end: false }, pathname));
      return <Link key={to} to={to} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>{title}</Link>;
    })}
  </nav>;
}

export function WorkspaceHeader({ title, description, actions, status }) {
  return <div className="local-workspace-header">
    <AppPageHeader title={title} description={description} actions={actions} />
    {status && <StatusBadge>{status}</StatusBadge>}
  </div>;
}

export function WorkspaceToolbar({ label, children }) {
  return <div className="local-workspace-toolbar" role="group" aria-label={label}>{children}</div>;
}
