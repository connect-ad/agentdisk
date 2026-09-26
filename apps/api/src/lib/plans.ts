/**
 * The plan limits floor - 17 Sept 2026 canonical table.
 *
 * ── What this file is, now that billing exists ──────────────────────────────
 * It used to say "billing never reaches this file". That was true and is not
 * any more, but the inversion is smaller than it sounds.
 *
 * Entitlements are now driven by the D1 `plans` table, which mirrors Stripe
 * product metadata, so a price or an allowance changes without a deploy
 * (14 PART 29.6). The numbers below are what the resolver falls back to, **per
 * field**, whenever D1 cannot supply one: no row, a row written by a half-
 * finished sync, a column added in a later migration, a value that does not
 * parse. See `billing/catalogue.ts`.
 *
 * That makes this the floor, and the direction of the fallback is the whole
 * point. amardrive - the reference implementation this borrows from - falls
 * back to a hardcoded 15 GB for a user with no subscription row, against a free
 * tier of 5 GB, so its failure mode silently grants three times the quota
 * somebody paid for. Falling back to the tier's own hardcoded value can only
 * ever match or tighten.
 *
 * Nothing here is authoritative about *price*. Stripe is.
 *
 * ── Unlimited ───────────────────────────────────────────────────────────────
 * Egress, requests and file count are unlimited on every plan. R2 egress costs
 * nothing, so it is free to promise, and storage already bounds file count -
 * a second aggregate cap is a second number that can contradict the first.
 *
 * The checks were deliberately NOT deleted. `assertWithinQuota` still compares
 * against these fields, and they still ride on every response that reports
 * usage. Keeping the machinery and widening the value means re-introducing a
 * cap later is a data change; deleting it would mean rebuilding the counters,
 * the checks and the Usage screen's meters from nothing.
 */

export const PLAN_NAMES = ["free", "basic", "pro", "team"] as const;
export type PlanName = (typeof PLAN_NAMES)[number];

export interface PlanLimits {
  storageBytes: number;
  fileCount: number;
  egressBytesPerPeriod: number;
  requestsPerPeriod: number;
  maxFileBytes: number;
  agents: number;
  apiKeys: number;
  members: number;
  /**
   * Workspaces the billing account may own.
   *
   * New in the billing module, and the only limit here counted against the
   * ORGANIZATION rather than a single workspace - as are `agents`, `apiKeys`
   * and `members` since 17 Sept 2026. A workspace-scoped count would make
   * "50 workspaces, 50 agent identities" mean 2,500 agents on Team, which is
   * not what the plan is selling.
   */
  workspaces: number;
  /**
   * Live public share links a workspace may hold.
   *
   * Zero is the free plan's wall, and it is a count rather than a boolean so
   * that it travels through the same D1 column, the same -1-means-unlimited
   * convention and the same admin-console editor as every other limit. A
   * boolean would have needed a second shape for one field.
   */
  shareLinks: number;
}

/**
 * No ceiling. Written as a named constant rather than Infinity because these
 * values are compared, serialized to JSON and mirrored into an INTEGER column,
 * and `Infinity` survives none of those three intact - `JSON.stringify` turns
 * it into `null`, which reads back as "unspecified" and would fall through to
 * the floor.
 *
 * In D1 the same idea is the literal -1, because a column also has to
 * distinguish "unlimited" from "not specified". See migration 0012.
 */
export const UNLIMITED = Number.MAX_SAFE_INTEGER;

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  free: {
    storageBytes: 1 * GB,
    fileCount: 10_000,
    egressBytesPerPeriod: 10 * GB,
    requestsPerPeriod: UNLIMITED,
    maxFileBytes: 100 * MB,
    agents: 1,
    apiKeys: 2,
    members: 1,
    workspaces: 1,
    shareLinks: 0,
  },
  basic: {
    storageBytes: 5 * GB,
    fileCount: 100_000,
    egressBytesPerPeriod: 50 * GB,
    requestsPerPeriod: UNLIMITED,
    maxFileBytes: 500 * MB,
    agents: 5,
    apiKeys: 6,
    members: 2,
    workspaces: 3,
    shareLinks: 10,
  },
  pro: {
    storageBytes: 50 * GB,
    fileCount: 1_000_000,
    egressBytesPerPeriod: 500 * GB,
    requestsPerPeriod: UNLIMITED,
    maxFileBytes: 1 * GB,
    agents: 10,
    apiKeys: 20,
    members: 5,
    workspaces: 10,
    shareLinks: 100,
  },
  team: {
    storageBytes: 500 * GB,
    fileCount: 10_000_000,
    egressBytesPerPeriod: 5000 * GB,
    requestsPerPeriod: UNLIMITED,
    maxFileBytes: 4.9 * GB,
    agents: 50,
    apiKeys: 100,
    members: 25,
    workspaces: 50,
    shareLinks: UNLIMITED,
  },
};

