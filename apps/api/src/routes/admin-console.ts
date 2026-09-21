/**
 * The admin console's handlers — 32 PART 6.
 *
 * Separate from `admin.ts`, which holds session handling and the workspace
 * screens that shipped first. Splitting on that line rather than merging keeps
 * either file readable, and there is no behaviour in the boundary: both build
 * their access object the same way, from the same `AdminDeps`, and both are
 * reachable only through `admin-router.ts`.
 *
 * ── Every mutating handler takes a reason, and means it ────────────────────
 * The reason is not decoration. It is the column somebody reads a year later
 * when asking why a customer's workspace was suspended, and a handler that
 * accepted an empty one would make "no reason given" and "reason was empty"
 * indistinguishable in the log. So the schemas below require a non-empty string
 * on every destructive action, and the modals collect it.
 *
 * ── The role gate is enforced twice, and only one of them counts ───────────
 * The console hides what a role cannot do, and every method here re-checks
 * server-side through `requireRole`. The UI gate is a convenience for the
 * operator; this one is the control. A 403 from a lower role is a tested
 * behaviour, not an assumption.
 */

import { z } from "zod";
import { ApiError, validationError } from "../lib/errors";
import { json, requireAdmin, type AdminDeps } from "./admin";
import { AdminScopedAccess, type AdminUser } from "../admin/access";
import { AdminUserAccess } from "../admin/users-access";
import { AdminPlanAccess } from "../admin/plans-access";
import { AdminBillingAccess } from "../admin/billing-access";
import { AdminAuditAccess } from "../admin/audit-access";
import { AdminAccountAccess } from "../admin/accounts-access";
import { setFirebaseUserDisabled } from "../auth/firebase-admin";
import { stripeClient } from "../billing/stripe";
import { syncProductToPlan } from "../billing/plan-sync";
import { invalidateCatalogue } from "../billing/catalogue";

/* ------------------------------- plumbing -------------------------------- */

type Ctor<T> = new (
  db: D1Database,
  admin: AdminUser,
  requestId: string,
  now: number,
  sourceIp: string | null
) => T;

/** One way to build any area's access object, so none of them can drift. */
export function area<T>(Cls: Ctor<T>, admin: AdminUser, deps: AdminDeps): T {
  return new Cls(deps.db, admin, deps.requestId, deps.now, deps.sourceIp ?? null);
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw validationError("A JSON body is required.");
  }
}

/** A reason that is actually a reason. Blank and whitespace are both refused. */
const reason = z.string().trim().min(3, "A reason is required.").max(500);

/**
 * Stripe, or a refusal naming the reason.
 *
 * An environment with no Stripe key can still run the whole console except the
 * plan screens. Refusing here with the cause named beats a 500 from the SDK
 * that says only that something was undefined.
 */
function stripeOf(deps: AdminDeps) {
  if (deps.stripeSecretKey === undefined || deps.stripeSecretKey === "") {
    throw new ApiError("INTERNAL_ERROR", "Stripe is not configured in this environment.", {
      internalReason: "STRIPE_SECRET_KEY is not set",
    });
  }
  return stripeClient(deps.stripeSecretKey);
}

/* --------------------------------- users --------------------------------- */

export async function adminFindUser(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const email = new URL(request.url).searchParams.get("email");
  if (email === null) throw validationError("An email address is required.");

  const users = area(AdminUserAccess, admin, deps);
  const user = await users.findByEmail(email);
  if (user === null) return json({ user: null, memberships: [] });

  return json({
    user,
    memberships: await users.membershipsOf(user.id),
    keys: await users.keyBlastRadius(user.id),
  });
}

export async function adminGetUser(
  request: Request,
  deps: AdminDeps,
  userId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const users = area(AdminUserAccess, admin, deps);

  const user = await users.getById(userId);
  if (user === null) throw new ApiError("NOT_FOUND", "No such user.");

  return json({
    user,
    memberships: await users.membershipsOf(userId),
    keys: await users.keyBlastRadius(userId),
  });
}

const disableSchema = z.object({ disabled: z.boolean(), reason });

