import { useAuth } from '../auth/auth-context.js';
import { WorkspaceDirectory } from '../components/app/WorkspaceDirectory.jsx';
import { administrationNavigation, navigationForPermissions } from '../lib/workspace-navigation.js';

export default function AdministrationPage() {
  const { permissions } = useAuth();
  return <WorkspaceDirectory title="Адміністрування" description="Доступ користувачів, ролі та контрольована історія дій."
    items={navigationForPermissions(administrationNavigation, permissions)} />;
}
