/**
 * The plan's count gates: workspaces, agents, API keys, members.
 *
 * Until 4 Oct 2026 these four fields of `PlanLimits` were read by nothing on
 * a write path - the pricing page said "1 workspace, 1 agent, 2 API keys" and
 * the API created a twentieth of each without comment (Skill 11, known gaps).
 * This is the check, shaped exactly like the share-link gate in
 * routes/shares.ts: count the live rows, compare, refuse with 403 FORBIDDEN
 * and a `details` block the dashboard can render as "used / allowed".
 *
 * FORBIDDEN rather than LIMIT_EXCEEDED, deliberately, and for the same reason
 * share links chose it. 429 says "try again later" and a client will. A plan
 * ceiling does not clear with time; it clears when somebody deletes
 * something or upgrades, and 403 is the status that says so.
 *
 * The check happens before any work and before any insert, so a refused
 * request leaves nothing behind - no half-minted key, no agent row to clean
 * up. Two creates racing past the same ceiling can both land; the gate is a
 * pricing boundary, not a security one, and a customer one over by a race
 * is an upgrade conversation, not an incident.
 */

import type { CountedDimension, OrgCounts } from "../db/org-counts";
import { forbidden } from "./errors";
import { UNLIMITED, isSandboxWorkspace, type ClaimState, type PlanLimits } from "./plans";

/** The plan field each counted dimension is held to. */
const LIMIT_FIELD: Record<CountedDimension, keyof PlanLimits> = {
  workspaces: "workspaces",
  agents: "agents",
  apiKeys: "apiKeys",
  members: "members",
};

const NOUN: Record<CountedDimension, [singular: string, plural: string]> = {
  workspaces: ["workspace", "workspaces"],
  agents: ["agent", "agents"],
  apiKeys: ["API key", "API keys"],
  members: ["member", "members"],
};

/** What the account is on, as a customer would say it: "Free", "Pro". */
export function planLabel(plan: { org_plan: string; org_plan_override: string | null }): string {
  const id =
    plan.org_plan_override !== null && plan.org_plan_override !== ""
      ? plan.org_plan_override
      : plan.org_plan;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export interface CountGateOptions {
  /**
   * For members: the person being invited. Somebody already invited to
   * another workspace on this bill does not need a second slot.
   */
  excludeUserId?: string;
}

/**
 * Refuse if creating one more of `dimension` would exceed the plan.
 *
 * `workspace` is whatever the caller has that says which plan applies and
 * whether this is an unclaimed sandbox; the middleware's `ctx.workspace`
 * satisfies it, and the user-authenticated workspace route builds one from
 * the organization row.
 */
export async function assertCountWithinPlan(
  counts: OrgCounts,
  dimension: CountedDimension,
  limits: PlanLimits,
  workspace: ClaimState & { org_plan: string; org_plan_override: string | null },
  options: CountGateOptions = {}
): Promise<void> {
  const allowed = limits[LIMIT_FIELD[dimension]];
  if (allowed >= UNLIMITED) return;

  const used =
    dimension === "members" ? await counts.members(options.excludeUserId) : await counts[dimension]();
  if (used < allowed) return;

  const [singular, plural] = NOUN[dimension];
  const noun = allowed === 1 ? singular : plural;
  const message = isSandboxWorkspace(workspace)
    ? `This sandbox allows ${allowed} ${noun}. Claim it to add more.`
    : allowed === 0
      ? `Your ${planLabel(workspace)} plan doesn't include ${plural}. Upgrade to add some.`
      : `Your ${planLabel(workspace)} plan allows ${allowed} ${noun}. Upgrade to add more.`;

  throw forbidden(message, { limit: dimension, used, allowed });
}
