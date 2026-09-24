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
 * No card form, ever. The card is entered on Stripe's own hosted page, on
 * Stripe's domain, and nothing card-shaped reaches this origin — that is what
 * keeps AgentDisk in PCI SAQ-A, and a "convenient" field here would end it.
 * Picking a plan and sending somebody to Stripe breaks neither rule, which is
 * why that is the direction this page grows in.
 *
 * Invoices stay on Stripe's portal rather than being copied here, so the two
 * cannot disagree about what somebody was charged.
 */
export default function Billing() {
  return (
    <div className="acct acct--billing">
      <h2 className="ds__h2">Manage Subscription</h2>
      <p className="ds__sub acct__sub">
        Plan and payment for the organization that owns this workspace. One bill covers
        every workspace on the account, and nothing renews automatically.
      </p>
      <BillingTab />
    </div>
  );
}
