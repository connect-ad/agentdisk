/**
 * `/app` for a returning person, and the login page for a signed-in one.
 *
 * REG-01 (28 Sept 2026): a person with a persisted Firebase session opening
 * `/app` cold was sent to /login and left there, with five workspaces and a
 * valid token. The session is restored asynchronously, so the workspace
 * provider's first pass sees no user; when the user then appears, `/app`
 * rendered in the same commit, read the provider as "not loading, nothing
 * here", and redirected before the provider's own effect could start the
 * fetch. These tests restore the session *after* mount, the way Firebase
 * does, so the race is the thing under test.
 */

import React, { useSyncExternalStore } from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A controllable auth state. `useAuth` reads it through a store so a change
// re-renders every consumer, as the real provider's context would.
const listeners = new Set();
let authState = {};
function setAuth(next) {
  authState = { ...authState, ...next };
  listeners.forEach(l => l());
}
vi.mock('../src/lib/auth.jsx', async () => {
  const actual = await vi.importActual('../src/lib/auth.jsx');
  return {
    ...actual,
    useAuth: () =>
      useSyncExternalStore(
        cb => { listeners.add(cb); return () => listeners.delete(cb); },
        () => authState
      ),
  };
});

let workspaces = [];
vi.mock('../src/lib/api.js', () => ({
  createApiClient: () => ({
    listWorkspaces: async () => ({ workspaces }),
  }),
}));

const { default: RequireAuth } = await import('../src/lib/RequireAuth.jsx');
const { WorkspaceProvider } = await import('../src/lib/workspace.jsx');
const { CurrentWorkspaceRedirect } = await import('../src/App.jsx');
const { Login } = await import('../src/routes/Auth.jsx');

function Where() {
  const { pathname } = useLocation();
  return <div data-testid="where">{pathname}</div>;
}

const baseAuth = {
  configured: true,
  getToken: async () => 'token',
  signInWithPassword: vi.fn(),
  signInWithGoogle: vi.fn(),
  signInWithGithub: vi.fn(),
  sendEmailLink: vi.fn(),
  isEmailLink: () => false,
  completeEmailLink: vi.fn(),
};

beforeEach(() => {
  authState = { ...baseAuth, user: null, loading: true };
  workspaces = [];
});
afterEach(cleanup);

function mountApp(at) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <WorkspaceProvider>
        <Where />
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/app" element={<CurrentWorkspaceRedirect />} />
          </Route>
          <Route path="/login" element={<Login />} />
          <Route path="/w/:ws" element={<div>workspace screen</div>} />
        </Routes>
      </WorkspaceProvider>
    </MemoryRouter>
  );
}

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

describe('/app for a returning person', () => {
  it('waits for the restored session and the list, then lands in the workspace', async () => {
    workspaces = [{ id: 'ws_1', name: 'One', slug: 'one', role: 'owner' }];
    mountApp('/app');
    expect(screen.getByTestId('where').textContent).toBe('/app');

    // Firebase restores the session after the tree has mounted.
    await act(async () => { setAuth({ user: { uid: 'u1' }, loading: false }); });
    // Never /login, not even for the render the user appears in. (With the
    // mocked list resolving at once it may already be in the workspace.)
    expect(screen.getByTestId('where').textContent).not.toBe('/login');

    await settle();
    expect(screen.getByTestId('where').textContent).toBe('/w/one');
    expect(screen.getByText('workspace screen')).toBeTruthy();
  });

  it('shows the no-workspace explanation to a signed-in person with none, not a login', async () => {
    mountApp('/app');
    await act(async () => { setAuth({ user: { uid: 'u1' }, loading: false }); });
    await settle();
    expect(screen.getByTestId('where').textContent).toBe('/app');
    expect(screen.getByText(/don't have access to any workspace/)).toBeTruthy();
  });

  it('still sends an anonymous visitor to /login, remembering where they were headed', async () => {
    mountApp('/app');
    await act(async () => { setAuth({ user: null, loading: false }); });
    await settle();
    expect(screen.getByTestId('where').textContent).toBe('/login');
  });
});

describe('/login for a signed-in person', () => {
  it('carries on to /app instead of showing the form', async () => {
    authState = { ...baseAuth, user: { uid: 'u1' }, loading: false };
    workspaces = [{ id: 'ws_1', name: 'One', slug: 'one', role: 'owner' }];
    mountApp('/login');
    await settle();
    expect(screen.getByTestId('where').textContent).toBe('/w/one');
  });
});
