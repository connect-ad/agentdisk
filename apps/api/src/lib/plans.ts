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
