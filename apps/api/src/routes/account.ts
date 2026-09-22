/**
 * A person closing their own account — `DELETE /v1/me`.
 *
 * Until now the only way out was to ask staff, which is the wrong shape for a
 * self-serve product and the wrong shape for a privacy policy: "you may request
 * deletion" is weaker than "you may delete it", and only one of them is a
 * button.
 *
 * ── Where this differs from the staff path, and why ────────────────────────
 * In exactly one respect: **this one cancels a live subscription.** The staff
 * path refuses while a subscription is active, on the rule that a human must
 * never implicitly cancel somebody's paid plan. That rule was written for staff
 * acting on another person's account. Here the account holder is doing it to
 * their own, having typed their address to confirm — they *are* that deliberate
 * human, and refusing would leave them paying for something they just
 * destroyed.
 *
 * ── What happens, in order, and why that order ─────────────────────────────
 * Billing first. A failure there must not leave an account destroyed and still
 * being charged; the reverse — cancelled but not yet deleted — is recoverable
 * by retrying, and costs nobody anything in the meantime.
 *
 * Then one cascade per workspace, deferred: every credential, membership and
 * folder is destroyed in this request and only the bytes wait. Then the user
 * row is marked and its purge queued.
 *
 * ── What is NOT done here ──────────────────────────────────────────────────
 * The email address is not released and the Firebase identity is not deleted.
 * Both happen together at the end of the seven-day window, in the sweep,
 * because every message this account is still owed is sent during it. Releasing
 * the address now would leave those with nowhere to go — see
 * `jobs/pending-deletions.ts`.
 *
 * Invoices are not touched. Retention is a legal obligation, GDPR Art. 17(3)(b)
 * exempts it, and Stripe keeps them regardless of what we do to the customer —
 * so promising their deletion would be a promise we cannot keep.
 */

import { z } from "zod";
import type { AuthContext } from "../middleware/auth";
import { ApiError, forbidden, validationError } from "../lib/errors";
import { deleteWorkspaceCascade, ACCOUNT_PURGE_TTL_MS } from "../db/workspace-cascade";
import { listWorkspacesForUser } from "../db/user-lookup";
import { findOrgForWorkspace } from "../billing/organizations";
import { stripeClient } from "../billing/stripe";

/**
 * The most workspaces one request will destroy.
 *
 * Deferring the bytes makes each cascade D1-only and far cheaper, but the
 * *count* is still unbounded. Refusing above the cap names the number, which is
 * a better outcome than timing out half-way and leaving an account partly
 * destroyed with no record of where it stopped.
 */
export const MAX_CASCADE_WORKSPACES = 20;

const schema = z.object({
  confirmEmail: z.string().trim().min(1, "Type your email address to confirm."),
});

export interface AccountDeps {
  db: D1Database;
  files: R2Bucket;
  stripeSecretKey?: string;
}

