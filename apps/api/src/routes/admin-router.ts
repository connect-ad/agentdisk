/**
 * Admin route dispatch.
 *
 * Lifted verbatim out of `index.ts`, where it was the one block two people
 * could not edit at the same time. Nothing about the routing changed: the same
 * segments are matched in the same order, and an unmatched admin path still
 * throws NOT_FOUND here rather than falling through to the customer chain
 * below it.
 *
 * Keeping it in its own file also states the boundary the block already had.
 * Admin use a separate table, a separate token shape and a separate code path
 * from every customer route, so there is no path along which a customer
 * credential could be evaluated against admin logic, or the reverse. This
 * module is the only place `AdminScopedAccess` is reachable.
 */

import { ApiError } from "../lib/errors";
import { readEmailConfig } from "../lib/email";
import { readFirebaseAdminConfig } from "../auth/firebase-admin";
import {
  adminForceLogout,
  adminForcePasswordReset,
  adminGetWorkspace,
  adminListWorkspaces,
  adminOverview,
  adminRevokeKeys,
  adminSetWorkspaceStatus,
  adminWhoami,
  adminWorkspaceActivity,
} from "./admin";
import {
  adminAudit,
  adminClaimLinkHistory,
  adminClaimLinks,
  adminDeletionQueue,
  adminDeletionRuns,
  adminRunDeletionSweep,
  adminAuditExport,
  adminAuditFilters,
  adminBilling,
  adminCreateAccount,
  adminCreatePlan,
  adminDeleteUser,
  adminDeleteWorkspace,
  adminDeletionCheck,
  adminFindUser,
  adminGetUser,
  adminListAccounts,
  adminListPlans,
  adminNeedsAttention,
  adminRetirePlan,
  adminRevokeKey,
  adminSetAccountDisabled,
  adminSetAccountRole,
  adminSetAgentStatus,
  adminSetPlanOverride,
  adminSetUserDisabled,
  adminStripeDiff,
  adminSyncCatalogue,
  adminSyncFromStripe,
  adminTransferOwner,
  adminUpdatePlan,
  adminWorkspaceBlastRadius,
} from "./admin-console";
import { adminComposeEmail, adminGetEmailSettings, adminTestEmail } from "./admin-settings";
// Type-only, so it is erased at compile time and the index <-> router cycle
// never exists at runtime.
import type { Env } from "../index";

/**
 * Dispatch one `/v1/admin/...` request. The caller has already established the
 * prefix; `segments` is the whole split path, so the indices below match what
 * they matched in `index.ts`.
 */
