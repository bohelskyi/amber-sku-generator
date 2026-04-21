import { BrowserRouter, Route, Routes } from 'react-router-dom';
import AppPage from './pages/AppPage.jsx';
import AdminPage from './pages/AdminPage.jsx';

export default function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppPage />} />
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
    </BrowserRouter>
  );
}
