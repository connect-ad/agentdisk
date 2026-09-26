/**
 * The `/s/{token}` public share page.
 *
 * Two properties carry consequences and are what these tests are about:
 *
 * **A refused token says nothing about why.** The API answers expired, revoked
 * and never-existed with one identical 404 precisely so that the page cannot
 * confirm which guesses are real tokens. A page that explained the difference
 * would hand back the oracle the API just refused to be.
 *
 * **A folder share lists what is public right now.** It is resolved live, so
 * the listing is the answer to "what does this link currently expose".
 *
 * The preview is served by the real, unauthenticated endpoint, so `previewShare`
 * is what gets stubbed — not the component's internals.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const previewShare = vi.fn();
const sharedDownloadWithPassword = vi.fn();

/** What the API client throws for a protected link. */
function passwordRefusal(message) {
  const err = new Error(message);
  err.details = { passwordRequired: true };
  return err;
}

vi.mock('../src/lib/api.js', () => ({
  previewShare: (...args) => previewShare(...args),
  sharedDownloadUrl: (token, fileId) => `https://api.test/v1/shares/open/${token}/download/${fileId}`,
  sharedDownloadWithPassword: (...args) => sharedDownloadWithPassword(...args),
  isPasswordRequired: (err) => err?.details?.passwordRequired === true,
  ApiError: class ApiError extends Error {},
}));

const { default: SharePage } = await import('../src/routes/SharePage.jsx');

function renderAt(token = 'tok123') {
  return render(
    <MemoryRouter initialEntries={[`/s/${token}`]}>
      <Routes>
        <Route path="/s/:token" element={<SharePage />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  previewShare.mockReset();
  sharedDownloadWithPassword.mockReset();
});

describe('a file share', () => {
  it('names the file and offers a download', async () => {
    previewShare.mockResolvedValue({
      kind: 'file',
      name: 'q3-report.pdf',
      workspaceName: 'Acme',
      expiresAt: '2026-10-01T00:00:00.000Z',
      files: [
        {
          id: 'fil_1',
          name: 'q3-report.pdf',
          path: '/q3-report.pdf',
          sizeBytes: 2048,
          mimeType: 'application/pdf',
        },
      ],
    });

    renderAt();

    await waitFor(() => expect(screen.getByText('q3-report.pdf')).toBeTruthy());
    const link = screen.getByRole('link', { name: /download/i });
    expect(link.getAttribute('href')).toContain('/download/fil_1');
  });
});

describe('a folder share', () => {
  it('lists every file the link currently exposes', async () => {
    previewShare.mockResolvedValue({
      kind: 'folder',
      name: '/reports',
      workspaceName: 'Acme',
      expiresAt: '2026-10-01T00:00:00.000Z',
      files: [
        { id: 'fil_1', name: 'a.md', path: '/reports/a.md', sizeBytes: 10, mimeType: 'text/markdown' },
        { id: 'fil_2', name: 'b.md', path: '/reports/b.md', sizeBytes: 20, mimeType: 'text/markdown' },
      ],
    });

    renderAt();

    await waitFor(() => expect(screen.getByText('a.md')).toBeTruthy());
    expect(screen.getByText('b.md')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /download/i })).toHaveLength(2);
  });
});

describe('a refused token', () => {
  it('renders the not-found state without saying why', async () => {
    previewShare.mockRejectedValue(new Error("This link isn't available."));

    renderAt('whatever');

    await waitFor(() => expect(screen.getByText(/isn't available/i)).toBeTruthy());

    // The whole point. If any of these words reached the page, it would tell a
    // guesser which tokens had once been real.
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/expired/i);
    expect(body).not.toMatch(/revoked/i);
    expect(body).not.toMatch(/deleted/i);
  });
});

describe('a password-protected share', () => {
  const FILE = {
    kind: 'file',
    name: 'secret.txt',
    workspaceName: 'Acme',
    expiresAt: '2026-10-01T00:00:00.000Z',
    files: [{ id: 'fil_S', name: 'secret.txt', path: '/secret.txt', sizeBytes: 5, mimeType: 'text/plain' }],
  };

  it('asks for the password, shows the server\'s sentence when it is wrong, and opens when right', async () => {
    const user = userEvent.setup();
    previewShare
      .mockRejectedValueOnce(passwordRefusal('This link needs a password.'))
      .mockRejectedValueOnce(passwordRefusal("That password isn't right."))
      .mockResolvedValueOnce(FILE);

    renderAt('tokpw');

    const field = await screen.findByLabelText(/password/i);
    expect(screen.queryByText('secret.txt')).toBeNull();

    await user.type(field, 'nope-nope');
    await user.click(screen.getByRole('button', { name: /open/i }));
    expect(await screen.findByText(/isn't right/i)).toBeTruthy();

    await user.clear(field);
    await user.type(field, 'right-one');
    await user.click(screen.getByRole('button', { name: /open/i }));

    await screen.findByText('secret.txt');
    expect(previewShare).toHaveBeenLastCalledWith('tokpw', undefined, 'right-one');
    // No plain link: the password cannot ride on one.
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
    expect(screen.getByRole('button', { name: /download/i })).toBeTruthy();
  });

  it('downloads through the password route, not a plain link', async () => {
    const user = userEvent.setup();
    previewShare
      .mockRejectedValueOnce(passwordRefusal('This link needs a password.'))
      .mockResolvedValueOnce(FILE);
    sharedDownloadWithPassword.mockRejectedValue(new Error('This link isn\'t available.'));

    renderAt('tokpw');
    await user.type(await screen.findByLabelText(/password/i), 'right-one');
    await user.click(screen.getByRole('button', { name: /open/i }));
    await user.click(await screen.findByRole('button', { name: /download/i }));

    expect(sharedDownloadWithPassword).toHaveBeenCalledWith('tokpw', 'fil_S', 'right-one');
    expect(await screen.findByText(/isn't available/i)).toBeTruthy();
  });
});
