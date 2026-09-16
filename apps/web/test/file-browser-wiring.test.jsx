/**
 * The file browser's wiring, from the 16 Sept 2026 live validation pass.
 *
 * Every test here exists because a control reported success for work that never
 * happened. Delete set a "Deleted" toast and sent no request; Create folder's
 * confirm button was `onClick={() => setDialog(null)}`; Download had no handler
 * at all. The screen had no test file of any kind, which is precisely how three
 * dead controls shipped looking alive.
 *
 * So these assert the thing the old code could not do: that the API was
 * **called**, and that a *failure* is visible rather than dressed as success.
 * A test that only checked for the toast would have passed against the bug.
 *
 * The mock stops at `useWorkspace` — `useResource`, the components and React are
 * all real, so what renders here is what renders in the app.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../src/lib/workspace.jsx', () => ({
  useWorkspace: () => globalThis.__ws
}));

const FileBrowser = (await import('../src/routes/FileBrowser.jsx')).default;

afterEach(cleanup);

const WS = 'ws_01M1WTCVFG3VEX6VRHCZWN1SK2';

const FILE_A = {
  id: 'fil_A', name: 'notes.md', path: '/notes.md', mimeType: 'text/markdown',
  sizeBytes: 2048, updatedAt: new Date().toISOString(), createdBy: 'usr_1',
  checksumSha256: 'a'.repeat(64)
};
const FILE_B = {
  id: 'fil_B', name: 'report.pdf', path: '/report.pdf', mimeType: 'application/pdf',
  sizeBytes: 4096, updatedAt: new Date().toISOString(), createdBy: 'agt_bot'
};

/** Mount the browser over a given API stub, and wait for the first listing. */
async function mount(api, files = [FILE_A, FILE_B]) {
  const listFiles = api.listFiles ?? vi.fn(async () => ({ files }));
  globalThis.__ws = { api: { listFiles, ...api }, workspaceId: WS, canWrite: true };
  render(
    <MemoryRouter initialEntries={[`/w/${WS}/files`]}>
      <Routes><Route path="/w/:ws/files" element={<FileBrowser />} /></Routes>
    </MemoryRouter>
  );
  await screen.findByText('notes.md');
  return globalThis.__ws.api;
}

/** Open the detail drawer for a file by clicking its row. */
async function openDrawer(user, name) {
  await user.click(screen.getByText(name));
  return screen.findByRole('dialog', { name });
}

/**
 * Press Delete in the drawer, then Delete in the confirmation it opens.
 *
 * Both are scoped to their own dialog on purpose: the drawer stays mounted
 * behind the confirmation, so an unscoped `getByRole('button', {name:'Delete'})`
 * matches two elements and the test cannot say which one it pressed.
 */
async function deleteFromDrawer(user, name) {
  const drawer = await openDrawer(user, name);
  await user.click(within(drawer).getByRole('button', { name: 'Delete' }));
  const confirm = await screen.findByRole('dialog', { name: `Delete ${name}?` });
  await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
  return confirm;
}

describe('File browser → delete', () => {
  it('calls the API rather than only showing a toast', async () => {
    const user = userEvent.setup();
    const deleteFile = vi.fn(async () => ({ id: 'fil_A', deleted: true }));
    let listed = 0;
    const listFiles = vi.fn(async () => {
      listed += 1;
      return { files: listed === 1 ? [FILE_A, FILE_B] : [FILE_B] };
    });
    await mount({ deleteFile, listFiles });

    await deleteFromDrawer(user, 'notes.md');

    await waitFor(() => expect(deleteFile).toHaveBeenCalledWith(WS, 'fil_A'));
    // The list is re-read, not patched in memory.
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('notes.md')).toBeNull());
  });

  it('keeps the row and shows why when the delete fails', async () => {
    const user = userEvent.setup();
    const deleteFile = vi.fn(async () => { throw new Error('Your role on this workspace cannot delete files.'); });
    await mount({ deleteFile });

    await deleteFromDrawer(user, 'notes.md');

    await screen.findByText('Your role on this workspace cannot delete files.');
    // The file is still listed — the drawer title and its row both carry the
    // name, so the assertion is that it did not vanish, not that it is unique —
    // and no success was ever claimed.
    expect(screen.getAllByText('notes.md').length).toBeGreaterThan(0);
    expect(screen.queryByText('File deleted')).toBeNull();
    // The confirmation is still open, because nothing was deleted.
    expect(screen.getByRole('dialog', { name: 'Delete notes.md?' })).toBeTruthy();
  });

  it('does not promise a trash it does not have', async () => {
    const user = userEvent.setup();
    await mount({ deleteFile: vi.fn() });

    const drawer = await openDrawer(user, 'notes.md');
    await user.click(within(drawer).getByRole('button', { name: 'Delete' }));
    await screen.findByRole('dialog', { name: 'Delete notes.md?' });

    const body = document.body.textContent;
    expect(body).not.toMatch(/30 days/);
    expect(body).not.toMatch(/trash/i);
    expect(body).toMatch(/24 hours/);
  });
});
