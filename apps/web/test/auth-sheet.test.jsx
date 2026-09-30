/**
 * The auth sheet after the brand panel went (21 Sept 2026).
 *
 * The password policy has its own file; this one pins the shell. Two of these
 * are the reason the layout changed and would be the first things a revert
 * brought back: the brand panel's copy, and a three-row checklist under the
 * password field. The rest is what the new shell must keep doing for a
 * keyboard or a screen reader while it does that.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { PASSWORD_RULES } from '../src/lib/password.js';

vi.mock('../src/lib/auth.jsx', async () => {
  const actual = await vi.importActual('../src/lib/auth.jsx');
  return { ...actual, useAuth: () => globalThis.__auth };
});

const { Signup, Login } = await import('../src/routes/Auth.jsx');

afterEach(cleanup);

function mount(Screen, path) {
  globalThis.__auth = {
    configured: true,
    signUpWithPassword: vi.fn(),
    signInWithPassword: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithGithub: vi.fn(),
    sendEmailLink: vi.fn(),
    isEmailLink: () => false,
    completeEmailLink: vi.fn()
  };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Screen />
    </MemoryRouter>
  );
}

describe('The auth sheet', () => {
  it('carries no brand panel', () => {
    const { container } = mount(Login, '/login');
    expect(container.querySelector('.auth__brandpanel')).toBeNull();
    expect(screen.queryByText('Welcome back.')).toBeNull();
    expect(screen.queryByText(/ENDPOINTS/)).toBeNull();
    // The wordmark survives, as the way back to the site.
    expect(screen.getByRole('link', { name: /AgentDisk/ }).getAttribute('href')).toBe('/');
  });

  it('marks the current tab for assistive tech, and the other is a real route', () => {
    mount(Login, '/login');
    expect(screen.getByRole('link', { name: 'Log in' }).getAttribute('aria-current')).toBe('page');
    const signup = screen.getByRole('link', { name: 'Sign up' });
    expect(signup.getAttribute('aria-current')).toBeNull();
    expect(signup.getAttribute('href')).toBe('/signup');
  });

  it('keeps every field label as a label, wherever it is drawn', () => {
    mount(Signup, '/signup');
    // Labels sit in the field's border now; they must still be the field's
    // accessible name, or the whole form is unlabelled to a screen reader.
    expect(screen.getByLabelText('FULL NAME').getAttribute('type')).toBe('text');
    expect(screen.getByLabelText('WORK EMAIL').getAttribute('type')).toBe('email');
    expect(screen.getByLabelText('PASSWORD').getAttribute('type')).toBe('password');
  });

  it('puts Forgot password? in the password field, not on its own row', () => {
    mount(Login, '/login');
    const link = screen.getByRole('link', { name: 'Forgot password?' });
    expect(link.getAttribute('href')).toBe('/forgot-password');
    expect(link.closest('.auth__group')).toBe(screen.getByLabelText('PASSWORD').closest('.auth__group'));
  });

  it('shows the rules as one row of short chips that tick as they are met', async () => {
    mount(Signup, '/signup');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('PASSWORD'), 'abc');
    const chips = screen.getByTestId('pw-requirements').querySelectorAll('.auth__req');
    expect(chips).toHaveLength(PASSWORD_RULES.requirements.length);
    expect([...chips].map(c => c.querySelector('span:nth-child(2)').textContent))
      .toEqual(PASSWORD_RULES.requirements.map(r => r.short));
    // 'abc' meets exactly one rule: lowercase.
    expect(screen.getByTestId('pw-requirements').querySelectorAll('.is-met')).toHaveLength(1);
    await user.type(screen.getByLabelText('PASSWORD'), 'DEF12!x');
    expect(screen.getByTestId('pw-requirements').querySelectorAll('.is-met')).toHaveLength(5);
  });

  it('hides the platter from assistive technology', () => {
    const { container } = mount(Login, '/login');
    const bg = container.querySelector('.auth__bg');
    expect(bg).not.toBeNull();
    expect(bg.getAttribute('aria-hidden')).toBe('true');
  });
});