export async function adminSetUserDisabled(
  request: Request,
  deps: AdminDeps,
  userId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = disableSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A disabled flag and a reason are required.");

  const users = area(AdminUserAccess, admin, deps);
  const user = await users.getById(userId);
  if (user === null) throw new ApiError("NOT_FOUND", "No such user.");

  // Ours first. It takes effect immediately and does not depend on Firebase
  // answering, which is the property the whole first-party check exists for.
  const changed = await users.setDisabled(userId, parsed.data.disabled, parsed.data.reason);

  let firebase: "updated" | "no_identity" | "unconfigured" | "failed" = "unconfigured";
  if (deps.firebaseAdmin !== null && user.firebaseUid !== null) {
    try {
      const updated = await setFirebaseUserDisabled(
        deps.firebaseAdmin,
        deps.kv,
        user.firebaseUid,
        parsed.data.disabled,
        deps.now
      );
      firebase = updated ? "updated" : "no_identity";
    } catch {
      // Reported, never thrown. The account is already refused by us; failing
      // the request would tell the operator nothing happened when the half that
      // matters did.
      firebase = "failed";
    }
  }

  return json({ changed, firebase });
}

export async function adminDeletionCheck(
  request: Request,
  deps: AdminDeps,
  userId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  return json(await area(AdminUserAccess, admin, deps).deletionCheck(userId));
}

const deleteUserSchema = z.object({
  reason,
  /** Typed back exactly, so the confirmation belongs to the operation. */
  confirmEmail: z.string().trim().min(1),
  revokeKeys: z.boolean().default(true),
});

export async function adminDeleteUser(
  request: Request,
  deps: AdminDeps,
  userId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = deleteUserSchema.safeParse(await body(request));
  if (!parsed.success) {
    throw validationError("A reason and the account's email address are required.");
  }

  const users = area(AdminUserAccess, admin, deps);
  const user = await users.getById(userId);
  if (user === null) throw new ApiError("NOT_FOUND", "No such user.");
  if (parsed.data.confirmEmail.toLowerCase() !== user.email.toLowerCase()) {
    throw validationError("The typed address does not match this account.");
  }

  const result = await users.softDelete(userId, parsed.data.reason, {
    revokeKeys: parsed.data.revokeKeys,
  });

  let firebase: "disabled" | "no_identity" | "unconfigured" | "failed" = "unconfigured";
  if (result.deleted && deps.firebaseAdmin !== null && user.firebaseUid !== null) {
    try {
      const updated = await setFirebaseUserDisabled(
        deps.firebaseAdmin,
        deps.kv,
        user.firebaseUid,
        true,
        deps.now
      );
      firebase = updated ? "disabled" : "no_identity";
    } catch {
      firebase = "failed";
    }
  }

  return json({ ...result, firebase, restorableUntil: deps.now + 30 * 24 * 60 * 60 * 1000 });
}

export async function adminRestoreUser(
  request: Request,
  deps: AdminDeps,
  userId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = z.object({ reason }).safeParse(await body(request));
  if (!parsed.success) throw validationError("A reason is required.");

  const users = area(AdminUserAccess, admin, deps);
  const user = await users.getById(userId);
  if (user === null) throw new ApiError("NOT_FOUND", "No such user.");

  const restored = await users.restore(userId, parsed.data.reason);

  let firebase: "enabled" | "no_identity" | "unconfigured" | "failed" = "unconfigured";
  if (restored && deps.firebaseAdmin !== null && user.firebaseUid !== null) {
    try {
      const updated = await setFirebaseUserDisabled(
        deps.firebaseAdmin,
        deps.kv,
        user.firebaseUid,
        false,
        deps.now
      );
      firebase = updated ? "enabled" : "no_identity";
    } catch {
      firebase = "failed";
    }
  }

  return json({ restored, firebase });
}

const transferSchema = z.object({ userId: z.string().trim().min(1), reason });

export async function adminTransferOwner(
  request: Request,
  deps: AdminDeps,
  orgId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = transferSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A target user and a reason are required.");

  await area(AdminUserAccess, admin, deps).transferOwner(
    orgId,
    parsed.data.userId,
    parsed.data.reason
  );
  return json({ transferred: true });
}

/* ------------------------------- workspaces ------------------------------ */

const overrideSchema = z.object({ planId: z.string().trim().min(1).nullable(), reason });

export async function adminSetPlanOverride(
  request: Request,
  deps: AdminDeps,
  workspaceId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = overrideSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A plan (or null) and a reason are required.");

  const changed = await area(AdminScopedAccess, admin, deps).setPlanOverride(
    workspaceId,
    parsed.data.planId,
    parsed.data.reason
  );
  return json({ changed });
}

const deleteWorkspaceSchema = z.object({ confirmName: z.string().min(1), reason });

export async function adminDeleteWorkspace(
  request: Request,
  deps: AdminDeps,
  workspaceId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = deleteWorkspaceSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("The workspace name and a reason are required.");

  const result = await area(AdminScopedAccess, admin, deps).softDeleteWorkspace(
    workspaceId,
    parsed.data.confirmName,
    parsed.data.reason
  );
  return json({ ...result, restorableUntil: deps.now + 30 * 24 * 60 * 60 * 1000 });
}

