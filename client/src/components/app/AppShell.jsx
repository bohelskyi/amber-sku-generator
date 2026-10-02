import { LogOut, Menu, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
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

export function AppShell({ children }) {
  const auth = useAuth();
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const active = activeWorkspaceDestination(auth.permissions, location.pathname);
  useEffect(() => { setNavigationOpen(false); }, [location.pathname]);
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
      {children}
    </div>
    <Drawer open={navigationOpen} title="Навігація" className="app-navigation-drawer"
      onClose={() => setNavigationOpen(false)}>
      <WorkspaceNav showBrand={false} onNavigate={() => setNavigationOpen(false)} />
    </Drawer>
  </div>;
}
