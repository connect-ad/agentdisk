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

/** Opens the row's State pill and returns the portalled menu. */
async function openMenu(user, row) {
  await user.click(within(row).getByRole('button', { name: /Actions$/ }));
  return screen.findByRole('menu');
}

describe('keys table → the State pill', () => {
  it.each([
    ['live', 'ok', 'Active', 'Active'],
    ['paused', 'warn', 'Disabled', 'Disabled'],
    ['orphan', 'warn', 'Disabled', 'Disabled, its agent is off'],
    ['stale', 'warn', 'Expired', 'Expired'],
    ['killed', 'danger', 'Revoked', 'Revoked by support']
  ])('%s is a %s pill reading "%s", "%s" on hover', async (name, tone, label, title) => {
    mount(<ApiKeys />);
    const pill = (await rowOf(name)).querySelector('.kst');
    expect(pill.className).toContain(`kst--${tone}`);
    expect(pill.querySelector('.kst__label').textContent).toBe(label);
    expect(pill.getAttribute('title')).toBe(title);
  });

  it('marks a working key with a dot and a disabled one with the caution triangle', async () => {
    mount(<ApiKeys />);
    const live = (await rowOf('live')).querySelector('.kst');
    expect(live.querySelector('.kst__dot')).toBeTruthy();
    const paused = (await rowOf('paused')).querySelector('.kst');
    const orphan = (await rowOf('orphan')).querySelector('.kst');
    expect(paused.querySelector('.kst__dot')).toBeNull();
    // The same shape for both disabled causes: the first SVG in the pill is
    // the mark (the chevron comes after the label).
    const path = el => el.querySelector('svg path').getAttribute('d');
    expect(path(paused)).toBe(path(orphan));
    expect(path(paused)).toMatch(/^M12 3\.5L21\.5 20h-19z/);
  });

  it('is a plain label, not a button, for a reader', async () => {
    mount(<ApiKeys />, { role: 'reader' });
    const row = await rowOf('live');
    expect(row.querySelector('.kst')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Actions$/ })).toBeNull();
  });
});

describe('keys table → the pill is the menu, and every item still confirms', () => {
  it('offers Disable and Delete on a live key, Enable and Delete on a paused one', async () => {
    const user = userEvent.setup();
    mount(<ApiKeys />);
    let menu = await openMenu(user, await rowOf('live'));
    expect(within(menu).getByRole('menuitem', { name: 'Disable' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Enable' })).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    menu = await openMenu(user, await rowOf('paused'));
    expect(within(menu).getByRole('menuitem', { name: 'Enable' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Disable' })).toBeNull();
  });

  it('offers only Delete where a switch would do nothing: agent-off, expired, revoked', async () => {
    const user = userEvent.setup();
    mount(<ApiKeys />);
    for (const name of ['orphan', 'stale', 'killed']) {
      const menu = await openMenu(user, await rowOf(name));
      expect(within(menu).getAllByRole('menuitem').map(m => m.textContent)).toEqual(['Delete']);
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    }
  });

  it('closes on Escape and hands focus back to the pill', async () => {
    const user = userEvent.setup();
    mount(<ApiKeys />);
    const row = await rowOf('live');
    await openMenu(user, row);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(within(row).getByRole('button', { name: /Actions$/ }));
  });

  it('confirms Enable before rotating, and then shows the new key', async () => {
    const user = userEvent.setup();
    const api = mount(<ApiKeys />);
    const menu = await openMenu(user, await rowOf('paused'));
    await user.click(within(menu).getByRole('menuitem', { name: 'Enable' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/issues a new key/i)).toBeTruthy();
    expect(api.setKeyStatus).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Enable key' }));
    expect(api.setKeyStatus).toHaveBeenCalledWith(WS, 'key_2', 'active');
    await screen.findByText('ask_live_bbbb_ROTATED');
  });

  it('confirms Disable and Delete from the menu too', async () => {
    const user = userEvent.setup();
    const api = mount(<ApiKeys />);
    let menu = await openMenu(user, await rowOf('live'));
    await user.click(within(menu).getByRole('menuitem', { name: 'Disable' }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/enabling issues a new key/i)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    menu = await openMenu(user, await rowOf('live'));
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/cannot be undone/)).toBeTruthy();
    expect(api.deleteKey).not.toHaveBeenCalled();
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

  it('keeps the masked key and the eye on one line, as a bare icon', async () => {
    mount(<ApiKeys />);
    const cell = (await rowOf('live')).querySelector('.ds__kkey');
    expect(cell).toBeTruthy();
    expect(within(cell).getByText(/ask_live_aaaa/)).toBeTruthy();
    const eye = within(cell).getByRole('button', { name: 'Show live' });
    expect(eye.className).toBe('icon-btn');
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

describe('keys table → column widths', () => {
  it('gives every column a width, so no one column absorbs the slack', async () => {
    // The bug this replaces: Key had no width, so in an auto-layout table it
    // took all the leftover space and the gap before Scope grew with the
    // window. A column with no width is the defect, whatever the numbers are.
    mount(<ApiKeys />);
    await rowOf('live');
    const widths = Array.from(document.querySelectorAll('.tbl thead th')).map(th => th.style.width);
    expect(widths).toEqual(['23%', '12%', '31%', '13%', '9%', '12%']);
    expect(widths.reduce((n, w) => n + parseFloat(w), 0)).toBe(100);
  });
});

describe('keys table → scope on two lines', () => {
  it('puts the operations on one line and the path on the next', async () => {
    mount(<ApiKeys />);
    const scope = (await rowOf('scoped')).querySelector('.ds__kscope');
    const lines = Array.from(scope.querySelectorAll('span')).map(s => s.textContent);
    expect(lines).toEqual(['read, list', '/demo/demo/*']);
    expect(screen.queryByText('read, list · /demo/demo/*')).toBeNull();
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
