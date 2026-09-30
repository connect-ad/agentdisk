/**
 * FUNC-01 (28 Sept 2026): the stats band in the shell went stale after a write.
 *
 * Create an agent, go back to Overview, and the AGENTS tile still said
 * "No agents yet" beside a list with the agent in it, until a full reload.
 * Every write already emptied the cache; nothing told a resource that had
 * already loaded to ask again, and each screen's own `reload()` refreshed
 * that screen alone. The provider that feeds the band is mounted once in the
 * shell and never remounts, so it was never asked.
 *
 * Three things are pinned here: a write refreshes a resource the writing
 * screen knows nothing about; it does so behind the figures on screen rather
 * than dropping to skeletons; and it costs exactly one request per shared
 * list, not one per subscriber and not two per write.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

import { clearCache, subscribeCache, writeCache, TTL_MS } from '../src/lib/resourceCache.js';

let workspaceApi = {};
vi.mock('../src/lib/workspace.jsx', () => ({
  useWorkspace: () => ({ workspaceId: 'ws_test', api: workspaceApi, canWrite: true, role: 'owner' })
}));

const { useResource } = await import('../src/lib/useResource.js');
const { fetchAgents } = await import('../src/lib/resources.js');
const { WorkspaceUsageProvider, useWorkspaceUsage } = await import('../src/lib/usage.jsx');
const { default: WorkspaceStats } = await import('../src/components-local/WorkspaceStats.jsx');
const { createApiClient } = await import('../src/lib/api.js');

beforeEach(() => { clearCache(); });
afterEach(() => { cleanup(); clearCache(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

function whoamiFor(files) {
  return {
    workspace: { plan: 'free' },
    usage: {
      storageBytes: { used: 1024, max: 1024 * 1024 },
      files: { used: files, max: 1000 },
      requests: { used: 10, max: 1000 },
    },
  };
}

/** A mocked API whose answers can be changed between calls, as a real one's would. */
function apiWith({ files = 0, agents = [] } = {}) {
  const state = { files, agents };
  return {
    state,
    whoami: vi.fn(async () => whoamiFor(state.files)),
    listAgents: vi.fn(async () => ({ agents: [...state.agents] })),
    listKeys: vi.fn(async () => ({ keys: [] })),
  };
}

function Shell({ children }) {
  return (
    <MemoryRouter initialEntries={['/w/test/agents']}>
      <WorkspaceUsageProvider>
        <WorkspaceStats />
        <Routes>
          <Route path="/w/test/*" element={children ?? null} />
        </Routes>
      </WorkspaceUsageProvider>
    </MemoryRouter>
  );
}

const agentsTile = () => screen.getByText('AGENTS').closest('.wstat');
const figure = tile => tile.querySelector('.wstat__value:not(.wstat__strut)')?.textContent;

