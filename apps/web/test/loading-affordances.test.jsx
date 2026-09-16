/**
 * The two things that tell you the app is working: the top progress bar, and
 * the stats band holding its shape while its figures are in flight.
 *
 * The band is the reason these exist. It used to return null until `whoami`
 * answered, which is correct about not showing invented figures and wrong
 * about everything else: the band is 118px directly above every screen's
 * content, and changing workspace puts the fetch back into `loading`, so the
 * page jumped up and dropped back on every switch. What is asserted here is
 * therefore not "a spinner appears" but "the tiles still exist, still carry
 * their labels, and still claim no numbers" — the three things that together
 * mean the layout cannot move.
 */

import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// The bar is driven from outside React — `pending.js` is a plain module, which
// is the point of it — so these tests push the store by hand inside `act()`.
// Testing Library sets this flag around its own renders only; without it here,
// React warns on every one of those manual updates.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import TopProgress from '../src/components-local/TopProgress.jsx';
import { beginRequest, endRequest, isPending, subscribePending } from '../src/lib/pending.js';

vi.mock('../src/lib/workspace.jsx', () => ({
  useWorkspace: () => ({ workspaceId: 'ws_test', canWrite: true, api: {} })
}));

let usageState = { status: 'loading', data: null, error: null, reload: () => {} };
vi.mock('../src/lib/usage.jsx', () => ({
  useWorkspaceUsage: () => usageState
}));

const WorkspaceStats = (await import('../src/components-local/WorkspaceStats.jsx')).default;

afterEach(() => {
  cleanup();
  // Drain anything a failing assertion left counted, so one test cannot leave
  // the bar running for the next.
  while (isPending()) endRequest();
});

describe('in-flight request count', () => {
  it('stays pending until the last of several requests lands', () => {
    beginRequest(); beginRequest(); beginRequest();
    endRequest(); endRequest();
    expect(isPending()).toBe(true);
    endRequest();
    expect(isPending()).toBe(false);
  });

  it('notifies only on the idle/busy edges, not once per request', () => {
    const seen = vi.fn();
    const stop = subscribePending(seen);
    beginRequest(); beginRequest(); beginRequest();
    expect(seen).toHaveBeenCalledTimes(1);
    endRequest(); endRequest(); endRequest();
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
  });

  it('cannot be driven negative by an unbalanced end', () => {
    endRequest(); endRequest();
    expect(isPending()).toBe(false);
    beginRequest();
    expect(isPending()).toBe(true);
    endRequest();
    expect(isPending()).toBe(false);
  });
});

describe('top progress bar', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is absent while nothing is loading', () => {
    const { container } = render(<TopProgress />);
    expect(container.querySelector('.tprog')).toBeNull();
  });

  it('appears while a request is in flight and finishes after it lands', () => {
    const { container } = render(<TopProgress />);
    act(() => { beginRequest(); });
    expect(container.querySelector('.tprog')).not.toBeNull();
    expect(container.querySelector('.tprog--done')).toBeNull();

    act(() => { endRequest(); });
    // Still mounted, now completing — a bar that vanished on the same frame
    // as the response would read as a flicker rather than as feedback.
    expect(container.querySelector('.tprog--done')).not.toBeNull();

    act(() => { vi.advanceTimersByTime(400); });
    expect(container.querySelector('.tprog')).toBeNull();
  });
});

describe('workspace stats band', () => {
  afterEach(() => { usageState = { status: 'loading', data: null, error: null, reload: () => {} }; });

  it('keeps all four tiles while the figures are loading', () => {
    usageState = { status: 'loading', data: null, error: null, reload: () => {} };
    const { container } = render(<WorkspaceStats />);

    expect(container.querySelectorAll('.wstat')).toHaveLength(4);
    for (const label of ['STORAGE', 'FILES', 'AGENTS', 'REQUESTS THIS PERIOD']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(4);
    expect(screen.getAllByText('Loading')).toHaveLength(4);
  });

  it('draws the reference loading treatment: skeleton figure, sweeping meter, worded caption', () => {
    usageState = { status: 'loading', data: null, error: null, reload: () => {} };
    const { container } = render(<WorkspaceStats />);

    // AgentDisk Patterns.dc.html § LOADING. All three on every tile, AGENTS
    // included: until whoami answers, nothing here knows which tiles carry a
    // quota, so every one of them draws the meter.
    expect(container.querySelectorAll('.wstat__skel--figure')).toHaveLength(4);
    expect(container.querySelectorAll('.wstat__sweep')).toHaveLength(4);
    expect(container.querySelectorAll('.wstat__skel--limit')).toHaveLength(4);
    expect(screen.getAllByText('LOADING…')).toHaveLength(4);

    // The caption is the one thing that is true; a percentage would not be.
    expect(container.textContent).not.toMatch(/\d+%/);
    // Decoration, and the sr-only "Loading" already says it in words.
    for (const skel of container.querySelectorAll('.wstat__skel--figure')) {
      expect(skel.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('states no figure it has not been given', () => {
    usageState = { status: 'loading', data: null, error: null, reload: () => {} };
    const { container } = render(<WorkspaceStats />);

    // The only "0" in the band is the hidden strut that holds the row's height,
    // and it is out of the accessibility tree. Nothing readable claims a value.
    const visibleZeros = [...container.querySelectorAll('.wstat__value')]
      .filter(el => !el.classList.contains('wstat__strut'));
    expect(visibleZeros).toHaveLength(0);
    expect(container.querySelector('.wstat__strut')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.textContent).not.toMatch(/% USED/);
  });

  it('holds the same four tiles when the load fails, with a dash for the figure', () => {
    usageState = { status: 'failed', data: null, error: new Error('nope'), reload: () => {} };
    const { container } = render(<WorkspaceStats />);

    expect(container.querySelectorAll('.wstat')).toHaveLength(4);
    expect(container.querySelectorAll('.wstat__value--none')).toHaveLength(4);
    // A failure is not a load in progress: nothing shimmers and nothing sweeps.
    expect(container.querySelector('.wstat__skel')).toBeNull();
    expect(container.querySelector('.wstat__sweep')).toBeNull();
    expect(container.textContent).not.toMatch(/LOADING/);
  });

  it('shows the real figures once they arrive', () => {
    usageState = {
      status: 'loaded',
      error: null,
      reload: () => {},
      data: {
        me: { usage: { storageBytes: { used: 0, max: 2147483648 }, files: { used: 0, max: 5000 }, requests: { used: 0, max: 100000 } }, workspace: { plan: 'free' } },
        agents: [{ id: 'agt_1', status: 'active' }]
      }
    };
    const { container } = render(<WorkspaceStats />);

    expect(container.querySelectorAll('.wstat')).toHaveLength(4);
    expect(container.querySelector('.wstat__skel')).toBeNull();
    expect(container.querySelector('.wstat__sweep')).toBeNull();
    expect(screen.getByText('1 active')).toBeTruthy();
    expect(screen.getAllByText('0% USED')).toHaveLength(3);
  });
});
