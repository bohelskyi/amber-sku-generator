import { lazy, Suspense, useState } from 'react';
import { createBrowserRouter, RouterProvider, Route, Routes, Navigate } from 'react-router-dom';
import { WorkspaceNav } from './components/app/WorkspaceNav.jsx';
import { LoadingState, Notice } from './components/app/UiPrimitives.jsx';
import { useAuth } from './auth/auth-context.js';
import { allowedWorkspaceNavigation, workspaceNavigation } from './lib/workspace-navigation.js';
import { ExportWorkflowProvider } from './hooks/product/export-workflow-context';

const AppPage = lazy(() => import('./pages/AppPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const SyncProblemsPage = lazy(() => import('./pages/SyncProblemsPage.jsx'));
const AdminPage = lazy(() => import('./pages/AdminPage.jsx'));
const RepricingPage = lazy(() => import('./pages/RepricingPage.jsx'));
const CorrectionRequestsPage = lazy(() => import('./pages/CorrectionRequestsPage.jsx'));
const CorrectionHistoryPage = lazy(() => import('./pages/CorrectionHistoryPage.jsx'));
const UsersPage = lazy(() => import('./pages/UsersPage.jsx'));
const RolesPage = lazy(() => import('./pages/RolesPage.jsx'));
const AuditPage = lazy(() => import('./pages/AuditPage.jsx'));
const ExportTemplatesPage = lazy(() => import('./pages/ExportTemplatesPage.jsx'));
const ExportsPage = lazy(() => import('./pages/ExportsPage.jsx'));

export default function AppRouter() {
  const [router] = useState(() => createBrowserRouter([{ path: '*', element: <Workspace /> }]));
  return <RouterProvider router={router} />;
}

export function Workspace() {
  const auth = useAuth();
  const allowed = allowedWorkspaceNavigation(auth.permissions);
  const guard = (path, element) => {
    const destination = workspaceNavigation.find((item) => item.to === path);
    if (destination.permissions.some((key) => auth.permissions.includes(key))) return element;
    if (path === '/' && allowed.length) return <Navigate to={allowed[0].to} replace />;
    return <main className="app-page p-6"><Notice tone="warning">Немає доступу до цього розділу.</Notice></main>;
  };
  return (
      <ExportWorkflowProvider>
      <div className="app-shell">
        <WorkspaceNav />
        <Suspense fallback={<main className="app-page"><LoadingState label="Відкриваємо розділ…" /></main>}>
          <Routes>
            <Route path="/" element={guard('/', <AppPage />)} />
            <Route path="/settings" element={guard('/settings', <SettingsPage />)} />
            <Route path="/sync-problems" element={guard('/sync-problems', <SyncProblemsPage />)} />
            <Route path="/admin" element={guard('/admin', <AdminPage />)} />
            <Route path="/admin/repricing" element={guard('/admin/repricing', <RepricingPage />)} />
            <Route path="/admin/corrections" element={guard('/admin/corrections', <CorrectionRequestsPage />)} />
            <Route path="/admin/corrections/history" element={guard('/admin/corrections/history', <CorrectionHistoryPage />)} />
            <Route path="/admin/users" element={guard('/admin/users', <UsersPage />)} />
            <Route path="/admin/roles" element={guard('/admin/roles', <RolesPage />)} />
            <Route path="/admin/audit" element={guard('/admin/audit', <AuditPage />)} />
            <Route path="/admin/export-templates/*" element={guard('/admin/export-templates', <ExportTemplatesPage />)} />
            <Route path="/exports/*" element={guard('/exports', <ExportsPage />)} />
            <Route path="*" element={<main className="app-page p-6"><Notice>Сторінку не знайдено.</Notice></main>} />
          </Routes>
        </Suspense>
      </div>
      </ExportWorkflowProvider>
  );
}
