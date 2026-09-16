/**
 * Settings → Privacy, from the 16 Sept 2026 live validation pass.
 *
 * This tab carried both of the product's outright false promises and two false
 * statements of fact. "Export my data" opened a modal saying an email would
 * arrive within 24 hours, and started nothing; "Delete my account" set a toast
 * reading "Account deletion scheduled", and scheduled nothing. Neither had any
 * mechanism behind it.
 *
 * The rule these tests encode: a control that cannot work is *disabled with a
 * reason*, never a success message. A success state for work that did not happen
 * leaves somebody's model of the system wrong with no way to notice — and for
 * account deletion specifically, believing it is underway is what stops a person
 * taking any other step.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/lib/workspace.jsx', () => ({
  useWorkspace: () => globalThis.__ws
}));

const { PrivacyTab } = await import('../src/routes/SettingsTabs.jsx');

afterEach(cleanup);

const WS = 'ws_01M1WTCVFG3VEX6VRHCZWN1SK2';

function mount(api) {
  globalThis.__ws = { api, workspaceId: WS, canWrite: true };
  render(<MemoryRouter><PrivacyTab /></MemoryRouter>);
}

/** One workspace owned alone, one owned with a co-owner, one merely joined. */
const REALISTIC = {
  listWorkspaces: async () => ({
    workspaces: [
      { id: 'ws_solo', name: 'Solo', role: 'owner' },
      { id: 'ws_shared', name: 'Shared', role: 'owner' },
      { id: 'ws_guest', name: 'Guest', role: 'reader' }
    ]
  }),
  listMembers: async id => ({
    members: id === 'ws_solo'
      ? [{ id: 'm1', role: 'owner' }]
      : [{ id: 'm1', role: 'owner' }, { id: 'm2', role: 'owner' }]
  })
};

describe('Privacy → the two controls that promised what does not exist', () => {
  it('offers export as disabled, with no promise of an email', async () => {
    const user = userEvent.setup();
    mount(REALISTIC);

    const button = await screen.findByRole('button', { name: 'Export my data' });
    expect(button.disabled).toBe(true);

    await user.click(button);
    // The old modal said "We'll email you a download link within 24 hours".
    expect(screen.queryByText(/email you a download link/i)).toBeNull();
    expect(screen.queryByText(/within 24 hours/i)).toBeNull();
    expect(screen.getAllByText(/Not available yet/).length).toBeGreaterThan(0);
  });

  it('offers account deletion as disabled, and never claims it was scheduled', async () => {
    const user = userEvent.setup();
    mount(REALISTIC);

    const button = await screen.findByRole('button', { name: 'Delete my account' });
    expect(button.disabled).toBe(true);

    await user.click(button);
    expect(screen.queryByText(/Account deletion scheduled/i)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Privacy → the sole-owner guard', () => {
  it('counts workspaces this person owns alone, from real membership', async () => {
    mount(REALISTIC);

    // ws_solo has one owner; ws_shared has two; ws_guest is not owned at all.
    await screen.findByText(/only owner of 1 workspace/);
  });

  it('says nothing when every owned workspace has a co-owner', async () => {
    mount({
      listWorkspaces: async () => ({ workspaces: [{ id: 'ws_shared', name: 'Shared', role: 'owner' }] }),
      listMembers: async () => ({ members: [{ id: 'm1', role: 'owner' }, { id: 'm2', role: 'owner' }] })
    });

    await screen.findByRole('button', { name: 'Delete my account' });
    expect(screen.queryByText(/only owner of/)).toBeNull();
  });

  it('does not block on a membership request that merely failed', async () => {
    mount({
      listWorkspaces: async () => ({ workspaces: [{ id: 'ws_solo', name: 'Solo', role: 'owner' }] }),
      listMembers: async () => { throw new Error('network'); }
    });

    await screen.findByRole('button', { name: 'Delete my account' });
    expect(screen.queryByText(/only owner of/)).toBeNull();
  });
});

describe('Privacy → statements of fact', () => {
  it('names the transactional email provider that is actually configured', async () => {
    mount(REALISTIC);

    await screen.findByText('MailerSend');
    // Resend was simply the wrong vendor -- naming it was the false statement.
    expect(screen.queryByText('Resend')).toBeNull();
  });

  it('claims no data residency, because the system has no region concept', async () => {
    mount(REALISTIC);

    await screen.findByRole('button', { name: 'Export my data' });
    expect(document.body.textContent).not.toMatch(/region you chose/i);
  });
});