export function isPlanName(value: unknown): value is PlanName {
  return typeof value === "string" && (PLAN_NAMES as readonly string[]).includes(value);
}

/**
 * The workspace's effective plan: its override if it has one, else the org's.
 *
 * Anything unrecognised resolves to `free`. Failing to the *tightest* limits is
 * the only safe direction - a typo in a plan column must never be the thing
 * that grants Team quota.
 */
export function resolvePlan(planOverride: string | null, orgPlan: string): PlanName {
  if (isPlanName(planOverride)) return planOverride;
  if (isPlanName(orgPlan)) return orgPlan;
  return "free";
}

export function limitsFor(planOverride: string | null, orgPlan: string): PlanLimits {
  return PLAN_LIMITS[resolvePlan(planOverride, orgPlan)];
}

/**
 * What an *unclaimed* sandbox workspace gets, instead of the free plan.
 *
 * Deliberately **not** a member of PLAN_NAMES, and that separation is the whole
 * point rather than a technicality. PLAN_NAMES gates `workspaces.plan_override`
 * and `organizations.plan` - the columns a human, and eventually the admin plan
 * editor (14 PART 29.6), can set. "sandbox" is not a thing anybody can be *put*
 * on; it is a description of a claim state, derived fresh on every request from
 * `claimed_at`. Adding it to the union would make it selectable, and a workspace
 * someone had deliberately placed on "sandbox" would then silently become
 * eligible for deletion by the unclaimed sweep.
 *
 * The numbers are tighter than free for one reason: before this existed, an
 * anonymous caller could mint unlimited unclaimed workspaces - bounded only by
 * 10/hour/IP - each able to hold a full free tier forever, with nothing that
 * ever reclaimed them. A sandbox is a trial, so it gets trial-sized room.
 *
 * Note that the aggregate caps here are NOT unlimited, where every real plan's
 * now are. That is the point: the reason egress and requests can be unlimited
 * on a paid plan is that somebody's card is attached to the account. Nobody's
 * is attached to an anonymous sandbox.
 *
 * `maxFileBytes` deliberately does **not** shrink. It is a per-file ceiling, not
 * an allowance, and lowering it would make the sandbox fail on exactly the file
 * an evaluator is most likely to try first. The aggregate caps are what bound
 * the abuse; the per-file cap only bounds one request.
 */
export const SANDBOX_LIMITS: PlanLimits = {
  storageBytes: 50 * MB,
  fileCount: 500,
  egressBytesPerPeriod: 500 * MB,
  requestsPerPeriod: 10_000,
  maxFileBytes: 100 * MB,
  agents: 1,
  apiKeys: 1,
  members: 1,
  // A sandbox is exactly one workspace and belongs to no organization, so
  // there is nothing for it to own a second of. Present because PlanLimits
  // requires it, not because it is a quota anything checks.
  workspaces: 1,
  // Zero, not a smaller number. An unclaimed sandbox is anonymous and
  // Turnstile-gated; nothing about it should be able to publish bytes to the
  // open internet.
  shareLinks: 0,
};

/** The claim-state fields limits resolution needs. A subset, so tests can pass a literal. */
export interface ClaimState {
  claimed_at: number | null;
  claim_token_hash: string | null;
}

/**
 * Whether the tighter sandbox limits apply to this workspace.
 *
 * Two conditions, and the second one is the rollout guard rather than a
 * redundant check. `claimed_at IS NULL` alone would be the natural definition -
 * but applying it that way would retroactively re-tier every sandbox already
 * sitting in the dev environment from earlier testing, and any of them already
 * holding more than 50 MB would start failing *every* write the instant this
 * deployed. Requiring a claim token as well means only workspaces provisioned
 * after this shipped are affected, because only those were ever issued one.
 *
 * It is also self-describing: there is no cutoff timestamp to configure, get
 * wrong, or forget to move between environments. A workspace either carries the
 * artifact of the new provisioning path or it does not.
 */
export function isSandboxWorkspace(workspace: ClaimState): boolean {
  return workspace.claimed_at === null && workspace.claim_token_hash !== null;
}
