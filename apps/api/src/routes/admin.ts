/**
 * `/v1/admin/*` — 14 PART 27.5, as amended.
 *
 * The only place `AdminScopedAccess` is constructed, which is what keeps the
 * cross-tenant exception auditable by reading rather than by grepping.
 *
 * ── Authentication is Firebase; authorisation is this database ─────────────
 * There is no admin password and no admin TOTP any more. Admin sign in through
 * the same Firebase project as customers, and `admin_users` decides what that
 * identity may do here. Migration 0014 carries the full reasoning, including
 * what was traded away.
 *
 * The consequence worth holding in mind while reading anything below: **one
 * token now reaches both the customer surface and this one.** Nothing about the
 * credential distinguishes them. `requireAdmin` is the entire boundary, and it
 * is a row lookup - which is why the role is never read from a Firebase claim,
 * where a demotion would linger in a token already issued.
 *
 * The email must be one Firebase has VERIFIED. Without that check, anybody able
 * to create an account naming a admin address would inherit that admin row.
 */

import { z } from "zod";
import { ApiError, unauthorized, validationError } from "../lib/errors";
import { sendPasswordResetEmail, type EmailConfig } from "../lib/email";
import {
  generatePasswordResetLink,
  type FirebaseAdminConfig,
} from "../auth/firebase-admin";
import {
  findAdminByEmail,
  touchAdminLogin,
  AdminScopedAccess,
  requireAdminRole,
  type AdminUser,
} from "../admin/access";
import { verifyFirebaseToken, type JwksCache } from "../auth/firebase";


export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export interface AdminDeps {
  db: D1Database;
  kv: KVNamespace;
  encryptionKey?: string;
  requestId: string;
  now: number;
  /**
   * Outbound email, or null when this deployment has none. Resolved once at the
   * dispatch site rather than read from `env` here, so a handler cannot reach
   * past the config object to the raw token.
   */
  email: EmailConfig | null;
  /** Privileged Firebase calls, or null when the credential is absent. */
  firebaseAdmin: FirebaseAdminConfig | null;
  /** Where a reset link returns the customer once they are done. */
  dashboardUrl?: string;
  /**
   * The caller's address, for the audit screen's Source IP column. Resolved at
   * the dispatch site from `cf-connecting-ip` - the one header Cloudflare sets
   * itself and a client cannot forge. Null when absent, rather than falling
   * back to a client-settable header: a forgeable value in an accountability
   * log is worse than an honest blank.
   */
  sourceIp?: string | null;
  /** Stripe, for the plan screens. Absent means those endpoints refuse, naming why. */
  stripeSecretKey?: string;
  /**
   * Object storage, for the deletion sweep's run-now control only.
   *
   * Optional, and passed at the dispatch site rather than required of every
   * handler: a console screen that has no business touching a tenant's bytes
   * should not be handed a bucket binding to reach them with.
   */
  files?: R2Bucket;
  /**
   * The subset of `env` the sweep reads - the enable flag and the Firebase
   * service account. Narrowed to those three keys so a handler cannot reach
   * past it to a secret it was not given.
   */
  sweepEnv?: {
    PENDING_DELETION_ENABLED?: string;
    FIREBASE_SERVICE_ACCOUNT_JSON?: string;
    FIREBASE_PROJECT_ID?: string;
  };
  /**
   * The same Firebase verifier the customer chain uses, and deliberately the
   * same project: one sign-in for every surface is the point of 0014.
   */
  firebase?: { cache: JwksCache; projectId: string };
}


function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Resolve the caller to a admin member, or refuse.
 *
 * Three things have to hold, and each refusal is the same body as every other
 * authentication failure - the reason goes to the log, never to the caller:
 *
 *   1. The Firebase token verifies against this deployment's project.
 *   2. Firebase has VERIFIED the email. An unverified address would let anyone
 *      who can type a admin address into a signup form inherit that admin row.
 *   3. A `admin_users` row exists for it and is not disabled.
 *
 * `last_login_at` is touched on the way through. It is the Admin Accounts
 * screen's "last seen", and with no session table there is nowhere else it
 * could come from.
 */
