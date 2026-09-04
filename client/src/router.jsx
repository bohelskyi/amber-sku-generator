import { BrowserRouter, Route, Routes } from 'react-router-dom';
import AppPage from './pages/AppPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import RepricingPage from './pages/RepricingPage.jsx';
import CorrectionRequestsPage from './pages/CorrectionRequestsPage.jsx';
import CorrectionHistoryPage from './pages/CorrectionHistoryPage.jsx';
import { WorkspaceNav } from './components/app/WorkspaceNav.jsx';

export default function AppRouter() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <WorkspaceNav />
        <Routes>
          <Route path="/" element={<AppPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/repricing" element={<RepricingPage />} />
          <Route path="/admin/corrections" element={<CorrectionRequestsPage />} />
          <Route path="/admin/corrections/history" element={<CorrectionHistoryPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
