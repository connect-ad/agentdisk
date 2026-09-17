/**
 * The staff console's handlers — 32 PART 6.
 *
 * Separate from `staff.ts`, which holds session handling and the workspace
 * screens that shipped first. Splitting on that line rather than merging keeps
 * either file readable, and there is no behaviour in the boundary: both build
 * their access object the same way, from the same `StaffDeps`, and both are
 * reachable only through `staff-router.ts`.
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
import { json, requireStaff, type StaffDeps } from "./staff";
import { StaffScopedAccess, type StaffUser } from "../staff/access";
import { StaffUserAccess } from "../staff/users-access";
import { StaffPlanAccess } from "../staff/plans-access";
import { StaffBillingAccess } from "../staff/billing-access";
import { StaffAuditAccess } from "../staff/audit-access";
import { StaffAccountAccess } from "../staff/accounts-access";
import { setFirebaseUserDisabled } from "../auth/firebase-admin";
import { stripeClient } from "../billing/stripe";
import { syncProductToPlan } from "../billing/plan-sync";
import { invalidateCatalogue } from "../billing/catalogue";

/* ------------------------------- plumbing -------------------------------- */

type Ctor<T> = new (
  db: D1Database,
  staff: StaffUser,
  requestId: string,
  now: number,
  sourceIp: string | null
) => T;

