/**
 * The Sept-2026 QA pass fixes (docs 17 and 18).
 *
 * Every finding those reports raised was proved the same way: render the same
 * element for **two different real workspaces**, one with data in the field and
 * one without, and see whether the output changes. Hardcoded UI is precisely the
 * bug that a single-workspace test passes on — a fixed string is correct for
 * exactly one workspace and the tests never visit the second.
 *
 * So these tests are paired on purpose. `WITH` and `WITHOUT` below stand in for
 * "My Workspace" (a real agent, real keys) and "Abc" (genuinely empty), which
 * are the two the audit actually compared.
 *
 * The mock stops at `useWorkspace`, so `useResource`, the components and React
 * are all real; only the API client is a stub.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../src/lib/workspace.jsx', () => ({
  useWorkspace: () => globalThis.__ws
}));
vi.mock('../src/lib/auth.jsx', async () => {
  const actual = await vi.importActual('../src/lib/auth.jsx');
  return { ...actual, useAuth: () => globalThis.__auth };
});

const Dashboard = (await import('../src/routes/Dashboard.jsx')).default;
const Settings = (await import('../src/routes/Settings.jsx')).default;
const McpConnection = (await import('../src/routes/McpConnection.jsx')).default;
const AccountMenu = (await import('../src/components-local/AccountMenu.jsx')).default;
const WorkspaceStats = (await import('../src/components-local/WorkspaceStats.jsx')).default;

afterEach(cleanup);

const WITH_ID = 'ws_01M1WTCVFG3VEX6VRHCZWN1SK2';
const WITHOUT_ID = 'ws_01M1X626F0Z63AEJN4RQPBW2JH';

const QUOTA = {
  usage: {
    storageBytes: { used: 0, max: 1073741824 },
    files: { used: 0, max: 1000 },
    requests: { used: 0, max: 10000 }
  },
  workspace: { plan: 'free' }
};

/** "My Workspace": one active agent, one live read+list key, no MCP calls yet. */
const WITH = {
  workspaceId: WITH_ID,
  name: 'My Workspace',
  agents: [{ id: 'agt_1', name: 'test01', status: 'active' }],
  keys: [
    {
      id: 'key_1',
      name: 'reader',
      prefix: 'ad_live_aaaa',
      status: 'active',
      agentId: 'agt_1',
      lastUsedAt: null,
      scopes: { ops: ['read', 'list'], pathPrefix: '' }
    }
  ],
  events: []
};

/** "Abc": genuinely empty. */
const WITHOUT = {
  workspaceId: WITHOUT_ID,
  name: 'Abc',
  agents: [],
  keys: [],
  events: []
};

function contextFor(fixture) {
  return {
    workspaceId: fixture.workspaceId,
    workspace: { id: fixture.workspaceId, name: fixture.name, role: 'owner' },
    workspaces: [{ id: fixture.workspaceId, name: fixture.name, role: 'owner' }],
    role: 'owner',
    canWrite: true,
    loading: false,
    error: null,
    api: {
      whoami: vi.fn().mockResolvedValue(QUOTA),
      listFiles: vi.fn().mockResolvedValue({ files: [] }),
      listAgents: vi.fn().mockResolvedValue({ agents: fixture.agents }),
      listKeys: vi.fn().mockResolvedValue({ keys: fixture.keys }),
      listActivity: vi.fn().mockResolvedValue({ events: fixture.events }),
      logoutEverywhere: vi.fn().mockResolvedValue({})
    }
  };
}

function mount(ui, fixture, { auth } = {}) {
  globalThis.__ws = contextFor(fixture);
  globalThis.__auth = auth ?? {
    user: { email: 'kernelv5@example.com', displayName: 'Kernel V5' },
    providerIds: ['google.com'],
    changePassword: vi.fn()
  };
  // A real `/w/:ws` route, so `useParams().ws` resolves and the links these
  // screens build point at the workspace rather than at `/w/undefined`.
  return render(
    <MemoryRouter initialEntries={[`/w/${fixture.workspaceId}/x`]}>
      <Routes>
        <Route path="/w/:ws/x" element={ui} />
      </Routes>
    </MemoryRouter>
  );
}

/* ------------------------- 18 #1 · Dashboard agents ----------------------- */

