import { Boxes, CircleDollarSign, CircleAlert, LogOut, SlidersHorizontal, ClipboardList } from 'lucide-react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { dailyWorkspaceNavigation } from '../../lib/workspace-navigation.js';
import { useAuth } from '../../auth/auth-context.js';
import { getIdentityDisplayName } from '../../auth/auth-model.js';
import { useMagentoSummary } from '../../hooks/useMagentoSummary.js';
import amberLogo from '../../assets/amber-logo-white-orange.png';

const icons = { '/': Boxes, '/admin/repricing': CircleDollarSign, '/sync-problems': CircleAlert,
  '/settings': SlidersHorizontal, '/admin/corrections': ClipboardList };
export function WorkspaceNav() {
  const auth = useAuth();
  const { pathname } = useLocation();
  const { summary } = useMagentoSummary();
  return <nav className="workspace-nav daily-navigation" aria-label="Основна навігація">
    <div className="workspace-nav-inner">
      <NavLink to={dailyWorkspaceNavigation(auth.permissions)[0]?.to || '/'} className="workspace-brand" aria-label="Amber SKU Manager">
        <img src={amberLogo} alt="" className="workspace-brand-logo" />
      </NavLink>
      <div className="workspace-nav-links daily-links">
        {dailyWorkspaceNavigation(auth.permissions).map(({ to, label, end }) => {
          const Icon = icons[to];
          const active = pathname === to || (!end && pathname.startsWith(`${to}/`)) || (to === '/settings'
            && ['/admin', '/admin/users', '/admin/roles', '/admin/audit', '/admin/corrections/history'].includes(pathname));
          return <Link key={to} to={to} title={label} aria-label={label} aria-current={active ? 'page' : undefined}
            aria-describedby={to === '/sync-problems' && summary?.problemCount > 0 ? 'sync-problem-count' : undefined}
            className={`workspace-nav-link${active ? ' is-active' : ''}`}>
            <Icon size={16} aria-hidden="true" /><span className={to === '/sync-problems' ? 'navigation-label-long' : undefined}>{label}</span>
            {to === '/sync-problems' && <span className="navigation-label-short" aria-hidden="true">Проблеми</span>}
            {to === '/sync-problems' && summary?.problemCount > 0 && <span id="sync-problem-count" className="navigation-count" aria-label={`${summary.problemCount} проблем`}>{summary.problemCount}</span>}
          </Link>;
        })}
      </div>
      <div className="workspace-user">
        <span className="workspace-user-name" title={getIdentityDisplayName(auth.identity)}>{getIdentityDisplayName(auth.identity)}</span>
        <button type="button" className="workspace-logout" aria-label="Вийти" onClick={() => { void auth.logout(); }}>
          <LogOut size={15} aria-hidden="true" /><span>Вийти</span>
        </button>
      </div>
    </div>
  </nav>;
}
