/**
 * The Support form sends.
 *
 * Until 26 September 2026 the screen rendered the design's ticket form with
 * the button disabled and a banner saying nothing was behind it. Pinned here:
 * the banner is gone, the button calls the API with the topic the person
 * picked plus what they typed, success is said out loud and the form clears,
 * and a refusal is shown rather than swallowed — on the one screen where a
 * silently lost message costs the most.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const sendSupportRequest = vi.fn(() => Promise.resolve({ sent: true }));

const workspaceState = {
  api: { sendSupportRequest },
  workspaceId: 'ws_test',
  role: 'reader',
  workspace: { id: 'ws_test', name: 'Kessler Labs' },
};
vi.mock('../src/lib/workspace.jsx', () => ({ useWorkspace: () => workspaceState }));

const Support = (await import('../src/routes/Support.jsx')).default;

afterEach(() => {
  cleanup();
  sendSupportRequest.mockReset();
  sendSupportRequest.mockImplementation(() => Promise.resolve({ sent: true }));
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/w/kessler-labs/support']}>
      <Routes>
        <Route path="/w/:ws/support" element={<Support />} />
      </Routes>
    </MemoryRouter>
  );
}

function fill() {
  fireEvent.change(screen.getByLabelText(/subject/i), { target: { value: 'Agent gets 403 since 09:00' } });
  fireEvent.change(screen.getByLabelText(/what happened/i), { target: { value: 'Key ending abcd, path /reports.' } });
}

describe('the Support form', () => {
  it('no longer says it cannot send', () => {
    renderPage();
    expect(screen.queryByText(/cannot send yet/i)).toBeNull();
    expect(screen.queryByText(/no support endpoint/i)).toBeNull();
  });

  it('keeps Send disabled until both fields are filled', () => {
    renderPage();
    const send = screen.getByRole('button', { name: /send request/i });
    expect(send.disabled).toBe(true);
    fill();
    expect(send.disabled).toBe(false);
  });

  it('sends the chosen topic, subject and message to the API and says so', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('radio', { name: /key or scope problem/i }));
    fill();
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() => expect(sendSupportRequest).toHaveBeenCalledTimes(1));
    expect(sendSupportRequest).toHaveBeenCalledWith('ws_test', {
      topic: 'keys',
      subject: 'Agent gets 403 since 09:00',
      message: 'Key ending abcd, path /reports.',
    });
    expect((await screen.findByRole('status')).textContent).toMatch(/sent/i);
    // The form clears, so pressing again cannot send the same message twice.
    expect(screen.getByLabelText(/subject/i).value).toBe('');
    expect(screen.getByLabelText(/what happened/i).value).toBe('');
  });

  it('shows the refusal and keeps what was typed when the API fails', async () => {
    sendSupportRequest.mockImplementation(() => Promise.reject(new Error('Email delivery is not configured.')));
    renderPage();
    fill();
    fireEvent.click(screen.getByRole('button', { name: /send request/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/not configured/i);
    expect(screen.getByLabelText(/subject/i).value).toBe('Agent gets 403 since 09:00');
  });
});