export async function requireAdmin(request: Request, deps: AdminDeps): Promise<AdminUser> {
  const token = bearer(request);
  if (token === null) throw unauthorized("no admin credential");

  if (deps.firebase === undefined) {
    throw new ApiError("INTERNAL_ERROR", "Admin sign-in is not configured here.", {
      internalReason: "no Firebase project configured for the admin routes",
    });
  }

  const claims = await verifyFirebaseToken(token, {
    cache: deps.firebase.cache,
    projectId: deps.firebase.projectId,
    now: deps.now,
  });

  if (claims.email === null || !claims.emailVerified) {
    throw unauthorized(`admin token for ${claims.uid} carries no verified email`);
  }

  const admin = await findAdminByEmail(deps.db, claims.email);
  if (admin === null) throw unauthorized(`${claims.email} is not a admin account`);
  if (admin.disabledAt !== null) throw unauthorized(`admin account ${admin.id} is disabled`);

  await touchAdminLogin(deps.db, admin.id, deps.now);
  return admin;
}

function access(admin: AdminUser, deps: AdminDeps): AdminScopedAccess {
  return new AdminScopedAccess(
    deps.db,
    admin,
    deps.requestId,
    deps.now,
    deps.sourceIp ?? null,
    deps.encryptionKey ?? null
  );
}

export async function adminWhoami(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  return json({ admin: { id: admin.id, email: admin.email, role: admin.role } });
}

export async function adminOverview(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  return json({ summary: await access(admin, deps).fleetSummary() });
}

const FLEET_STATUSES = ["active", "suspended", "deleted"];

export async function adminListWorkspaces(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const url = new URL(request.url);
  const search = url.searchParams.get("q");
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;

  // An unrecognised status is refused rather than ignored. Dropping it would
  // answer a narrower question with the whole fleet, which is the shape of
  // mistake the Suspended view was already making.
  const rawStatus = url.searchParams.get("status");
  if (rawStatus !== null && !FLEET_STATUSES.includes(rawStatus)) {
    throw validationError(`status must be one of ${FLEET_STATUSES.join(", ")}.`);
  }

  return json({ workspaces: await access(admin, deps).listFleet(limit, search, rawStatus) });
}

export async function adminGetWorkspace(
  request: Request,
  deps: AdminDeps,
  workspaceId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const workspace = await access(admin, deps).getWorkspace(workspaceId);
  if (workspace === null) throw new ApiError("NOT_FOUND", "No such workspace.");
  return json({ workspace });
}

export async function adminWorkspaceActivity(
  request: Request,
  deps: AdminDeps,
  workspaceId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  return json({ events: await access(admin, deps).workspaceActivity(workspaceId) });
}

const statusSchema = z.object({
  status: z.enum(["active", "suspended", "deleted"]),
  reason: z.string().trim().min(1, "Say why. A suspension nobody can explain later is worse than none."),
});

export async function adminSetWorkspaceStatus(
  request: Request,
  deps: AdminDeps,
  workspaceId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);

  let body;
  try {
    body = statusSchema.parse(await request.json());
  } catch (err) {
    throw validationError(
      err instanceof z.ZodError ? (err.issues[0]?.message ?? "Invalid body.") : "Send a JSON body."
    );
  }

  const changed = await access(admin, deps).setWorkspaceStatus(workspaceId, body.status, body.reason);
  if (!changed) throw new ApiError("NOT_FOUND", "No such workspace.");

  // Nothing else is needed to make this bite: step 5 of the authorization chain
  // reads workspaces.status on every request, so every key in that workspace
  // stops working on its next call without any of them being touched.
  return json({ workspaceId, status: body.status });
}

