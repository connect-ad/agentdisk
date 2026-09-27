/**
 * The sandbox as a dialog (28 Sept 2026): one Copy takes both the key and
 * the claim link, the agent is named by the dialog, and closing throws the
 * credentials away.
 *
 * The claim link is the only door from a sandbox into an account, and the
 * API keeps only its hash. Until 27 Sept the page dropped it on the floor;
 * this pins that the dialog puts it in the same block as the key, so a
 * person who copies the key cannot fail to copy the link.
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

const { SandboxDialog, credentialsBlock } = await import('../src/components-local/SandboxDialog.jsx');

const CREATED = {
  workspace: { id: 'ws_SANDBOX0000000000000000000', deleteAfter: '2026-10-05T12:00:00.000Z' },
  agent: { name: 'sandbox-agent-20260928-120000' },
  apiKey: { token: 'ask_live_' + 'a'.repeat(32), lastFour: 'aaaa' },
  claim: { url: 'https://app.test/claim/tok_ONCE', expiresAt: '2026-10-05T12:00:00.000Z' },
};

function stubCreate(body) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(cleanup);

async function createSandbox(onClose = vi.fn()) {
  render(<SandboxDialog open onClose={onClose} />);
  const button = await screen.findByRole('button', { name: 'Create sandbox' });
  await waitFor(() => expect(button.disabled).toBe(false));
  await userEvent.click(button);
  await screen.findByRole('dialog', { name: 'Your sandbox credentials' });
  return onClose;
}

describe('sandbox dialog', () => {
  it('opens on the bot check with no field to fill', async () => {
    stubCreate(CREATED);
    render(<SandboxDialog open onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Get Sandbox Credentials' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('puts the key and the claim link in one block, so one Copy takes both', async () => {
    const fetchMock = stubCreate(CREATED);
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await createSandbox();

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/v1/workspaces');
    const block = screen.getByTestId('sandbox-credentials');
    const code = block.querySelector('.code__pre').textContent;
    expect(code).toBe(`AGENTDISK_KEY=${CREATED.apiKey.token}\nCLAIM_LINK=${CREATED.claim.url}`);
    // Exactly one code block: two would mean two Copy buttons and a link left behind.
    expect(block.querySelectorAll('.code__pre')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /Copy/ }));
    expect(writeText).toHaveBeenCalledWith(code);
    // The text says why both matter, and the shown-once rule.
    expect(block.textContent).toMatch(/Shown once/);
    expect(block.textContent).toMatch(/act as your agent/);
    expect(block.textContent).toMatch(/becomes the owner/);
  });

  it('names the agent itself, stamped with the time', async () => {
    const fetchMock = stubCreate(CREATED);
    await createSandbox();
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.agentName).toMatch(/^sandbox-agent-\d{8}-\d{6}$/);
    expect(sent.turnstileToken).toBe('turnstile-token');
  });

  it('closes from its own button, and the credentials leave with it', async () => {
    stubCreate(CREATED);
    const onClose = await createSandbox();
    await userEvent.click(screen.getByRole('button', { name: /copied both, close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // The parent re-renders it closed: nothing of the last sandbox survives a reopen.
    cleanup();
    const { rerender } = render(<SandboxDialog open={false} onClose={onClose} />);
    rerender(<SandboxDialog open onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Get Sandbox Credentials' })).toBeTruthy();
    expect(screen.queryByText(/ask_live_/)).toBeNull();
  });

  it('says so plainly when the deployment issued no link, and copies the key alone', async () => {
    stubCreate({ ...CREATED, claim: { url: null, expiresAt: null } });
    await createSandbox();
    expect(screen.getByRole('alert').textContent).toMatch(/no claim link/);
    const code = screen.getByTestId('sandbox-credentials').querySelector('.code__pre').textContent;
    expect(code).toBe(`AGENTDISK_KEY=${CREATED.apiKey.token}`);
    expect(screen.getByRole('button', { name: /copied the key, close/ })).toBeTruthy();
  });

  it('shows the server message verbatim on a refusal and re-arms the challenge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({ error: { message: 'Too many sandboxes from this address.' } }),
    }));
    render(<SandboxDialog open onClose={vi.fn()} />);
    const button = await screen.findByRole('button', { name: 'Create sandbox' });
    await waitFor(() => expect(button.disabled).toBe(false));
    await userEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Too many sandboxes/);
    expect(screen.getByRole('dialog', { name: 'Get Sandbox Credentials' })).toBeTruthy();
  });

  it('formats the block as two labelled lines', () => {
    expect(credentialsBlock(CREATED)).toBe(
      `AGENTDISK_KEY=${CREATED.apiKey.token}\nCLAIM_LINK=${CREATED.claim.url}`
    );
  });
});