/** One way to build any area's access object, so none of them can drift. */
function area<T>(Cls: Ctor<T>, staff: StaffUser, deps: StaffDeps): T {
  return new Cls(deps.db, staff, deps.requestId, deps.now, deps.sourceIp ?? null);
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
function stripeOf(deps: StaffDeps) {
  if (deps.stripeSecretKey === undefined || deps.stripeSecretKey === "") {
    throw new ApiError("INTERNAL_ERROR", "Stripe is not configured in this environment.", {
      internalReason: "STRIPE_SECRET_KEY is not set",
    });
  }
  return stripeClient(deps.stripeSecretKey);
}

/* --------------------------------- users --------------------------------- */

export async function staffFindUser(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const email = new URL(request.url).searchParams.get("email");
  if (email === null) throw validationError("An email address is required.");

  const users = area(StaffUserAccess, staff, deps);
  const user = await users.findByEmail(email);
  if (user === null) return json({ user: null, memberships: [] });

  return json({
    user,
    memberships: await users.membershipsOf(user.id),
    keys: await users.keyBlastRadius(user.id),
  });
}

export async function staffGetUser(
  request: Request,
  deps: StaffDeps,
  userId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const users = area(StaffUserAccess, staff, deps);

  const user = await users.getById(userId);
  if (user === null) throw new ApiError("NOT_FOUND", "No such user.");

  return json({
    user,
    memberships: await users.membershipsOf(userId),
    keys: await users.keyBlastRadius(userId),
  });
}

const disableSchema = z.object({ disabled: z.boolean(), reason });

export async function staffSetUserDisabled(
  request: Request,
  deps: StaffDeps,
  userId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = disableSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A disabled flag and a reason are required.");

  const users = area(StaffUserAccess, staff, deps);
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

export async function staffDeletionCheck(
  request: Request,
  deps: StaffDeps,
  userId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  return json(await area(StaffUserAccess, staff, deps).deletionCheck(userId));
}

const deleteUserSchema = z.object({
  reason,
  /** Typed back exactly, so the confirmation belongs to the operation. */
  confirmEmail: z.string().trim().min(1),
  revokeKeys: z.boolean().default(true),
});

export async function staffDeleteUser(
  request: Request,
  deps: StaffDeps,
  userId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = deleteUserSchema.safeParse(await body(request));
  if (!parsed.success) {
    throw validationError("A reason and the account's email address are required.");
  }

  const users = area(StaffUserAccess, staff, deps);
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

export async function staffRestoreUser(
  request: Request,
  deps: StaffDeps,
  userId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = z.object({ reason }).safeParse(await body(request));
  if (!parsed.success) throw validationError("A reason is required.");

  const users = area(StaffUserAccess, staff, deps);
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

export async function staffTransferOwner(
  request: Request,
  deps: StaffDeps,
  orgId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = transferSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A target user and a reason are required.");

  await area(StaffUserAccess, staff, deps).transferOwner(
    orgId,
    parsed.data.userId,
    parsed.data.reason
  );
  return json({ transferred: true });
}

/* ------------------------------- workspaces ------------------------------ */

const overrideSchema = z.object({ planId: z.string().trim().min(1).nullable(), reason });

export async function staffSetPlanOverride(
  request: Request,
  deps: StaffDeps,
  workspaceId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = overrideSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A plan (or null) and a reason are required.");

  const changed = await area(StaffScopedAccess, staff, deps).setPlanOverride(
    workspaceId,
    parsed.data.planId,
    parsed.data.reason
  );
  return json({ changed });
}

const deleteWorkspaceSchema = z.object({ confirmName: z.string().min(1), reason });

export async function staffDeleteWorkspace(
  request: Request,
  deps: StaffDeps,
  workspaceId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = deleteWorkspaceSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("The workspace name and a reason are required.");

  const result = await area(StaffScopedAccess, staff, deps).softDeleteWorkspace(
    workspaceId,
    parsed.data.confirmName,
    parsed.data.reason
  );
  return json({ ...result, restorableUntil: deps.now + 30 * 24 * 60 * 60 * 1000 });
}

export async function staffRestoreWorkspace(
  request: Request,
  deps: StaffDeps,
  workspaceId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = z.object({ reason }).safeParse(await body(request));
  if (!parsed.success) throw validationError("A reason is required.");

  const restored = await area(StaffScopedAccess, staff, deps).restoreWorkspace(
    workspaceId,
    parsed.data.reason
  );
  return json({ restored });
}

export async function staffWorkspaceBlastRadius(
  request: Request,
  deps: StaffDeps,
  workspaceId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  return json(await area(StaffScopedAccess, staff, deps).workspaceBlastRadius(workspaceId));
}

export async function staffNeedsAttention(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  return json({ workspaces: await area(StaffScopedAccess, staff, deps).needsAttention() });
}

/* ---------------------------- agents and keys ---------------------------- */

const agentSchema = z.object({ disabled: z.boolean(), reason });

export async function staffSetAgentStatus(
  request: Request,
  deps: StaffDeps,
  agentId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = agentSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A disabled flag and a reason are required.");

  const changed = await area(StaffScopedAccess, staff, deps).setAgentStatus(
    agentId,
    parsed.data.disabled,
    parsed.data.reason
  );
  return json({ changed });
}

export async function staffRevokeKey(
  request: Request,
  deps: StaffDeps,
  keyId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = z.object({ reason }).safeParse(await body(request));
  if (!parsed.success) throw validationError("A reason is required.");

  const revoked = await area(StaffScopedAccess, staff, deps).revokeKey(keyId, parsed.data.reason);
  return json({ revoked });
}

/* -------------------------------- billing -------------------------------- */

export async function staffBilling(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const filter = new URL(request.url).searchParams.get("filter");
  const chosen = filter === "past_due" || filter === "canceled" ? filter : "all";

  // Null rather than a refusal: the org table still renders without Stripe, with
  // the two live cells marked unavailable. A billing screen that shows nothing
  // because one upstream is down is worse than one that shows what it knows.
  const stripe =
    deps.stripeSecretKey === undefined || deps.stripeSecretKey === ""
      ? null
      : stripeClient(deps.stripeSecretKey);

  return json(await area(StaffBillingAccess, staff, deps).list(stripe, chosen));
}

/* --------------------------------- plans --------------------------------- */

export async function staffListPlans(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  return json({
    plans: await area(StaffPlanAccess, staff, deps).list(),
    // Stated on every render rather than left to be discovered. Terraform still
    // declares these products, so an apply after an edit here reverts it.
    catalogueOwner: "terraform",
    catalogueNote:
      "infra/stripe-catalogue/ still declares these products. A terraform apply will revert " +
      "edits made here until that root is removed at launch.",
  });
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

export async function staffUpdatePlan(
  request: Request,
  deps: StaffDeps,
  planId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = updatePlanSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("Those plan values are not valid.");

  const { reason: why, ...patch } = parsed.data;
  const result = await area(StaffPlanAccess, staff, deps).update(
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

export async function staffCreatePlan(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = createPlanSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("Those plan values are not valid.");

  const { reason: why, ...input } = parsed.data;
  return json({ plan: await area(StaffPlanAccess, staff, deps).create(stripeOf(deps), input, why) }, 201);
}

export async function staffRetirePlan(
  request: Request,
  deps: StaffDeps,
  planId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = z.object({ reason }).safeParse(await body(request));
  if (!parsed.success) throw validationError("A reason is required.");

  return json({
    plan: await area(StaffPlanAccess, staff, deps).retire(stripeOf(deps), planId, parsed.data.reason),
  });
}

export async function staffStripeDiff(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  return json({ diffs: await area(StaffPlanAccess, staff, deps).stripeDiff(stripeOf(deps)) });
}

const syncSchema = z.object({
  selections: z
    .array(z.object({ planId: z.string().trim().min(1), fields: z.array(z.string()).min(1) }))
    .min(1),
  reason,
});

export async function staffSyncFromStripe(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = syncSchema.safeParse(await body(request));
  if (!parsed.success) {
    // A one-click pull is not an acceptable implementation, so an empty
    // selection is a refusal rather than "apply everything".
    throw validationError("Choose at least one field to apply.");
  }

  return json({
    applied: await area(StaffPlanAccess, staff, deps).syncFromStripe(
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
export async function staffSyncCatalogue(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = z.object({ reason }).safeParse(await body(request));
  if (!parsed.success) throw validationError("A reason is required.");

  const access = area(StaffPlanAccess, staff, deps);
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

export async function staffAudit(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const url = new URL(request.url);
  return json(await area(StaffAuditAccess, staff, deps).list(auditFilterFrom(url)));
}

export async function staffAuditFilters(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const audit = area(StaffAuditAccess, staff, deps);
  return json({ actions: await audit.actions(), actors: await audit.actors() });
}

export async function staffAuditExport(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const url = new URL(request.url);
  const csv = await area(StaffAuditAccess, staff, deps).exportCsv(auditFilterFrom(url));

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="staff-audit-${deps.now}.csv"`,
      // The export is a bulk pull of customer-adjacent data. Nothing should
      // hold a copy of it on the way back.
      "cache-control": "no-store",
    },
  });
}

/* ----------------------------- staff accounts ---------------------------- */

export async function staffListAccounts(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  return json({ accounts: await area(StaffAccountAccess, staff, deps).list() });
}

const createAccountSchema = z.object({
  email: z.string().trim().min(3),
  role: z.enum(["support", "admin", "super_admin"]),
  reason,
});

export async function staffCreateAccount(request: Request, deps: StaffDeps): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = createAccountSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("An email, a role and a reason are required.");

  const created = await area(StaffAccountAccess, staff, deps).create(
    parsed.data.email,
    parsed.data.role,
    deps.encryptionKey,
    parsed.data.reason
  );

  // Shown once, like an API key. The response is the only place this credential
  // ever exists; nothing stores it and no later call can retrieve it.
  return json(created, 201);
}

const accountRoleSchema = z.object({ role: z.enum(["support", "admin", "super_admin"]), reason });

export async function staffSetAccountRole(
  request: Request,
  deps: StaffDeps,
  staffId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = accountRoleSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A role and a reason are required.");

  await area(StaffAccountAccess, staff, deps).setRole(staffId, parsed.data.role, parsed.data.reason);
  return json({ changed: true });
}

export async function staffSetAccountDisabled(
  request: Request,
  deps: StaffDeps,
  staffId: string
): Promise<Response> {
  const staff = await requireStaff(request, deps);
  const parsed = disableSchema.safeParse(await body(request));
  if (!parsed.success) throw validationError("A disabled flag and a reason are required.");

  const changed = await area(StaffAccountAccess, staff, deps).setDisabled(
    staffId,
    parsed.data.disabled,
    parsed.data.reason
  );
  return json({ changed });
}
