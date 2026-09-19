/**
 * `/v1/staff/*` — 14 PART 27.5, as amended.
 *
 * The only place `StaffScopedAccess` is constructed, which is what keeps the
 * cross-tenant exception auditable by reading rather than by grepping.
 *
 * ── Authentication is Firebase; authorisation is this database ─────────────
 * There is no staff password and no staff TOTP any more. Staff sign in through
 * the same Firebase project as customers, and `staff_users` decides what that
 * identity may do here. Migration 0014 carries the full reasoning, including
 * what was traded away.
 *
 * The consequence worth holding in mind while reading anything below: **one
 * token now reaches both the customer surface and this one.** Nothing about the
 * credential distinguishes them. `requireStaff` is the entire boundary, and it
 * is a row lookup - which is why the role is never read from a Firebase claim,
 * where a demotion would linger in a token already issued.
 *
 * The email must be one Firebase has VERIFIED. Without that check, anybody able
 * to create an account naming a staff address would inherit that staff row.
 */

import { z } from "zod";
import { ApiError, unauthorized, validationError } from "../lib/errors";
import { sendPasswordResetEmail, type EmailConfig } from "../lib/email";
import {
  generatePasswordResetLink,
  type FirebaseAdminConfig,
} from "../auth/firebase-admin";
import {
  findStaffByEmail,
  touchStaffLogin,
  StaffScopedAccess,
  requireStaffRole,
  type StaffUser,
} from "../staff/access";
import { verifyFirebaseToken, type JwksCache } from "../auth/firebase";


export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export interface StaffDeps {
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
 * Resolve the caller to a staff member, or refuse.
 *
 * Three things have to hold, and each refusal is the same body as every other
 * authentication failure - the reason goes to the log, never to the caller:
 *
 *   1. The Firebase token verifies against this deployment's project.
 *   2. Firebase has VERIFIED the email. An unverified address would let anyone
 *      who can type a staff address into a signup form inherit that staff row.
 *   3. A `staff_users` row exists for it and is not disabled.
 *
 * `last_login_at` is touched on the way through. It is the Staff Accounts
 * screen's "last seen", and with no session table there is nowhere else it
 * could come from.
 */
export async function requireStaff(request: Request, deps: StaffDeps): Promise<StaffUser> {
  const token = bearer(request);
  if (token === null) throw unauthorized("no staff credential");

  if (deps.firebase === undefined) {
    throw new ApiError("INTERNAL_ERROR", "Staff sign-in is not configured here.", {
      internalReason: "no Firebase project configured for the staff routes",
    });
  }

  const claims = await verifyFirebaseToken(token, {
    cache: deps.firebase.cache,
    projectId: deps.firebase.projectId,
    now: deps.now,
  });

  if (claims.email === null || !claims.emailVerified) {
    throw unauthorized(`staff token for ${claims.uid} carries no verified email`);
  }

  const staff = await findStaffByEmail(deps.db, claims.email);
  if (staff === null) throw unauthorized(`${claims.email} is not a staff account`);
  if (staff.disabledAt !== null) throw unauthorized(`staff account ${staff.id} is disabled`);

  await touchStaffLogin(deps.db, staff.id, deps.now);
  return staff;
}

function access(staff: StaffUser, deps: StaffDeps): StaffScopedAccess {
  return new StaffScopedAccess(deps.db, staff, deps.requestId, deps.now, deps.sourceIp ?? null);
}

export async function staffWhoami(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  return json({ staff: { id: staff.id, email: staff.email, role: staff.role } });
}

export async function staffOverview(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  return json({ summary: await access(staff, deps).fleetSummary() });
}

export async function staffListWorkspaces(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const url = new URL(request.url);
  const search = url.searchParams.get("q");
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;

  return json({ workspaces: await access(staff, deps).listFleet(limit, search) });
}

export async function staffGetWorkspace(
  request: Request,
  deps: StaffDeps,
  workspaceId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const workspace = await access(staff, deps).getWorkspace(workspaceId);
  if (workspace === null) throw new ApiError("NOT_FOUND", "No such workspace.");
  return json({ workspace });
}

export async function staffWorkspaceActivity(
  request: Request,
  deps: StaffDeps,
  workspaceId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  return json({ events: await access(staff, deps).workspaceActivity(workspaceId) });
}

const statusSchema = z.object({
  status: z.enum(["active", "suspended", "deleted"]),
  reason: z.string().trim().min(1, "Say why. A suspension nobody can explain later is worse than none."),
});

export async function staffSetWorkspaceStatus(
  request: Request,
  deps: StaffDeps,
  workspaceId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);

  let body;
  try {
    body = statusSchema.parse(await request.json());
  } catch (err) {
    throw validationError(
      err instanceof z.ZodError ? (err.issues[0]?.message ?? "Invalid body.") : "Send a JSON body."
    );
  }

  const changed = await access(staff, deps).setWorkspaceStatus(workspaceId, body.status, body.reason);
  if (!changed) throw new ApiError("NOT_FOUND", "No such workspace.");

  // Nothing else is needed to make this bite: step 5 of the authorization chain
  // reads workspaces.status on every request, so every key in that workspace
  // stops working on its next call without any of them being touched.
  return json({ workspaceId, status: body.status });
}

