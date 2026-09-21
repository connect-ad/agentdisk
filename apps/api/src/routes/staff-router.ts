/**
 * Staff route dispatch.
 *
 * Lifted verbatim out of `index.ts`, where it was the one block two people
 * could not edit at the same time. Nothing about the routing changed: the same
 * segments are matched in the same order, and an unmatched staff path still
 * throws NOT_FOUND here rather than falling through to the customer chain
 * below it.
 *
 * Keeping it in its own file also states the boundary the block already had.
 * Staff use a separate table, a separate token shape and a separate code path
 * from every customer route, so there is no path along which a customer
 * credential could be evaluated against staff logic, or the reverse. This
 * module is the only place `StaffScopedAccess` is reachable.
 */

import { ApiError } from "../lib/errors";
import { readEmailConfig } from "../lib/email";
import { readFirebaseAdminConfig } from "../auth/firebase-admin";
import {
  staffForceLogout,
  staffForcePasswordReset,
  staffGetWorkspace,
  staffListWorkspaces,
  staffOverview,
  staffRevokeKeys,
  staffSetWorkspaceStatus,
  staffWhoami,
  staffWorkspaceActivity,
} from "./staff";
import {
  staffAudit,
  staffAuditExport,
  staffAuditFilters,
  staffBilling,
  staffCreateAccount,
  staffCreatePlan,
  staffDeleteUser,
  staffDeleteWorkspace,
  staffDeletionCheck,
  staffFindUser,
  staffGetUser,
  staffListAccounts,
  staffListPlans,
  staffNeedsAttention,
  staffRestoreUser,
  staffRestoreWorkspace,
  staffRetirePlan,
  staffRevokeKey,
  staffSetAccountDisabled,
  staffSetAccountRole,
  staffSetAgentStatus,
  staffSetPlanOverride,
  staffSetUserDisabled,
  staffStripeDiff,
  staffSyncCatalogue,
  staffSyncFromStripe,
  staffTransferOwner,
  staffUpdatePlan,
  staffWorkspaceBlastRadius,
} from "./staff-console";
import { staffGetEmailSettings, staffTestEmail } from "./staff-settings";
// Type-only, so it is erased at compile time and the index <-> router cycle
// never exists at runtime.
import type { Env } from "../index";

/**
 * Dispatch one `/v1/staff/...` request. The caller has already established the
 * prefix; `segments` is the whole split path, so the indices below match what
 * they matched in `index.ts`.
 */
