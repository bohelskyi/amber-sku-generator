import { useAuth } from '../auth/auth-context';
import { useExportWorkflow } from '../hooks/product/useExportWorkflow';
import { ExportTools } from '../components/app/ExportTools';
import { Link, Route, Routes } from 'react-router-dom';
import { ExportWorkspaceShell } from '../components/workspace/ExportWorkspaceShell';
import ExportSessionsPage from './ExportSessionsPage';

export default function ExportsPage() {
  const { permissions } = useAuth();
  const workflow = useExportWorkflow();
  if (!permissions.includes('exports.view')) return <main className="app-page p-6">Немає дозволу на перегляд експорту</main>;
  const tools = (surface) => <ExportTools {...workflow} durableSessions surface={surface}
    onPreviewExport={workflow.handlePreviewExport} onCreateSnapshot={workflow.handleCreateSnapshot}
    onDownloadMagentoArtifact={workflow.handleDownloadMagentoArtifact} onConfirmSnapshot={workflow.handleConfirmSnapshot}
    onPriceExportCsv={workflow.handlePriceExportCsv} canArchive={false} canViewExport
    canActivateTemplate={permissions.includes('export_templates.activate')}
    canCreateExport={permissions.includes('exports.create')} />;
  return <ExportWorkspaceShell><Routes>
    <Route index element={<><div className="mb-4 space-y-2"><h2 className="text-xl font-semibold">Новий експорт</h2>
      <p>Звичайний експорт використовує системний профіль.</p>
      <Link className="btn btn-outline px-4" to="/exports/new/template">Експорт за опублікованим шаблоном</Link>
    </div>{tools('products')}</>} />
    <Route path="prices" element={<>{!permissions.includes('exports.create') && <p className="mb-3">Лише перегляд. Створення та підтвердження експорту цін недоступні.</p>}{tools('prices')}</>} />
    <Route path="sessions/:sessionId?" element={<ExportSessionsPage embedded />} />
    <Route path="shared" element={<ExportSessionsPage embedded scope="shared" />} />
    <Route path="invitations" element={<ExportSessionsPage embedded scope="invitations" />} />
    <Route path="new/template" element={<ExportSessionsPage embedded create />} />
    <Route path="*" element={<p>Розділ не знайдено. Оберіть розділ експорту вище.</p>} />
  </Routes></ExportWorkspaceShell>;
}