describe('Agents figure', () => {
  /**
   * The figure moved, the guarantee did not.
   *
   * These four cards were on the Dashboard; the design puts them in the shell
   * above the tab bar, so they are on every screen and WorkspaceStats owns
   * them now. The behaviour under test is unchanged and is the one doc 18
   * raised: the count is real for both workspaces, and the fixed placeholder
   * that made them render identically never comes back.
   */
  const tile = async () => {
    const label = await screen.findByText('AGENTS');
    return label.closest('.wstat') ?? label.parentElement;
  };

  it('counts the workspace that has an agent', async () => {
    mount(<WorkspaceStats />, WITH);
    await waitFor(async () => expect((await tile()).textContent).toContain('1'));
    expect((await tile()).textContent).toContain('active');
  });

  it('says zero for the workspace that has none', async () => {
    mount(<WorkspaceStats />, WITHOUT);
    await waitFor(async () => expect((await tile()).textContent).toContain('No agents yet'));
  });

  it('never renders the placeholder that used to be there', async () => {
    mount(<WorkspaceStats />, WITH);
    await screen.findByText('AGENTS');
    // The exact string that made a workspace with an agent and one without
    // render identically.
    expect(screen.queryByText('Not built yet')).toBeNull();
  });
});

/* ---------------------- 17 #5 / 18 #4 · Workspace ID ---------------------- */

describe('Settings → General workspace ID', () => {
  const idField = () => screen.getByLabelText(/Workspace ID/);

  it('shows the real ID of the workspace you are in', () => {
    mount(<Settings />, WITH);
    expect(idField().value).toBe(WITH_ID);
  });

  it('shows a different real ID for a different workspace', () => {
    mount(<Settings />, WITHOUT);
    expect(idField().value).toBe(WITHOUT_ID);
  });

  it('is never the hardcoded value the audit found on every workspace', () => {
    mount(<Settings />, WITH);
    expect(idField().value).not.toBe('ws_8Kq2xR4mN7pL');
  });
});

/* ------------------------ 18 #5 / #6 · Security tab ----------------------- */

