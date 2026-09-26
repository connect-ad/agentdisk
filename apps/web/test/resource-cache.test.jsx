/**
 * The cache behind `useResource`, and the four things that make it safe.
 *
 * A cache is easy to get right on the happy path and dangerous everywhere else,
 * so what is pinned here is not "the second visit is fast" but the cases where
 * being fast would be a bug: a write must invalidate, a failure must not be
 * remembered, a retry must actually reach the network, and signing out must
 * leave nothing of the previous account behind.
 *
 * The first test is the one that came from a real complaint — switching from
 * API keys to MCP connection and back refetched everything, twice.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { clearCache, fetchCached, peekCache, writeCache } from '../src/lib/resourceCache.js';

let workspaceApi = {};
vi.mock('../src/lib/workspace.jsx', () => ({
  useWorkspace: () => ({ workspaceId: 'ws_test', api: workspaceApi, canWrite: true, role: 'owner' })
}));

const { useResource } = await import('../src/lib/useResource.js');
const { fetchAgents, fetchKeys } = await import('../src/lib/resources.js');
const { createApiClient } = await import('../src/lib/api.js');

beforeEach(() => {
  clearCache();
});

afterEach(() => {
  cleanup();
  clearCache();
});

function Screen({ load, cacheKey = 'screen' }) {
  const { status, data } = useResource(load, [], cacheKey);
  return <div data-testid="out">{status === 'loaded' ? JSON.stringify(data) : status}</div>;
}

describe('the store', () => {
  it('serves a fresh entry without calling the fetcher again', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });

    await fetchCached('k', fetcher);
    await fetchCached('k', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('joins an in-flight request rather than racing a second one', async () => {
    let release;
    const fetcher = vi.fn(() => new Promise(resolve => { release = resolve; }));

    const first = fetchCached('k', fetcher);
    const second = fetchCached('k', fetcher);
    release({ n: 1 });

    expect(await first).toEqual({ n: 1 });
    expect(await second).toEqual({ n: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never remembers a failure', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ n: 2 });

    await expect(fetchCached('k', fetcher)).rejects.toThrow('offline');
    // The second call must reach the fetcher: a cached error is a screen that
    // stays broken after the network comes back.
    expect(await fetchCached('k', fetcher)).toEqual({ n: 2 });
  });

  it('keeps the previous data when a revalidation fails', async () => {
    await fetchCached('k', vi.fn().mockResolvedValue({ n: 1 }));
    await expect(
      fetchCached('k', vi.fn().mockRejectedValue(new Error('offline')), { force: true })
    ).rejects.toThrow('offline');

    expect(peekCache('k')).toMatchObject({ data: { n: 1 } });
  });

  it('force bypasses a fresh entry', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    await fetchCached('k', fetcher);
    await fetchCached('k', fetcher, { force: true });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('clearCache empties everything', async () => {
    writeCache('k', { n: 1 });
    clearCache();
    expect(peekCache('k')).toBeNull();
  });
});

describe('shared lists', () => {
  it('two screens asking for the same list cost one request', async () => {
    const listKeys = vi.fn().mockResolvedValue({ keys: [] });
    const listAgents = vi.fn().mockResolvedValue({ agents: [] });
    const api = { listKeys, listAgents };

    // The API keys screen, then the MCP screen, then back.
    await Promise.all([fetchKeys(api, 'ws_test'), fetchAgents(api, 'ws_test')]);
    await Promise.all([fetchKeys(api, 'ws_test'), fetchAgents(api, 'ws_test')]);
    await fetchKeys(api, 'ws_test');

    expect(listKeys).toHaveBeenCalledTimes(1);
    expect(listAgents).toHaveBeenCalledTimes(1);
  });

  it('keeps workspaces apart', async () => {
    const listKeys = vi.fn().mockResolvedValue({ keys: [] });
    await fetchKeys({ listKeys }, 'ws_one');
    await fetchKeys({ listKeys }, 'ws_two');

    expect(listKeys).toHaveBeenCalledTimes(2);
  });
});

describe('useResource', () => {
  it('renders cached data on the first frame of a revisit, with no loading state', async () => {
    const load = vi.fn().mockResolvedValue({ n: 1 });

    const first = render(<Screen load={load} />);
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('{"n":1}'));
    first.unmount();

    // The revisit. `status` must be 'loaded' in the very first render — not
    // 'loading' for one frame — or the skeleton flickers on every tab switch.
    render(<Screen load={load} />);
    expect(screen.getByTestId('out').textContent).toBe('{"n":1}');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('still fetches on every mount when given no key', async () => {
    const load = vi.fn().mockResolvedValue({ n: 1 });

    const first = render(<Screen load={load} cacheKey={null} />);
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('{"n":1}'));
    first.unmount();

    render(<Screen load={load} cacheKey={null} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('shows the error when there is nothing cached to fall back on', async () => {
    const load = vi.fn().mockRejectedValue(new Error('nope'));
    render(<Screen load={load} />);
    await waitFor(() => expect(screen.getByTestId('out').textContent).toBe('failed'));
  });
});

/**
 * The invariant the whole design rests on. If a write could leave a cached
 * read in place, the product would show somebody their own change not having
 * happened — which is worse than the slowness this cache exists to fix.
 */
describe('writes invalidate', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const stubResponse = () => ({ ok: true, status: 200, json: async () => ({}) });

  it('empties the cache after a successful non-GET', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(stubResponse());
    const api = createApiClient(async () => 'token');

    writeCache('ws_test:keys', { keys: [{ id: 'old' }] });
    await api.createAgent('ws_test', { name: 'a' });

    expect(peekCache('ws_test:keys')).toBeNull();
  });

  it('leaves the cache alone on a GET', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(stubResponse());
    const api = createApiClient(async () => 'token');

    writeCache('ws_test:keys', { keys: [] });
    await api.listKeys('ws_test');

    expect(peekCache('ws_test:keys')).not.toBeNull();
  });
});
