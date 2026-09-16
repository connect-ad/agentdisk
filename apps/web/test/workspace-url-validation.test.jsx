/**
 * `/w/:ws` must name a workspace this person can actually reach.
 *
 * The reported fault was not a crash or a wrong error page — it was silence.
 * `/w/ws_00000000000000000000000000` rendered the shell, labelled it with the
 * literal word "Workspace", and filled it with the signed-in user's OWN default
 * workspace: `whoami` and `files` were fetched for a workspace the URL never
 * named, while the address bar went on showing the bogus one. Nothing failed,
 * so nothing said anything.
 *
 * That makes "renders the 404" the weaker half of what these tests check. The
 * stronger half is that the screens behind the guard never mount and never
 * fetch — because the bug was never about which page appeared, it was about the
 * data that appeared on it.
 *
 * Every case runs against **two real workspaces**, matching the standing bar
 * for this series of reports: a guard that is right for the first workspace in
 * the list and wrong for the second is exactly the shape that keeps getting
 * through.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../src/lib/auth.jsx', async () => {
  const actual = await vi.importActual('../src/lib/auth.jsx');
  return { ...actual, useAuth: () => globalThis.__auth };
});
vi.mock('../src/lib/api.js', async () => {
  const actual = await vi.importActual('../src/lib/api.js');
  return { ...actual, createApiClient: () => globalThis.__api };
});

const App = (await import('../src/App.jsx')).default;
const { WorkspaceProvider } = await import('../src/lib/workspace.jsx');

afterEach(cleanup);

/* ------------------------------- fixtures -------------------------------- */

const BUSY_ID = 'ws_01M1WTCVFG3VEX6VRHCZWN1SK2';
const BUSY_SLUG = 'my-workspace';
const QUIET_ID = 'ws_01M1X626F0Z63AEJN4RQPBW2JH';
const QUIET_SLUG = 'abc';

/** Syntactically a perfectly good ULID workspace ID. It just is not anyone's. */
const NOBODYS_ID = 'ws_00000000000000000000000000';

/** Real, and belongs to another account — the URL a colleague pastes. */
const SOMEBODY_ELSES_ID = 'ws_01M1ZZZZZZZZZZZZZZZZZZZZZZ';

const MEMBERSHIPS = [
  { id: BUSY_ID, slug: BUSY_SLUG, name: 'My Workspace', role: 'owner' },
  { id: QUIET_ID, slug: QUIET_SLUG, name: 'Abc', role: 'owner' }
];

const AUTH = {
  user: { uid: 'u1', email: 'owner@example.com', displayName: 'Owner' },
  providerIds: ['google.com'],
  loading: false,
  configured: true,
  getToken: async () => 'token',
  signOut: vi.fn(),
  changePassword: vi.fn()
};

/**
 * The API as the *server* would answer it: `listWorkspaces` returns only the
 * workspaces this user is a member of, which is what makes one check able to
 * cover both "no such workspace" and "not yours".
 */
function apiStub(workspaces = MEMBERSHIPS) {
  return {
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces }),
    whoami: vi.fn().mockResolvedValue({
      usage: {
        storageBytes: { used: 0, max: 1073741824 },
        files: { used: 0, max: 1000 },
        requests: { used: 0, max: 10000 }
      },
      workspace: { plan: 'free' }
    }),
    listFiles: vi.fn().mockResolvedValue({ files: [] }),
    listAgents: vi.fn().mockResolvedValue({ agents: [] }),
    listKeys: vi.fn().mockResolvedValue({ keys: [] }),
    listActivity: vi.fn().mockResolvedValue({ events: [] }),
    listMembers: vi.fn().mockResolvedValue({ members: [] }),
    getBilling: vi.fn().mockResolvedValue({ plan: 'free', status: 'active' })
  };
}

function Probe() {
  const { pathname } = useLocation();
  return <div data-testid="loc">{pathname}</div>;
}

function mountApp(entry, api = apiStub()) {
  globalThis.__auth = AUTH;
  globalThis.__api = api;
  render(
    <MemoryRouter initialEntries={[entry]}>
      <WorkspaceProvider>
        <App />
        <Probe />
      </WorkspaceProvider>
    </MemoryRouter>
  );
  return api;
}

const notFound = () => screen.queryByText(/404/);

/* ------------------------------- the guard -------------------------------- */

