import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
// The overlay ladder, agreed with apps/web in docs/ui-layering.md. Imported
// here so the tokens exist before anything that reads them renders.
import './app.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
