/**
 * Plan limits - 07 PART 19.0, which is the canonical table every other document
 * forward-references.
 *
 * (05 PART 13's example error text says "Free plan (1 GB)". That is illustrative
 * prose inside a sample response; 19.0 is the numbers document and says 2 GB.
 * The table below follows 19.0.)
 *
 * Billing never reaches this file. 02 PART 6.6 requires that storage/API/MCP
 * code paths only ever read plan limits, so that adding Stripe later touches
 * the plan lookup and nothing else.
 */

export const PLAN_NAMES = ["free", "pro", "team"] as const;
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
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  free: {
    storageBytes: 2 * GB,
    fileCount: 5_000,
    egressBytesPerPeriod: 10 * GB,
    requestsPerPeriod: 100_000,
    maxFileBytes: 100 * MB,
    agents: 3,
    apiKeys: 10,
    members: 1,
  },
  pro: {
    storageBytes: 50 * GB,
    fileCount: 100_000,
    egressBytesPerPeriod: 200 * GB,
    requestsPerPeriod: 2_000_000,
    maxFileBytes: 1 * GB,
    agents: 20,
    apiKeys: 50,
    members: 5,
  },
  team: {
    storageBytes: 500 * GB,
    fileCount: 1_000_000,
    egressBytesPerPeriod: 2048 * GB,
    requestsPerPeriod: 20_000_000,
    maxFileBytes: 5 * GB,
    agents: 100,
    apiKeys: 500,
    members: 25,
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
 * 10/hour/IP - each able to hold 2 GB forever, with nothing that ever reclaimed
 * them. A sandbox is a trial, so it gets trial-sized room.
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

/**
 * The limits actually enforced for a workspace, claim state included.
 *
 * This is what the authorization chain calls. `limitsFor` remains the pure
 * plan-only lookup beneath it, because the staff console and the billing code
 * genuinely do want "what does this plan grant" without the sandbox overlay.
 */
export function limitsForWorkspace(
  workspace: ClaimState & { plan_override: string | null; org_plan: string }
): PlanLimits {
  if (isSandboxWorkspace(workspace)) return SANDBOX_LIMITS;
  return limitsFor(workspace.plan_override, workspace.org_plan);
}