describe('a /w/:ws URL naming no reachable workspace', () => {
  it('shows the 404 rather than a nonexistent workspace — bogus ID', async () => {
    mountApp(`/w/${NOBODYS_ID}`);
    await waitFor(() => expect(notFound()).not.toBeNull());
  });

  it('shows the 404 for a real workspace belonging to somebody else', async () => {
    // Indistinguishable from the invented one above, deliberately: a different
    // answer would confirm that this ID exists, which is an oracle for other
    // people's workspace IDs. The API answers these two identically too.
    mountApp(`/w/${SOMEBODY_ELSES_ID}`);
    await waitFor(() => expect(notFound()).not.toBeNull());
  });

  it('shows the 404 for a slug-shaped segment that matches nothing', async () => {
    mountApp('/w/not-a-real-workspace');
    await waitFor(() => expect(notFound()).not.toBeNull());
  });

  /**
   * The actual bug. The page being wrong was the symptom; the data being
   * somebody else's was the fault. If the guard ever regresses to rendering the
   * shell, `Dashboard` mounts and fetches for the context's workspace — so
   * these two spies are what really pins the fix.
   */
  it('fetches nothing for the user own workspace while showing it', async () => {
    const api = mountApp(`/w/${NOBODYS_ID}`);
    await waitFor(() => expect(notFound()).not.toBeNull());

    expect(api.whoami).not.toHaveBeenCalled();
    expect(api.listFiles).not.toHaveBeenCalled();
    // The membership list is the one call that must still happen: it is how the
    // guard knows the URL names nothing.
    expect(api.listWorkspaces).toHaveBeenCalled();
  });

  it('does not silently substitute the workspace name into the page', async () => {
    mountApp(`/w/${NOBODYS_ID}`);
    await waitFor(() => expect(notFound()).not.toBeNull());
    expect(screen.queryByText('My Workspace')).toBeNull();
    expect(screen.queryByText('Abc')).toBeNull();
  });

  it('guards a deep link, not just the workspace root', async () => {
    const api = mountApp(`/w/${NOBODYS_ID}/files`);
    await waitFor(() => expect(notFound()).not.toBeNull());
    expect(api.listFiles).not.toHaveBeenCalled();
  });

  it('guards every screen under the workspace', async () => {
    for (const path of ['agents', 'keys', 'activity', 'settings', 'usage']) {
      cleanup();
      mountApp(`/w/${NOBODYS_ID}/${path}`);
      await waitFor(() => expect(notFound(), path).not.toBeNull());
    }
  });

  /**
   * The other direction of the same mistake. A person whose membership is
   * removed while they have the tab open should meet the 404, but a person who
   * still has exactly one workspace must not — `RequireWorkspace` owns the
   * "you have none at all" case and says something kinder than 404.
   */
  it('leaves the no-workspaces-at-all case to RequireWorkspace', async () => {
    mountApp(`/w/${BUSY_SLUG}`, apiStub([]));
    await waitFor(() =>
      expect(screen.getByText(/don't have access to any workspace/i)).toBeTruthy()
    );
    expect(notFound()).toBeNull();
  });
});

/* --------------------------- the routes that work -------------------------- */

/**
 * The guard's real risk is over-reach: a check that 404s a URL somebody was
 * legitimately using is worse than the bug it replaces. Both workspaces, both
 * spellings of the address.
 */
describe('workspaces the person can reach still open', () => {
  const at = () => screen.getByTestId('loc').textContent;

  it('opens the first workspace by slug', async () => {
    mountApp(`/w/${BUSY_SLUG}`);
    await waitFor(() => expect(at()).toBe(`/w/${BUSY_SLUG}`));
    expect(notFound()).toBeNull();
  });

  it('opens the second workspace by slug', async () => {
    mountApp(`/w/${QUIET_SLUG}`);
    await waitFor(() => expect(at()).toBe(`/w/${QUIET_SLUG}`));
    expect(notFound()).toBeNull();
  });

  it('still redirects a raw-ID bookmark to the slug — first workspace', async () => {
    mountApp(`/w/${BUSY_ID}/keys`);
    await waitFor(() => expect(at()).toBe(`/w/${BUSY_SLUG}/keys`));
    expect(notFound()).toBeNull();
  });

  it('still redirects a raw-ID bookmark to the slug — second workspace', async () => {
    mountApp(`/w/${QUIET_ID}/keys`);
    await waitFor(() => expect(at()).toBe(`/w/${QUIET_SLUG}/keys`));
    expect(notFound()).toBeNull();
  });

  it('renders the workspace name once it is open', async () => {
    mountApp(`/w/${QUIET_SLUG}`);
    await waitFor(() => expect(screen.getAllByText('Abc').length).toBeGreaterThan(0));
  });
});
