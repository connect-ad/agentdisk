/**
 * The password policy, in the three places this product sets a password.
 *
 * The policy itself is Firebase's — Authentication → Settings → Password policy,
 * on Require enforcement — because the browser is not where this can be decided:
 * `createUserWithEmailAndPassword` posts straight to `identitytoolkit`, and
 * anything that only lives in this bundle is skipped by a `curl` holding the
 * public web API key. What lives here is the client half of the same rules:
 * say them before the field is submitted, and block a form that cannot succeed.
 *
 * These tests therefore check two different things and neither one on its own
 * is the feature:
 *
 *  - `checkPassword` states the rules once, so the meter and the gate cannot
 *    disagree with each other the way the old `strengthOf` disagreed with the
 *    `pw.length < 8` beside it — a meter that scored a password WEAK and then
 *    let it through is the `backlog/023` defect, not a decoration.
 *  - each form refuses to call Firebase with a password Firebase will refuse,
 *    and names what is missing. Without that the person gets
 *    `auth/password-does-not-meet-requirements` after filling the whole form,
 *    which `describeAuthError` used to render as "Something went wrong signing
 *    you in" — a dead end on the one error they can actually fix.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { PASSWORD_RULES, checkPassword, strengthOf } from '../src/lib/password.js';

vi.mock('../src/lib/workspace.jsx', () => ({
  useWorkspace: () => globalThis.__ws
}));
vi.mock('../src/lib/auth.jsx', async () => {
  const actual = await vi.importActual('../src/lib/auth.jsx');
  return { ...actual, useAuth: () => globalThis.__auth };
});

const { Signup, ResetPassword } = await import('../src/routes/Auth.jsx');
const Settings = (await import('../src/routes/Settings.jsx')).default;
const { describeAuthError } = await vi.importActual('../src/lib/auth.jsx');

afterEach(cleanup);

/** Meets every rule: 8+, upper, lower, digit, symbol. */
const GOOD = 'Str0ng!pass';
/** Long enough for the old rule, and refused by every other one. */
const WEAK = 'abcdefgh';

/* ------------------------------- the rules ------------------------------- */

describe('checkPassword', () => {
  it('mirrors the five rules set in the Firebase console', () => {
    expect(PASSWORD_RULES.minLength).toBe(8);
    expect(PASSWORD_RULES.requirements.map(r => r.id)).toEqual([
      'length',
      'upper',
      'lower',
      'digit',
      'symbol'
    ]);
  });

  it('accepts a password that satisfies all of them', () => {
    const result = checkPassword(GOOD);
    expect(result.ok).toBe(true);
    expect(result.unmet).toEqual([]);
  });

  it('refuses eight lowercase letters, which the old check allowed', () => {
    const result = checkPassword(WEAK);
    expect(result.ok).toBe(false);
    expect(result.unmet.map(r => r.id)).toEqual(['upper', 'digit', 'symbol']);
  });

  it('refuses a short password even when it has every character class', () => {
    const result = checkPassword('Ab1!');
    expect(result.ok).toBe(false);
    expect(result.unmet.map(r => r.id)).toEqual(['length']);
  });

  it('treats an empty field as unmet rather than as an error', () => {
    expect(checkPassword('').ok).toBe(false);
    expect(checkPassword('').unmet).toHaveLength(5);
  });

  it('names what is still missing, in words a person can act on', () => {
    expect(checkPassword(WEAK).summary).toMatch(/uppercase/);
    expect(checkPassword(WEAK).summary).toMatch(/number/);
  });
});

describe('strengthOf', () => {
  it('scores one bar per rule met, so the meter cannot outrank the gate', () => {
    expect(strengthOf(WEAK).score).toBe(2);
    expect(strengthOf(GOOD).score).toBe(5);
  });

  it('never calls a non-compliant password strong', () => {
    expect(strengthOf(WEAK).tone).toBe('bad');
    expect(strengthOf('Passw0rd').label).not.toBe('STRONG');
  });

  it('separates a compliant password from a long compliant one', () => {
    expect(strengthOf(GOOD).label).toBe('GOOD');
    expect(strengthOf('Str0ng!passphrase').label).toBe('STRONG');
  });
});

