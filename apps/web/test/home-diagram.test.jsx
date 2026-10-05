/**
 * The landing page's "what AgentDisk is" picture, and the two hero controls
 * that changed with it. Pinned by role and text, never by geometry: the
 * diagram must name its three steps, show a write, a read, a share and a
 * denial, and lead to the guided tour; the hero must call the tour what it
 * is and keep "Read the docs" as a real link.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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

describe('home diagram', () => {
  it('names the three steps in order', () => {
    renderLanding();
    const steps = screen.getByRole('list', { name: 'How it works' });
    const items = [...steps.querySelectorAll('li')].map(li => li.textContent.replace(/^\d/, '').trim());
    expect(items).toEqual(['Agents and apps connect', 'Each key writes to its own path', 'Others pick it up']);
  });

  it('shows writes to distinct paths, a read, a shared link and one denial', () => {
    renderLanding();
    const stage = screen.getByRole('img', { name: /one AgentDisk workspace/ });
    const chips = [...stage.querySelectorAll('.hd__chip')].map(c => c.textContent);
    expect(chips).toContain('write/projectA/tech');
    expect(chips).toContain('write/projectB/docs');
    expect(chips).toContain('read/projectA/tech');
    expect(chips.some(c => c.includes('403'))).toBe(true);
    expect(stage.textContent).toContain('Customer');
    expect(stage.textContent).toContain('Public');
    expect(stage.textContent).toContain('You');
  });

  it('draws one line per node and points reads and shares away from the disk', () => {
    renderLanding();
    const stage = screen.getByRole('img', { name: /one AgentDisk workspace/ });
    expect(stage.querySelectorAll('line.hd__line').length).toBe(10);
    const read = stage.querySelector('line.hd__line--read');
    const write = stage.querySelector('line.hd__line--write');
    // a read starts near the hub (x≈500) and ends at the node; a write does the reverse
    expect(Math.abs(Number(read.getAttribute('x1')) - 500)).toBeLessThan(120);
    expect(Math.abs(Number(write.getAttribute('x2')) - 500)).toBeLessThan(120);
    expect(stage.querySelector('line.hd__line--denied').getAttribute('marker-end')).toBeNull();
  });

  it('pairs every line colour with a word in the legend', () => {
    renderLanding();
    const legend = screen.getByRole('list', { name: 'Legend' });
    for (const word of ['agent writes', 'agent reads', 'human owns', 'shared out', '403']) {
      expect(legend.textContent).toContain(word);
    }
  });

  it('leads to the guided tour and the comparisons', () => {
    renderLanding();
    const section = screen.getByRole('region', { name: /A shared disk where agents work/ });
    expect(within(section).getByRole('link', { name: 'Follow the guided tour' }).getAttribute('href')).toBe('/docs/quickstart');
    expect(within(section).getByRole('link', { name: 'see how this compares' }).getAttribute('href')).toBe('/compare');
  });
});

describe('hero controls', () => {
  it('calls the tour a tour and keeps the docs link', () => {
    renderLanding();
    const tour = screen.getAllByRole('link', { name: /Follow the guided tour/ });
    expect(tour[0].getAttribute('href')).toBe('/docs/quickstart');
    expect(tour[0].className).toContain('mk__quick');
    const docs = screen.getByRole('link', { name: /Read the docs/ });
    expect(docs.getAttribute('href')).toBe('/docs');
    expect(docs.className).toContain('mk__docs');
  });
});
