/**
 * ScrollOnNavigate (App.jsx, 7 Oct 2026): a client-side route change puts
 * the window back at the top, or at the element a hash names. The first
 * render is left alone, so a reload keeps the browser's own position.
 */
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Link, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/analytics.js', () => ({ trackEvent: vi.fn(), trackPageView: vi.fn() }));
const { ScrollOnNavigate } = await import('../src/App.jsx');

afterEach(cleanup);

let scrollTo;
beforeEach(() => {
  scrollTo = vi.fn();
  window.scrollTo = scrollTo;
});

function Pages() {
  return (
    <>
      <ScrollOnNavigate />
      <Link to="/privacy">Privacy</Link>
      <Link to="/security#certifications">Certifications</Link>
      <Routes>
        <Route path="/" element={<h1>Home</h1>} />
        <Route path="/privacy" element={<h1>Privacy</h1>} />
        <Route path="/security" element={<section id="certifications">Certifications</section>} />
      </Routes>
    </>
  );
}

describe('ScrollOnNavigate', () => {
  it('leaves the first render alone', () => {
    render(<MemoryRouter initialEntries={['/']}><Pages /></MemoryRouter>);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('scrolls to the top when the route changes', () => {
    const { getByText } = render(<MemoryRouter initialEntries={['/']}><Pages /></MemoryRouter>);
    act(() => { getByText('Privacy', { selector: 'a' }).click(); });
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('scrolls to the element a hash names instead of the top', () => {
    const { getByText } = render(<MemoryRouter initialEntries={['/']}><Pages /></MemoryRouter>);
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    act(() => { getByText('Certifications', { selector: 'a' }).click(); });
    expect(into).toHaveBeenCalledTimes(1);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
