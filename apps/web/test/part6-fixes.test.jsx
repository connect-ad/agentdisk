/**
 * The Part 6 product-feedback fixes.
 *
 * Same discipline as `qa-fixes.test.jsx`, and for the same reason: every claim
 * is checked against **two different workspaces**, because a fix that is right
 * for one workspace and wrong for the next is the exact bug this whole series of
 * reports keeps finding, and a single-workspace test passes on it every time.
 *
 * The slug tests go further and use the **real `WorkspaceProvider`** rather than
 * a stubbed context. Resolution ("which workspace does this URL name?") and
 * redirection ("and should the URL have said it differently?") live in two
 * different files, and stubbing either one would leave the seam between them —
 * which is the only place this can actually break — untested.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

vi.mock('../src/lib/workspace.jsx', async () => {
  const actual = await vi.importActual('../src/lib/workspace.jsx');
  return {
    ...actual,
    // Only the hook is stubbed, and only when a test asks for it. The provider
    // itself stays real, so the slug tests below exercise the shipped one.
    useWorkspace: () => globalThis.__ws ?? actual.useWorkspace()
  };
});
vi.mock('../src/lib/auth.jsx', async () => {
  const actual = await vi.importActual('../src/lib/auth.jsx');
  return { ...actual, useAuth: () => globalThis.__auth };
});
vi.mock('../src/lib/api.js', async () => {
  const actual = await vi.importActual('../src/lib/api.js');
  return { ...actual, createApiClient: () => globalThis.__api };
});

const AgentDetails = (await import('../src/routes/AgentDetails.jsx')).default;
const Agents = (await import('../src/routes/Agents.jsx')).default;
const ApiKeys = (await import('../src/routes/ApiKeys.jsx')).default;
const Settings = (await import('../src/routes/Settings.jsx')).default;
const App = (await import('../src/App.jsx')).default;
const { NAV } = await import('../src/App.jsx');
const { WorkspaceProvider } = await import('../src/lib/workspace.jsx');

afterEach(() => {
  cleanup();
  globalThis.__ws = undefined;
});

/* =========================================================================
 * Fixtures — two real workspaces, as the audits compared them.
 * ========================================================================= */

const BUSY_ID = 'ws_01M1WTCVFG3VEX6VRHCZWN1SK2';
const BUSY_SLUG = 'my-workspace';
const QUIET_ID = 'ws_01M1X626F0Z63AEJN4RQPBW2JH';
const QUIET_SLUG = 'abc';

const QUOTA = {
  usage: {
    storageBytes: { used: 0, max: 1073741824 },
    files: { used: 0, max: 1000 },
    requests: { used: 0, max: 10000 }
  },
  workspace: { plan: 'free' }
};

function key(overrides) {
  return {
    id: 'key_1',
    name: 'reader',
    prefix: 'ad_live_aaaa',
    lastFour: 'aaaa',
    status: 'active',
    agentId: 'agt_1',
    lastUsedAt: null,
    expiresAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    scopes: { ops: ['read', 'list'], pathPrefix: '' },
    ...overrides
  };
}

/** "My Workspace": one agent holding a live key and a blocked one. */
const BUSY = {
  workspaceId: BUSY_ID,
  slug: BUSY_SLUG,
  name: 'My Workspace',
  agent: {
    id: 'agt_1',
    name: 'test01',
    description: 'Reads the docs folder',
    status: 'active',
    createdBy: 'usr_1',
    lastSeenAt: null,
    createdAt: '2026-09-01T00:00:00.000Z'
  },
  keys: [
    key({ id: 'key_1', name: 'reader' }),
    key({ id: 'key_2', name: 'blocked one', status: 'blocked' }),
    key({ id: 'key_3', name: 'old one', status: 'revoked' })
  ]
};

/** "Abc": an agent that was created and never given a credential. */
const QUIET = {
  workspaceId: QUIET_ID,
  slug: QUIET_SLUG,
  name: 'Abc',
  agent: {
    id: 'agt_2',
    name: 'unused',
    description: null,
    status: 'active',
    createdBy: 'usr_1',
    lastSeenAt: null,
    createdAt: '2026-09-02T00:00:00.000Z'
  },
  keys: []
};