/* --------------------------------- signup -------------------------------- */

function mountSignup(auth = {}) {
  globalThis.__auth = {
    configured: true,
    signUpWithPassword: vi.fn().mockResolvedValue(undefined),
    signInWithGoogle: vi.fn(),
    signInWithGithub: vi.fn(),
    ...auth
  };
  render(
    <MemoryRouter initialEntries={['/signup']}>
      <Signup />
    </MemoryRouter>
  );
  return globalThis.__auth;
}

async function fillSignup(user, password) {
  await user.type(screen.getByLabelText('FULL NAME'), 'Kernel V5');
  await user.type(screen.getByLabelText('WORK EMAIL'), 'a@b.co');
  await user.type(screen.getByLabelText('PASSWORD'), password);
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Create account' }));
}

describe('Signup', () => {
  it('keeps Create account inactive until every requirement is met', async () => {
    const auth = mountSignup();
    const user = userEvent.setup();
    await fillSignup(user, WEAK);
    // Inactive, not merely refusing on click: the checklist above it has been
    // naming what is missing since the first keystroke, so the button has a
    // visible reason to be dim.
    expect(screen.getByRole('button', { name: 'Create account' }).disabled).toBe(true);
    expect(auth.signUpWithPassword).not.toHaveBeenCalled();
  });

  it('activates it the moment the last requirement is satisfied', async () => {
    mountSignup();
    const user = userEvent.setup();
    const create = () => screen.getByRole('button', { name: 'Create account' });
    await user.type(screen.getByLabelText('FULL NAME'), 'Kernel V5');
    await user.type(screen.getByLabelText('WORK EMAIL'), 'a@b.co');
    await user.click(screen.getByRole('checkbox'));
    // Everything but the symbol.
    await user.type(screen.getByLabelText('PASSWORD'), 'Str0ngpass');
    expect(create().disabled).toBe(true);
    await user.type(screen.getByLabelText('PASSWORD'), '!');
    expect(create().disabled).toBe(false);
  });

  it('still refuses in the handler, for a submit that reaches it anyway', async () => {
    // The disabled button is the guard a person sees; this is the one that
    // holds if a form is submitted without it — and it names the unmet rules
    // rather than saying "too weak".
    const auth = mountSignup();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('FULL NAME'), 'Kernel V5');
    await user.type(screen.getByLabelText('WORK EMAIL'), 'a@b.co');
    await user.type(screen.getByLabelText('PASSWORD'), WEAK);
    fireEvent.submit(screen.getByLabelText('PASSWORD').closest('form'));
    expect(auth.signUpWithPassword).not.toHaveBeenCalled();
    const message = screen.getAllByRole('alert').map(n => n.textContent).join(' ');
    expect(message).toMatch(/uppercase/);
    expect(message).toMatch(/number/);
    expect(message).toMatch(/special/);
  });

  it('accepts a password that meets the policy', async () => {
    const auth = mountSignup();
    const user = userEvent.setup();
    await fillSignup(user, GOOD);
    await waitFor(() =>
      expect(auth.signUpWithPassword).toHaveBeenCalledWith('a@b.co', GOOD, 'Kernel V5')
    );
  });

  it('shows the requirements while they type, before anything is submitted', async () => {
    mountSignup();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('PASSWORD'), 'abc');
    const meter = screen.getByTestId('pw-requirements');
    expect(meter.textContent).toMatch(/uppercase/);
    expect(meter.textContent).toMatch(/special/);
  });
});

/* ----------------------------- reset password ---------------------------- */

function mountReset() {
  window.history.replaceState({}, '', '/reset-password?oobCode=abc123');
  globalThis.__auth = {
    configured: true,
    verifyResetCode: vi.fn().mockResolvedValue('a@b.co'),
    confirmReset: vi.fn().mockResolvedValue(undefined)
  };
  render(
    <MemoryRouter initialEntries={['/reset-password?oobCode=abc123']}>
      <ResetPassword />
    </MemoryRouter>
  );
  return globalThis.__auth;
}

