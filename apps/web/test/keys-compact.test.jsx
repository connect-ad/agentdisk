/**
 * The compact keys row (22 Sept 2026).
 *
 * Status and Actions became icons to give the key, scope and name the width.
 * What these tests pin is that nothing was lost in the shrinking: every icon
 * still has its word (as the accessible name and hover text), every action
 * still confirms before touching a credential — Enable included, since it
 * rotates — and the secret is shown only inside a dialog that takes it with
 * it when it closes. The form limits mirror the API's: fifteen characters
 * for a name, two levels for a path restriction.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../src/lib/workspace.jsx', async () => {
  const actual = await vi.importActual('../src/lib/workspace.jsx');
  return { ...actual, useWorkspace: () => globalThis.__ws };
});

const ApiKeys = (await import('../src/routes/ApiKeys.jsx')).default;
const Agents = (await import('../src/routes/Agents.jsx')).default;

afterEach(() => { cleanup(); globalThis.__ws = undefined; });

const WS = 'ws_01M1WTCVFG3VEX6VRHCZWN1SK2';

function key(overrides) {
  return {
    id: 'key_1',
    name: 'reader',
    prefix: 'ask_live_aaaa',
    lastFour: 'aaaa',
    status: 'active',
    disabledBy: null,
    retrievable: true,
    agentId: 'agt_1',
    lastUsedAt: null,
    expiresAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    scopes: { ops: ['read', 'list'], pathPrefix: '' },
    ...overrides
  };
}

const KEYS = [
  key({ id: 'key_1', name: 'live' }),
  key({ id: 'key_2', name: 'paused', status: 'disabled', disabledBy: 'key' }),
  key({ id: 'key_3', name: 'orphan', status: 'disabled', disabledBy: 'agent' }),
  key({ id: 'key_4', name: 'stale', status: 'expired' }),
  key({ id: 'key_5', name: 'killed', status: 'revoked' }),
  key({ id: 'key_6', name: 'ancient', retrievable: false }),
  key({ id: 'key_7', name: 'scoped', scopes: { ops: ['read', 'list'], pathPrefix: '/demo/demo' } })
];

function apiFor(overrides = {}) {
  return {
    listKeys: vi.fn().mockResolvedValue({ keys: KEYS }),
    listAgents: vi.fn().mockResolvedValue({ agents: [{ id: 'agt_1', name: 'bot', status: 'active' }] }),
    revealKey: vi.fn().mockResolvedValue({ secret: 'ask_live_aaaa_THE_WHOLE_SECRET_VALUE' }),
    setKeyStatus: vi.fn().mockResolvedValue({ key: {}, secret: 'ask_live_bbbb_ROTATED', rotated: true }),
    deleteKey: vi.fn().mockResolvedValue({ deleted: true }),
    createKey: vi.fn().mockResolvedValue({ key: {}, secret: 'ask_live_cccc_NEW' }),
    createAgent: vi.fn().mockResolvedValue({ agent: { id: 'agt_2', name: 'x', status: 'active' } }),
    ...overrides
  };
}

function mount(ui, { role = 'owner', api } = {}) {
  const client = api ?? apiFor();
  globalThis.__ws = {
    workspaceId: WS,
    workspaceSlug: 'my-workspace',
    workspace: { id: WS, slug: 'my-workspace', name: 'My Workspace', role },
    workspaces: [],
    role,
    canWrite: role === 'owner',
    loading: false,
    error: null,
    api: client,
    select: vi.fn(), create: vi.fn(), refresh: vi.fn(), resolveWorkspace: vi.fn()
  };
  render(
    <MemoryRouter initialEntries={['/w/my-workspace/keys']}>
      <Routes>
        <Route path="/w/:ws/keys" element={ui} />
        <Route path="/w/:ws/agents" element={ui} />
      </Routes>
    </MemoryRouter>
  );
  return client;
}

const rowOf = async name => (await screen.findByText(name)).closest('tr');

describe('keys table → status as an icon with its word', () => {
  it.each([
    ['live', 'Active'],
    ['paused', 'Disabled'],
    ['orphan', 'Disabled, its agent is off'],
    ['stale', 'Expired'],
    ['killed', 'Revoked by support']
  ])('%s reads "%s" on hover and to a screen reader', async (name, label) => {
    mount(<ApiKeys />);
    const row = await rowOf(name);
    const stat = row.querySelector('.ds__kstat');
    expect(stat.getAttribute('title')).toBe(label);
    expect(within(row).getByText(label).className).toBe('sr-only');
  });

  it('marks the disabled ones with the caution triangle', async () => {
    mount(<ApiKeys />);
    const paused = (await rowOf('paused')).querySelector('.ds__kstat');
    expect(paused.className).toContain('ds__kstat--warn');
    const live = (await rowOf('live')).querySelector('.ds__kstat');
    expect(live.className).toContain('ds__kstat--ok');
    // Same SVG path for both disabled causes: a triangle, not a tick.
    const orphan = (await rowOf('orphan')).querySelector('.ds__kstat svg path').getAttribute('d');
    expect(paused.querySelector('svg path').getAttribute('d')).toBe(orphan);
    expect(live.querySelector('svg path').getAttribute('d')).not.toBe(orphan);
  });
});

describe('keys table → actions as icons that still confirm', () => {
  it('offers Disable and Delete on a live key, Enable and Delete on a paused one', async () => {
    mount(<ApiKeys />);
    const live = await rowOf('live');
    expect(within(live).getByRole('button', { name: 'Disable' })).toBeTruthy();
    expect(within(live).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(within(live).queryByRole('button', { name: 'Enable' })).toBeNull();

    const paused = await rowOf('paused');
    expect(within(paused).getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(within(paused).queryByRole('button', { name: 'Disable' })).toBeNull();
  });

  it('offers no switch where the switch would do nothing: agent-off, expired, revoked', async () => {
    mount(<ApiKeys />);
    for (const name of ['orphan', 'stale', 'killed']) {
      const row = await rowOf(name);
      expect(within(row).queryByRole('button', { name: 'Enable' })).toBeNull();
      expect(within(row).queryByRole('button', { name: 'Disable' })).toBeNull();
      expect(within(row).getByRole('button', { name: 'Delete' })).toBeTruthy();
    }
  });

  it('confirms Enable before rotating, and then shows the new key', async () => {
    const user = userEvent.setup();
    const api = mount(<ApiKeys />);
    await user.click(within(await rowOf('paused')).getByRole('button', { name: 'Enable' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/issues a new key/i)).toBeTruthy();
    expect(api.setKeyStatus).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Enable key' }));
    expect(api.setKeyStatus).toHaveBeenCalledWith(WS, 'key_2', 'active');
    await screen.findByText('ask_live_bbbb_ROTATED');
  });

  it('carries the word as hover text on every action icon', async () => {
    mount(<ApiKeys />);
    const live = await rowOf('live');
    expect(within(live).getByRole('button', { name: 'Disable' }).getAttribute('title')).toBe('Disable');
    expect(within(live).getByRole('button', { name: 'Delete' }).getAttribute('title')).toBe('Delete');
  });
});

describe('keys table → the eye opens a dialog', () => {
  it('shows the secret in a dialog and nowhere in the table', async () => {
    const user = userEvent.setup();
    const api = mount(<ApiKeys />);
    const row = await rowOf('live');
    await user.click(within(row).getByRole('button', { name: 'Show live' }));

    const dialog = await screen.findByRole('dialog');
    expect(api.revealKey).toHaveBeenCalledWith(WS, 'key_1');
    expect(within(dialog).getByText('ask_live_aaaa_THE_WHOLE_SECRET_VALUE')).toBeTruthy();
    expect(within(row).queryByText('ask_live_aaaa_THE_WHOLE_SECRET_VALUE')).toBeNull();
    // The sentence that used to live here claimed we could not show it again.
    expect(within(dialog).queryByText(/cannot show it again/)).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('ask_live_aaaa_THE_WHOLE_SECRET_VALUE')).toBeNull());
  });

  it('keeps the masked key and the eye on one line', async () => {
    mount(<ApiKeys />);
    const cell = (await rowOf('live')).querySelector('.ds__kkey');
    expect(cell).toBeTruthy();
    expect(within(cell).getByText(/ask_live_aaaa/)).toBeTruthy();
    expect(within(cell).getByRole('button', { name: 'Show live' })).toBeTruthy();
  });

  it('disables the eye on a key minted before keys were kept, and says why', async () => {
    mount(<ApiKeys />);
    const row = await rowOf('ancient');
    const eye = within(row).getByRole('button', { name: /Created before keys were kept/ });
    expect(eye.disabled).toBe(true);
  });

  it('shows no eye to a reader', async () => {
    mount(<ApiKeys />, { role: 'reader' });
    const row = await rowOf('live');
    expect(within(row).queryByRole('button', { name: /^Show/ })).toBeNull();
  });
});

describe('keys table → scope on two lines', () => {
  it('puts the operations on one line and the path on the next', async () => {
    mount(<ApiKeys />);
    const scope = (await rowOf('scoped')).querySelector('.ds__kscope');
    const lines = Array.from(scope.querySelectorAll('span')).map(s => s.textContent);
    expect(lines).toEqual(['read, list', '/demo/demo/*']);
    const plain = (await rowOf('live')).querySelector('.ds__kscope');
    expect(Array.from(plain.querySelectorAll('span')).map(s => s.textContent)).toEqual(['read, list', '/*']);
  });
});

describe('create key form → the limits the API enforces', () => {
  it('stops a name at 15 characters', async () => {
    const user = userEvent.setup();
    mount(<ApiKeys />);
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(/Name/);
    expect(name.getAttribute('maxlength')).toBe('15');
    await user.type(name, 'sixteen-chars-xx');
    expect(name.value).toBe('sixteen-chars-x');
  });

  it('refuses a path restriction deeper than two levels before calling the API', async () => {
    const user = userEvent.setup();
    const api = mount(<ApiKeys />);
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Name/), 'deep');
    await user.type(within(dialog).getByLabelText(/Restrict to path/), '/abc/dev/x');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    await within(dialog).findByText(/at most 2 levels/);
    expect(api.createKey).not.toHaveBeenCalled();
  });

  it('accepts two levels with a trailing star', async () => {
    const user = userEvent.setup();
    const api = mount(<ApiKeys />);
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Name/), 'two');
    await user.type(within(dialog).getByLabelText(/Restrict to path/), '/abc/dev/*');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(api.createKey).toHaveBeenCalled());
    expect(api.createKey.mock.calls[0][1].pathPrefix).toBe('/abc/dev/*');
  });
});

describe('create agent form → the same name limit', () => {
  it('stops a name at 15 characters', async () => {
    const user = userEvent.setup();
    globalThis.__ws = undefined;
    const client = apiFor({ listAgents: vi.fn().mockResolvedValue({ agents: [] }) });
    globalThis.__ws = {
      workspaceId: WS, workspaceSlug: 'my-workspace',
      workspace: { id: WS, slug: 'my-workspace', name: 'My Workspace', role: 'owner' },
      workspaces: [], role: 'owner', canWrite: true, loading: false, error: null, api: client,
      select: vi.fn(), create: vi.fn(), refresh: vi.fn(), resolveWorkspace: vi.fn()
    };
    render(
      <MemoryRouter initialEntries={['/w/my-workspace/agents']}>
        <Routes><Route path="/w/:ws/agents" element={<Agents />} /></Routes>
      </MemoryRouter>
    );
    await user.click(await screen.findByRole('button', { name: 'Create agent' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Name/).getAttribute('maxlength')).toBe('15');
  });
});
