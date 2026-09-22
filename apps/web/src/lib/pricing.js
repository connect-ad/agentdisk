/**
 * The single source of every number on the pricing page.
 *
 * Numbers stay hardcoded here by decision (`backlog/001` task 11): the server
 * sends no pricing table, only `purchasable` plan ids. Everything the page
 * renders is read from `PLANS` below, so markup in `Marketing.jsx` does not
 * move when a figure changes.
 *
 * ── Where these values come from ─────────────────────────────────────────
 * The entitlement table in `backlog/001-billing-module.md`, which is stated to
 * replace every other pricing table in the repository. It agrees with
 * `apps/api/src/lib/plans.ts` — the module the upload path actually enforces —
 * and with the four products created in Stripe on 18 September 2026. All three
 * say the same thing; this file is the fourth copy and the only public one, so
 * it is the one that has to be checked against them.
 *
 *   name, limits   apps/api/src/lib/plans.ts · PLAN_LIMITS
 *   price          the Stripe catalogue: $0 / $9 / $20 / $80
 *
 * ── What this file used to claim, and why it was wrong ───────────────────
 * Three tiers, a 2 GB free allowance and "100,000 requests / month". None of
 * those survive the final plan:
 *
 *   Basic did not exist here at all. It is a real $9 product in Stripe and a
 *   real row in `PLAN_LIMITS`, so a three-column page was hiding a plan people
 *   can be billed for.
 *
 *   Free is 1 GB, not 2. The API enforced 1 GB the whole time, so the page was
 *   advertising twice the quota the upload path would allow — the exact bug
 *   this file's header warned about when the design claimed 5 GB.
 *
 *   Requests are unlimited on every plan, so a 100,000/month cap was a limit
 *   nothing imposes. Egress and file count are unlimited too.
 *
 * Webhooks and path-scoped keys were listed as Pro features. They are ungated
 * on every plan, so naming them per-tier implied a gate that does not exist.
 *
 * ── What is deliberately absent ──────────────────────────────────────────
 * Priority support. The entitlement table marks it "display only" on the tiers
 * that have it, which means no support process is wired to it; selling it on a
 * public page would be a promise nothing keeps.
 *
 * Overage rates. Pricing is hard-capped — there is no metered tier above a
 * plan limit, by design, which is why the console has no overage row either.
 * `OVERAGES` stays empty and the page's table stays unrendered.
 */

/** Mirrors PLAN_LIMITS in apps/api/src/lib/plans.ts. Keep the two in step. */
export const PLANS = [
  {
    id: 'free',
    name: 'Free',
    kicker: 'FREE',
    price: '$0',
    unit: 'forever',
    featured: false,
    cta: 'Start free',
    ctaTo: '/signup',
    lines: [
      '1 GB storage',
      '1 agent identity',
      '10 GB egress / month · 10,000 files',
      'Unlimited requests',
      '1 workspace · 1 member · 2 API keys',
      '100 MB max file size',
    ],
  },
  {
    id: 'basic',
    name: 'Basic',
    kicker: 'BASIC',
    price: '$9',
    unit: '/ month',
    featured: false,
    cta: 'Start on Basic',
    ctaTo: '/signup',
    lines: [
      '5 GB storage',
      '5 agent identities',
      '50 GB egress / month · 100,000 files',
      'Unlimited requests',
      '3 workspaces · 2 members · 6 API keys',
      '500 MB max file size',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    kicker: 'PRO',
    price: '$20',
    unit: '/ month',
    featured: true,
    cta: 'Start on Pro',
    ctaTo: '/signup',
    lines: [
      '50 GB storage',
      '10 agent identities',
      '500 GB egress / month · 1,000,000 files',
      'Unlimited requests',
      '10 workspaces · 5 members · 20 API keys',
      '1 GB max file size',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    kicker: 'TEAM',
    price: '$80',
    unit: '/ month',
    featured: false,
    cta: 'Start on Team',
    ctaTo: '/signup',
    lines: [
      '500 GB storage',
      '50 agent identities',
      '5,000 GB egress / month · 10,000,000 files',
      'Unlimited requests',
      '50 workspaces · 25 members · 100 API keys',
      '4.9 GB max file size',
    ],
  },
];

/**
 * The free tier in one clause, for prose.
 *
 * The landing band and the signup panel both state it mid-sentence. The landing
 * one used to read `PLANS[0].lines[0]` and `lines[1]` positionally, so
 * reordering a card's bullets silently rewrote a sentence on another page —
 * and the signup panel did not read this module at all, which is how it came to
 * advertise a free allowance this module had already been corrected away from.
 */
export const FREE_SUMMARY = '1 GB of storage and one agent identity';

/**
 * Counted per organization, not per workspace: agents, keys, members and
 * workspaces are account-wide totals. Stated once, on the page, rather than
 * repeated on four cards.
 */
export const COUNTING_NOTE =
  'Agents, keys, members and workspaces are counted across your whole account, not per workspace.';

/**
 * Metered overage rows. Permanently empty — see the header. Kept as an export
 * because the page already branches on it, and an empty array is a clearer
 * statement of "there are none" than deleting the branch and leaving the
 * question open.
 */
export const OVERAGES = [];
