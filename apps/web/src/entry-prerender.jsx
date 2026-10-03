/**
 * Build-time prerender of the public marketing routes.
 *
 * The dashboard is a client-only SPA, and until 28 Sept 2026 every route
 * returned the same empty shell: nothing for a crawler that does not run
 * JavaScript, nothing for a social preview, and nothing for an agent that was
 * told "go to agentdisk.io" and fetched the page with an HTTP tool. This entry
 * renders the three public routes to HTML with react-dom/server so the built
 * `index.html`, `pricing.html` and `docs.html` carry their content.
 *
 * It is the same tree `main.jsx` mounts, minus the two pieces of chrome that
 * are not content (the progress bar and the cookie notice) and with a
 * StaticRouter in place of the BrowserRouter. It runs under Node with no
 * `window`, so nothing in these routes may touch a browser global while
 * rendering - effects are fine, they never run here. `test/prerender.test.jsx`
 * renders every route under Node so a component that starts reading `window`
 * at render fails the suite rather than the build.
 *
 * The client does not hydrate this markup; `main.jsx` mounts with createRoot
 * and React replaces it on the first commit. For a marketing route that swap
 * is invisible. For any other route (the SPA fallback serves index.html, which
 * now holds the landing page) `public/prerender-guard.js` hides the markup
 * before first paint, so a person refreshing the dashboard never sees the
 * homepage flash.
 */

import React from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { ThemeProvider } from './lib/theme.jsx';
import { WorkspaceProvider } from './lib/workspace.jsx';

/** The routes that get a static file, from the one list the sitemap also reads. */
export { PRERENDERED_ROUTES } from './lib/seo.js';

export function render(url) {
  return renderToString(
    <React.StrictMode>
      <StaticRouter location={url}>
        <ThemeProvider>
          <AuthProvider>
            <WorkspaceProvider>
              <App />
            </WorkspaceProvider>
          </AuthProvider>
        </ThemeProvider>
      </StaticRouter>
    </React.StrictMode>
  );
}