export async function adminForceLogout(
  request: Request,
  deps: AdminDeps,
  userId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId") ?? "";

  const done = await access(admin, deps).forceLogout(userId, workspaceId);
  if (!done) throw new ApiError("NOT_FOUND", "No such user.");
  return json({ userId, sessionsRevoked: true });
}

const passwordResetSchema = z.object({
  // Mandatory, and short-circuiting a reset on somebody else's account without
  // one is the point. Every other admin mutation that reaches into a customer
  // account takes a reason; this one reaches all the way to their credentials.
  reason: z.string().trim().min(1).max(500),
});

/**
 * POST /v1/admin/users/:id/password-reset — support and above.
 *
 * Sends the customer a reset link. Support-level on purpose: this is the action
 * a support engineer performs on the phone, and it grants nothing — the link
 * goes to the account holder's address, never to the admin member, and the
 * response body deliberately does not contain it. A admin member who could read
 * the link back would hold a credential for that account.
 *
 * The response does not say whether Firebase had an identity for the address.
 * It says the reset was started, because that is the only fact the caller can
 * act on, and "no identity" is a detail for the log.
 */
export async function adminForcePasswordReset(
  request: Request,
  deps: AdminDeps,
  userId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);

  let body;
  try {
    body = passwordResetSchema.parse(await request.json());
  } catch {
    throw validationError("A reason is required.");
  }

  // Both dependencies, checked before anything is written. Either one missing
  // means the feature is off in this deployment, and saying so plainly beats the
  // alternative shape - reporting success for a message nobody will receive.
  if (deps.email === null) {
    throw new ApiError("INTERNAL_ERROR", "Email delivery is not configured.", {
      internalReason: "the EMAIL send_email binding is not configured",
    });
  }
  if (deps.firebaseAdmin === null) {
    throw new ApiError("INTERNAL_ERROR", "Account administration is not configured.", {
      internalReason: "FIREBASE_SERVICE_ACCOUNT_JSON is not set",
    });
  }

  const emailConfig = deps.email;
  const adminConfig = deps.firebaseAdmin;

  const outcome = await access(admin, deps).forcePasswordReset(
    userId,
    body.reason,
    async (address) => {
      const reset = await generatePasswordResetLink(
        adminConfig,
        deps.kv,
        address,
        deps.now,
        deps.dashboardUrl === undefined ? {} : { continueUrl: deps.dashboardUrl }
      );
      if (reset === null) return "no_identity";

      await sendPasswordResetEmail(emailConfig, {
        to: address,
        resetUrl: reset.link,
        // The recipient did not ask for this, and a reset link arriving
        // unexplained is indistinguishable from a phishing attempt.
        initiatedBy: "support",
      });
      return "sent";
    }
  );

  if (outcome === null) throw new ApiError("NOT_FOUND", "No such user.");
  return json({ userId, passwordResetSent: true });
}

export async function adminRevokeKeys(
  request: Request,
  deps: AdminDeps,
  userId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const revoked = await access(admin, deps).revokeUserKeys(userId);
  return json({ userId, keysRevoked: revoked });
}

/*
 * `adminCreate` — `POST /v1/admin/users` — was removed here.
 *
 * It answered 501 by design, from a time when a admin member had a password and
 * a TOTP secret of their own: an endpoint that mints a working admin credential
 * is an endpoint that can be tricked into minting one, so it deliberately did
 * nothing and told the operator to provision out of band.
 *
 * `0014_admin_firebase_sso.sql` removed the premise. Admin authenticate through
 * Firebase and `admin_users` holds only an address and a role, so creating one
 * mints nothing and the refusal protects nothing. What survived was a route
 * whose response instructed the caller to write a `password_hash` and a
 * `totp_secret` into columns that no longer exist.
 *
 * Creating admin is `adminCreateAccount` — `POST /v1/admin/accounts` — which is
 * super_admin only, audits `admin.create`, and shows nothing once because
 * nothing secret is made.
 */
