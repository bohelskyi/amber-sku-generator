import {
  Boxes, CircleDollarSign, ListChecks, Settings, ShieldCheck,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import {
  dailyWorkspaceNavigation, isWorkspaceDestination,
} from '../../lib/workspace-navigation.js';
import { useAuth } from '../../auth/auth-context.js';
import amberLogo from '../../assets/amber-logo-white-orange.png';

const icons = {
  products: Boxes,
  attention: ListChecks,
  repricing: CircleDollarSign,
  settings: Settings,
  administration: ShieldCheck,
};

export function WorkspaceNav({ onNavigate, showBrand = true }) {
  const auth = useAuth();
  const { pathname } = useLocation();
  const destinations = dailyWorkspaceNavigation(auth.permissions);
  const work = destinations.filter((item) => item.group === 'Щоденна робота');
  const system = destinations.filter((item) => item.group === 'Система');
  const home = destinations[0]?.to || '/';
  const links = (items) => items.map((item) => {
    const Icon = icons[item.id];
    const active = isWorkspaceDestination(item, pathname);
    return <Link key={item.id} to={item.to} onClick={onNavigate} aria-current={active ? 'page' : undefined}
      className={`app-navigation-link${active ? ' is-active' : ''}`}>
      <Icon size={18} aria-hidden="true" /><span>{item.label}</span>
    </Link>;
  });

  return <nav className="app-navigation" aria-label="Основна навігація">
    {showBrand && <Link to={home} onClick={onNavigate} className="app-navigation-brand" aria-label="Amber SKU Manager">
      <img src={amberLogo} alt="" />
    </Link>}
    <div className="app-navigation-sections">
      {work.length > 0 && <section aria-labelledby="navigation-work-label">
        <p id="navigation-work-label" className="app-navigation-label">Щоденна робота</p>
        <div className="app-navigation-links">{links(work)}</div>
      </section>}
      {system.length > 0 && <section aria-labelledby="navigation-system-label">
        <p id="navigation-system-label" className="app-navigation-label">Система</p>
        <div className="app-navigation-links">{links(system)}</div>
      </section>}
    </div>
  </nav>;
}
