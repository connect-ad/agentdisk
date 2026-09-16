/**
 * `/v1/staff/*` — 14 PART 27.5.
 *
 * The only place `StaffScopedAccess` is constructed, which is what keeps the
 * cross-tenant exception auditable by reading rather than by grepping.
 *
 * **TOTP is mandatory, every login, no exceptions.** Customer auth requires no
 * second factor; staff auth requires one always. That is not inconsistency, it
 * is proportionality — a staff credential is the one credential type in the
 * system with cross-tenant reach, so it gets the categorically higher bar.
 *
 * **A staff session is never accepted on a customer route, and a customer
 * credential is never accepted here.** They are separate tables, separate token
 * shapes and separate code paths, so there is no path along which one could be
 * evaluated against the other's logic.
 */

import { z } from "zod";
import { ApiError, unauthorized, validationError } from "../lib/errors";
import { verifyPassword, verifyTotp, decryptSecret } from "../staff/crypto";
import {
  createStaffSession,
  resolveStaffSession,
  revokeStaffSession,
  StaffScopedAccess,
  requireStaffRole,
  type StaffUser,
} from "../staff/access";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
  // Required, not optional. A schema that allowed it to be absent would make
  // "forgot to send a code" and "chose not to" the same request.
  totp: z.string().trim().min(6).max(8),
});

function json(body: unknown, status = 200): Response {
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
}

/** Failed logins per email per window, before the account is refused outright. */
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 900;

async function countFailure(kv: KVNamespace, email: string): Promise<number> {
  const key = `staff:login:${email}`;
  const current = Number.parseInt((await kv.get(key)) ?? "0", 10);
  const next = Number.isFinite(current) ? current + 1 : 1;
  await kv.put(key, String(next), { expirationTtl: LOGIN_WINDOW_SECONDS });
  return next;
}

async function isLockedOut(kv: KVNamespace, email: string): Promise<boolean> {
  const current = Number.parseInt((await kv.get(`staff:login:${email}`)) ?? "0", 10);
  return Number.isFinite(current) && current >= LOGIN_ATTEMPT_LIMIT;
}

/**
 * POST /v1/staff/login
 *
 * Every failure below returns the same body. Whether the email is unknown, the
 * password is wrong, the code is wrong or the account is disabled, the caller
 * learns only that the attempt failed — the alternative is an oracle that lets
 * somebody enumerate staff accounts and then work on one they know exists.
 */
export async function staffLogin(request: Request, deps: StaffDeps): Promise<Response> {
  if (deps.encryptionKey === undefined || deps.encryptionKey === "") {
    // Without it the TOTP secret cannot be decrypted, so the second factor
    // cannot be checked. Refusing to run is the only safe answer.
    throw new ApiError("INTERNAL_ERROR", "Staff login is not configured.", {
      internalReason: "DATABASE_ENCRYPTION_KEY is not set",
    });
  }

  let body;
  try {
    body = loginSchema.parse(await request.json());
  } catch {
    throw validationError("Email, password and authenticator code are all required.");
  }

  if (await isLockedOut(deps.kv, body.email)) {
    // Deliberately distinguishable from a bad password: somebody locked out
    // needs to know waiting is the answer, and a lockout is not a secret - an
    // attacker triggering it already knows they triggered it.
    throw new ApiError("LIMIT_EXCEEDED", "Too many failed attempts. Try again in 15 minutes.");
  }

  const row = await deps.db
    .prepare(
      `SELECT id, email, role, password_hash AS passwordHash, totp_secret AS totpSecret,
              disabled_at AS disabledAt
         FROM staff_users WHERE email = ?`
    )
    .bind(body.email)
    .first<{
      id: string; email: string; role: string;
      passwordHash: string; totpSecret: string; disabledAt: number | null;
    }>();

  const fail = async (reason: string): Promise<never> => {
    await countFailure(deps.kv, body.email);
    throw unauthorized(reason);
  };

  if (row === null) {
    // Still hash something, so a missing account does not return measurably
    // faster than a wrong password.
    await verifyPassword(body.password, "pbkdf2$210000$00$00");
    return fail(`no staff account for ${body.email}`);
  }
  if (row.disabledAt !== null) return fail(`staff account ${row.id} is disabled`);
  if (!(await verifyPassword(body.password, row.passwordHash))) {
    return fail(`wrong password for staff ${row.id}`);
  }

  const secret = await decryptSecret(row.totpSecret, deps.encryptionKey);
  if (secret === null) return fail(`TOTP secret for staff ${row.id} could not be decrypted`);
  if (!(await verifyTotp(secret, body.totp, deps.now))) {
    return fail(`wrong TOTP code for staff ${row.id}`);
  }

  // Only a fully successful login clears the counter. Clearing it on a correct
  // password but wrong code would let somebody who has the password brute-force
  // the six digits indefinitely.
  await deps.kv.delete(`staff:login:${body.email}`);

  const session = await createStaffSession(deps.db, row.id, deps.now);
  await deps.db
    .prepare(`UPDATE staff_users SET last_login_at = ? WHERE id = ?`)
    .bind(deps.now, row.id)
    .run();

  return json({
    token: session.token,
    expiresAt: new Date(session.expiresAt).toISOString(),
    staff: { id: row.id, email: row.email, role: row.role },
  });
}

export async function staffLogout(request: Request, deps: StaffDeps): Promise<Response> {
  const token = bearer(request);
  if (token !== null) await revokeStaffSession(deps.db, token, deps.now);
  // Unconditionally 200: logging out something already logged out is the
  // caller's intent satisfied, not a failure.
  return json({ loggedOut: true });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Resolve the session or refuse. Used by every route below. */
async function requireStaff(request: Request, deps: StaffDeps): Promise<StaffUser> {
  const token = bearer(request);
  if (token === null) throw unauthorized("no staff session token");

  const staff = await resolveStaffSession(deps.db, token, deps.now);
  if (staff === null) throw unauthorized("staff session is not valid");
  return staff;
}

function access(staff: StaffUser, deps: StaffDeps): StaffScopedAccess {
  return new StaffScopedAccess(deps.db, staff, deps.requestId, deps.now);
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