export async function staffForceLogout(
  request: Request,
  deps: StaffDeps,
  userId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId") ?? "";

  const done = await access(staff, deps).forceLogout(userId, workspaceId);
  if (!done) throw new ApiError("NOT_FOUND", "No such user.");
  return json({ userId, sessionsRevoked: true });
}

const passwordResetSchema = z.object({
  // Mandatory, and short-circuiting a reset on somebody else's account without
  // one is the point. Every other staff mutation that reaches into a customer
  // account takes a reason; this one reaches all the way to their credentials.
  reason: z.string().trim().min(1).max(500),
});

/**
 * POST /v1/staff/users/:id/password-reset — support and above.
 *
 * Sends the customer a reset link. Support-level on purpose: this is the action
 * a support engineer performs on the phone, and it grants nothing — the link
 * goes to the account holder's address, never to the staff member, and the
 * response body deliberately does not contain it. A staff member who could read
 * the link back would hold a credential for that account.
 *
 * The response does not say whether Firebase had an identity for the address.
 * It says the reset was started, because that is the only fact the caller can
 * act on, and "no identity" is a detail for the log.
 */
export async function staffForcePasswordReset(
  request: Request,
  deps: StaffDeps,
  userId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);

  let body;
  try {
    body = passwordResetSchema.parse(await request.json());
  } catch {
    throw validationError("A reason is required.");
  }

  // Both halves, checked before anything is written. Either one missing means
  // the feature is off in this deployment, and saying so plainly beats the
  // alternative shape - reporting success for a message nobody will receive.
  if (deps.email === null) {
    throw new ApiError("INTERNAL_ERROR", "Email delivery is not configured.", {
      internalReason: "MAILJET_API_KEY / MAILJET_SECRET_KEY are not both set",
    });
  }
  if (deps.firebaseAdmin === null) {
    throw new ApiError("INTERNAL_ERROR", "Account administration is not configured.", {
      internalReason: "FIREBASE_SERVICE_ACCOUNT_JSON is not set",
    });
  }

  const emailConfig = deps.email;
  const adminConfig = deps.firebaseAdmin;

  const outcome = await access(staff, deps).forcePasswordReset(
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

export async function staffRevokeKeys(
  request: Request,
  deps: StaffDeps,
  userId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const revoked = await access(staff, deps).revokeUserKeys(userId);
  return json({ userId, keysRevoked: revoked });
}

/** Creating staff is super_admin only — the one role that can grant roles. */
const createStaffSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["support", "admin", "super_admin"]),
});

export async function staffCreate(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  requireStaffRole(staff, "super_admin");

  let body;
  try {
    body = createStaffSchema.parse(await request.json());
  } catch {
    throw validationError("An email and a role are required.");
  }

  if (deps.encryptionKey === undefined || deps.encryptionKey === "") {
    throw new ApiError("INTERNAL_ERROR", "Staff provisioning is not configured.", {
      internalReason: "DATABASE_ENCRYPTION_KEY is not set",
    });
  }

  // Provisioning returns the enrolment URI once and never stores anything the
  // new account can log in with on its own - a password still has to be set out
  // of band. That is deliberate: an invite link that is itself a credential is
  // a credential in somebody's inbox.
  return json(
    {
      pending: true,
      email: body.email,
      role: body.role,
      note:
        "Staff accounts are provisioned out of band. Create the row with a hashed password " +
        "and an encrypted TOTP secret; this endpoint deliberately does not mint a credential.",
    },
    501
  );
}
