import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthGate } from './auth/AuthGate.jsx';
import { AuthProvider } from './auth/AuthProvider.jsx';
import AppRouter from './router.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AuthGate>
        <AppRouter />
      </AuthGate>
    </AuthProvider>
  </React.StrictMode>,
);