function apiFor(fixture, overrides = {}) {
  return {
    whoami: vi.fn().mockResolvedValue(QUOTA),
    listWorkspaces: vi.fn().mockResolvedValue({
      workspaces: [
        { id: BUSY_ID, slug: BUSY_SLUG, name: 'My Workspace', role: 'owner' },
        { id: QUIET_ID, slug: QUIET_SLUG, name: 'Abc', role: 'owner' }
      ]
    }),
    listFiles: vi.fn().mockResolvedValue({ files: [] }),
    listAgents: vi.fn().mockResolvedValue({ agents: fixture.agent ? [fixture.agent] : [] }),
    getAgent: vi.fn().mockResolvedValue({ agent: fixture.agent }),
    deleteAgent: vi.fn().mockResolvedValue({ deleted: true, keysDeleted: 2 }),
    updateAgent: vi.fn().mockResolvedValue({ agent: fixture.agent }),
    listKeys: vi.fn().mockResolvedValue({ keys: fixture.keys }),
    revokeKey: vi.fn().mockResolvedValue({ revoked: true }),
    listActivity: vi.fn().mockResolvedValue({ events: [] }),
    listMembers: vi.fn().mockResolvedValue({ members: [] }),
    getBilling: vi.fn().mockResolvedValue({ plan: 'free', status: 'active' }),
    logoutEverywhere: vi.fn().mockResolvedValue({}),
    deleteWorkspace: vi.fn().mockResolvedValue({ deleted: true }),
    ...overrides
  };
}

const AUTH = {
  user: { uid: 'u1', email: 'owner@example.com', displayName: 'Owner' },
  providerIds: ['google.com'],
  loading: false,
  configured: true,
  getToken: async () => 'token',
  signOut: vi.fn(),
  changePassword: vi.fn()
};

/** Renders one screen with a stubbed workspace context, at a real route. */
function mount(ui, fixture, { path, entry, canWrite = true, api } = {}) {
  const client = api ?? apiFor(fixture);
  globalThis.__api = client;
  globalThis.__auth = AUTH;
  globalThis.__ws = {
    workspaceId: fixture.workspaceId,
    workspaceSlug: fixture.slug,
    workspace: { id: fixture.workspaceId, slug: fixture.slug, name: fixture.name, role: 'owner' },
    workspaces: [
      { id: fixture.workspaceId, slug: fixture.slug, name: fixture.name, role: 'owner' },
      { id: 'ws_OTHER', slug: 'other', name: 'Other', role: 'owner' }
    ],
    role: canWrite ? 'owner' : 'reader',
    canWrite,
    loading: false,
    error: null,
    api: client,
    select: vi.fn(),
    create: vi.fn(),
    refresh: vi.fn(),
    resolveWorkspace: vi.fn()
  };
  const result = render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path={path} element={ui} />
        <Route path="/w/:ws/agents" element={<Agents />} />
      </Routes>
    </MemoryRouter>
  );
  return { ...result, api: client };
}

const agentRoute = {
  path: '/w/:ws/agents/:agentId'
};

function mountAgent(fixture, options = {}) {
  return mount(<AgentDetails />, fixture, {
    ...agentRoute,
    entry: `/w/${fixture.slug}/agents/${fixture.agent.id}`,
    ...options
  });
}

/* =========================================================================
 * Part 6 #1 — Delete agent
 * ========================================================================= */

