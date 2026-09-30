/**
 * The console's two rules, tested where they live.
 *
 * **1. The role matrix.** The sidebar and every gated control read `holds`, so
 * a mistake there silently offers somebody a control their role cannot use —
 * which is only embarrassing, because the server refuses independently — or,
 * worse, hides a screen from a role that should have it, which is how a support
 * engineer ends up escalating something they could have answered. The design
 * gates Billing and Plans at admin; these pin the correction.
 *
 * **2. Never render an invented value.** The formatters are where that rule is
 * actually enforceable, and the case that matters most is `quota`: `null` and
 * `-1` are different answers from the database and must stay different on
 * screen. `-1` is unlimited, a decision somebody made; `null` means the plan row
 * did not say and the code floor applies. Collapsing them would show an
 * operator "Unlimited" for a column that is simply missing.
 */

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NAV, holds } from '../src/components/Shell.jsx';
import { ErrorState, NotTracked } from '../src/components/States.jsx';
import { UNAVAILABLE, bytes, count, money, quota } from '../src/lib/format.js';

afterEach(cleanup);

describe('the role matrix', () => {
  it('has one role, which reaches every screen', () => {
    // Three tests here pinned a three-tier nav matrix. The server collapsed to
    // a single `admin` role, so `holds('admin', 'super_admin')` was false and
    // Admin Accounts was hidden from everybody - including the only role that
    // could reach it. The tests stayed green because RANK still described the
    // old hierarchy, which is exactly how a nav can be broken and covered at
    // the same time.
    expect(holds('admin', 'admin')).toBe(true);

    const visible = NAV.filter(item => holds('admin', item.role)).map(item => item.key);
    for (const key of ['overview', 'users', 'billing', 'plans', 'audit', 'deletions', 'admin']) {
      expect(visible).toContain(key);
    }
  });

  it('refuses a role it does not recognise rather than defaulting to the most permissive', () => {
    // Unchanged, and the one property worth keeping from the old matrix: an
    // unknown role grants nothing. The roles it now refuses include the two
    // that used to be real.
    expect(holds('root', 'admin')).toBe(false);
    expect(holds(undefined, 'admin')).toBe(false);
    expect(holds('support', 'admin')).toBe(false);
    expect(holds('super_admin', 'admin')).toBe(false);
  });
});

describe('never render an invented value', () => {
  it('keeps "unlimited" and "the row did not say" distinguishable', () => {
    // The distinction migration 0012 is built on. -1 is a decision; null is a
    // gap that defers to the code floor.
    expect(quota(-1)).toBe('Unlimited');
    expect(quota(null)).toBe('from code default');
    expect(quota(undefined)).toBe('from code default');
    expect(quota(0)).toBe('0');
    expect(quota(50)).toBe('50');
  });

  it('never turns a missing number into a zero', () => {
    expect(bytes(null)).toBe(UNAVAILABLE);
    expect(bytes(undefined)).toBe(UNAVAILABLE);
    expect(count(null)).toBe(UNAVAILABLE);
    expect(money(null)).toBe(UNAVAILABLE);

    // A real zero still reads as zero.
    expect(bytes(0)).toBe('0 B');
    expect(count(0)).toBe('0');
    expect(money(0)).toBe('$0');
  });

  it('formats bytes at the scale an operator reads', () => {
    expect(bytes(1024)).toBe('1 KB');
    expect(bytes(1024 ** 3)).toBe('1 GB');
    expect(bytes(50 * 1024 ** 3)).toBe('50 GB');
    expect(bytes(-1)).toBe('Unlimited');
  });

  it('renders a price without inventing cents that are not there', () => {
    expect(money(2000)).toBe('$20');
    expect(money(900)).toBe('$9');
    expect(money(1999)).toBe('$19.99');
  });

  it('says what is not tracked rather than showing nothing', () => {
    render(<NotTracked />);
    expect(screen.getByText('not tracked yet')).toBeInTheDocument();
  });
});

describe('a refusal reads differently from a failure', () => {
  it('names the role as the cause on a 403, and offers no retry', () => {
    // Retrying a 403 cannot succeed. Offering the button would teach an
    // operator to keep pressing it.
    render(<ErrorState error={{ status: 403, code: 'FORBIDDEN', message: 'The support role cannot edit plans.' }} onRetry={() => {}} />);

    expect(screen.getByText(/NOT PERMITTED FOR YOUR ROLE/)).toBeInTheDocument();
    expect(screen.getByText(/The server refused this, not the interface/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('offers a retry on an ordinary failure, and shows the request id', () => {
    render(
      <ErrorState
        error={{ status: 500, code: 'INTERNAL_ERROR', message: 'Something broke.', requestId: 'req_ABC' }}
        onRetry={() => {}}
      />
    );

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    // The one thing that lets somebody find this in the Worker's logs without
    // being asked to reproduce it.
    expect(screen.getByText(/req_ABC/)).toBeInTheDocument();
  });
});
