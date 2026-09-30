/**
 * One bundle, two hostnames: what the SPA does on each.
 *
 * The Worker (worker.js) decides the first request; these are the decisions
 * the SPA makes after it has loaded. `window.location.hostname` is fixed per
 * test by rendering under a jsdom whose URL names the host, so the components
 * are exercised through the same `currentHost()` the product uses.
 */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/routes/Marketing.jsx', () => ({
  Landing: () => <div>landing page</div>,
  Pricing: () => <div>pricing page</div>,
  Nav: () => null,
  Footer: () => null
}));

const { Home, AppHostOnly } = await import('../src/App.jsx');

function Where() {
  const { pathname } = useLocation();
  return <div data-testid="where">{pathname}</div>;
}

function mount(at, { leave } = {}) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Where />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route element={<AppHostOnly leave={leave} />}>
          <Route path="/login" element={<div>login screen</div>} />
          <Route path="/app" element={<div>app screen</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function setHost(hostname) {
  // jsdom's Location is not configurable; replace the object the code reads.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, hostname, replace: vi.fn() }
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('single-host build', () => {
  beforeEach(() => setHost('localhost'));

  it('renders the landing page at / and every app route in place', () => {
    mount('/');
    expect(screen.getByText('landing page')).toBeTruthy();
    cleanup();
    const leave = vi.fn();
    mount('/login', { leave });
    expect(screen.getByText('login screen')).toBeTruthy();
    expect(leave).not.toHaveBeenCalled();
  });
});

describe('split build', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SITE_HOST', 'dev.agentdisk.io');
    vi.stubEnv('VITE_APP_HOST', 'app-dev.agentdisk.io');
  });

  it('on the site host, / is the landing page', () => {
    setHost('dev.agentdisk.io');
    mount('/');
    expect(screen.getByText('landing page')).toBeTruthy();
  });

  it('on the site host, an app route leaves for the same path on the app host', () => {
    setHost('dev.agentdisk.io');
    const leave = vi.fn();
    mount('/login?next=%2Fapp', { leave });
    expect(screen.queryByText('login screen')).toBeNull();
    expect(screen.getByText(/Taking you to the app/)).toBeTruthy();
    expect(leave).toHaveBeenCalledWith('https://app-dev.agentdisk.io/login?next=%2Fapp');
  });

  it('on the app host, / goes into the app rather than showing the landing page', () => {
    setHost('app-dev.agentdisk.io');
    mount('/');
    expect(screen.queryByText('landing page')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/app');
    expect(screen.getByText('app screen')).toBeTruthy();
  });

  it('on the app host, app routes render in place', () => {
    setHost('app-dev.agentdisk.io');
    const leave = vi.fn();
    mount('/login', { leave });
    expect(screen.getByText('login screen')).toBeTruthy();
    expect(leave).not.toHaveBeenCalled();
  });

  it('on any other host, such as localhost, the product is single-host', () => {
    setHost('localhost');
    mount('/');
    expect(screen.getByText('landing page')).toBeTruthy();
  });
});
