import { createContext, useContext } from 'react';
import { useProductExportController } from './useProductExportController';

export const ExportWorkflowContext = createContext(null);
export function useExportWorkflow() {
  const shared = useContext(ExportWorkflowContext);
  // Isolated consumers (including the existing hook harness) retain their API.
  // Routed workspaces use the provider; the dormant local hook issues no reads.
  const local = useProductExportController({ enabled: !shared });
  return shared || local;
}
