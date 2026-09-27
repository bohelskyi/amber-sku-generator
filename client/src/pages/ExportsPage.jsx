import { useAuth } from '../auth/auth-context';
import { useExportWorkflow } from '../hooks/product/useExportWorkflow';
import { ExportTools } from '../components/app/ExportTools';
import { Link, Route, Routes } from 'react-router-dom';
import { ExportWorkspaceShell } from '../components/workspace/ExportWorkspaceShell';
import ExportSessionsPage from './ExportSessionsPage';
import ExportHistoryPage from './ExportHistoryPage';
import { PriceExportWorkspace } from '../components/exports/PriceExportWorkspace';

export default function ExportsPage() {
  const { permissions } = useAuth();
  const workflow = useExportWorkflow();
  if (!permissions.includes('exports.view')) return <main className="app-page p-6">Немає дозволу на перегляд експорту</main>;
  const tools = (surface) => <ExportTools {...workflow} durableSessions surface={surface}
    onPreviewExport={workflow.handlePreviewExport} onCreateSnapshot={workflow.handleCreateSnapshot}
    onDownloadMagentoArtifact={workflow.handleDownloadMagentoArtifact} onConfirmSnapshot={workflow.handleConfirmSnapshot}
    canArchive={false} canViewExport canDecode={permissions.includes('products.decode') && permissions.includes('products.view')}
    canActivateTemplate={permissions.includes('export_templates.activate')}
    canCreateExport={permissions.includes('exports.create')} />;
  return <ExportWorkspaceShell><Routes>
    <Route index element={<><div className="export-review-heading"><h2 className="text-xl font-semibold">Новий експорт</h2>
      <Link className="underline" to="/exports/new/template">Експорт за опублікованим шаблоном</Link>
    </div>{tools('products')}</>} />
    <Route path="prices" element={<PriceExportWorkspace workflow={workflow.priceWorkflow} canCreate={permissions.includes('exports.create')} />} />
    <Route path="history" element={<ExportHistoryPage />} />
    <Route path="history/:stream/:snapshotId" element={<ExportHistoryPage />} />
    <Route path="sessions/:sessionId?" element={<ExportSessionsPage embedded />} />
    <Route path="shared" element={<ExportSessionsPage embedded scope="shared" />} />
    <Route path="invitations" element={<ExportSessionsPage embedded scope="invitations" />} />
    <Route path="new/template" element={<ExportSessionsPage embedded create />} />
    <Route path="*" element={<p>Розділ не знайдено. Оберіть розділ експорту вище.</p>} />
  </Routes></ExportWorkspaceShell>;
}
