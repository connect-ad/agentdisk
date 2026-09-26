/**
 * Closing your own account from the dashboard.
 *
 * Two things are pinned. The dialog says what actually happens — the owner's
 * words, both phases, what stays and where — because a destructive dialog that
 * describes the wrong behaviour is the one a customer discovers is wrong at the
 * worst moment. And the button does exactly one thing in exactly one order:
 * call the API with the typed address, sign out of Firebase, land on the closed
 * page. A dashboard that kept rendering against a refused session would be the
 * confusing half of a correct deletion.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

const signOut = vi.fn(() => Promise.resolve());
const navigate = vi.fn();
const deleteAccount = vi.fn(() =>
  Promise.resolve({ closed: true, workspacesDeleted: 2, filesQueued: 3, billing: 'cancelled', purgeAfter: '2026-10-03T00:00:00.000Z' })
);

vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => ({
    user: { uid: 'fb_1', displayName: 'Rina Kessler', email: 'rina@kesslerlabs.dev', emailVerified: true },
    updateDisplayName: vi.fn(),
    requestEmailChange: vi.fn(),
    signOut,
  }),
  describeAuthError: err => err?.message ?? 'Something went wrong.',
}));

const workspaceState = {
  api: { logoutEverywhere: vi.fn(), deleteAccount },
  workspaceId: 'ws_test',
  role: 'reader',
  workspace: { id: 'ws_guest', name: 'Somebody Else' },
  workspaces: [
    { id: 'ws_a', name: 'Kessler Labs', role: 'owner' },
    { id: 'ws_b', name: 'Side project', role: 'owner' },
    { id: 'ws_guest', name: 'Somebody Else', role: 'reader' },
  ],
};
vi.mock('../src/lib/workspace.jsx', () => ({ useWorkspace: () => workspaceState }));

vi.mock('react-router-dom', async importOriginal => ({
  ...(await importOriginal()),
  useNavigate: () => navigate,
}));

const Profile = (await import('../src/routes/Profile.jsx')).default;
const { AccountClosed } = await import('../src/routes/ErrorPages.jsx');

afterEach(() => {
  cleanup();
  signOut.mockClear();
  navigate.mockClear();
  deleteAccount.mockClear();
});

function openDialog() {
  render(<MemoryRouter><Profile /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /delete account/i }));
  return screen.getByRole('dialog');
}

describe('the Delete account dialog', () => {
  it('is live, and opens from a workspace the person only reads', () => {
    const dialog = openDialog();
    expect(dialog).toBeTruthy();
    expect(screen.queryByText('Not available yet')).toBeNull();
  });

  it('names the owned workspaces and not the guest one', () => {
    const dialog = openDialog();
    expect(dialog.textContent).toMatch(/Kessler Labs, Side project/);
    expect(dialog.textContent).not.toMatch(/Somebody Else/);
  });

  it('says what goes now, what goes in 7 days, and what stays at Stripe', () => {
    const dialog = openDialog();
    expect(dialog.textContent).toMatch(/API key, agent identity, webhook and share link/);
    expect(dialog.textContent).toMatch(/guests.{0,3} access/);
    expect(dialog.textContent).toMatch(/erased within 7 days/);
    expect(dialog.textContent).toMatch(/sign-in and email address/);
    expect(dialog.textContent).toMatch(/invoices stay, at Stripe, for seven years/);
    expect(dialog.textContent).toMatch(/Download what you want to keep/);
  });

  it('keeps the red button disabled until the address is typed, in any case', () => {
    openDialog();
    const confirm = screen.getByRole('button', { name: 'Delete my account' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/type your email address/i), { target: { value: 'rina@other.dev' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/type your email address/i), { target: { value: 'RINA@kesslerlabs.dev' } });
    expect(confirm.disabled).toBe(false);
  });

  it('calls the API with the typed address, signs out, then lands on the closed page', async () => {
    openDialog();
    fireEvent.change(screen.getByLabelText(/type your email address/i), { target: { value: 'rina@kesslerlabs.dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(deleteAccount).toHaveBeenCalledWith('ws_test', 'rina@kesslerlabs.dev');
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(deleteAccount.mock.invocationCallOrder[0]).toBeLessThan(signOut.mock.invocationCallOrder[0]);
    expect(navigate).toHaveBeenCalledWith('/account-closed', {
      replace: true,
      state: { erasesAt: '2026-10-03T00:00:00.000Z', email: 'rina@kesslerlabs.dev' },
    });
  });

  it('shows the refusal and stays signed in when the API says no', async () => {
    deleteAccount.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('We could not end your subscription, so nothing was deleted.'), { requestId: 'req_1' }))
    );
    openDialog();
    fireEvent.change(screen.getByLabelText(/type your email address/i), { target: { value: 'rina@kesslerlabs.dev' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    await screen.findByText(/could not end your subscription.*request req_1/);
    expect(signOut).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('the closed page', () => {
  function Probe() {
    const { pathname } = useLocation();
    return <span data-testid="path">{pathname}</span>;
  }

  it('names the date and the address when it arrives from the dialog', () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/account-closed', state: { erasesAt: '2026-10-03T00:00:00.000Z', email: 'rina@kesslerlabs.dev' } }]}>
        <Routes><Route path="/account-closed" element={<><AccountClosed /><Probe /></>} /></Routes>
      </MemoryRouter>
    );
    expect(screen.getByText('Your account is closed')).toBeTruthy();
    expect(screen.getByText('Files and sign-in erased on 3 October 2026')).toBeTruthy();
    expect(screen.getByText('We will email rina@kesslerlabs.dev on 3 October 2026 when it is done')).toBeTruthy();
    expect(screen.getByText('You can sign up again with the same address after 3 October 2026')).toBeTruthy();
  });

  it('invents no date on a direct visit', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/account-closed']}>
        <Routes><Route path="/account-closed" element={<AccountClosed />} /></Routes>
      </MemoryRouter>
    );
    expect(screen.getByText('Your account is closed')).toBeTruthy();
    // No fact rows at all: nothing to put in them that would be true.
    expect(container.querySelectorAll('.err__fact')).toHaveLength(0);
  });
});
