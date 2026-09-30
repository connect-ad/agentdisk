/**
 * The email screen.
 *
 * It exists so an operator can answer "does outbound mail work here?" without
 * performing a real password reset on a real customer. Every assertion below is
 * about the screen telling the truth rather than about how it looks:
 *
 * **It never offers a button that cannot work.** When the deployment has no
 * email binding the control is inert and says why. Offering it anyway
 * would teach an operator that the console's buttons are suggestions.
 *
 * **A failure is shown as a failure.** This screen's whole purpose is to
 * surface a broken configuration; one that reported success regardless would be
 * worse than not existing, because somebody would cite it.
 *
 * **State is readable without colour.** `Configured` and `Not configured` are
 * words, per the house rule that no status is carried by a tone alone.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EmailSettings } from '../src/screens/EmailSettings.jsx';

afterEach(cleanup);

const CONFIGURED = {
  configured: true,
  sender: 'connect@agentdisk.io',
  provider: 'Cloudflare Email Service',
  composeDefaultSender: 'noreply@agentdisk.io',
  sendingDomain: 'agentdisk.io'
};

const UNCONFIGURED = { ...CONFIGURED, configured: false };

function renderScreen({ role = 'admin', status = CONFIGURED, test, compose, onToast = () => {} } = {}) {
  const api = {
    read: vi.fn(async () => status),
    test: test ?? vi.fn(async () => ({ sentTo: 'super@agentdisk.io', provider: 'Cloudflare Email Service' })),
    compose: compose ?? vi.fn(async body => ({ sent: true, from: body.from, to: ['customer@example.com'] }))
  };
  render(<EmailSettings role={role} onToast={onToast} api={api} />);
  return api;
}

describe('EmailSettings', () => {
  it('says the provider and the sender it would send from', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Cloudflare Email Service')).toBeInTheDocument());
    expect(screen.getByText('connect@agentdisk.io')).toBeInTheDocument();
  });

  it('names the configured state in words, not only a colour', async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByText(/^configured$/i)).toBeInTheDocument());

    cleanup();

    renderScreen({ status: UNCONFIGURED });
    await waitFor(() => expect(screen.getByText(/^not configured$/i)).toBeInTheDocument());
  });

  it('will not offer a test send when the deployment has no credentials', async () => {
    const api = renderScreen({ status: UNCONFIGURED });

    await waitFor(() => expect(screen.getByRole('button', { name: /send a test/i })).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /send a test/i }));
    expect(api.test).not.toHaveBeenCalled();

    // And it says why, rather than leaving a dead button unexplained.
    expect(screen.getByText(/no email binding/i)).toBeInTheDocument();
  });

  it('disables the test send below super_admin', async () => {
    // The server re-checks; this is the convenience half of the same gate.
    const api = renderScreen({ role: 'support' });

    await waitFor(() => expect(screen.getByRole('button', { name: /send a test/i })).toBeDisabled());
    expect(api.test).not.toHaveBeenCalled();
  });

  it('names the address it sent to, so the operator knows which inbox to open', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByRole('button', { name: /send a test/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /send a test/i }));

    await waitFor(() => expect(screen.getByText(/super@agentdisk\.io/)).toBeInTheDocument());
  });

  it('shows a failure as a failure', async () => {
    const failing = vi.fn(async () => {
      throw Object.assign(new Error('The message could not be sent.'), { status: 500 });
    });
    renderScreen({ test: failing });

    await waitFor(() => expect(screen.getByRole('button', { name: /send a test/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /send a test/i }));

    await waitFor(() => expect(screen.getByText(/could not be sent/i)).toBeInTheDocument());
  });
});

describe('EmailSettings → Compose', () => {
  function fill({ to = 'customer@example.com', subject = 'Hello', message = 'Body text' } = {}) {
    fireEvent.change(screen.getByLabelText('To'), { target: { value: to } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: subject } });
    fireEvent.change(screen.getByLabelText('Email message'), { target: { value: message } });
  }

  it('starts with noreply@ as the sender, and lets the operator change it', async () => {
    const api = renderScreen();

    const sender = await screen.findByLabelText('Sender email');
    expect(sender).toHaveValue('noreply@agentdisk.io');

    fireEvent.change(sender, { target: { value: 'billing@agentdisk.io' } });
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send email' }));

    await waitFor(() => expect(api.compose).toHaveBeenCalledTimes(1));
    expect(api.compose.mock.calls[0][0]).toEqual({
      from: 'billing@agentdisk.io',
      to: 'customer@example.com',
      subject: 'Hello',
      message: 'Body text',
      attachments: []
    });
  });

  it('sends an attachment as base64', async () => {
    const api = renderScreen();
    await screen.findByLabelText('Sender email');

    fill();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Attachment'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send email' }));

    await waitFor(() => expect(api.compose).toHaveBeenCalledTimes(1));
    expect(api.compose.mock.calls[0][0].attachments).toEqual([
      { filename: 'notes.txt', type: 'text/plain', content: btoa('hello') }
    ]);
  });

  it('stays disabled until every field is filled', async () => {
    renderScreen();
    await screen.findByLabelText('Sender email');

    expect(screen.getByRole('button', { name: 'Send email' })).toBeDisabled();
    fill();
    expect(screen.getByRole('button', { name: 'Send email' })).toBeEnabled();
  });

  it('will not send when the deployment has no email binding', async () => {
    renderScreen({ status: UNCONFIGURED });
    await screen.findByLabelText('Sender email');

    fill();
    expect(screen.getByRole('button', { name: 'Send email' })).toBeDisabled();
  });

  it('shows a failure as a failure', async () => {
    const compose = vi.fn(async () => {
      throw Object.assign(new Error('from: The sender must be an @agentdisk.io address.'), { status: 400 });
    });
    renderScreen({ compose });
    await screen.findByLabelText('Sender email');

    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send email' }));

    await waitFor(() => expect(screen.getByText(/must be an @agentdisk\.io address/)).toBeInTheDocument());
  });
});
