import { useAuth } from '../auth/auth-context';
import { useExportWorkflow } from '../hooks/product/useExportWorkflow';
import { ExportTools } from '../components/app/ExportTools';

export default function ExportsPage() {
  const { permissions } = useAuth();
  const workflow = useExportWorkflow();
  if (!permissions.includes('exports.view')) return <main className="app-page p-6">Немає дозволу на перегляд експорту</main>;
  return <main className="app-page"><div className="mx-auto max-w-7xl p-4 sm:p-6"><ExportTools {...workflow} durableSessions
    onPreviewExport={workflow.handlePreviewExport} onCreateSnapshot={workflow.handleCreateSnapshot}
    onDownloadMagentoArtifact={workflow.handleDownloadMagentoArtifact} onConfirmSnapshot={workflow.handleConfirmSnapshot}
    onPriceExportCsv={workflow.handlePriceExportCsv} canArchive={false} canViewExport
    canActivateTemplate={permissions.includes('export_templates.activate')}
    canCreateExport={permissions.includes('exports.create')} /></div></main>;
}