export async function handleStaffRoute(
  request: Request,
  env: Env,
  segments: string[],
  requestId: string
): Promise<Response> {
  const staffDeps = {
    db: env.DB,
    kv: env.CACHE,
    encryptionKey: env.DATABASE_ENCRYPTION_KEY,
    requestId,
    now: Date.now(),
    // Resolved here, once, so the handlers receive a config object rather
    // than the environment - there is no path from a staff handler to the
    // raw token. Null means "not configured here", which the handlers
    // that need it turn into a refusal naming the feature.
    email: readEmailConfig(env),
    firebaseAdmin: readFirebaseAdminConfig(env),
    dashboardUrl: env.DASHBOARD_URL,
    // Cloudflare sets this itself and a client cannot forge it. Read once here
    // so no handler has to remember to.
    sourceIp: request.headers.get("cf-connecting-ip"),
    // The same verifier and the same project as the customer chain. Staff are
    // told apart by their staff_users row, never by the credential.
    // undefined rather than an empty projectId when unset, so requireStaff
    // refuses with "not configured" instead of verifying every token against an
    // audience of "" and reporting it as a bad credential.
    firebase:
      env.FIREBASE_PROJECT_ID === undefined || env.FIREBASE_PROJECT_ID === ""
        ? undefined
        : { cache: env.CACHE, projectId: env.FIREBASE_PROJECT_ID },
    stripeSecretKey: env.STRIPE_SECRET_KEY,
  };

  const [, , area, resourceId, action] = segments;

  // No login or logout route. A Firebase ID token IS the session (migration
  // 0014), so signing in happens entirely in the browser against Firebase and
  // signing out is discarding the token there. A server endpoint for either
  // would be a thing that looks like it does something and does not.
  if (area === "whoami" && request.method === "GET") {
    return await staffWhoami(request, staffDeps);
  }
  if (area === "overview" && request.method === "GET") {
    return await staffOverview(request, staffDeps);
  }
  if (area === "workspaces") {
    if (resourceId === undefined && request.method === "GET") {
      return await staffListWorkspaces(request, staffDeps);
    }
    // Before the `:id` GET below, or this reads as a workspace whose id is the
    // literal string "needs-attention" and answers 404 - which looks like a
    // data problem rather than the routing one it is.
    if (resourceId === "needs-attention" && request.method === "GET") {
      return await staffNeedsAttention(request, staffDeps);
    }
    if (resourceId !== undefined && action === undefined && request.method === "GET") {
      return await staffGetWorkspace(request, staffDeps, resourceId);
    }
    if (resourceId !== undefined && action === "activity" && request.method === "GET") {
      return await staffWorkspaceActivity(request, staffDeps, resourceId);
    }
    if (resourceId !== undefined && action === "status" && request.method === "POST") {
      return await staffSetWorkspaceStatus(request, staffDeps, resourceId);
    }
    if (resourceId !== undefined && action === "plan-override" && request.method === "PATCH") {
      return await staffSetPlanOverride(request, staffDeps, resourceId);
    }
    if (resourceId !== undefined && action === "blast-radius" && request.method === "GET") {
      return await staffWorkspaceBlastRadius(request, staffDeps, resourceId);
    }
    if (resourceId !== undefined && action === "restore" && request.method === "POST") {
      return await staffRestoreWorkspace(request, staffDeps, resourceId);
    }
    if (resourceId !== undefined && action === undefined && request.method === "DELETE") {
      return await staffDeleteWorkspace(request, staffDeps, resourceId);
    }
  }

  if (area === "users" && resourceId === undefined && request.method === "GET") {
    return await staffFindUser(request, staffDeps);
  }

  if (area === "users" && resourceId !== undefined) {
    if (action === undefined && request.method === "GET") {
      return await staffGetUser(request, staffDeps, resourceId);
    }
    if (action === "disable" && request.method === "PATCH") {
      return await staffSetUserDisabled(request, staffDeps, resourceId);
    }
    if (action === "deletion-check" && request.method === "GET") {
      return await staffDeletionCheck(request, staffDeps, resourceId);
    }
    if (action === "restore" && request.method === "POST") {
      return await staffRestoreUser(request, staffDeps, resourceId);
    }
    if (action === undefined && request.method === "DELETE") {
      return await staffDeleteUser(request, staffDeps, resourceId);
    }
    if (action === "force-logout" && request.method === "POST") {
      return await staffForceLogout(request, staffDeps, resourceId);
    }
    if (action === "revoke-keys" && request.method === "POST") {
      return await staffRevokeKeys(request, staffDeps, resourceId);
    }
    if (action === "password-reset" && request.method === "POST") {
      return await staffForcePasswordReset(request, staffDeps, resourceId);
    }
  }


  /* ------------------------ the console (32 PART 6) ----------------------- */
  //
  // Ordering note that is load-bearing: the literal sub-paths under `plans`
  // (`stripe-diff`, `sync-from-stripe`, `sync`) are matched BEFORE `plans/:id`,
  // because `:id` would otherwise swallow them and look up a plan called
  // "stripe-diff". Same reason `workspaces/needs-attention` comes before
  // `workspaces/:id`.

  if (area === "plans") {
    if (resourceId === undefined) {
      if (request.method === "GET") return await staffListPlans(request, staffDeps);
      if (request.method === "POST") return await staffCreatePlan(request, staffDeps);
    }
    if (resourceId === "stripe-diff" && request.method === "GET") {
      return await staffStripeDiff(request, staffDeps);
    }
    if (resourceId === "sync-from-stripe" && request.method === "POST") {
      return await staffSyncFromStripe(request, staffDeps);
    }
    if (resourceId === "sync" && request.method === "POST") {
      return await staffSyncCatalogue(request, staffDeps);
    }
    if (resourceId !== undefined && action === undefined && request.method === "PATCH") {
      return await staffUpdatePlan(request, staffDeps, resourceId);
    }
    if (resourceId !== undefined && action === "retire" && request.method === "POST") {
      return await staffRetirePlan(request, staffDeps, resourceId);
    }
  }

  if (area === "billing" && resourceId === undefined && request.method === "GET") {
    return await staffBilling(request, staffDeps);
  }

  if (area === "audit") {
    if (resourceId === undefined && request.method === "GET") {
      return await staffAudit(request, staffDeps);
    }
    if (resourceId === "filters" && request.method === "GET") {
      return await staffAuditFilters(request, staffDeps);
    }
    if (resourceId === "export" && request.method === "GET") {
      return await staffAuditExport(request, staffDeps);
    }
  }

  if (area === "accounts") {
    if (resourceId === undefined && request.method === "GET") {
      return await staffListAccounts(request, staffDeps);
    }
    if (resourceId === undefined && request.method === "POST") {
      return await staffCreateAccount(request, staffDeps);
    }
    if (resourceId !== undefined && action === undefined && request.method === "PATCH") {
      return await staffSetAccountRole(request, staffDeps, resourceId);
    }
    if (resourceId !== undefined && action === "disable" && request.method === "PATCH") {
      return await staffSetAccountDisabled(request, staffDeps, resourceId);
    }
  }

  if (area === "orgs" && resourceId !== undefined && action === "owner" && request.method === "PATCH") {
    return await staffTransferOwner(request, staffDeps, resourceId);
  }

  if (area === "agents" && resourceId !== undefined && request.method === "PATCH") {
    return await staffSetAgentStatus(request, staffDeps, resourceId);
  }

  if (area === "keys" && resourceId !== undefined && request.method === "DELETE") {
    return await staffRevokeKey(request, staffDeps, resourceId);
  }

  // `email` and `test` are literal segments, named explicitly rather than
  // matched as a `:id`. There is no settings resource with an id today, and
  // writing one in would invite the `workspaces/needs-attention` mistake the
  // moment there is.
  if (area === "settings" && resourceId === "email") {
    if (action === undefined && request.method === "GET") {
      return await staffGetEmailSettings(request, staffDeps);
    }
    if (action === "test" && request.method === "POST") {
      return await staffTestEmail(request, staffDeps);
    }
  }

  throw new ApiError("NOT_FOUND", "No such route.");
}
