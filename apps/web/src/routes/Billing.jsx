import React from 'react';
import { BillingTab } from './SettingsTabs.jsx';

/**
 * Billing, as its own page in the account area.
 *
 * ── Why this exists when Settings already had a Billing tab ───────────────
 * `AgentDisk Dashboard.dc.html` reaches billing from the profile menu, not
 * from workspace settings, and it is right to: one organization owns many
 * workspaces and is billed once, so billing is an account concern that merely
 * happened to be filed under a workspace's settings. The tab was also the only
 * way in, and `Settings.jsx` keeps its tab in `useState` — so there was no URL
 * for a menu item to point at, and none to send anybody in a support thread.
 *
 * It renders the existing `BillingTab` rather than a second implementation.
 * Both are the same component reading the same endpoint; the tab stays where
 * it is so an existing bookmark or habit does not break.
 *
 * ── What this page deliberately does not do ───────────────────────────────
 * 14 PART 29.1 puts everything past "who is this account" on Stripe's hosted
 * portal: cards, plan changes, cancellation. A card form here would be a PCI
 * surface and a plan-change UI would be a second place for pricing to drift
 * out of step with Stripe. Reading invoices and the card's brand back from
 * Stripe to *display* breaks neither rule, which is why that is the only
 * direction this page grows in.
 */
export default function Billing() {
  return (
    <div className="acct acct--billing">
      <h2 className="ds__h2">Billing</h2>
      <p className="ds__sub acct__sub">
        Plan and payment for the organization that owns this workspace. One bill covers
        every workspace on the account.
      </p>
      <BillingTab />
    </div>
  );
}
