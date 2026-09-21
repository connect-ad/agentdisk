/**
 * The dashboard's share-link dialog (Task 10 of the share-links plan).
 *
 * Every test here is chosen to fail against a plausible half-implementation:
 *  - the expiry default is asserted by *value*, not by presence of the control
 *  - the free-plan refusal is asserted by disabled state AND wording, driven by
 *    a `limits` prop that varies between tests (never a fixture baked into the
 *    component)
 *  - the folder warning's live count/size is asserted only once a mocked
 *    `api.listFiles` call resolves, so a hardcoded warning with no wiring behind
 *    it fails
 *  - the existing-link and revoke flows are asserted against the actual API
 *    calls the mocks record, not just a toast or a vanished element
 *  - the create-vs-revoke ConfirmModal distinction is asserted by the rendered
 *    button variant (danger vs primary), which is exactly what `destructive`
 *    controls in ConfirmModal.jsx — so passing the wrong flag fails the test
 *
 * No jest-dom matchers: nothing else in this repo's test suite extends chai
 * with them, so assertions here stick to the vanilla `.disabled` / `.value` /
 * `.className` checks the rest of `apps/web/test` already uses.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

afterEach(cleanup);

const ShareModal = (await import('../src/components-local/ShareModal.jsx')).default;

const WS = 'ws_01M1WTCVFG3VEX6VRHCZWN1SK2';
const FILE_TARGET = { kind: 'file', id: 'fil_A', name: 'q3.pdf' };
const FOLDER_TARGET = { kind: 'folder', name: '/reports', path: '/reports' };

describe('ShareModal → expiry', () => {
  it('offers seven days by default', () => {
    render(<ShareModal open target={FILE_TARGET} limits={{ shareLinks: 100 }} />);
    expect(screen.getByLabelText(/expires/i).value).toBe('7d');
  });
});

describe('ShareModal → free plan', () => {
  it('tells a free-plan user why they cannot share, in words, computed from real limits', () => {
    render(<ShareModal open target={FILE_TARGET} limits={{ shareLinks: 0 }} />);
    // Both the alert's title and its body name the plan, so this checks the
    // dialog's text as a whole rather than picking one node — the same
    // convention `file-browser-wiring.test.jsx` uses for prose assertions.
    expect(document.body.textContent).toMatch(/not available on your plan/i);
    expect(screen.getByRole('button', { name: /create link/i }).disabled).toBe(true);
  });

  it('offers an upgrade path from the same refusal', () => {
    render(<ShareModal open target={FILE_TARGET} limits={{ shareLinks: 0 }} ws="acme" />);
    const upgrade = screen.getByRole('link', { name: /upgrade/i });
    expect(upgrade.getAttribute('href')).toMatch(/acme/);
  });

  it('re-enables the button once the same modal is given a plan that allows it', () => {
    const { rerender } = render(<ShareModal open target={FILE_TARGET} limits={{ shareLinks: 0 }} />);
    expect(screen.getByRole('button', { name: /create link/i }).disabled).toBe(true);

    rerender(<ShareModal open target={FILE_TARGET} limits={{ shareLinks: 10 }} />);
    expect(screen.getByRole('button', { name: /create link/i }).disabled).toBe(false);
  });
});

describe('ShareModal → folder target', () => {
  it('warns that a shared folder publishes anything added to it later', () => {
    render(<ShareModal open target={FOLDER_TARGET} limits={{ shareLinks: 100 }} />);
    expect(screen.queryByText(/anything added to this folder/i)).not.toBeNull();
  });

  it('shows the live count and size the link would currently expose, read from the real API', async () => {
    const listFiles = vi.fn(async () => ({
      files: [{ sizeBytes: 1024 }, { sizeBytes: 2048 }]
    }));
    const listShares = vi.fn(async () => ({ shares: [] }));
    render(
      <ShareModal
        open
        target={FOLDER_TARGET}
        limits={{ shareLinks: 100 }}
        api={{ listFiles, listShares }}
        workspaceId={WS}
      />
    );

    await waitFor(() => expect(listFiles).toHaveBeenCalledWith(WS, { path: '/reports' }));
    await screen.findByText(/2 files/i);
    await screen.findByText(/3(\.0)? KB/i);
  });

  it('does not warn a file target about later additions', () => {
    render(<ShareModal open target={FILE_TARGET} limits={{ shareLinks: 100 }} />);
    expect(screen.queryByText(/anything added to this folder/i)).toBeNull();
  });

  it('confirms before creating a folder link, additively rather than as a danger action', async () => {
    const user = userEvent.setup();
    const createShare = vi.fn(async () => ({
      share: { id: 'shr_1', url: 'https://app.example/s/tok', expiresAt: new Date(Date.now() + 1000).toISOString() }
    }));
    const listShares = vi.fn(async () => ({ shares: [] }));
    render(
      <ShareModal
        open
        target={FOLDER_TARGET}
        limits={{ shareLinks: 100 }}
        api={{ createShare, listShares, listFiles: vi.fn(async () => ({ files: [] })) }}
        workspaceId={WS}
      />
    );

    await waitFor(() => expect(listShares).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /create link/i }));

    const confirmButton = await screen.findByRole('button', { name: /share folder/i });
    // The additive confirmation must not borrow the danger treatment: that is
    // exactly what `destructive={false}` buys in ConfirmModal, rendered here
    // as a primary button rather than a danger one.
    expect(confirmButton.className).toMatch(/btn--primary/);
    expect(confirmButton.className).not.toMatch(/btn--danger/);

    expect(createShare).not.toHaveBeenCalled();
    await user.click(confirmButton);
    await waitFor(() => expect(createShare).toHaveBeenCalledWith(WS, expect.objectContaining({ path: '/reports' })));
  });
});

describe('ShareModal → creating a file link', () => {
  it('calls the real API with the file id and shows the created link', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const createShare = vi.fn(async () => ({
      share: {
        id: 'shr_9', url: 'https://app.example/s/abc123',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      }
    }));
    const listShares = vi.fn(async () => ({ shares: [] }));
    render(
      <ShareModal
        open
        target={FILE_TARGET}
        limits={{ shareLinks: 100 }}
        api={{ createShare, listShares }}
        workspaceId={WS}
        onCreated={onCreated}
      />
    );

    await waitFor(() => expect(listShares).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /create link/i }));

    await waitFor(() => expect(createShare).toHaveBeenCalledWith(WS, expect.objectContaining({ fileId: 'fil_A' })));
    await screen.findByDisplayValue('https://app.example/s/abc123');
    expect(screen.queryByText(/active/i)).not.toBeNull();
    expect(onCreated).toHaveBeenCalled();
  });

  it('shows the server refusal rather than a link that was never created', async () => {
    const user = userEvent.setup();
    const createShare = vi.fn(async () => {
      throw new Error('This workspace has used all of its share links. Revoke one, or upgrade for more.');
    });
    const listShares = vi.fn(async () => ({ shares: [] }));
    render(
      <ShareModal
        open
        target={FILE_TARGET}
        limits={{ shareLinks: 1 }}
        api={{ createShare, listShares }}
        workspaceId={WS}
      />
    );

    await waitFor(() => expect(listShares).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /create link/i }));

    await screen.findByText(/used all of its share links/i);
  });

  it('sends no expiry at all for the seven-day default', async () => {
    // The defect this pins. Sending `browserNow + 7 days` asks for exactly the
    // server's ceiling, and the server computes that ceiling from `ctx.now` -
    // captured before any I/O, on a clock that only advances on I/O. So the
    // default preset was refused whenever the isolate's clock was stale, which
    // is most of the time. Seven days is already what an absent expiresAt
    // means, decided by the only clock that matters.
    const user = userEvent.setup();
    const createShare = vi.fn(async () => ({
      share: { id: 'shr_1', url: 'https://app.example/s/tok', expiresAt: new Date().toISOString() }
    }));
    const listShares = vi.fn(async () => ({ shares: [] }));
    render(
      <ShareModal open target={FILE_TARGET} limits={{ shareLinks: 100 }}
        api={{ createShare, listShares }} workspaceId={WS} />
    );

    await waitFor(() => expect(listShares).toHaveBeenCalled());
    expect(screen.getByLabelText(/expires/i).value).toBe('7d');
    await user.click(screen.getByRole('button', { name: /create link/i }));

    await waitFor(() => expect(createShare).toHaveBeenCalled());
    expect(createShare.mock.calls[0][1]).toEqual({ fileId: 'fil_A' });
  });

  it('still sends an explicit expiry for a preset with headroom', async () => {
    const user = userEvent.setup();
    const createShare = vi.fn(async () => ({
      share: { id: 'shr_2', url: 'https://app.example/s/tok2', expiresAt: new Date().toISOString() }
    }));
    const listShares = vi.fn(async () => ({ shares: [] }));
    render(
      <ShareModal open target={FILE_TARGET} limits={{ shareLinks: 100 }}
        api={{ createShare, listShares }} workspaceId={WS} />
    );

    await waitFor(() => expect(listShares).toHaveBeenCalled());
    await user.selectOptions(screen.getByLabelText(/expires/i), '1h');
    await user.click(screen.getByRole('button', { name: /create link/i }));

    await waitFor(() => expect(createShare).toHaveBeenCalled());
    expect(createShare.mock.calls[0][1].expiresAt).toEqual(expect.any(String));
  });

  it('offers no custom date', () => {
    render(<ShareModal open target={FILE_TARGET} limits={{ shareLinks: 100 }} />);
    const options = [...screen.getByLabelText(/expires/i).options].map(o => o.value);
    expect(options).toEqual(['1h', '24h', '7d']);
  });
});

describe('ShareModal → an existing link', () => {
  it('shows a badge pairing a tone with a word, plus copy and revoke controls', async () => {
    const listShares = vi.fn(async () => ({
      shares: [{
        id: 'shr_live', kind: 'file', fileId: 'fil_A', path: null,
        url: 'https://app.example/s/existing',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }]
    }));
    render(
      <ShareModal
        open
        target={FILE_TARGET}
        limits={{ shareLinks: 100 }}
        api={{ listShares }}
        workspaceId={WS}
      />
    );

    await screen.findByDisplayValue('https://app.example/s/existing');
    expect(screen.queryByText(/active/i)).not.toBeNull();
    expect(screen.getByRole('button', { name: /copy/i })).not.toBeNull();
    expect(screen.getByRole('button', { name: /revoke/i })).not.toBeNull();
  });

  it('revokes through a destructive ConfirmModal and calls the real API', async () => {
    const user = userEvent.setup();
    const listShares = vi.fn(async () => ({
      shares: [{
        id: 'shr_live', kind: 'file', fileId: 'fil_A', path: null,
        url: 'https://app.example/s/existing',
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }]
    }));
    const revokeShare = vi.fn(async () => ({ revoked: true }));
    render(
      <ShareModal
        open
        target={FILE_TARGET}
        limits={{ shareLinks: 100 }}
        api={{ listShares, revokeShare }}
        workspaceId={WS}
      />
    );

    await screen.findByDisplayValue('https://app.example/s/existing');
    await user.click(screen.getByRole('button', { name: /revoke/i }));

    const confirmDialog = await screen.findByRole('dialog', { name: /revoke/i });
    const confirmButton = within(confirmDialog).getByRole('button', { name: /revoke/i });
    // Revoking is destructive, and keeps ConfirmModal's default rather than
    // overriding it — the opposite of the folder-create confirmation above.
    expect(confirmButton.className).toMatch(/btn--danger/);

    await user.click(confirmButton);
    await waitFor(() => expect(revokeShare).toHaveBeenCalledWith(WS, 'shr_live'));
    await waitFor(() => expect(screen.queryByDisplayValue('https://app.example/s/existing')).toBeNull());
  });
});

describe('ShareModal → focus', () => {
  it('keeps focus on the expiry field while it is being changed', async () => {
    const user = userEvent.setup();
    render(<ShareModal open target={FILE_TARGET} limits={{ shareLinks: 100 }} />);

    const field = screen.getByLabelText(/expires/i);
    await user.click(field);
    // A dialog whose focus-restoring effect depends on an inline `onClose`
    // re-runs per interaction and throws focus onto the close button — the bug
    // this project has shipped before. Changing the value here would fail if
    // this modal reproduced it.
    await user.selectOptions(field, '1h');
    expect(document.activeElement).toBe(field);
  });
});
