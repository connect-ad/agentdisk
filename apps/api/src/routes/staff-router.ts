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
  staffCreate,
  staffForceLogout,
  staffForcePasswordReset,
  staffGetWorkspace,
  staffListWorkspaces,
  staffLogin,
  staffLogout,
  staffOverview,
  staffRevokeKeys,
  staffSetWorkspaceStatus,
  staffWhoami,
  staffWorkspaceActivity,
} from "./staff";
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
  };

  const [, , area, resourceId, action] = segments;

  if (area === "login" && request.method === "POST") {
    return await staffLogin(request, staffDeps);
  }
  if (area === "logout" && request.method === "POST") {
    return await staffLogout(request, staffDeps);
  }
  if (area === "whoami" && request.method === "GET") {
    return await staffWhoami(request, staffDeps);
  }
  if (area === "overview" && request.method === "GET") {
    return await staffOverview(request, staffDeps);
  }
  if (area === "users" && request.method === "POST" && resourceId === undefined) {
    return await staffCreate(request, staffDeps);
  }

  if (area === "workspaces") {
    if (resourceId === undefined && request.method === "GET") {
      return await staffListWorkspaces(request, staffDeps);
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
  }

  if (area === "users" && resourceId !== undefined) {
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

  throw new ApiError("NOT_FOUND", "No such route.");
}