describe('Agent details → Danger zone', () => {
  const openDialog = async user => {
    await user.click(await screen.findByRole('button', { name: 'Delete agent' }));
    return screen.getByRole('dialog');
  };

  it('states the real blast radius for an agent holding live keys', async () => {
    const user = userEvent.setup();
    mountAgent(BUSY);
    const dialog = await openDialog(user);

    // Two live keys: the active one and the blocked one. The revoked third is
    // deliberately not counted — it is already dead, though it is deleted too,
    // which is what the second half of the sentence has to say.
    expect(within(dialog).getByText(/and its 2 live keys/)).toBeTruthy();
    expect(within(dialog).getByText(/deleted rather than revoked/)).toBeTruthy();
  });

  it('says so plainly when the agent holds none — the other workspace', async () => {
    const user = userEvent.setup();
    mountAgent(QUIET);
    const dialog = await openDialog(user);

    expect(within(dialog).getByText(/and its 0 live keys/)).toBeTruthy();
    expect(within(dialog).getByText('This agent holds no live keys')).toBeTruthy();
  });

  it('will not arm the button until the agent name is typed exactly', async () => {
    const user = userEvent.setup();
    const { api } = mountAgent(BUSY);
    const dialog = await openDialog(user);
    const confirm = within(dialog).getByRole('button', { name: 'Delete agent' });

    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Confirm'), 'test0');
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Confirm'), '1');
    expect(confirm.disabled).toBe(false);

    // Nothing has been called yet — arming is not doing.
    expect(api.deleteAgent).not.toHaveBeenCalled();
  });

  it('calls the real endpoint and reports the count the API actually revoked', async () => {
    const user = userEvent.setup();
    const { api } = mountAgent(BUSY);
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText('Confirm'), 'test01');
    await user.click(within(dialog).getByRole('button', { name: 'Delete agent' }));

    await waitFor(() => expect(api.deleteAgent).toHaveBeenCalledWith(BUSY_ID, 'agt_1'));
    // Landed on the list, which now says what happened. "2" is the API's
    // `keysDeleted`, not the dialog's estimate — a key minted in another tab
    // between opening the dialog and confirming is in that number and not in
    // the estimate.
    await screen.findByText('test01 deleted.');
    expect(screen.getByText(/2 keys were deleted with it/)).toBeTruthy();
  });

  it('surfaces a refusal instead of pretending it worked', async () => {
    const user = userEvent.setup();
    const failing = apiFor(BUSY, {
      deleteAgent: vi.fn().mockRejectedValue(
        Object.assign(new Error('Insufficient scope.'), { requestId: 'req_9' })
      )
    });
    mountAgent(BUSY, { api: failing });
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText('Confirm'), 'test01');
    await user.click(within(dialog).getByRole('button', { name: 'Delete agent' }));

    await within(dialog).findByText('Insufficient scope. (request req_9)');
    // Still on the agent, still open. A failed delete must not look like a
    // completed one.
    expect(screen.queryByText('test01 deleted.')).toBeNull();
  });

  it('is not offered to a reader, who the API would refuse anyway', async () => {
    mountAgent(BUSY, { canWrite: false });
    await screen.findByText('Details');
    expect(screen.queryByText('Danger zone')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete agent' })).toBeNull();
  });
});

/* =========================================================================
 * Part 6 #2 — Revocation is permanent, and says so first
 * ========================================================================= */

