import { useAuth } from '../auth/auth-context.js';
import { WorkspaceDirectory } from '../components/app/WorkspaceDirectory.jsx';
import { navigationForPermissions, settingsNavigation } from '../lib/workspace-navigation.js';

export default function SettingsPage() {
  const { permissions } = useAuth();
  return <WorkspaceDirectory title="Налаштування" description="Каталог, ціноутворення та підключення робочих систем."
    items={navigationForPermissions(settingsNavigation, permissions)} />;
}
