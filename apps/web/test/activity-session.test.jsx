/**
 * The Activity screen shows the session label an event carries (migration
 * 0031, `X-AgentDisk-Session`), on the row and in the expanded detail, and
 * the search box matches on it. An event without one renders exactly as it
 * did before.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../src/lib/workspace.jsx', async () => {
  const actual = await vi.importActual('../src/lib/workspace.jsx');
  return { ...actual, useWorkspace: () => globalThis.__ws };
});
vi.mock('../src/lib/auth.jsx', async () => {
  const actual = await vi.importActual('../src/lib/auth.jsx');
  return { ...actual, useAuth: () => globalThis.__auth };
});
vi.mock('../src/lib/api.js', async () => {
  const actual = await vi.importActual('../src/lib/api.js');
  return { ...actual, createApiClient: () => globalThis.__api };
});

const ActivityLog = (await import('../src/routes/ActivityLog.jsx')).default;

afterEach(cleanup);

const WS = 'ws_ACTIVITY0000000000000000';

const EVENTS = [
  {
    id: 'ev_labelled',
    action: 'file.created',
    actor: { type: 'agent', id: 'agt_reporter' },
    resource: { type: 'file', id: 'fil_1' },
    result: 'success',
    ip: '203.0.113.9',
    client: 'agentdisk-cli/0.1',
    requestId: 'req_1',
    session: 'nightly-report #42',
    metadata: { path: '/memory/tasks.md' },
    at: new Date().toISOString(),
  },
  {
    id: 'ev_plain',
    action: 'file.created',
    actor: { type: 'agent', id: 'agt_reporter' },
    resource: { type: 'file', id: 'fil_2' },
    result: 'success',
    ip: '203.0.113.9',
    client: 'curl/8',
    requestId: 'req_2',
    session: null,
    metadata: { path: '/memory/other.md' },
    at: new Date().toISOString(),
  },
];

function mount() {
  const api = { listActivity: vi.fn().mockResolvedValue({ events: EVENTS, limit: 200 }) };
  globalThis.__api = api;
  globalThis.__auth = { user: { uid: 'u1' }, loading: false, getToken: async () => 't' };
  globalThis.__ws = {
    workspaceId: WS, workspaceSlug: 'activity', role: 'owner', canWrite: true,
    workspace: { id: WS, slug: 'activity', name: 'Activity', role: 'owner' },
    workspaces: [{ id: WS, slug: 'activity', name: 'Activity', role: 'owner' }],
    loading: false, error: null, api,
    select: vi.fn(), create: vi.fn(), refresh: vi.fn(), resolveWorkspace: vi.fn(),
  };
  return render(
    <MemoryRouter initialEntries={['/w/activity/activity']}>
      <Routes>
        <Route path="/w/:ws/activity" element={<ActivityLog />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('activity session label', () => {
  it('shows the label on the row and in the detail, and nothing extra when there is none', async () => {
    mount();
    const labelled = (await screen.findByText('Session: nightly-report #42')).closest('.actrow');
    expect(labelled).not.toBeNull();

    const plainRow = screen.getByText('/memory/other.md').closest('.actrow');
    expect(within(plainRow).queryByText(/Session:/)).toBeNull();

    await userEvent.click(labelled);
    const detail = labelled.parentElement.nextSibling;
    expect(within(detail).getByText('Session').nextSibling.textContent).toBe('nightly-report #42');
  });

  it('matches the search box against the session label', async () => {
    mount();
    await screen.findByText('Session: nightly-report #42');
    await userEvent.type(screen.getByPlaceholderText('Actor, action, resource or session'), 'nightly');
    expect(screen.getByText('/memory/tasks.md')).toBeTruthy();
    expect(screen.queryByText('/memory/other.md')).toBeNull();
  });
});
