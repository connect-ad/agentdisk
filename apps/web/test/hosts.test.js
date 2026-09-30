import { afterEach, describe, expect, it, vi } from 'vitest';
import { appUrl, onAppHost, onSiteHost, siteUrl, splitHosts } from '../src/lib/hosts.js';

afterEach(() => vi.unstubAllEnvs());

function split() {
  vi.stubEnv('VITE_SITE_HOST', 'dev.agentdisk.io');
  vi.stubEnv('VITE_APP_HOST', 'app-dev.agentdisk.io');
}

describe('splitHosts', () => {
  it('is null unless both hosts are configured and differ', () => {
    expect(splitHosts()).toBeNull();
    vi.stubEnv('VITE_SITE_HOST', 'dev.agentdisk.io');
    expect(splitHosts()).toBeNull();
    vi.stubEnv('VITE_APP_HOST', 'dev.agentdisk.io');
    expect(splitHosts()).toBeNull();
  });

  it('names both origins when split', () => {
    split();
    expect(splitHosts()).toEqual({
      siteHost: 'dev.agentdisk.io',
      appHost: 'app-dev.agentdisk.io',
      siteOrigin: 'https://dev.agentdisk.io',
      appOrigin: 'https://app-dev.agentdisk.io'
    });
  });
});

describe('which host', () => {
  it('knows the site host and the app host, and nothing else', () => {
    split();
    expect(onSiteHost('dev.agentdisk.io')).toBe(true);
    expect(onAppHost('dev.agentdisk.io')).toBe(false);
    expect(onAppHost('app-dev.agentdisk.io')).toBe(true);
    expect(onSiteHost('app-dev.agentdisk.io')).toBe(false);
    // localhost with a split build behaves as the single-host product.
    expect(onSiteHost('localhost')).toBe(false);
    expect(onAppHost('localhost')).toBe(false);
  });

  it('is never on either host in single-host mode', () => {
    expect(onSiteHost('dev.agentdisk.io')).toBe(false);
    expect(onAppHost('app-dev.agentdisk.io')).toBe(false);
  });
});

describe('cross-host links', () => {
  it('point at the other origin only from the host that needs it', () => {
    split();
    expect(appUrl('/login', 'dev.agentdisk.io')).toBe('https://app-dev.agentdisk.io/login');
    expect(appUrl('/login', 'app-dev.agentdisk.io')).toBe('/login');
    expect(siteUrl('/', 'app-dev.agentdisk.io')).toBe('https://dev.agentdisk.io/');
    expect(siteUrl('/', 'dev.agentdisk.io')).toBe('/');
  });

  it('are plain paths in single-host mode', () => {
    expect(appUrl('/login', 'dev.agentdisk.io')).toBe('/login');
    expect(siteUrl('/', 'app-dev.agentdisk.io')).toBe('/');
  });
});