describe('API keys → revocation permanence', () => {
  const mountKeys = fixture =>
    mount(<ApiKeys />, fixture, {
      path: '/w/:ws/keys',
      entry: `/w/${fixture.slug}/keys`
    });

  it('replaces the Revoke button with the reason on an already-revoked key', async () => {
    mountKeys(BUSY);
    const row = (await screen.findByText('old one')).closest('tr');
    expect(
      within(row).getByText(/Revoked keys can't be reactivated/).textContent
    ).toContain('mint a new key');
    // No dead control: the Status column already says Revoked, so a disabled
    // red button beside it says the same thing twice and looks operable.
    expect(within(row).queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('says nothing of the kind beside a key that is still usable', async () => {
    mountKeys(BUSY);
    const row = (await screen.findByText('reader')).closest('tr');
    expect(within(row).queryByText(/can't be reactivated/)).toBeNull();
    expect(within(row).getByRole('button', { name: 'Revoke' }).disabled).toBe(false);
  });

  /** The other workspace: no keys at all, so no note anywhere on the page. */
  it('shows no reactivation note on a workspace with no keys', async () => {
    mountKeys(QUIET);
    await screen.findByText(/No API keys/i);
    expect(screen.queryByText(/can't be reactivated/)).toBeNull();
  });

  it('states the permanence before the commitment, not after it', async () => {
    const user = userEvent.setup();
    mountKeys(BUSY);
    const row = (await screen.findByText('reader')).closest('tr');
    await user.click(within(row).getByRole('button', { name: 'Revoke' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/can never be reactivated/)).toBeTruthy();
    expect(within(dialog).getByText(/minting a new key/)).toBeTruthy();
  });
});

/* =========================================================================
 * Part 6 #3 — Slug URLs, with the real provider
 * ========================================================================= */

function Probe() {
  const { pathname, search } = useLocation();
  return <div data-testid="loc">{pathname + search}</div>;
}

/**
 * The whole app at a URL, with only Firebase and fetch replaced. The provider,
 * the resolver, the router and the redirect are all the shipped ones.
 */
function mountApp(entry) {
  globalThis.__ws = undefined;
  globalThis.__auth = AUTH;
  globalThis.__api = apiFor(BUSY);
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <WorkspaceProvider>
        <App />
        <Probe />
      </WorkspaceProvider>
    </MemoryRouter>
  );
}

const at = () => screen.getByTestId('loc').textContent;

describe('workspace URLs', () => {
  it('serves the readable slug for the first workspace', async () => {
    mountApp(`/w/${BUSY_SLUG}`);
    await waitFor(() => expect(at()).toBe(`/w/${BUSY_SLUG}`));
  });

  it('serves the readable slug for the second workspace', async () => {
    mountApp(`/w/${QUIET_SLUG}`);
    await waitFor(() => expect(at()).toBe(`/w/${QUIET_SLUG}`));
  });

  it('redirects an old raw-ID bookmark to the slug — first workspace', async () => {
    mountApp(`/w/${BUSY_ID}/keys`);
    await waitFor(() => expect(at()).toBe(`/w/${BUSY_SLUG}/keys`));
  });

  it('redirects an old raw-ID bookmark to the slug — second workspace', async () => {
    mountApp(`/w/${QUIET_ID}/keys`);
    await waitFor(() => expect(at()).toBe(`/w/${QUIET_SLUG}/keys`));
  });

  /**
   * A bookmark is rarely just the workspace root. Losing the rest of the path
   * or the query on the way through the redirect would turn "your links keep
   * working" into "your links keep opening the wrong screen".
   */
  it('carries the deep path and the query string across the redirect', async () => {
    mountApp(`/w/${BUSY_ID}/agents/agt_1?tab=keys`);
    await waitFor(() => expect(at()).toBe(`/w/${BUSY_SLUG}/agents/agt_1?tab=keys`));
  });

  it('resolves /app to the slug rather than the ID', async () => {
    mountApp('/app');
    await waitFor(() => expect(at()).toMatch(/^\/w\/(my-workspace|abc)$/));
  });
});

describe('the real workspace ID is still shown where it is needed', () => {
  it('Settings → General shows ws_..., not the slug', async () => {
    mount(<Settings />, BUSY, { path: '/w/:ws/settings', entry: `/w/${BUSY_SLUG}/settings` });
    const field = await screen.findByLabelText(/Workspace ID/);
    expect(field.value).toBe(BUSY_ID);
    expect(field.value).not.toBe(BUSY_SLUG);
  });

  it('and shows the second workspace its own ID, not the first one\'s', async () => {
    mount(<Settings />, QUIET, { path: '/w/:ws/settings', entry: `/w/${QUIET_SLUG}/settings` });
    const field = await screen.findByLabelText(/Workspace ID/);
    expect(field.value).toBe(QUIET_ID);
  });

  /**
   * The Dashboard's ID chip read the URL segment, which was the ID until slugs
   * arrived and would have quietly become the slug the moment they did. It is
   * the value people copy into an API call, so showing them a slug there would
   * hand them something nothing accepts — a regression introduced *by* the
   * readable-URL change, not one that predates it.
   */
  /**
   * The chip moved from the Dashboard's heading into the shell's workspace
   * strip, where the design puts it and where it is now on every screen rather
   * than only the overview.
   *
   * Tested through `mountApp` rather than by rendering one component, which
   * makes this a stronger check than it was: it exercises App.jsx resolving the
   * URL segment to a workspace and passing that workspace's real `id`. The
   * original regression was precisely a screen reading the URL segment — which
   * was the ID until slugs arrived and would silently have become the slug the
   * moment they did. It is the value people paste into an API call, so a slug
   * there hands them something nothing accepts.
   */
  it('the workspace strip shows the ID even though the URL says the slug', async () => {
    mountApp(`/w/${BUSY_SLUG}`);
    await waitFor(() => expect(screen.getByText(BUSY_ID)).toBeTruthy());
    expect(screen.queryByText(BUSY_SLUG)).toBeNull();
  });

  it('and the same on the second workspace', async () => {
    // The pair is the point: a chip hardcoded to one workspace passes the test
    // above and fails this one.
    mountApp(`/w/${QUIET_SLUG}`);
    await waitFor(() => expect(screen.getByText(QUIET_ID)).toBeTruthy());
    expect(screen.queryByText(QUIET_SLUG)).toBeNull();
  });
});

/* =========================================================================
 * Part 6 #4 — The nav label, and only the nav label
 * ========================================================================= */

describe('sidebar navigation', () => {
  const agents = NAV.flatMap(group => group.items).find(item => item.id === 'agents');

  it('calls the item "Agent identities"', () => {
    expect(agents.label).toBe('Agent identities');
  });

  it('leaves the URL path alone, so no link or bookmark moves', () => {
    expect(agents.path).toBe('/agents');
  });

  it('leaves the section header alone', () => {
    const section = NAV.find(group => group.items.some(item => item.id === 'agents'));
    expect(section.label).toBe('Agent access');
  });
});