export async function handleAdminRoute(
  request: Request,
  env: Env,
  segments: string[],
  requestId: string
): Promise<Response> {
  const adminDeps = {
    db: env.DB,
    kv: env.CACHE,
    encryptionKey: env.DATABASE_ENCRYPTION_KEY,
    requestId,
    now: Date.now(),
    // Resolved here, once, so the handlers receive a config object rather
    // than the environment - there is no path from a admin handler to the
    // raw token. Null means "not configured here", which the handlers
    // that need it turn into a refusal naming the feature.
    email: readEmailConfig(env),
    firebaseAdmin: readFirebaseAdminConfig(env),
    dashboardUrl: env.DASHBOARD_URL,
    // Cloudflare sets this itself and a client cannot forge it. Read once here
    // so no handler has to remember to.
    sourceIp: request.headers.get("cf-connecting-ip"),
    // Only the deletion sweep uses these two. Handed over here rather than
    // added to every handler's reach: a screen with no business touching a
    // tenant's bytes should not be given a bucket binding to reach them with.
    files: env.FILES,
    sweepEnv: {
      PENDING_DELETION_ENABLED: env.PENDING_DELETION_ENABLED,
      FIREBASE_SERVICE_ACCOUNT_JSON: env.FIREBASE_SERVICE_ACCOUNT_JSON,
      FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID,
    },
    // The same verifier and the same project as the customer chain. Admin are
    // told apart by their admin_users row, never by the credential.
    // undefined rather than an empty projectId when unset, so requireAdmin
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
    return await adminWhoami(request, adminDeps);
  }
  if (area === "overview" && request.method === "GET") {
    return await adminOverview(request, adminDeps);
  }
  if (area === "workspaces") {
    if (resourceId === undefined && request.method === "GET") {
      return await adminListWorkspaces(request, adminDeps);
    }
    // Before the `:id` GET below, or this reads as a workspace whose id is the
    // literal string "needs-attention" and answers 404 - which looks like a
    // data problem rather than the routing one it is.
    if (resourceId === "needs-attention" && request.method === "GET") {
      return await adminNeedsAttention(request, adminDeps);
    }
    if (resourceId !== undefined && action === undefined && request.method === "GET") {
      return await adminGetWorkspace(request, adminDeps, resourceId);
    }
    if (resourceId !== undefined && action === "activity" && request.method === "GET") {
      return await adminWorkspaceActivity(request, adminDeps, resourceId);
    }
    if (resourceId !== undefined && action === "status" && request.method === "POST") {
      return await adminSetWorkspaceStatus(request, adminDeps, resourceId);
    }
    if (resourceId !== undefined && action === "plan-override" && request.method === "PATCH") {
      return await adminSetPlanOverride(request, adminDeps, resourceId);
    }
    if (resourceId !== undefined && action === "blast-radius" && request.method === "GET") {
      return await adminWorkspaceBlastRadius(request, adminDeps, resourceId);
    }
    if (resourceId !== undefined && action === undefined && request.method === "DELETE") {
      return await adminDeleteWorkspace(request, adminDeps, resourceId);
    }
  }

  if (area === "users" && resourceId === undefined && request.method === "GET") {
    return await adminFindUser(request, adminDeps);
  }

  if (area === "users" && resourceId !== undefined) {
    if (action === undefined && request.method === "GET") {
      return await adminGetUser(request, adminDeps, resourceId);
    }
    if (action === "disable" && request.method === "PATCH") {
      return await adminSetUserDisabled(request, adminDeps, resourceId);
    }
    if (action === "deletion-check" && request.method === "GET") {
      return await adminDeletionCheck(request, adminDeps, resourceId);
    }
    if (action === undefined && request.method === "DELETE") {
      return await adminDeleteUser(request, adminDeps, resourceId);
    }
    if (action === "force-logout" && request.method === "POST") {
      return await adminForceLogout(request, adminDeps, resourceId);
    }
    if (action === "revoke-keys" && request.method === "POST") {
      return await adminRevokeKeys(request, adminDeps, resourceId);
    }
    if (action === "password-reset" && request.method === "POST") {
      return await adminForcePasswordReset(request, adminDeps, resourceId);
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
      if (request.method === "GET") return await adminListPlans(request, adminDeps);
      if (request.method === "POST") return await adminCreatePlan(request, adminDeps);
    }
    if (resourceId === "stripe-diff" && request.method === "GET") {
      return await adminStripeDiff(request, adminDeps);
    }
    if (resourceId === "sync-from-stripe" && request.method === "POST") {
      return await adminSyncFromStripe(request, adminDeps);
    }
    if (resourceId === "sync" && request.method === "POST") {
      return await adminSyncCatalogue(request, adminDeps);
    }
    if (resourceId !== undefined && action === undefined && request.method === "PATCH") {
      return await adminUpdatePlan(request, adminDeps, resourceId);
    }
    if (resourceId !== undefined && action === "retire" && request.method === "POST") {
      return await adminRetirePlan(request, adminDeps, resourceId);
    }
  }

  if (area === "billing" && resourceId === undefined && request.method === "GET") {
    return await adminBilling(request, adminDeps);
  }

  if (area === "claim-links") {
    if (resourceId === undefined && request.method === "GET") {
      return await adminClaimLinks(request, adminDeps);
    }
    if (resourceId !== undefined && request.method === "GET") {
      return await adminClaimLinkHistory(request, adminDeps, resourceId);
    }
  }

  if (area === "deletions") {
    if (resourceId === "queue" && request.method === "GET") {
      return await adminDeletionQueue(request, adminDeps);
    }
    if (resourceId === "runs" && request.method === "GET") {
      return await adminDeletionRuns(request, adminDeps);
    }
    if (resourceId === "run" && request.method === "POST") {
      return await adminRunDeletionSweep(request, adminDeps);
    }
  }

  if (area === "audit") {
    if (resourceId === undefined && request.method === "GET") {
      return await adminAudit(request, adminDeps);
    }
    if (resourceId === "filters" && request.method === "GET") {
      return await adminAuditFilters(request, adminDeps);
    }
    if (resourceId === "export" && request.method === "GET") {
      return await adminAuditExport(request, adminDeps);
    }
  }

  if (area === "accounts") {
    if (resourceId === undefined && request.method === "GET") {
      return await adminListAccounts(request, adminDeps);
    }
    if (resourceId === undefined && request.method === "POST") {
      return await adminCreateAccount(request, adminDeps);
    }
    if (resourceId !== undefined && action === undefined && request.method === "PATCH") {
      return await adminSetAccountRole(request, adminDeps, resourceId);
    }
    if (resourceId !== undefined && action === "disable" && request.method === "PATCH") {
      return await adminSetAccountDisabled(request, adminDeps, resourceId);
    }
  }

  if (area === "orgs" && resourceId !== undefined && action === "owner" && request.method === "PATCH") {
    return await adminTransferOwner(request, adminDeps, resourceId);
  }

  if (area === "agents" && resourceId !== undefined && request.method === "PATCH") {
    return await adminSetAgentStatus(request, adminDeps, resourceId);
  }

  if (area === "keys" && resourceId !== undefined && request.method === "DELETE") {
    return await adminRevokeKey(request, adminDeps, resourceId);
  }

  // `email` and `test` are literal segments, named explicitly rather than
  // matched as a `:id`. There is no settings resource with an id today, and
  // writing one in would invite the `workspaces/needs-attention` mistake the
  // moment there is.
  if (area === "settings" && resourceId === "email") {
    if (action === undefined && request.method === "GET") {
      return await adminGetEmailSettings(request, adminDeps);
    }
    if (action === "test" && request.method === "POST") {
      return await adminTestEmail(request, adminDeps);
    }
    if (action === "compose" && request.method === "POST") {
      return await adminComposeEmail(request, adminDeps);
    }
  }

  throw new ApiError("NOT_FOUND", "No such route.");
}
