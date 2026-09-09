import {
  Boxes,
  CircleDollarSign,
  ClipboardList,
  History,
  LogOut,
  SlidersHorizontal,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../auth/auth-context.js';
import { getIdentityDisplayName } from '../../auth/auth-model.js';
import amberLogo from '../../assets/amber-logo-white-orange.png';

const navigation = [
  { to: '/', label: 'Товари', icon: <Boxes size={16} aria-hidden="true" />, end: true },
  { to: '/admin', label: 'Каталог і ціни', icon: <SlidersHorizontal size={16} aria-hidden="true" />, end: true },
  { to: '/admin/repricing', label: 'Переоцінка', icon: <CircleDollarSign size={16} aria-hidden="true" /> },
  { to: '/admin/corrections', label: 'Виправлення', icon: <ClipboardList size={16} aria-hidden="true" />, end: true },
  { to: '/admin/corrections/history', label: 'Журнал', icon: <History size={16} aria-hidden="true" /> },
];

export function WorkspaceNav() {
  const auth = useAuth();

  return (
    <nav className="workspace-nav" aria-label="Основна навігація">
      <div className="workspace-nav-inner">
        <NavLink to="/" className="workspace-brand" aria-label="Amber SKU Manager">
          <img src={amberLogo} alt="" className="workspace-brand-logo" />
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

        <div className="workspace-user">
          <span className="workspace-user-name" title={getIdentityDisplayName(auth.identity)}>
            {getIdentityDisplayName(auth.identity)}
          </span>
          <button
            type="button"
            className="workspace-logout"
            onClick={() => { void auth.logout(); }}
          >
            <LogOut size={15} aria-hidden="true" />
            <span>Вийти</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
