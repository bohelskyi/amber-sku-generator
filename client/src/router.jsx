import { lazy, Suspense, useState } from 'react';
import {
  createBrowserRouter, Navigate, Route, RouterProvider, Routes, useLocation,
} from 'react-router-dom';
import { AppShell } from './components/app/AppShell.jsx';
import { LoadingState, Notice } from './components/app/UiPrimitives.jsx';
import { useAuth } from './auth/auth-context.js';
import {
  dailyWorkspaceNavigation, hasAllPermissions, hasAnyPermission, legacyNavigation, navigationForPermissions,
} from './lib/workspace-navigation.js';
import { ExportWorkflowProvider } from './hooks/product/export-workflow-context';

const AppPage = lazy(() => import('./pages/AppPage.jsx'));
const AttentionPage = lazy(() => import('./pages/AttentionPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const AdministrationPage = lazy(() => import('./pages/AdministrationPage.jsx'));
const MagentoIntegrationPage = lazy(() => import('./pages/MagentoIntegrationPage.jsx'));
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

const productPermissions = ['products.view', 'products.decode', 'history.view'];

function AccessDenied() {
  return <main className="app-page p-6"><Notice tone="warning">Немає доступу до цього розділу.</Notice></main>;
}

function LegacyRootRedirect() {
  const auth = useAuth();
  const location = useLocation();
  if (hasAnyPermission(auth.permissions, productPermissions)) {
    const params = new URLSearchParams(location.search);
    const requestedProduct = params.has('article') || params.has('exportSku');
    const path = requestedProduct && auth.permissions.includes('products.decode') ? '/products/open' : '/products';
    return <Navigate replace to={{ pathname: path, search: location.search, hash: location.hash }} />;
  }
  const fallback = dailyWorkspaceNavigation(auth.permissions)[0]?.to
    || navigationForPermissions(legacyNavigation, auth.permissions)[0]?.to;
  return fallback ? <Navigate to={fallback} replace /> : <AccessDenied />;
}

function LegacyAdminRedirect() {
  const { permissions } = useAuth();
  const location = useLocation();
  const canCatalog = permissions.includes('catalog.view');
  const canPricing = permissions.includes('pricing.view');
  let pathname = null;
  if (location.hash === '#catalog-pricing' && canPricing) pathname = '/admin/pricing';
  else if (location.hash === '#catalog-structure' && canCatalog) pathname = '/admin/catalog';
  else if (canCatalog) pathname = '/admin/catalog';
  else if (canPricing) pathname = '/admin/pricing';
  return pathname ? <Navigate replace to={{ pathname, search: location.search }} /> : <AccessDenied />;
}

export default function AppRouter() {
  const [router] = useState(() => createBrowserRouter([{ path: '*', element: <Workspace /> }]));
  return <RouterProvider router={router} />;
}

export function Workspace() {
  const auth = useAuth();
  const guardAny = (permissions, element) => hasAnyPermission(auth.permissions, permissions) ? element : <AccessDenied />;
  const guardAll = (permissions, element) => hasAllPermissions(auth.permissions, permissions) ? element : <AccessDenied />;
  return <ExportWorkflowProvider>
    <AppShell>
      <Suspense fallback={<main className="app-page"><LoadingState label="Відкриваємо розділ…" /></main>}>
        <Routes>
          <Route path="/" element={<LegacyRootRedirect />} />
          <Route path="/products" element={guardAny(productPermissions, <AppPage />)} />
          <Route path="/products/open" element={guardAny(['products.decode'], <AppPage />)} />
          <Route path="/products/create" element={guardAll(['products.view', 'products.create'], <AppPage />)} />
          <Route path="/products/history" element={guardAny(['history.view'], <CorrectionHistoryPage />)} />
          <Route path="/attention" element={guardAny(['corrections.view', 'products.view'], <AttentionPage />)} />
          <Route path="/settings" element={guardAny(['catalog.view', 'pricing.view', 'export_templates.view'], <SettingsPage />)} />
          <Route path="/administration" element={guardAny(['users.manage', 'roles.manage', 'audit.view'], <AdministrationPage />)} />
          <Route path="/sync-problems" element={guardAny(['products.view'], <SyncProblemsPage />)} />
          <Route path="/admin" element={<LegacyAdminRedirect />} />
          <Route path="/admin/catalog" element={guardAny(['catalog.view'], <AdminPage key="catalog" mode="catalog" />)} />
          <Route path="/admin/pricing" element={guardAny(['pricing.view'], <AdminPage key="pricing" mode="pricing" />)} />
          <Route path="/admin/magento/*" element={guardAny(['export_templates.view'], <MagentoIntegrationPage />)} />
          <Route path="/admin/repricing" element={guardAny(['repricing.view'], <RepricingPage />)} />
          <Route path="/admin/corrections" element={guardAny(['corrections.view'], <CorrectionRequestsPage />)} />
          <Route path="/admin/corrections/history" element={guardAny(['history.view'], <CorrectionHistoryPage />)} />
          <Route path="/admin/users" element={guardAny(['users.manage'], <UsersPage />)} />
          <Route path="/admin/roles" element={guardAny(['roles.manage'], <RolesPage />)} />
          <Route path="/admin/audit" element={guardAny(['audit.view'], <AuditPage />)} />
          <Route path="/admin/export-templates/*" element={guardAny(['export_templates.view'], <ExportTemplatesPage />)} />
          <Route path="/exports/*" element={guardAny(['exports.view'], <ExportsPage />)} />
          <Route path="*" element={<main className="app-page p-6"><Notice>Сторінку не знайдено.</Notice></main>} />
        </Routes>
      </Suspense>
    </AppShell>
  </ExportWorkflowProvider>;
}
