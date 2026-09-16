import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles.css';
import './app.css';
import App from './App.jsx';
import TopProgress from './components-local/TopProgress.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { ThemeProvider } from './lib/theme.jsx';
import { WorkspaceProvider } from './lib/workspace.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
      <AuthProvider>
        <WorkspaceProvider>
          {/* Outside <App> so it is not unmounted by a route change, and
              inside the providers so it is mounted before the first request
              a refresh makes. */}
          <TopProgress />
          <App />
        </WorkspaceProvider>
      </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