describe('the store tells its subscribers when it is cleared', () => {
  it('runs each listener once per clear, synchronously, and stops after unsubscribe', () => {
    const listener = vi.fn();
    const stop = subscribeCache(listener);

    clearCache();
    expect(listener).toHaveBeenCalledTimes(1);

    stop();
    clearCache();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('the stats band after a write on another screen', () => {
  it('shows the new agent count without a reload, and without a skeleton', async () => {
    workspaceApi = apiWith();
    render(<Shell />);
    await waitFor(() => expect(agentsTile().textContent).toMatch(/No agents yet/));

    // The Agents screen creates one. The client's write path is what empties
    // the store; here the answer changes and the store is cleared the same
    // way `api.js` does it after a non-GET.
    workspaceApi.state.agents = [{ id: 'agt_1', name: 'bot', status: 'active' }];
    act(() => { clearCache(); });

    // No skeleton: the tile keeps its figure while the fresh one is fetched.
    expect(agentsTile().querySelector('.wstat__skel')).toBeNull();
    expect(agentsTile().textContent).toMatch(/No agents yet/);

    await waitFor(() => expect(agentsTile().textContent).toMatch(/1 active/));
  });

  it('shows the new file count the same way', async () => {
    workspaceApi = apiWith({ files: 3 });
    render(<Shell />);
    const filesTile = () => screen.getByText('ACCOUNT FILES').closest('.wstat');
    await waitFor(() => expect(figure(filesTile())).toBe('3'));

    workspaceApi.state.files = 4;
    act(() => { clearCache(); });
    await waitFor(() => expect(figure(filesTile())).toBe('4'));
  });

  it('costs one request per shared list, however many resources are mounted', async () => {
    workspaceApi = apiWith();
    // A screen beside the band that reads the same agent list — the overview
    // and the MCP page both do. Its own post-write `reload()` is the second
    // thing that used to double every request.
    const loadScreen = (api, ws) => fetchAgents(api, ws);
    let reloadScreen;
    function AgentsScreen() {
      const { status, reload } = useResource(loadScreen, [], 'agents-screen');
      reloadScreen = reload;
      return <div data-testid="screen">{status}</div>;
    }
    render(<Shell><AgentsScreen /></Shell>);
    await waitFor(() => expect(screen.getByTestId('screen').textContent).toBe('loaded'));
    await waitFor(() => expect(agentsTile().textContent).toMatch(/No agents yet/));
    expect(workspaceApi.listAgents).toHaveBeenCalledTimes(1);
    expect(workspaceApi.whoami).toHaveBeenCalledTimes(1);

    // A write: the client clears, then the screen reloads itself, as every
    // screen in the product does after its own mutation.
    workspaceApi.state.agents = [{ id: 'agt_1', name: 'bot', status: 'active' }];
    await act(async () => { clearCache(); await reloadScreen(); });
    await waitFor(() => expect(agentsTile().textContent).toMatch(/1 active/));

    expect(workspaceApi.listAgents).toHaveBeenCalledTimes(2);
    expect(workspaceApi.whoami).toHaveBeenCalledTimes(2);
  });

  it('keeps the figures it has when the refetch fails', async () => {
    workspaceApi = apiWith({ files: 3 });
    render(<Shell />);
    const filesTile = () => screen.getByText('ACCOUNT FILES').closest('.wstat');
    await waitFor(() => expect(figure(filesTile())).toBe('3'));

    workspaceApi.whoami.mockRejectedValueOnce(new Error('offline'));
    act(() => { clearCache(); });
    await flush();

    expect(figure(filesTile())).toBe('3');
  });

  it('is driven by the real client: a non-GET through api.js refreshes the band', async () => {
    const realFetch = globalThis.fetch;
    try {
      let agents = [];
      globalThis.fetch = vi.fn(async (url, init = {}) => {
        const path = new URL(url).pathname;
        const body = init.method === 'POST' && path === '/v1/agents'
          ? (agents = [{ id: 'agt_1', name: 'bot', status: 'active' }], { id: 'agt_1' })
          : path === '/v1/agents' ? { agents }
          : path === '/v1/whoami' ? whoamiFor(0)
          : {};
        return { ok: true, status: 200, json: async () => body };
      });
      workspaceApi = createApiClient(async () => 'token');

      render(<Shell />);
      await waitFor(() => expect(agentsTile().textContent).toMatch(/No agents yet/));

      await act(async () => { await workspaceApi.createAgent('ws_test', { name: 'bot' }); });
      await waitFor(() => expect(agentsTile().textContent).toMatch(/1 active/));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the band after a change made outside this browser', () => {
  function Go({ to }) {
    const navigate = useNavigate();
    return <button onClick={() => navigate(to)}>go</button>;
  }

  it('does not refetch on navigation while its answer is fresh', async () => {
    workspaceApi = apiWith();
    render(<Shell><Go to="/w/test/files" /></Shell>);
    await waitFor(() => expect(agentsTile().textContent).toMatch(/No agents yet/));

    act(() => { screen.getByText('go').click(); });
    await flush();

    expect(workspaceApi.whoami).toHaveBeenCalledTimes(1);
    expect(workspaceApi.listAgents).toHaveBeenCalledTimes(1);
  });

  it('revalidates behind the figures on navigation once the answer is older than the TTL', async () => {
    workspaceApi = apiWith();
    render(<Shell><Go to="/w/test/files" /></Shell>);
    await waitFor(() => expect(agentsTile().textContent).toMatch(/No agents yet/));

    // An agent worked through the API meanwhile; nothing in this browser saw
    // it. Age the cached answer past the TTL, as a minute of not clicking
    // would.
    workspaceApi.state.agents = [{ id: 'agt_1', name: 'bot', status: 'active' }];
    // `writeCache` stamps "now"; stamp these in the past instead.
    const stale = Date.now() - TTL_MS - 1;
    vi.spyOn(Date, 'now').mockReturnValue(stale);
    writeCache('view:ws_test:usage', { me: whoamiFor(0), agents: [] });
    writeCache('ws_test:whoami', whoamiFor(0));
    writeCache('ws_test:agents', { agents: [] });
    Date.now.mockRestore();

    act(() => { screen.getByText('go').click(); });

    expect(agentsTile().querySelector('.wstat__skel')).toBeNull();
    await waitFor(() => expect(agentsTile().textContent).toMatch(/1 active/));
    expect(workspaceApi.listAgents).toHaveBeenCalledTimes(2);
  });
});
