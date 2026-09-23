import { useAuth } from '../../auth/auth-context';
import { useProductExportController } from './useProductExportController';
import { ExportWorkflowContext } from './useExportWorkflow';

export function ExportWorkflowProvider({ children }) {
  const { permissions, applicationUser, principalLifetime } = useAuth();
  const enabled = permissions.includes('exports.view');
  const canCreate = permissions.includes('exports.create');
  return <PrincipalWorkflow key={`${applicationUser?.id || 'isolated'}:${enabled}:${canCreate}`}
    enabled={enabled} canCreate={canCreate} principalLifetime={principalLifetime}>{children}</PrincipalWorkflow>;
}

function PrincipalWorkflow({ children, enabled, canCreate, principalLifetime }) {
  const controller = useProductExportController({ enabled, canCreate, principalLifetime });
  return <ExportWorkflowContext.Provider value={controller}>{children}</ExportWorkflowContext.Provider>;
}
