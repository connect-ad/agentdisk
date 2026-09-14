/**
 * The single source of every number on the pricing page.
 *
 * Pricing becomes dynamic at the end of the project. Everything the page
 * renders is read from `PLANS` below, so that change is a swap of this module
 * for an API call — no markup in `Marketing.jsx` moves.
 *
 * ── Why these values and not the design's ────────────────────────────────
 * `AgentDisk Site.dc.html` draws FREE / TEAM / SCALE at $0 / $49 / $249 with
 * 5 / 50 / 500 GB. Two of those would be wrong here whichever way pricing is
 * sourced later:
 *
 *   The design advertises 5 GB free. `apps/api/src/lib/plans.ts` enforces
 *   2 GB, and that is the number the upload path checks. Promising quota the
 *   API refuses is a bug, not a design choice.
 *
 *   The design's tier NAMES collide with the code's. Its "TEAM" is the 50 GB
 *   tier; the API's `team` is the 500 GB tier. Shipping the design's names
 *   would label a 500 GB customer "Scale" while every API response, audit row
 *   and Stripe mapping calls them `team`.
 *
 * So limits and names mirror `plans.ts`, and prices are the ones the live
 * marketing page already shows.
 *
 * ── What is authoritative and what is a placeholder ──────────────────────
 *   name, limits   mirror apps/api/src/lib/plans.ts  → later: the API
 *   price          today's marketing page            → later: Stripe
 *   overage rates  DO NOT EXIST anywhere in the repo → later: Stripe
 *
 * There are no overage rates in the codebase, so the design's "Metered above
 * plan limits" table has nothing to fill it. It is omitted rather than
 * invented — inventing four figures is how `backlog/024` started.
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
      '2 GB storage',
      '100,000 requests / month',
      '3 agent identities',
      'MCP server + REST API',
      '10 API keys, 1 member',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    kicker: 'PRO',
    price: '$20',
    unit: '/ month',
    featured: true,
    cta: 'Start free trial',
    ctaTo: '/signup',
    lines: [
      '50 GB storage',
      '2M requests / month',
      '20 agent identities',
      'Webhooks + path-scoped keys',
      '50 API keys, 5 members',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    kicker: 'TEAM',
    price: '$80',
    unit: '/ month',
    featured: false,
    cta: 'Talk to us',
    ctaTo: '/signup',
    lines: [
      '500 GB storage',
      '20M requests / month',
      '100 agent identities',
      'Unlimited path prefixes',
      '500 API keys, 25 members',
    ],
  },
];

/**
 * Metered overage rows. Empty until a rate exists as data.
 *
 * The page renders this table only when it has something to put in it, so the
 * day rates arrive from Stripe the section appears with no markup change.
 */
export const OVERAGES = [];
