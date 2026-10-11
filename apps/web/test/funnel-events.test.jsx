/**
 * The two funnel events the marketing plan is read off (Skill 14 §4).
 *
 * `sign_up` and `purchase` were already tracked, and they measure people who
 * have committed. Neither can see the sandbox — the one flow a stranger can
 * use with no account, and therefore the only place the real top of the
 * funnel is visible at all. Until 11 Oct 2026 nothing measured it, so every
 * decision rule in Skill 14 §7 was unanswerable.
 *
 * These tests exist because an analytics call is exactly the kind of line
 * that gets dropped in a refactor without anything going red: no screen
 * changes, no request fails, the number simply stops arriving and the
 * dashboard quietly reads zero. That is indistinguishable from "nobody came",
 * which is the one reading that would send the plan in the wrong direction.
 *
 * They also pin the privacy rule. `lib/analytics.js` promises that no
 * parameter ever names a person, a workspace or a file; both events fire
 * next to exactly that data — a live API key, a claim token, a customer's
 * filename — so each is asserted to carry no payload at all.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// vi.mock is hoisted above every import, so the spies it closes over have to
// be created by vi.hoisted rather than a plain const — which would still be
// in its temporal dead zone when the factory runs.
const spies = vi.hoisted(() => ({
  trackEvent: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock('../src/lib/analytics.js', () => ({
  trackEvent: spies.trackEvent,
  trackPageView: vi.fn(),
}));
vi.mock('../src/lib/upload.js', () => ({ uploadFile: spies.uploadFile }));
vi.mock('../src/lib/workspace.jsx', () => ({ useWorkspace: () => globalThis.__ws }));

vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'test-site-key');
vi.stubEnv('VITE_API_BASE', 'https://api.test');

// A Turnstile that solves itself on render, so submit arms without a challenge.
window.turnstile = {
  render: (_el, options) => { queueMicrotask(() => options.callback('turnstile-token')); return 1; },
  remove: () => {},
};

const { SandboxDialog } = await import('../src/components-local/SandboxDialog.jsx');
const FileBrowser = (await import('../src/routes/FileBrowser.jsx')).default;

beforeEach(() => {
  spies.trackEvent.mockClear();
  spies.uploadFile.mockReset();
});
afterEach(cleanup);

/** Every call for one event name, as the full argument list it was given. */
const sent = name => spies.trackEvent.mock.calls.filter(c => c[0] === name);

describe('sandbox_created — somebody tried the product', () => {
  const CREATED = {
    workspace: { id: 'ws_SANDBOX0000000000000000000', deleteAfter: '2026-10-18T12:00:00.000Z' },
    agent: { name: 'sandbox-agent-20261011-120000' },
    apiKey: { token: 'ask_live_' + 'a'.repeat(32), lastFour: 'aaaa' },
    claim: { url: 'https://app.test/claim/tok_ONCE', expiresAt: '2026-10-18T12:00:00.000Z' },
  };

  async function submit(response) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    render(<SandboxDialog open onClose={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Create sandbox' });
    await waitFor(() => expect(button.disabled).toBe(false));
    await userEvent.click(button);
  }

  it('fires once when the API really created a sandbox', async () => {
    await submit({ ok: true, status: 201, json: async () => CREATED });
    await screen.findByRole('dialog', { name: 'Your sandbox credentials' });
    expect(sent('sandbox_created')).toHaveLength(1);
  });

  it('sends no parameters, because the response is a live credential', async () => {
    await submit({ ok: true, status: 201, json: async () => CREATED });
    await screen.findByRole('dialog', { name: 'Your sandbox credentials' });
    // `trackEvent(name)` and nothing more. A second argument here would be the
    // workspace id, the agent name or the key itself travelling to Google.
    expect(sent('sandbox_created')[0]).toEqual(['sandbox_created']);
    expect(JSON.stringify(spies.trackEvent.mock.calls)).not.toContain('ask_live_');
  });

  it('does not fire when the API refused', async () => {
    await submit({
      ok: false, status: 429, json: async () => ({ error: { message: 'Too many requests.' } }),
    });
    await screen.findByText(/Too many requests/);
    expect(sent('sandbox_created')).toHaveLength(0);
  });
});

describe('file_stored — somebody used the product', () => {
  const WS = 'ws_01M1WTCVFG3VEX6VRHCZWN1SK2';
  const FILE_A = {
    id: 'fil_A', name: 'notes.md', path: '/notes.md', mimeType: 'text/markdown',
    sizeBytes: 2048, updatedAt: new Date().toISOString(), createdBy: 'usr_1',
    checksumSha256: 'a'.repeat(64),
  };

  async function mountBrowser() {
    globalThis.__ws = {
      api: { listFiles: vi.fn(async () => ({ files: [FILE_A] })) },
      workspaceId: WS,
      canWrite: true,
    };
    render(
      <MemoryRouter initialEntries={[`/w/${WS}/files`]}>
        <Routes><Route path="/w/:ws/files" element={<FileBrowser />} /></Routes>
      </MemoryRouter>
    );
    await screen.findByText('notes.md');
  }

  /** The hidden input is the keyboard path into the same handler the dropzone uses. */
  const choose = file => userEvent.upload(document.querySelector('input[type="file"]'), file);

  it('fires once when an upload completed', async () => {
    spies.uploadFile.mockResolvedValue({});
    await mountBrowser();
    await choose(new File(['hello'], 'invoice.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(sent('file_stored')).toHaveLength(1));
  });

  it("names no file, because the filename is the customer's", async () => {
    spies.uploadFile.mockResolvedValue({});
    await mountBrowser();
    await choose(new File(['x'], 'acme-contract-2026.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(sent('file_stored')).toHaveLength(1));
    expect(sent('file_stored')[0]).toEqual(['file_stored']);
    expect(JSON.stringify(spies.trackEvent.mock.calls)).not.toContain('acme-contract');
  });

  it('does not fire when the upload failed', async () => {
    spies.uploadFile.mockRejectedValue(
      Object.assign(new Error('Network lost'), { step: 'transfer' })
    );
    await mountBrowser();
    await choose(new File(['x'], 'doomed.bin'));
    await screen.findByText(/Network lost/);
    expect(sent('file_stored')).toHaveLength(0);
  });
});