export async function deleteOwnAccount(
  ctx: AuthContext,
  request: Request,
  deps: AccountDeps
): Promise<Response> {
  // A person's act, never a credential's — the same rule that governs
  // DELETE /v1/workspaces/:id. An API key that could close the account it
  // belongs to would make a leaked key unrecoverable rather than merely
  // dangerous.
  if (ctx.identity.kind !== "firebase_user") {
    throw forbidden("An API key cannot close an account. This is a person's act.");
  }
  if (ctx.identity.role !== "owner") {
    throw forbidden("Only the account owner can close the account.");
  }

  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw validationError("Type your email address exactly to confirm.");
  }

  const user = await deps.db
    .prepare(`SELECT id, email FROM users WHERE id = ? AND deleted_at IS NULL`)
    .bind(ctx.identity.userId)
    .first<{ id: string; email: string }>();
  if (user === null) throw new ApiError("NOT_FOUND", "No such account.");

  // Compared case-insensitively: an address differing only in case is the same
  // person to Google and must be the same person here.
  if (parsed.data.confirmEmail.toLowerCase() !== user.email.toLowerCase()) {
    throw validationError("That email address doesn't match this account.", {
      hint: "Type your own email address exactly to confirm.",
    });
  }

  const workspaces = await listWorkspacesForUser(deps.db, user.id);
  if (workspaces.length > MAX_CASCADE_WORKSPACES) {
    throw new ApiError(
      "LIMIT_EXCEEDED",
      `This account owns ${workspaces.length} workspaces, more than the ${MAX_CASCADE_WORKSPACES} one request can destroy safely. Contact support and we will do it in one go.`,
      { details: { workspaces: workspaces.length, max: MAX_CASCADE_WORKSPACES } }
    );
  }

  const billing = await endBilling(ctx, deps, workspaces[0]?.id ?? null);

  let filesQueued = 0;
  for (const workspace of workspaces) {
    // `listWorkspacesForUser` returns what a person needs to SEE a workspace,
    // not what the cascade needs to destroy one, so the org is read here. It
    // is per-workspace rather than read once because a person can in principle
    // own workspaces across more than one organization.
    const owning = await deps.db
      .prepare(`SELECT org_id FROM workspaces WHERE id = ?`)
      .bind(workspace.id)
      .first<{ org_id: string }>();
    if (owning === null) continue;

    const { objectsDeferred } = await deleteWorkspaceCascade(
      deps.db,
      deps.files,
      workspace.id,
      {
        workspaceName: workspace.name,
        orgId: owning.org_id,
        deletedBy: user.id,
        now: ctx.now,
        source: "account_delete",
      }
    );
    filesQueued += objectsDeferred;
  }

  const purgeAfter = ctx.now + ACCOUNT_PURGE_TTL_MS;

  // The address stays. It is released by the sweep, with the identity, at the
  // end of the window - see this file's header.
  await deps.db
    .prepare(
      `UPDATE users
          SET deleted_at = ?, session_revoked_after = ?, updated_at = ?, purge_after = ?
        WHERE id = ? AND deleted_at IS NULL`
    )
    .bind(ctx.now, ctx.now, ctx.now, purgeAfter, user.id)
    .run();

  // Logged rather than audited, and forced rather than chosen: `audit_events`
  // is workspace-scoped by foreign key, so the rows describing an account's
  // destruction are the rows it cannot hold.
  console.log(
    JSON.stringify({
      level: "warn",
      message: "account closed by owner",
      userId: user.id,
      workspacesDeleted: workspaces.length,
      filesQueued,
      billing,
      purgeAfter: new Date(purgeAfter).toISOString(),
      at: new Date(ctx.now).toISOString(),
    })
  );

  return new Response(
    JSON.stringify({
      closed: true,
      workspacesDeleted: workspaces.length,
      filesQueued,
      billing,
      purgeAfter: new Date(purgeAfter).toISOString(),
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/**
 * Cancel the subscription and remove the saved card.
 *
 * Both are best-effort and neither can stop the deletion. Somebody who has
 * asked to close their account must not be told "we could not reach Stripe, so
 * you still have an account" — the webhook and the on-demand sync both
 * reconcile a subscription we failed to cancel, and a card left attached to a
 * customer with no subscription charges nobody.
 *
 * The card is detached rather than the customer deleted. Card tokens are the
 * sensitive part and go immediately; the customer object carries the invoices,
 * which are kept.
 */
async function endBilling(
  ctx: AuthContext,
  deps: AccountDeps,
  anyWorkspaceId: string | null
): Promise<"cancelled" | "nothing_to_cancel" | "unconfigured" | "failed"> {
  if (deps.stripeSecretKey === undefined || deps.stripeSecretKey === "") {
    return "unconfigured";
  }
  if (anyWorkspaceId === null) return "nothing_to_cancel";

  const org = await findOrgForWorkspace(deps.db, anyWorkspaceId);
  if (org === null || org.stripeCustomerId === null) return "nothing_to_cancel";

  try {
    const stripe = stripeClient(deps.stripeSecretKey);

    const subscriptions = await stripe.subscriptions.list({
      customer: org.stripeCustomerId,
      status: "active",
      limit: 10,
    });
    for (const subscription of subscriptions.data) {
      await stripe.subscriptions.cancel(subscription.id);
    }

    const methods = await stripe.paymentMethods.list({
      customer: org.stripeCustomerId,
      limit: 20,
    });
    for (const method of methods.data) {
      await stripe.paymentMethods.detach(method.id);
    }

    return subscriptions.data.length > 0 ? "cancelled" : "nothing_to_cancel";
  } catch (err) {
    console.log(
      JSON.stringify({
        level: "error",
        message: "billing teardown failed during account closure",
        requestId: ctx.requestId,
        reason: err instanceof Error ? err.message : String(err),
      })
    );
    return "failed";
  }
}