describe('Reset password', () => {
  it('holds the new password to the same policy as signup', async () => {
    const auth = mountReset();
    const user = userEvent.setup();
    await screen.findByLabelText('NEW PASSWORD');
    await user.type(screen.getByLabelText('NEW PASSWORD'), WEAK);
    await user.type(screen.getByLabelText('CONFIRM NEW PASSWORD'), WEAK);
    expect(screen.getByRole('button', { name: 'Update password' }).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText('NEW PASSWORD').closest('form'));
    expect(auth.confirmReset).not.toHaveBeenCalled();
    const message = screen.getAllByRole('alert').map(n => n.textContent).join(' ');
    expect(message).toMatch(/uppercase/);
  });

  it('sets a compliant one', async () => {
    const auth = mountReset();
    const user = userEvent.setup();
    await screen.findByLabelText('NEW PASSWORD');
    await user.type(screen.getByLabelText('NEW PASSWORD'), GOOD);
    await user.type(screen.getByLabelText('CONFIRM NEW PASSWORD'), GOOD);
    await user.click(screen.getByRole('button', { name: 'Update password' }));
    await waitFor(() => expect(auth.confirmReset).toHaveBeenCalledWith('abc123', GOOD));
  });
});

/* -------------------------- settings → security -------------------------- */

const WS_ID = 'ws_01M1WTCVFG3VEX6VRHCZWN1SK2';

function mountSettings(changePassword) {
  globalThis.__ws = {
    workspaceId: WS_ID,
    workspace: { id: WS_ID, name: 'My Workspace', role: 'owner', plan: 'free' },
    workspaces: [{ id: WS_ID, name: 'My Workspace', role: 'owner' }],
    api: { logoutEverywhere: vi.fn() },
    refresh: vi.fn()
  };
  globalThis.__auth = {
    user: { email: 'a@b.co' },
    providerIds: ['password'],
    changePassword
  };
  render(
    <MemoryRouter initialEntries={[`/w/${WS_ID}/settings`]}>
      <Settings />
    </MemoryRouter>
  );
}

describe('Settings → Security', () => {
  const openSecurity = async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Security' }));
    return user;
  };

  it('keeps Change password inactive until the policy is met', async () => {
    const changePassword = vi.fn();
    mountSettings(changePassword);
    const user = await openSecurity();
    const change = () => screen.getByRole('button', { name: 'Change password' });
    await user.type(screen.getByLabelText(/Current password/), 'old-secret');
    await user.type(screen.getByLabelText(/^New password/), WEAK);
    await user.type(screen.getByLabelText(/Confirm new password/), WEAK);
    expect(change().disabled).toBe(true);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('names what is missing while they type, not only on submit', async () => {
    mountSettings(vi.fn());
    const user = await openSecurity();
    await user.type(screen.getByLabelText(/^New password/), WEAK);
    expect(screen.getByText(/Still needs/).textContent).toMatch(/uppercase/);
  });

  it('accepts one that does', async () => {
    const changePassword = vi.fn().mockResolvedValue(undefined);
    mountSettings(changePassword);
    const user = await openSecurity();
    await user.type(screen.getByLabelText(/Current password/), 'old-secret');
    await user.type(screen.getByLabelText(/^New password/), GOOD);
    await user.type(screen.getByLabelText(/Confirm new password/), GOOD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(changePassword).toHaveBeenCalledWith('old-secret', GOOD));
  });

  it('no longer promises a rule nobody enforces', async () => {
    mountSettings(vi.fn());
    await openSecurity();
    // The hint said "At least 12 characters" while the form checked nothing.
    expect(screen.queryByText(/At least 12 characters/)).toBeNull();
  });
});

/* ------------------------------ the rejection ----------------------------- */

describe('describeAuthError', () => {
  it('turns a policy rejection into something a person can act on', () => {
    const message = describeAuthError({ code: 'auth/password-does-not-meet-requirements' });
    expect(message).toMatch(/password/i);
    // The default is the dead end this case exists to avoid.
    expect(message).not.toMatch(/Something went wrong/);
  });

  it('states the real minimum for a weak-password rejection', () => {
    const message = describeAuthError({ code: 'auth/weak-password' });
    expect(message).toMatch(/8/);
    expect(message).toMatch(/uppercase|number|special/i);
  });
});
