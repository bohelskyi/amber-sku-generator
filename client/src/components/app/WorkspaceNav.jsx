import {
  Boxes,
  CircleDollarSign,
  ClipboardList,
  History,
  LogOut,
  SlidersHorizontal,
  Shield,
  ScrollText,
  Users,
} from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useRef, useState } from 'react';
import { useAuth } from '../../auth/auth-context.js';
import { getIdentityDisplayName } from '../../auth/auth-model.js';
import amberLogo from '../../assets/amber-logo-white-orange.png';

const navigation = [
  { to: '/exports', label: 'Експорт', icon: <Boxes size={16} aria-hidden="true" />, permissions: ['exports.view'] },
  { to: '/admin/export-templates', label: 'Шаблони експорту', icon: <ScrollText size={16} aria-hidden="true" />, permissions: ['export_templates.view'] },
  { to: '/', label: 'Товари', icon: <Boxes size={16} aria-hidden="true" />, end: true, permissions: ['products.view'] },
  { to: '/admin', label: 'Каталог і ціни', icon: <SlidersHorizontal size={16} aria-hidden="true" />, end: true, permissions: ['catalog.view', 'pricing.view'] },
  { to: '/admin/repricing', label: 'Переоцінка', icon: <CircleDollarSign size={16} aria-hidden="true" />, permissions: ['repricing.view'] },
  { to: '/admin/corrections', label: 'Виправлення', icon: <ClipboardList size={16} aria-hidden="true" />, end: true, permissions: ['corrections.view'] },
  { to: '/admin/corrections/history', label: 'Журнал', icon: <History size={16} aria-hidden="true" />, permissions: ['history.view'] },
  { to: '/admin/users', label: 'Користувачі', icon: <Users size={16} aria-hidden="true" />, permissions: ['users.manage'] },
  { to: '/admin/roles', label: 'Ролі', icon: <Shield size={16} aria-hidden="true" />, permissions: ['roles.manage'] },
  { to: '/admin/audit', label: 'Аудит', icon: <ScrollText size={16} aria-hidden="true" />, permissions: ['audit.view'] },
];

export function WorkspaceNav() {
  const auth = useAuth();
  const [menuOpen, setMenuOpen] = useState(false); const trigger = useRef(null);
  const allowed = navigation.filter((item) => item.permissions.some((permission) => auth.permissions.includes(permission)));
  const primary = new Set(['/exports', '/admin/export-templates', '/']);
  const itemLink = ({ to, label, icon, end }, className = '') => <NavLink key={to} to={to} end={end} title={label}
    onClick={() => setMenuOpen(false)} className={({ isActive }) => `workspace-nav-link ${className}${isActive ? ' is-active' : ''}`}>{icon}<span>{label}</span></NavLink>;

  return (
    <nav className="workspace-nav" aria-label="Основна навігація">
      <div className="workspace-nav-inner">
        <NavLink to="/" className="workspace-brand" aria-label="Amber SKU Manager">
          <img src={amberLogo} alt="" className="workspace-brand-logo" />
        </NavLink>

        <div className="workspace-nav-links">
          {allowed.filter((item) => primary.has(item.to)).map((item) => itemLink(item, 'workspace-primary-link'))}
          <div className={`workspace-more${allowed.every((item) => primary.has(item.to)) ? ' workspace-more-primary-only' : ''}`} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setMenuOpen(false); trigger.current?.focus(); } }}>
            <button ref={trigger} className="workspace-nav-link" aria-expanded={menuOpen} aria-controls="workspace-more-links" onClick={() => setMenuOpen(!menuOpen)}><span>Розділи</span> ▾</button>
            {menuOpen && <div id="workspace-more-links" className="workspace-more-links">{allowed.map((item) => itemLink(item, primary.has(item.to) ? 'workspace-menu-primary' : ''))}</div>}
          </div>
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
