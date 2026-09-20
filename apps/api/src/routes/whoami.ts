/**
 * GET /v1/whoami - 05 PART 13.
 *
 * The first route behind the authorization chain, and deliberately the one that
 * reflects the caller's own resolved identity back at them: if this returns the
 * right workspace, the chain resolved the workspace from the key rather than
 * from anything the client said.
 *
 * What it must never return: the key hash, the raw token, or any part of the
 * secret beyond the prefix and last four that 15.3 designed for display. A
 * Firebase caller has no key at all, so `key` is null for them rather than a
 * shape full of nulls that a client would have to guess the meaning of.
 */

import { resolvePlan } from "../lib/plans";
import type { AuthContext } from "../middleware/auth";

export async function whoami(ctx: AuthContext): Promise<Response> {
  const { identity, workspace, limits } = ctx;

  // Counted live, the same way `POST /v1/shares` counts before deciding
  // whether to refuse — a stale "shares used" number here would let the
  // dashboard say a plan allows one more link when the create call is about
  // to say otherwise. Cheap: `share_links` is small per workspace and this is
  // a single indexed COUNT, not a listing.
  const shareLinksUsed = await ctx.db.shares.countLive(ctx.now);

  const scopes = {
    ops: identity.scope.ops,
    pathPrefix: identity.scope.pathPrefix === "" ? "/*" : `${identity.scope.pathPrefix}/*`,
  };

  const body = {
    actor: {
      type: identity.actorType,
      id: identity.actorId,
    },
    credential: identity.kind,
    key:
      identity.kind === "api_key"
        ? {
            id: identity.keyId,
            mode: identity.mode,
            prefix: identity.keyPrefix,
            lastFour: identity.keyLastFour,
            scopes,
          }
        : null,
    user:
      identity.kind === "firebase_user"
        ? {
            id: identity.userId,
            email: identity.email,
            emailVerified: identity.emailVerified,
            role: identity.role,
            signInProvider: identity.signInProvider,
            scopes,
          }
        : null,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      plan: resolvePlan(workspace.plan_override, workspace.org_plan),
    },
    usage: {
      storageBytes: { used: workspace.storage_bytes_used, max: limits.storageBytes },
      files: { used: workspace.file_count, max: limits.fileCount },
      egressBytes: { used: workspace.egress_bytes_period, max: limits.egressBytesPerPeriod },
      requests: { used: workspace.requests_period, max: limits.requestsPerPeriod },
      /**
       * The one entitlement the dashboard has to gate a *button* on before any
       * request is made — the other three only ever explain a number after the
       * fact. Zero on the free plan is a wall, not a warning, so the create
       * dialog can honestly disable itself instead of offering a control the
       * server would refuse.
       */
      shareLinks: { used: shareLinksUsed, max: limits.shareLinks },
      periodResetAt: new Date(workspace.period_reset_at).toISOString(),
    },
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