export async function adminRestoreWorkspace(
  request: Request,
  deps: AdminDeps,
  workspaceId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = z.object({ reason }).safeParse(await body(request));
  if (!parsed.success) throw validationError("A reason is required.");

  const restored = await area(AdminScopedAccess, admin, deps).restoreWorkspace(
    workspaceId,
    parsed.data.reason
  );
  return json({ restored });
}

export async function adminWorkspaceBlastRadius(
  request: Request,
  deps: AdminDeps,
  workspaceId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  return json(await area(AdminScopedAccess, admin, deps).workspaceBlastRadius(workspaceId));
}

export async function adminNeedsAttention(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  return json({ workspaces: await area(AdminScopedAccess, admin, deps).needsAttention() });
}

/* ---------------------------- agents and keys ---------------------------- */

const agentSchema = z.object({ disabled: z.boolean(), reason });

export async function adminSetAgentStatus(
  request: Request,
  deps: AdminDeps,
  agentId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = agentSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A disabled flag and a reason are required.");

  const changed = await area(AdminScopedAccess, admin, deps).setAgentStatus(
    agentId,
    parsed.data.disabled,
    parsed.data.reason
  );
  return json({ changed });
}

export async function adminRevokeKey(
  request: Request,
  deps: AdminDeps,
  keyId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = z.object({ reason }).safeParse(await body(request));
  if (!parsed.success) throw validationError("A reason is required.");

  const revoked = await area(AdminScopedAccess, admin, deps).revokeKey(keyId, parsed.data.reason);
  return json({ revoked });
}

/* -------------------------------- billing -------------------------------- */

export async function adminBilling(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const filter = new URL(request.url).searchParams.get("filter");
  const chosen = filter === "past_due" || filter === "canceled" ? filter : "all";

  // Null rather than a refusal: the org table still renders without Stripe, with
  // the two live cells marked unavailable. A billing screen that shows nothing
  // because one upstream is down is worse than one that shows what it knows.
  const stripe =
    deps.stripeSecretKey === undefined || deps.stripeSecretKey === ""
      ? null
      : stripeClient(deps.stripeSecretKey);

  return json(await area(AdminBillingAccess, admin, deps).list(stripe, chosen));
}

/* --------------------------------- plans --------------------------------- */

export async function adminListPlans(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  // The console owns the catalogue outright as of 18 Sept 2026. The Terraform
  // root that used to declare these products is deleted, so nothing reverts an
  // edit made here and there is no second writer to warn about.
  return json({ plans: await area(AdminPlanAccess, admin, deps).list() });
}

const planFields = {
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  amount_cents: z.number().int().min(0).optional(),
  storage_bytes: z.number().int().nullable().optional(),
  max_file_bytes: z.number().int().nullable().optional(),
  agents: z.number().int().nullable().optional(),
  members: z.number().int().nullable().optional(),
  workspaces: z.number().int().nullable().optional(),
  api_keys: z.number().int().nullable().optional(),
  file_count: z.number().int().nullable().optional(),
  egress_bytes_period: z.number().int().nullable().optional(),
  requests_period: z.number().int().nullable().optional(),
  priority_support: z.number().int().min(0).max(1).optional(),
  is_public: z.number().int().min(0).max(1).optional(),
  is_default: z.number().int().min(0).max(1).optional(),
  sort_order: z.number().int().optional(),
};

const updatePlanSchema = z.object({ ...planFields, reason });

export async function adminUpdatePlan(
  request: Request,
  deps: AdminDeps,
  planId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = updatePlanSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("Those plan values are not valid.");

  const { reason: why, ...patch } = parsed.data;
  const result = await area(AdminPlanAccess, admin, deps).update(
    stripeOf(deps),
    planId,
    patch,
    why
  );
  return json(result);
}

const createPlanSchema = z.object({
  ...planFields,
  id: z.string().trim().min(2).max(31),
  currency: z.string().trim().length(3).optional(),
  interval: z.enum(["month", "year"]).optional(),
  reason,
});

export async function adminCreatePlan(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = createPlanSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("Those plan values are not valid.");

  const { reason: why, ...input } = parsed.data;
  return json({ plan: await area(AdminPlanAccess, admin, deps).create(stripeOf(deps), input, why) }, 201);
}

export async function adminRetirePlan(
  request: Request,
  deps: AdminDeps,
  planId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = z.object({ reason }).safeParse(await body(request));
  if (!parsed.success) throw validationError("A reason is required.");

  return json({
    plan: await area(AdminPlanAccess, admin, deps).retire(stripeOf(deps), planId, parsed.data.reason),
  });
}

