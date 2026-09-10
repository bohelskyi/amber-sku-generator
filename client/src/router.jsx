import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { WorkspaceNav } from './components/app/WorkspaceNav.jsx';
import { LoadingState } from './components/app/UiPrimitives.jsx';

const AppPage = lazy(() => import('./pages/AppPage.jsx'));
const AdminPage = lazy(() => import('./pages/AdminPage.jsx'));
const RepricingPage = lazy(() => import('./pages/RepricingPage.jsx'));
const CorrectionRequestsPage = lazy(() => import('./pages/CorrectionRequestsPage.jsx'));
const CorrectionHistoryPage = lazy(() => import('./pages/CorrectionHistoryPage.jsx'));
const UsersPage = lazy(() => import('./pages/UsersPage.jsx'));
const RolesPage = lazy(() => import('./pages/RolesPage.jsx'));
const AuditPage = lazy(() => import('./pages/AuditPage.jsx'));

export default function AppRouter() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <WorkspaceNav />
        <Suspense fallback={<main className="app-page"><LoadingState label="Відкриваємо розділ…" /></main>}>
          <Routes>
            <Route path="/" element={<AppPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/admin/repricing" element={<RepricingPage />} />
            <Route path="/admin/corrections" element={<CorrectionRequestsPage />} />
            <Route path="/admin/corrections/history" element={<CorrectionHistoryPage />} />
            <Route path="/admin/users" element={<UsersPage />} />
            <Route path="/admin/roles" element={<RolesPage />} />
            <Route path="/admin/audit" element={<AuditPage />} />
          </Routes>
        </Suspense>
      </div>
    </BrowserRouter>
  );
}
