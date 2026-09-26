/**
 * The gate in front of every workspace screen.
 *
 * Three states, and conflating any two of them produces a visible bug:
 *
 *   loading   Firebase has not yet said whether a session exists. Rendering the
 *             redirect here bounces a signed-in person to /login on every hard
 *             reload, because the SDK restores the session asynchronously.
 *   signed in Render the screens.
 *   anonymous Redirect, remembering where they were headed so the sign-in lands
 *             them there rather than dumping them on a generic dashboard.
 *
 * This is a convenience, not a security boundary. Every screen behind it still
 * gets its data from an API that verifies the token itself — a determined
 * person can render the shell with dev tools and will find it empty.
 */

import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import { useWorkspace } from './workspace.jsx';

function Centered({ children }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh', padding: 'var(--s-8)' }}>
      {children}
    </div>
  );
}

export default function RequireAuth() {
  const { user, loading, configured } = useAuth();
  const location = useLocation();

  if (!configured) {
    return (
      <Centered>
        <p className="ad-meta">
          Sign-in is not configured for this build. Set the VITE_FIREBASE_* variables.
        </p>
      </Centered>
    );
  }

  if (loading) {
    return (
      <Centered>
        <p className="ad-meta" aria-live="polite">Checking your session…</p>
      </Centered>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <Outlet />;
}

/**
 * Sits inside RequireAuth and waits for the workspace list before rendering
 * anything that needs a workspace ID.
 *
 * Separate from the auth gate because it fails differently: being signed in
 * with no reachable workspace is a real state — an invited person whose access
 * was removed — and it deserves an explanation rather than a redirect loop back
 * to a login they have already completed.
 */
export function RequireWorkspace() {
  const { workspaces, workspaceId, loading, error } = useWorkspace();

  if (loading) {
    return (
      <Centered>
        <p className="ad-meta" aria-live="polite">Loading your workspaces…</p>
      </Centered>
    );
  }

  if (error) {
    return (
      <Centered>
        <div>
          <p>We could not load your workspaces.</p>
          <p className="ad-meta">
            {error.message}
            {error.requestId ? ` (request ${error.requestId})` : ''}
          </p>
        </div>
      </Centered>
    );
  }

  if (workspaces.length === 0 || !workspaceId) {
    return (
      <Centered>
        <div>
          <p>You don't have access to any workspace.</p>
          <p className="ad-meta">
            If somebody invited you, ask them to add you again — an invitation can be removed.
          </p>
        </div>
      </Centered>
    );
  }

  return <Outlet />;
}