export async function adminStripeDiff(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  return json({ diffs: await area(AdminPlanAccess, admin, deps).stripeDiff(stripeOf(deps)) });
}

const syncSchema = z.object({
  selections: z
    .array(z.object({ planId: z.string().trim().min(1), fields: z.array(z.string()).min(1) }))
    .min(1),
  reason,
});

export async function adminSyncFromStripe(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = syncSchema.safeParse(await body(request));
  if (!parsed.success) {
    // A one-click pull is not an acceptable implementation, so an empty
    // selection is a refusal rather than "apply everything".
    throw validationError("Choose at least one field to apply.");
  }

  return json({
    applied: await area(AdminPlanAccess, admin, deps).syncFromStripe(
      stripeOf(deps),
      parsed.data.selections,
      parsed.data.reason
    ),
  });
}

/**
 * Replay the product -> plan upsert for every product in Stripe.
 *
 * This is the reconcile that makes a fresh `terraform apply` useful. Terraform
 * creates a product before its price, so `product.created` lands with a NULL
 * price and the row is unsellable until something fills it in. It runs the same
 * `syncProductToPlan` the webhook does, which is the whole point: a missed
 * delivery, a dashboard edit and this manual reconcile all heal through
 * identical code rather than through two implementations that drift.
 */
export async function adminSyncCatalogue(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = z.object({ reason }).safeParse(await body(request));
  if (!parsed.success) throw validationError("A reason is required.");

  const access = area(AdminPlanAccess, admin, deps);
  // Gated at the same level as the other inbound sync: it can change what every
  // customer is entitled to.
  await access.stripeDiff(stripeOf(deps));

  const stripe = stripeOf(deps);
  const products = await stripe.products.list({ active: true, limit: 100 });
  const synced: { planId: string; priceId: string | null }[] = [];

  for (const product of products.data) {
    const result = await syncProductToPlan(deps.db, stripe, product, deps.now);
    if (result !== null) synced.push(result);
  }

  invalidateCatalogue();
  return json({ synced });
}

/* --------------------------------- audit --------------------------------- */

function auditFilterFrom(url: URL) {
  const number = (name: string): number | null => {
    const raw = url.searchParams.get(name);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    actorId: url.searchParams.get("actorId"),
    action: url.searchParams.get("action"),
    from: number("from"),
    to: number("to"),
    before: number("before"),
    limit: number("limit") ?? 50,
  };
}

export async function adminAudit(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const url = new URL(request.url);
  return json(await area(AdminAuditAccess, admin, deps).list(auditFilterFrom(url)));
}

export async function adminAuditFilters(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const audit = area(AdminAuditAccess, admin, deps);
  return json({ actions: await audit.actions(), actors: await audit.actors() });
}

export async function adminAuditExport(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const url = new URL(request.url);
  const csv = await area(AdminAuditAccess, admin, deps).exportCsv(auditFilterFrom(url));

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="admin-audit-${deps.now}.csv"`,
      // The export is a bulk pull of customer-adjacent data. Nothing should
      // hold a copy of it on the way back.
      "cache-control": "no-store",
    },
  });
}

/* ----------------------------- admin accounts ---------------------------- */

export async function adminListAccounts(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  return json({ accounts: await area(AdminAccountAccess, admin, deps).list() });
}

const createAccountSchema = z.object({
  email: z.string().trim().min(3),
  role: z.enum(["admin"]),
  reason,
});

export async function adminCreateAccount(request: Request, deps: AdminDeps): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = createAccountSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("An email, a role and a reason are required.");

  const account = await area(AdminAccountAccess, admin, deps).create(
    parsed.data.email,
    parsed.data.role,
    parsed.data.reason
  );

  // No credential in the response, because none was created. Whoever holds this
  // address at our Firebase project becomes admin on their next sign-in.
  return json({ account }, 201);
}

const accountRoleSchema = z.object({ role: z.enum(["admin"]), reason });

export async function adminSetAccountRole(
  request: Request,
  deps: AdminDeps,
  adminId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = accountRoleSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A role and a reason are required.");

  await area(AdminAccountAccess, admin, deps).setRole(adminId, parsed.data.role, parsed.data.reason);
  return json({ changed: true });
}

export async function adminSetAccountDisabled(
  request: Request,
  deps: AdminDeps,
  adminId: string
): Promise<Response> {
  const admin = await requireAdmin(request, deps);
  const parsed = disableSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A disabled flag and a reason are required.");

  const changed = await area(AdminAccountAccess, admin, deps).setDisabled(
    adminId,
    parsed.data.disabled,
    parsed.data.reason
  );
  return json({ changed });
}
