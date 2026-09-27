/**
 * The Sandbox result screen shows the claim link the API returns.
 *
 * The API has returned `claim.url` since claiming shipped, and this screen
 * ignored it, so every sandbox made in a browser was unclaimable from birth
 * and nobody could tell: the key worked, the files landed, and the one-time
 * link had already been thrown away. This pins the link on screen, its
 * expiry, and the warning shown when a deployment issues none.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.stubEnv('VITE_TURNSTILE_SITE_KEY', 'test-site-key');
vi.stubEnv('VITE_API_BASE', 'https://api.test');

// A Turnstile that solves itself the moment it renders, so the submit button
// arms without a real challenge.
window.turnstile = {
  render: (_el, options) => { queueMicrotask(() => options.callback('turnstile-token')); return 1; },
  remove: () => {},
};

const { Sandbox } = await import('../src/routes/Sandbox.jsx');

const CREATED = {
  workspace: {
    id: 'ws_SANDBOX0000000000000000000',
    deleteAfter: '2026-10-04T12:00:00.000Z',
    limits: {
      storageBytes: 50 * 1024 * 1024, files: 500, maxFileBytes: 100 * 1024 * 1024,
      egressBytesPerPeriod: 500 * 1024 * 1024, requestsPerPeriod: 10000, shareLinks: 0,
    },
  },
  agent: { name: 'sandbox-agent' },
  apiKey: { token: 'ask_live_' + 'a'.repeat(32), lastFour: 'aaaa' },
  claim: {
    url: 'https://app.test/claim/tok_ONCE',
    expiresAt: '2026-10-04T12:00:00.000Z',
  },
};

function stubCreate(body) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(cleanup);

async function createSandbox() {
  render(<Sandbox />);
  const button = await screen.findByRole('button', { name: 'Create sandbox' });
  await waitFor(() => expect(button.disabled).toBe(false));
  await userEvent.click(button);
  await screen.findByText('Your sandbox is ready');
}

describe('sandbox result screen', () => {
  it('shows the claim link beside the key, with its expiry', async () => {
    const fetchMock = stubCreate(CREATED);
    await createSandbox();

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/v1/workspaces');
    const block = screen.getByTestId('claim-link');
    expect(block.textContent).toContain('https://app.test/claim/tok_ONCE');
    expect(block.textContent).toMatch(/shown once/);
    // Locale decides the order of day and month; the date itself is pinned.
    expect(block.textContent).toMatch(/expires on (4 October|October 4)/);
    // The key is still there too; the link is added, not swapped in.
    expect(screen.getAllByText(/ask_live_/).length).toBeGreaterThan(0);
  });

  it('states the key validity, the deletion date and the sandbox limits from the response', async () => {
    stubCreate(CREATED);
    await createSandbox();

    const terms = screen.getByTestId('sandbox-terms').textContent;
    expect(terms).toMatch(/No expiry and no use limit/);
    expect(terms).toMatch(/deleted on (4 October|October 4)/);
    expect(terms).toMatch(/50 MB · 500 files · 100 MB per file/);
    expect(terms).toMatch(/500 MB download · 10,000 requests/);
    expect(terms).toMatch(/None until claimed/);
    expect(terms).toMatch(/key keeps working/);
  });

  it('says so plainly when the deployment issued no link', async () => {
    stubCreate({ ...CREATED, claim: { url: null, expiresAt: null } });
    await createSandbox();

    expect(screen.queryByTestId('claim-link')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/no claim link/);
  });
});
