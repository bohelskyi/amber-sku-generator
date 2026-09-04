import {
  Boxes,
  CircleDollarSign,
  ClipboardList,
  History,
  SlidersHorizontal,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';

const navigation = [
  { to: '/', label: 'Товари', icon: <Boxes size={16} aria-hidden="true" />, end: true },
  { to: '/admin', label: 'Каталог і ціни', icon: <SlidersHorizontal size={16} aria-hidden="true" />, end: true },
  { to: '/admin/repricing', label: 'Переоцінка', icon: <CircleDollarSign size={16} aria-hidden="true" /> },
  { to: '/admin/corrections', label: 'Виправлення', icon: <ClipboardList size={16} aria-hidden="true" />, end: true },
  { to: '/admin/corrections/history', label: 'Журнал', icon: <History size={16} aria-hidden="true" /> },
];

export function WorkspaceNav() {
  return (
    <nav className="workspace-nav" aria-label="Основна навігація">
      <div className="workspace-nav-inner">
        <NavLink to="/" className="workspace-brand" aria-label="Amber SKU Manager">
          <span className="workspace-brand-mark" aria-hidden="true">A</span>
          <span className="workspace-brand-copy">
            <strong>Amber</strong>
            <span>SKU Manager</span>
          </span>
        </NavLink>

        <div className="workspace-nav-links">
          {navigation.map(({ to, label, icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={label}
              className={({ isActive }) => `workspace-nav-link${isActive ? ' is-active' : ''}`}
            >
              {icon}
              <span>{label}</span>
            </NavLink>
          ))}
        </div>
      </div>
    </nav>
  );
}
