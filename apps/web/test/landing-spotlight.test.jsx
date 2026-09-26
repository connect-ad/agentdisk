/**
 * The landing page's sandbox-and-claim spotlight, and the theme control the
 * marketing nav now carries. Both are pinned lightly: the spotlight's calls to
 * action must go where they say, and the toggle must exist on a marketing page
 * as well as in the dashboard.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';

vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => ({ user: null, loading: false }),
}));

const { Landing } = await import('../src/routes/Marketing.jsx');
const { ThemeProvider } = await import('../src/lib/theme.jsx');

afterEach(cleanup);

function renderLanding() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/']}>
        <Landing />
      </MemoryRouter>
    </ThemeProvider>
  );
}

describe('landing spotlight', () => {
  it('sends people to the sandbox and to the claiming guide', () => {
    renderLanding();
    expect(screen.getByRole('link', { name: /Open a sandbox/ }).getAttribute('href')).toBe('/sandbox');
    expect(screen.getByRole('link', { name: 'How claiming works' }).getAttribute('href')).toBe('/docs/quickstart');
  });

  it('draws the three-node flow ending on the claim link', () => {
    renderLanding();
    const flow = screen.getByRole('list', { name: 'From sandbox to your account' });
    expect(flow.textContent).toContain('Sandbox');
    expect(flow.textContent).toContain('Agent works');
    expect(flow.textContent).toContain('Claim link');
    expect(flow.querySelector('.mk__spotnode--claim').textContent).toContain('Claim link');
  });

  it('carries the light/dark control in the marketing nav', () => {
    const { container } = renderLanding();
    expect(container.querySelector('.mk__theme button')).not.toBeNull();
  });
});
