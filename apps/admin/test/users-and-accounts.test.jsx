/**
 * The Users list and the Admin Accounts screen, as of 2 October 2026.
 *
 * Users became a browsable list: a filter, a status, page sizes of 10, 20, 50
 * and 100, and Previous and Next. Each request the screen makes is pinned here,
 * because the server refuses any page size outside that set and a mismatch
 * would show as an error rather than a wrong page.
 *
 * Admin Accounts was refused to every operator by a stale `super_admin` gate,
 * and its add dialog sent the `support` role, which the server rejects. These
 * pin the add flow sending `admin`.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listCalls = [];
const created = vi.fn();
let total = 0;

function person(n) {
  return {
    id: `usr_${n}`,
    email: `person${n}@example.com`,
    emailVerifiedAt: n % 2 === 0 ? 1 : null,
    isProvisional: 0,
    deletedAt: null,
    disabledAt: n === 3 ? 1 : null,
    createdAt: 1_759_000_000_000,
    memberships: 1
  };
}

vi.mock('../src/api.js', () => ({
  adminApi: {
    listUsers: async params => {
      listCalls.push(params);
      const start = params.offset;
      const end = Math.min(start + params.limit, total);
      const users = [];
      for (let i = start; i < end; i += 1) users.push(person(i + 1));
      return { users, total, limit: params.limit, offset: params.offset };
    },
    listAccounts: async () => ({
      accounts: [
        { id: 'adm_1', email: 'kernelv5@gmail.com', role: 'admin', createdAt: 1, lastLoginAt: 2, disabledAt: null }
      ]
    }),
    createAccount: async (email, role, reason) => {
      created(email, role, reason);
      return { account: {} };
    }
  }
}));

const { Users, PAGE_SIZES, resetUserListFilter } = await import('../src/screens/Users.jsx');
const { AdminAccounts } = await import('../src/screens/AdminAccounts.jsx');

beforeEach(() => {
  listCalls.length = 0;
  created.mockReset();
  resetUserListFilter();
});
afterEach(cleanup);

describe('the user list', () => {
  it('offers exactly the page sizes the server accepts', () => {
    expect(PAGE_SIZES).toEqual([10, 20, 50, 100]);
  });

  it('shows the first page of twenty, and the range it covers', async () => {
    total = 45;
    render(<Users onNavigate={() => {}} />);
    expect(await screen.findByText('person1@example.com')).toBeInTheDocument();
    expect(screen.getByText('person20@example.com')).toBeInTheDocument();
    expect(screen.queryByText('person21@example.com')).toBeNull();
    expect(screen.getByText('1–20 of 45')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(listCalls.at(-1)).toMatchObject({ status: 'all', limit: 20, offset: 0 });
  });

  it('pages forward and back, and stops at the ends', async () => {
    total = 45;
    const user = userEvent.setup();
    render(<Users onNavigate={() => {}} />);
    await screen.findByText('person1@example.com');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('41–45 of 45')).toBeInTheDocument();
    expect(listCalls.at(-1)).toMatchObject({ limit: 20, offset: 40 });
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('21–40 of 45')).toBeInTheDocument();
  });

  it('changes the page size and goes back to the first page', async () => {
    total = 150;
    const user = userEvent.setup();
    render(<Users onNavigate={() => {}} />);
    await screen.findByText('person1@example.com');

    await user.selectOptions(screen.getByLabelText('Rows per page'), '100');
    expect(await screen.findByText('1–100 of 150')).toBeInTheDocument();
    expect(listCalls.at(-1)).toMatchObject({ limit: 100, offset: 0 });

    await user.selectOptions(screen.getByLabelText('Rows per page'), '10');
    expect(await screen.findByText('1–10 of 150')).toBeInTheDocument();
  });

  it('sends the filter and the status to the server', async () => {
    total = 5;
    const user = userEvent.setup();
    render(<Users onNavigate={() => {}} />);
    await screen.findByText('person1@example.com');

    await user.selectOptions(screen.getByLabelText('Status'), 'disabled');
    await user.type(screen.getByLabelText('Filter users'), 'gmail.com');
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() =>
      expect(listCalls.at(-1)).toMatchObject({ q: 'gmail.com', status: 'disabled', offset: 0 })
    );

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(listCalls.at(-1)).toMatchObject({ q: undefined, status: 'all' }));
  });

  it('opens a user when their row is clicked', async () => {
    total = 3;
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(<Users onNavigate={navigate} />);
    await user.click(await screen.findByText('person2@example.com'));
    expect(navigate).toHaveBeenCalledWith('/users/usr_2');
  });
});

describe('admin accounts', () => {
  it('lists every admin, and adds one with the only role the server accepts', async () => {
    const user = userEvent.setup();
    render(<AdminAccounts currentAdminId="adm_1" onToast={() => {}} />);
    expect(await screen.findByText('kernelv5@gmail.com')).toBeInTheDocument();
    // One role means nothing to change.
    expect(screen.queryByRole('button', { name: 'Role' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add admin' }));
    expect(screen.queryByLabelText('Role')).toBeNull();
    await user.type(screen.getByLabelText('Admin email'), 'new@agentdisk.io');
    await user.type(screen.getByLabelText(/Reason/), 'joining the support rota');
    await user.click(screen.getByRole('button', { name: 'Grant access' }));

    await waitFor(() =>
      expect(created).toHaveBeenCalledWith('new@agentdisk.io', 'admin', 'joining the support rota')
    );
    // The dialog closes once the account exists.
    await waitFor(() => expect(screen.queryByLabelText('Admin email')).toBeNull());
  });
});
