import { BrowserRouter, Route, Routes } from 'react-router-dom';
import AppPage from './pages/AppPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import RepricingPage from './pages/RepricingPage.jsx';

export default function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/repricing" element={<RepricingPage />} />
      </Routes>
    </BrowserRouter>
  );
}
