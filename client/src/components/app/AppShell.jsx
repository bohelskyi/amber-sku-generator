import { LogOut, Menu, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/auth-context.js';
import { getIdentityDisplayName } from '../../auth/auth-model.js';
import { activeWorkspaceDestination } from '../../lib/workspace-navigation.js';
import { ActionMenu, Drawer, IconButton } from '../ui/index.js';
import { WorkspaceNav } from './WorkspaceNav.jsx';
import amberLogo from '../../assets/amber-logo-white-orange.png';
import './shell.css';

function AccountMenu() {
  const auth = useAuth();
  const name = auth.applicationUser?.displayName || getIdentityDisplayName(auth.identity);
  const roleNames = (auth.roles || []).map((role) => role.displayName).filter(Boolean);
  return <ActionMenu label={`Обліковий запис: ${name}`} icon={UserRound}
    triggerContent={<span className="app-account-trigger-text">{name}</span>} className="app-account-menu">
    <div className="app-account-summary">
      <strong>{name}</strong>
      {roleNames.length > 0 && <span>{roleNames.join(', ')}</span>}
    </div>
    <button type="button" onClick={() => { void auth.logout(); }}><LogOut size={16} aria-hidden="true" />Вийти</button>
  </ActionMenu>;
}

function RouteFocusManager({ pathname }) {
  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current === pathname) return undefined;
    previousPath.current = pathname;
    const routeContent = document.querySelector('.app-route-content');
    if (!routeContent) return undefined;
    let frame;
    let observer;
    const focusRoute = () => {
      const target = routeContent.querySelector('h1') || routeContent.querySelector('main');
      if (!target) return false;
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      }
      target.tabIndex = -1;
      target.classList.add('app-route-focus-target');
      target.focus({ preventScroll: true });
      return true;
    };
    frame = window.requestAnimationFrame(() => {
      if (focusRoute()) return;
      observer = new MutationObserver(() => { if (focusRoute()) observer.disconnect(); });
      observer.observe(routeContent, { childList: true, subtree: true });
    });
    return () => { window.cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [pathname]);
  return null;
}

export function AppShell({ children }) {
  const auth = useAuth();
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const active = activeWorkspaceDestination(auth.permissions, location.pathname);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setNavigationOpen(false));
    return () => window.cancelAnimationFrame(frame);
  }, [location.pathname]);
  return <div className="app-shell">
    <aside className="app-sidebar"><WorkspaceNav /></aside>
    <div className="app-shell-content">
      <header className="app-context-bar">
        <IconButton className="app-navigation-toggle" icon={Menu} label="Відкрити навігацію"
          variant="ghost" onClick={() => setNavigationOpen(true)} />
        <img className="app-context-logo" src={amberLogo} alt="Amber SKU Manager" />
        <p className="app-context-section">{active?.label || 'Amber SKU Manager'}</p>
        <AccountMenu />
      </header>
      <RouteFocusManager pathname={location.pathname} />
      <div className="app-route-content">{children}</div>
    </div>
    <Drawer open={navigationOpen} title="Навігація" className="app-navigation-drawer"
      onClose={() => setNavigationOpen(false)}>
      <WorkspaceNav showBrand={false} onNavigate={() => setNavigationOpen(false)} />
    </Drawer>
  </div>;
}
