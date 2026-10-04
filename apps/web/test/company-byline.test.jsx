/**
 * The company behind the brand is named where a customer will look for it.
 *
 * AgentDisk is the product; Kernelv5 Inc. is the company that sells it, and
 * the name Stripe prints on the checkout page and the card statement. A
 * person who sees "Kernelv5 Inc." on a bank statement and cannot find those
 * words anywhere on agentdisk.io files a chargeback. So the header carries a
 * byline, the footer carries the copyright and the byline, the auth sheet
 * carries the byline, and the Terms, the Privacy policy and the billing page
 * all say who "we" is — every one reading the same constants.
 *
 * The byline is text, not an image: the company has no logo.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { COMPANY_LEGAL_NAME, COMPANY_NAME, COMPANY_URL } from '../src/lib/company.js';
import { AppShell } from '../src/components/AppShell/AppShell.jsx';

vi.mock('../src/lib/auth.jsx', () => ({
  useAuth: () => ({ user: null, loading: false }),
}));

const { Nav, Footer } = await import('../src/routes/Marketing.jsx');
const { Terms, Privacy } = await import('../src/routes/Trust.jsx');

afterEach(cleanup);

const at = (path, ui) => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);

/** Every byline on the page: a link to the company site whose text is the wordmark. */
const bylines = () => screen.getAllByRole('link', { name: new RegExp(`product by ${COMPANY_NAME}`, 'i') });

describe('the company byline', () => {
  it('sits in the header beside the brand, as a link to the company site in a new tab', () => {
    at('/', <Nav />);
    const [by] = bylines();
    expect(by.getAttribute('href')).toBe(COMPANY_URL);
    expect(by.getAttribute('target')).toBe('_blank');
    expect(by.getAttribute('rel')).toContain('noopener');
    expect(by.querySelector('img')).toBeNull();
    // A sibling of the brand link, never inside it: nested anchors are invalid.
    expect(by.closest('a.mk__brand')).toBeNull();
    const brand = screen.getByRole('link', { name: /AgentDisk/ });
    expect(brand.getAttribute('href')).toBe('/');
    // Under the wordmark, not beside it: the two share one lockup block, with
    // the byline as the row after the brand link (30 Sept 2026).
    expect(by.parentElement).toBe(brand.parentElement);
    expect(by.parentElement.classList.contains('mk__lockup')).toBe(true);
    expect(brand.nextElementSibling).toBe(by);
  });

  it("gives the footer the owner's copyright sentence and the byline in the about column", () => {
    at('/', <Footer />);
    const foot = screen.getByRole('contentinfo');
    const base = foot.querySelector('.mk__footbase');
    // The owner's sentence of 30 Sept 2026, with the legal name in the
    // copyright since 4 Oct 2026: "© <year> Kernelv5 Inc. AgentDisk is a product by Kernelv5."
    expect(base.textContent).toContain(`© ${new Date().getFullYear()} ${COMPANY_LEGAL_NAME} AgentDisk is a product by ${COMPANY_NAME}.`);
    expect(within(base).getByRole('link', { name: COMPANY_LEGAL_NAME }).getAttribute('href')).toBe(COMPANY_URL);
    // Inside the footer's brand lockup, under the wordmark.
    expect(foot.querySelector('.mk__footbrand .byline')).not.toBeNull();
    // AgentDisk stays the brand: the wordmark is still there, above the company.
    expect(foot.querySelector('.mk__footmark').textContent).toBe('AgentDisk');
  });
});

describe('the dashboard shell', () => {
  it('draws the same lockup: the byline directly under the wordmark, inside the brand block', () => {
    render(<AppShell nav={[]} active="overview"><p>page</p></AppShell>);
    const [by] = bylines();
    const brand = by.closest('.shell__brand');
    expect(brand).not.toBeNull();
    expect(brand.querySelector('.shell__wordmark').nextElementSibling).toBe(by);
    expect(by.getAttribute('href')).toBe(COMPANY_URL);
  });
});

describe('the legal text names the company', () => {
  it('says in the Terms and the Privacy policy that Kernelv5 Inc. provides AgentDisk', () => {
    // Their own pages since 4 Oct 2026 (routes/Trust.jsx).
    const terms = at('/terms', <Terms />).container.querySelector('#terms').textContent;
    cleanup();
    const privacy = at('/privacy', <Privacy />).container.querySelector('#privacy').textContent;
    expect(terms).toContain(COMPANY_LEGAL_NAME);
    expect(privacy).toContain(COMPANY_LEGAL_NAME);
    // The one fact a person checks against a bank statement.
    expect(terms).toMatch(/card statement as Kernelv5 Inc\./);
  });
});
