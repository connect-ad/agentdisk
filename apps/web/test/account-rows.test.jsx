/**
 * The Account screen, against `AgentDisk Dashboard.dc.html`.
 *
 * Two things are pinned here, and neither is "it renders".
 *
 * The first is the measure. `.acct--account` sat in app.css unused while this
 * page rendered full-bleed, which is the kind of divergence nothing catches:
 * the build is clean, the tests pass, and the screen is simply wider than the
 * design every day until somebody puts the two side by side.
 *
 * The second is which of the reference's five rows are allowed to exist. It
 * draws an editable TIME ZONE and three named devices with cities and IPs,
 * and nothing in apps/api stores a time zone or records a session. A row that
 * looks exactly like the four real ones beside it is the most believable
 * possible place to put invented data.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

const updateDisplayName = vi.fn(() => Promise.resolve());
const requestEmailChange = vi.fn(() => Promise.resolve());

let authState = {
  user: {
    uid: 'firebase_uid_31c8fa0e77',
    displayName: 'Rina Kessler',
    email: 'rina@kesslerlabs.dev',
    emailVerified: true
  },
  updateDisplayName,
  requestEmailChange
};
vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => authState,
  describeAuthError: err => err?.message ?? 'Something went wrong.'
}));

let workspaceState = {
  api: { logoutEverywhere: vi.fn(() => Promise.resolve()) },
  workspaceId: 'ws_test',
  role: 'owner',
  workspace: { id: 'ws_test', name: 'Kessler Labs' }
};
vi.mock('../src/lib/workspace.jsx', () => ({
  useWorkspace: () => workspaceState
}));

const Profile = (await import('../src/routes/Profile.jsx')).default;

afterEach(() => {
  cleanup();
  updateDisplayName.mockClear();
  requestEmailChange.mockClear();
});

describe('Account layout', () => {
  it('is held to the reference measure rather than the full content column', () => {
    const { container } = render(<Profile />);
    expect(container.querySelector('.acct--account')).toBeTruthy();
  });

  it('draws the reference five rows, in its order', () => {
    const { container } = render(<Profile />);
    const keys = [...container.querySelectorAll('.acctrow__k')].map(el => el.textContent);
    expect(keys).toEqual(['FULL NAME', 'EMAIL', 'ROLE', 'TIME ZONE', 'USER ID']);
  });

  it('fills them from the signed-in user and the open workspace', () => {
    render(<Profile />);
    expect(screen.getByText('Rina Kessler')).toBeTruthy();
    expect(screen.getByText('rina@kesslerlabs.dev')).toBeTruthy();
    expect(screen.getByText('Owner · Kessler Labs')).toBeTruthy();
    expect(screen.getByText('firebase_uid_31c8fa0e77')).toBeTruthy();
    expect(screen.getByText('VERIFIED')).toBeTruthy();
  });

  it('offers no way to edit a time zone nothing would store', () => {
    const { container } = render(<Profile />);
    const row = [...container.querySelectorAll('.acctrow')]
      .find(el => el.querySelector('.acctrow__k')?.textContent === 'TIME ZONE');
    expect(row).toBeTruthy();
    expect(row.querySelector('.acctrow__edit')).toBeNull();
    // And it says where the value came from, so a row that looks like the four
    // real ones beside it cannot read as a saved preference.
    expect(row.textContent).toMatch(/From this browser/);
  });
});

describe('Active sessions', () => {
  it('shows the current session and invents no others', () => {
    const { container } = render(<Profile />);
    expect(container.querySelectorAll('.sessrow')).toHaveLength(1);
    expect(screen.getByText('THIS DEVICE')).toBeTruthy();
    // The reference's fixture devices, and anything shaped like the IP
    // addresses it prints beside them.
    expect(container.textContent).not.toMatch(/MacBook|iPhone|adk CLI|\d+\.\d+\.\d+\.\d+/);
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull();
  });
});

describe('Editing a row', () => {
  it('saves the name through Firebase rather than reporting a success it did not do', async () => {
    render(<Profile />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const field = screen.getByLabelText('Full name');
    fireEvent.change(field, { target: { value: 'Rina K' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateDisplayName).toHaveBeenCalledWith('Rina K'));
  });

  it('refuses to send a verification link to the address already on the account', async () => {
    render(<Profile />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Send link' }));
    await screen.findByText('Enter a different address to move this account to.');
    expect(requestEmailChange).not.toHaveBeenCalled();
  });
});
