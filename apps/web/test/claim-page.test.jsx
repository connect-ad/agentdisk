/**
 * The `/claim/{token}` landing page.
 *
 * Two properties carry real consequences and are therefore what these tests are
 * about, rather than the page's appearance:
 *
 * **Neither destination is pre-selected.** "Create a new workspace" and "Add to
 * an existing workspace" differ in that the second spends an existing
 * workspace's storage quota and then deletes the sandbox. A default would make
 * that the path a distracted person takes by pressing the obvious button, so
 * the commit control stays disabled until somebody actually chooses.
 *
 * **The picker only offers workspaces the person may spend.** The API refuses a
 * reader outright; listing one here would only walk somebody into a refusal
 * that reads like a bug.
 *
 * The preview is served by the real, unauthenticated endpoint, so `previewClaim`
 * is what gets stubbed — not the component's internals.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const previewClaim = vi.fn();
const claimWorkspace = vi.fn();
const listWorkspaces = vi.fn();

vi.mock('../src/lib/api.js', () => ({
  previewClaim: (...args) => previewClaim(...args),
  createApiClient: () => ({ claimWorkspace, listWorkspaces }),
  ApiError: class ApiError extends Error {},
  isAuthError: () => false,
}));

const authState = { user: { uid: 'u1' }, loading: false, getToken: async () => 't' };
vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => authState,
}));

const { default: Claim } = await import('../src/routes/Claim.jsx');

const PREVIEW = {
  claimed: false,
  claimable: true,
  workspace: { id: 'ws_1', name: 'Agent Scratch', fileCount: 3, storageBytes: 2048 },
  agent: { name: 'researcher' },
  limits: { storageBytes: 52_428_800, files: 500, maxFileBytes: 104_857_600 },
  expiresAt: Date.now() + 86_400_000,
  deletesAt: Date.now() + 86_400_000,
  warning: null,
};

function renderClaim() {
  return render(
    <MemoryRouter initialEntries={['/claim/tok123']}>
      <Routes>
        <Route path="/claim/:token" element={<Claim />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  previewClaim.mockReset().mockResolvedValue(PREVIEW);
  claimWorkspace.mockReset().mockResolvedValue({
    claimed: true,
    mode: 'new',
    workspace: { id: 'ws_1', name: 'Agent Scratch', slug: 'agent-scratch' },
  });
  listWorkspaces.mockReset().mockResolvedValue({
    workspaces: [
      { id: 'ws_own', name: 'Owned', role: 'owner' },
      { id: 'ws_adm', name: 'Administered', role: 'admin' },
      { id: 'ws_read', name: 'Read Only', role: 'reader' },
    ],
  });
  authState.user = { uid: 'u1' };
  authState.loading = false;
});

afterEach(cleanup);

describe('the claim preview', () => {
  it('describes the workspace before anybody signs in', async () => {
    authState.user = null;
    renderClaim();

    expect(await screen.findByText(/Agent Scratch/)).toBeTruthy();
    expect(screen.getByText('researcher')).toBeTruthy();
    // The offer to sign in, not a redirect away from the page.
    expect(screen.getByRole('button', { name: /Sign in/ })).toBeTruthy();
  });

  it('reports an already-claimed workspace without describing it', async () => {
    previewClaim.mockResolvedValue({ claimed: true, claimable: false, reason: 'ALREADY_CLAIMED' });
    renderClaim();

    expect(await screen.findByText(/already been claimed/i)).toBeTruthy();
    expect(screen.queryByText(/Agent Scratch/)).toBeNull();
  });

  it('shows the API’s own warning text rather than recomputing it', async () => {
    previewClaim.mockResolvedValue({
      ...PREVIEW,
      workspace: { ...PREVIEW.workspace, storageBytes: 44_000_000 },
      warning: {
        code: 'SANDBOX_QUOTA_WARNING',
        dimension: 'storage',
        usedPercent: 84,
        message: 'This unclaimed workspace is at 84% of its temporary storage limit.',
        deletesInDays: 3,
      },
    });
    renderClaim();

    // The exact sentence the server produced, not a locally derived one.
    expect(
      await screen.findByText('This unclaimed workspace is at 84% of its temporary storage limit.')
    ).toBeTruthy();
  });
});

describe('choosing where the workspace goes', () => {
  it('pre-selects neither option and keeps the commit disabled until one is chosen', async () => {
    renderClaim();
    await screen.findByText(/Agent Scratch/);

    const options = screen.getAllByRole('radio');
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.getAttribute('aria-checked')).toBe('false');
    }

    expect(screen.getByRole('button', { name: /Claim workspace/ }).disabled).toBe(true);
  });

  it('arms the commit once a destination is picked', async () => {
    const user = userEvent.setup();
    renderClaim();
    await screen.findByText(/Agent Scratch/);

    await user.click(screen.getByRole('radio', { name: /Create a new workspace/ }));
    expect(screen.getByRole('button', { name: /Claim workspace/ }).disabled).toBe(false);
  });

  it('offers only workspaces the person owns or administers', async () => {
    const user = userEvent.setup();
    renderClaim();
    await screen.findByText(/Agent Scratch/);

    await user.click(screen.getByRole('radio', { name: /Add to an existing workspace/ }));

    await waitFor(() => expect(screen.getByRole('option', { name: 'Owned' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'Administered' })).toBeTruthy();
    // A reader cannot spend that workspace's quota, so it is not on offer.
    expect(screen.queryByRole('option', { name: 'Read Only' })).toBeNull();
  });

  it('keeps the commit disabled for an attach with no target chosen', async () => {
    const user = userEvent.setup();
    renderClaim();
    await screen.findByText(/Agent Scratch/);

    await user.click(screen.getByRole('radio', { name: /Add to an existing workspace/ }));
    expect(screen.getByRole('button', { name: /Add to workspace/ }).disabled).toBe(true);
  });

  /**
   * Confirmation, then a real call. `backlog/023` is a catalogue of controls in
   * this product that reported success for work that never happened, so the
   * assertion that matters is that the API was actually called with the chosen
   * mode - not that a success message appeared.
   */
  it('claims through the API after the confirmation, with the chosen mode', async () => {
    const user = userEvent.setup();
    renderClaim();
    await screen.findByText(/Agent Scratch/);

    await user.click(screen.getByRole('radio', { name: /Create a new workspace/ }));
    await user.click(screen.getByRole('button', { name: /Claim workspace/ }));

    const dialog = await screen.findByRole('dialog');
    // No "type the name" step: this is additive, not destructive, so that
    // friction would be miscalibrated here.
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: /^Claim workspace$/ }));

    await waitFor(() => expect(claimWorkspace).toHaveBeenCalledWith('tok123', { mode: 'new' }));
  });

  it('surfaces a refusal instead of reporting a success it did not get', async () => {
    const user = userEvent.setup();
    claimWorkspace.mockRejectedValue(new Error('This workspace has already been claimed.'));
    renderClaim();
    await screen.findByText(/Agent Scratch/);

    await user.click(screen.getByRole('radio', { name: /Create a new workspace/ }));
    await user.click(screen.getByRole('button', { name: /Claim workspace/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^Claim workspace$/ }));

    expect(await screen.findByText(/already been claimed/i)).toBeTruthy();
    expect(screen.queryByText(/Workspace claimed/)).toBeNull();
  });
});