describe('Settings → Security', () => {
  const openSecurity = async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Security' }));
    return user;
  };

  it('offers no password form to an account that signs in with Google', async () => {
    mount(<Settings />, WITH, {
      auth: { user: { email: 'a@b.co' }, providerIds: ['google.com'], changePassword: vi.fn() }
    });
    await openSecurity();
    expect(screen.queryByLabelText(/Current password/)).toBeNull();
    expect(screen.getByText(/signs in with Google/)).toBeTruthy();
  });

  it('offers a real one to an account that has a password', async () => {
    mount(<Settings />, WITH, {
      auth: { user: { email: 'a@b.co' }, providerIds: ['password'], changePassword: vi.fn() }
    });
    await openSecurity();
    expect(screen.getByLabelText(/Current password/)).toBeTruthy();
  });

  it('sends the change to Firebase rather than reporting a success it did not do', async () => {
    const changePassword = vi.fn().mockResolvedValue(undefined);
    mount(<Settings />, WITH, {
      auth: { user: { email: 'a@b.co' }, providerIds: ['password'], changePassword }
    });
    const user = await openSecurity();
    await user.type(screen.getByLabelText(/Current password/), 'old-secret');
    await user.type(screen.getByLabelText(/^New password/), 'a-much-longer-one');
    await user.type(screen.getByLabelText(/Confirm new password/), 'a-much-longer-one');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(changePassword).toHaveBeenCalledWith('old-secret', 'a-much-longer-one'));
  });

  it('refuses a mismatched confirmation without calling Firebase', async () => {
    const changePassword = vi.fn();
    mount(<Settings />, WITH, {
      auth: { user: { email: 'a@b.co' }, providerIds: ['password'], changePassword }
    });
    const user = await openSecurity();
    await user.type(screen.getByLabelText(/Current password/), 'old-secret');
    await user.type(screen.getByLabelText(/^New password/), 'one-thing');
    await user.type(screen.getByLabelText(/Confirm new password/), 'another-thing');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(changePassword).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/do not match/);
  });

  it('has no per-device session table to render zero rows into', async () => {
    mount(<Settings />, WITH);
    await openSecurity();
    expect(screen.queryByText('Active sessions')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Device' })).toBeNull();
    expect(screen.getByText(/not built yet/i)).toBeTruthy();
  });

  it('really calls logout-all instead of only showing a toast', async () => {
    mount(<Settings />, WITH);
    const user = await openSecurity();
    await user.click(screen.getByRole('button', { name: /Sign out other sessions/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out other sessions' }));
    await waitFor(() =>
      expect(globalThis.__ws.api.logoutEverywhere).toHaveBeenCalledWith(WITH_ID)
    );
  });
});

/* ------------- PRIORITY 0 · MCP tool availability from real scope --------- */

describe('MCP available tools', () => {
  const toolRow = name => screen.getByText(name).closest('li');

  it('locks every write tool for a read+list key', async () => {
    mount(<McpConnection />, WITH);
    await screen.findByText('create_file');
    for (const name of ['create_file', 'update_file', 'create_folder', 'move_file', 'copy_file']) {
      expect(within(toolRow(name)).getByText(/Requires/).textContent).toContain('write');
    }
    expect(within(toolRow('delete_file')).getByText(/Requires/).textContent).toContain('delete');
  });

  it('leaves the tools that key really can call unlocked', async () => {
    mount(<McpConnection />, WITH);
    await screen.findByText('list_files');
    for (const name of ['list_files', 'search_files', 'get_file', 'get_metadata']) {
      expect(within(toolRow(name)).queryByText(/Requires/)).toBeNull();
    }
  });

  it('unlocks the write tools for a key that actually holds write', async () => {
    const writer = {
      ...WITH,
      keys: [{ ...WITH.keys[0], scopes: { ops: ['read', 'list', 'write'], pathPrefix: '' } }]
    };
    mount(<McpConnection />, writer);
    await screen.findByText('create_file');
    expect(within(toolRow('create_file')).queryByText(/Requires/)).toBeNull();
    // Still locked: the key holds no delete.
    expect(within(toolRow('delete_file')).getByText(/Requires/)).toBeTruthy();
  });

  it('names scopes the way the API keys screen does', async () => {
    mount(<McpConnection />, WITH);
    await screen.findByText('create_file');
    expect(screen.queryByText('files:write')).toBeNull();
  });

  it('ticks nothing at all when the workspace has no usable key', async () => {
    mount(<McpConnection />, WITHOUT);
    await screen.findByText('No key to compute this from');
    expect(screen.queryByText('create_file')).toBeNull();
  });
});

/* ---------------- 18 #3 · connection badge and recent calls --------------- */

describe('MCP connection status', () => {
  it('does not claim "Connected" for keys that have never been used', async () => {
    mount(<McpConnection />, WITH);
    await screen.findByText('Never connected');
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('reports an active connection when there really has been a recent call', async () => {
    const busy = {
      ...WITH,
      events: [
        {
          id: 'ev_1',
          action: 'mcp.list_files',
          actor: { type: 'agent', id: 'agt_1' },
          result: 'success',
          at: new Date().toISOString()
        }
      ]
    };
    mount(<McpConnection />, busy);
    await screen.findByText('Active now');
  });

  it('gives Recent MCP calls the empty state every other list has', async () => {
    mount(<McpConnection />, WITH);
    await screen.findByText('No MCP calls yet');
  });

  it('lists real calls when there are some', async () => {
    const busy = {
      ...WITH,
      events: [
        {
          id: 'ev_1',
          action: 'mcp.create_file',
          actor: { type: 'agent', id: 'agt_1' },
          result: 'denied',
          at: new Date().toISOString()
        }
      ]
    };
    mount(<McpConnection />, busy);
    const panel = (await screen.findByText('Recent MCP calls')).closest('section');
    await waitFor(() => expect(within(panel).getByText('create_file')).toBeTruthy());
    // A denied call is shown as denied rather than quietly dropped.
    expect(within(panel).getByText(/Refused by the key/)).toBeTruthy();
    expect(screen.queryByText('No MCP calls yet')).toBeNull();
  });
});

/* -------------------------- 18 #9 · account menu -------------------------- */

describe('AccountMenu', () => {
  const setup = () => {
    const onNavigate = vi.fn();
    const onSignOut = vi.fn();
    render(
      <AccountMenu
        name="Kernel V5"
        email="kernelv5@example.com"
        profileHref="/w/ws_1/profile"
        onNavigate={onNavigate}
        onSignOut={onSignOut}
      />
    );
    return { onNavigate, onSignOut, user: userEvent.setup() };
  };

  it('opens a menu, which the old dead button never did', async () => {
    const { user } = setup();
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Kernel V5/ }));
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('advertises the menu to assistive tech before it is opened', () => {
    setup();
    const trigger = screen.getByRole('button', { name: /Kernel V5/ });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('goes to the profile', async () => {
    const { user, onNavigate } = setup();
    await user.click(screen.getByRole('button', { name: /Kernel V5/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Profile' }));
    expect(onNavigate).toHaveBeenCalledWith('/w/ws_1/profile');
  });

  it('signs out', async () => {
    const { user, onSignOut } = setup();
    await user.click(screen.getByRole('button', { name: /Kernel V5/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalled();
  });

  it('closes on Escape and hands focus back to the trigger', async () => {
    const { user } = setup();
    const trigger = screen.getByRole('button', { name: /Kernel V5/ });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

/* --------------------- 17 #7 / 18 #8 · billing has no flash -------------- */

describe('Settings → Billing', () => {
  it('shows only a loading state until the real fetch resolves', async () => {
    let resolve;
    const ctx = contextFor(WITH);
    ctx.api.getBilling = vi.fn(() => new Promise(r => { resolve = r; }));
    globalThis.__ws = ctx;
    globalThis.__auth = { user: { email: 'a@b.co' }, providerIds: [], changePassword: vi.fn() };

    const user = userEvent.setup();
    render(<MemoryRouter><Settings /></MemoryRouter>);
    await user.click(screen.getByRole('tab', { name: 'Billing' }));

    // The bug this replaces flashed a hardcoded "Pro — $20/month" here.
    expect(screen.getByText('Loading billing…')).toBeTruthy();
    expect(screen.queryByText(/Pro/)).toBeNull();
    expect(screen.queryByText(/\$20/)).toBeNull();

    resolve({ billing: { plan: 'free', status: 'active', ownerEmail: 'a@b.co', subscribed: false } });
    await screen.findByText('free');
  });
});

/* ------------------- 18 #11 · deleting a test workspace ------------------- */

describe('Settings → Danger zone', () => {
  function mountWithTwo(extra = {}) {
    const ctx = contextFor(WITH);
    ctx.workspaces = [
      { id: WITH_ID, name: 'My Workspace', role: 'owner' },
      { id: WITHOUT_ID, name: 'Abc', role: 'owner' }
    ];
    ctx.refresh = vi.fn().mockResolvedValue(undefined);
    ctx.api.deleteWorkspace = vi.fn().mockResolvedValue({ deleted: true, files: 0 });
    Object.assign(ctx, extra);
    globalThis.__ws = ctx;
    globalThis.__auth = { user: { email: 'a@b.co' }, providerIds: [], changePassword: vi.fn() };
    render(
      <MemoryRouter initialEntries={[`/w/${WITH_ID}/x`]}>
        <Routes>
          <Route path="/w/:ws/x" element={<Settings />} />
          {/* Where the app sends you after a workspace is gone. */}
          <Route path="/app" element={<p>picked another workspace</p>} />
        </Routes>
      </MemoryRouter>
    );
    return { ctx, user: userEvent.setup() };
  }

  it('will not arm the button until the name is typed exactly', async () => {
    const { user } = mountWithTwo();
    await user.click(screen.getByRole('button', { name: 'Delete workspace' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete workspace' });
    expect(confirm.disabled).toBe(true);

    await user.type(within(dialog).getByLabelText('Confirm'), 'My Workspac');
    expect(confirm.disabled).toBe(true);

    await user.type(within(dialog).getByLabelText('Confirm'), 'e');
    expect(confirm.disabled).toBe(false);
  });

  it('really calls the API, then re-reads the list before navigating', async () => {
    const { ctx, user } = mountWithTwo();
    await user.click(screen.getByRole('button', { name: 'Delete workspace' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Confirm'), 'My Workspace');
    await user.click(within(dialog).getByRole('button', { name: 'Delete workspace' }));

    await waitFor(() =>
      expect(ctx.api.deleteWorkspace).toHaveBeenCalledWith(WITH_ID, 'My Workspace')
    );
    // Navigating on a stale list sends you straight back to the workspace that
    // no longer exists.
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
    await screen.findByText('picked another workspace');
  });

  it('surfaces a refusal instead of pretending it worked', async () => {
    const { ctx, user } = mountWithTwo();
    ctx.api.deleteWorkspace = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('That name does not match this workspace.'), {
        requestId: 'req_1'
      }));
    await user.click(screen.getByRole('button', { name: 'Delete workspace' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Confirm'), 'My Workspace');
    await user.click(within(dialog).getByRole('button', { name: 'Delete workspace' }));

    await waitFor(() => expect(screen.getByText(/does not match/)).toBeTruthy());
    // Still open, so the person can see what happened and try again.
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('refuses to offer deletion of the only workspace at all', async () => {
    mountWithTwo({ workspaces: [{ id: WITH_ID, name: 'My Workspace', role: 'owner' }] });
    expect(screen.getByRole('button', { name: 'Delete workspace' }).disabled).toBe(true);
    expect(screen.getByText('This is your only workspace')).toBeTruthy();
  });
});
