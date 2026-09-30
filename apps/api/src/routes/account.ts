/**
 * A person closing their own account — `DELETE /v1/me`.
 *
 * Until now the only way out was to ask staff, which is the wrong shape for a
 * self-serve product and the wrong shape for a privacy policy: "you may request
 * deletion" is weaker than "you may delete it", and only one of them is a
 * button.
 *
 * ── What "yours" means, and why it is the billing account ───────────────────
 * The owner pays, so the owner's closure takes every workspace under their
 * billing account — and everybody invited into those workspaces loses access,
 * because Readers and Admins are guests, not co-owners. That is the Google
 * Drive model: delete the owner and the shared file goes for the editor and the
 * viewer alike. It is also why "owned" is `organizations.owner_user_id` and not
 * "has an owner-role membership somewhere": a membership row can be granted
 * into an org somebody else pays for, and cancelling *their* subscription
 * because *you* left would be the worst possible reading of "yours".
 *
 * The inverse holds too. Where this person was only a guest, their seat is
 * removed and the host's workspace is untouched. Before 26 Sept 2026 this route
 * cascaded `listWorkspacesForUser`, which returns every workspace a person can
 * SEE — so a reader closing their own account destroyed the workspace they had
 * been invited into. Two tests in `test/account.test.ts` pin the fix.
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
 * Billing first, and **a billing failure stops everything**. The earlier
 * version logged the failure and destroyed the account anyway, on the theory
 * that the webhook would reconcile it — but the org row survives, Stripe keeps
 * charging, the person can no longer sign in to stop it, and nothing alerts.
 * "Cancelled but not yet deleted" is recoverable by pressing the button again;
 * "deleted but still billed" is recoverable by nobody. So a Stripe error is a
 * 409 with nothing destroyed.
 *
 * Then one cascade per owned workspace, deferred: every credential, membership
 * and folder is destroyed in this request and only the bytes wait. Then the
 * person's own guest seats, keys and share links elsewhere. Then the user row
 * is marked and its purge queued.
 *
 * ── What is NOT done here ──────────────────────────────────────────────────
 * The email address is not released and the Firebase identity is not deleted.
 * Both happen together at the end of the seven-day window, in the sweep, after
 * the one message this account is still owed has been sent. Releasing the
 * address now would leave it with nowhere to go — see
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
import { listOwnedWorkspacesForUser } from "../db/user-lookup";
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

/**
 * The slice of Stripe this route uses, as a structural type so a test can pass
 * a fake. Every billing test in this repository is a refusal that returns
 * before the outbound call — correctly — which is how two checkout defects went
 * out green. The teardown here has real branches (which statuses, what happens
 * on failure), so it gets a seam.
 */
export interface StripeTeardownClient {
  subscriptions: {
    list(params: { customer: string; status: "all"; limit: number }): Promise<{
      data: { id: string; status: string; schedule?: string | { id: string } | null }[];
    }>;
    cancel(id: string): Promise<unknown>;
  };
  subscriptionSchedules: {
    release(id: string): Promise<unknown>;
  };
  paymentMethods: {
    list(params: { customer: string; limit: number }): Promise<{ data: { id: string }[] }>;
    detach(id: string): Promise<unknown>;
  };
}

export interface AccountDeps {
  db: D1Database;
  files: R2Bucket;
  stripeSecretKey?: string;
  /** Tests only. Production builds the client from `stripeSecretKey`. */
  stripe?: StripeTeardownClient;
}

/** A subscription in one of these states is already over; nothing to cancel. */
const ENDED_STATUSES = new Set(["canceled", "incomplete_expired"]);

export async function deleteOwnAccount(
  ctx: AuthContext,
  request: Request,
  deps: AccountDeps
): Promise<Response> {
  // A person's act, never a credential's — the same rule that governs
  // DELETE /v1/workspaces/:id. An API key that could close the account it
  // belongs to would make a leaked key unrecoverable rather than merely
  // dangerous.
  //
  // No role check beyond that. The dashboard's Account screen is reachable from
  // any workspace, including one the person merely reads, and their account is
  // theirs to close from wherever they happen to be standing. What they own is
  // decided below, per organization, not by the workspace this request named.
  if (ctx.identity.kind !== "firebase_user") {
    throw forbidden("An API key cannot close an account. This is a person's act.");
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

  const ownedOrgs = await deps.db
    .prepare(`SELECT id, stripe_customer_id AS stripeCustomerId FROM organizations WHERE owner_user_id = ?`)
    .bind(user.id)
    .all<{ id: string; stripeCustomerId: string | null }>();

  const workspaces = await listOwnedWorkspacesForUser(deps.db, user.id);
  if (workspaces.length > MAX_CASCADE_WORKSPACES) {
    throw new ApiError(
      "LIMIT_EXCEEDED",
      `This account owns ${workspaces.length} workspaces, more than the ${MAX_CASCADE_WORKSPACES} one request can destroy safely. Write to connect@agentdisk.io and we will do it in one go.`,
      { details: { workspaces: workspaces.length, max: MAX_CASCADE_WORKSPACES } }
    );
  }

  // Throws on failure, before anything below has run.
  const billing = await endBilling(deps, ownedOrgs.results ?? []);

  let filesQueued = 0;
  for (const workspace of workspaces) {
    const { objectsDeferred } = await deleteWorkspaceCascade(
      deps.db,
      deps.files,
      workspace.id,
      {
        workspaceName: workspace.name,
        orgId: workspace.orgId,
        deletedBy: user.id,
        now: ctx.now,
        source: "account_delete",
      }
    );
    filesQueued += objectsDeferred;
  }

  // Everything this person holds in workspaces that survive: their guest seats,
  // and — defensively, since no invitable role can write — any key or share
  // link they created there. The cascades above have already taken these for
  // the owned workspaces; this is the remainder. Same three statements the
  // staff path runs, for the same reason: a closed account must not leave a
  // live credential or a public link behind it.
  await deps.db.batch([
    deps.db.prepare(`DELETE FROM memberships WHERE user_id = ?`).bind(user.id),
    deps.db
      .prepare(`UPDATE api_keys SET revoked_at = ? WHERE created_by_user_id = ? AND revoked_at IS NULL`)
      .bind(ctx.now, user.id),
    deps.db.prepare(`DELETE FROM share_links WHERE created_by = ?`).bind(user.id),
  ]);

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
 * Cancel every subscription on every organization this person pays for, and
 * remove the saved cards.
 *
 * **Every status that is not already over**, not only `active`. A `past_due`
 * subscription is mid-dunning and will bill again the moment the card works; a
 * `trialing` one converts on schedule. Cancelling only `active` left both
 * running against an account with nobody left to notice.
 *
 * **A pending downgrade goes first.** A Subscription Schedule owns the
 * subscription's future phases and Stripe refuses to cancel underneath one, so
 * a customer who downgraded last week would otherwise be refused here with an
 * error naming an object they have never heard of — the same order
 * `cancelSubscription` in routes/billing.ts uses.
 *
 * **Any failure throws**, and the caller has not destroyed anything yet. See
 * the header for why the alternative — log it and carry on — is the one
 * outcome nobody can recover from.
 *
 * The card is detached rather than the customer deleted. Card tokens are the
 * sensitive part and go immediately; the customer object carries the invoices,
 * which are kept.
 */
async function endBilling(
  deps: AccountDeps,
  ownedOrgs: { id: string; stripeCustomerId: string | null }[]
): Promise<"cancelled" | "nothing_to_cancel" | "unconfigured"> {
  const customers = ownedOrgs
    .map((org) => org.stripeCustomerId)
    .filter((id): id is string => id !== null);
  if (customers.length === 0) return "nothing_to_cancel";

  const stripe =
    deps.stripe ??
    (deps.stripeSecretKey === undefined || deps.stripeSecretKey === ""
      ? null
      : stripeClient(deps.stripeSecretKey));
  if (stripe === null) return "unconfigured";

  let cancelled = 0;
  try {
    for (const customer of customers) {
      const subscriptions = await stripe.subscriptions.list({ customer, status: "all", limit: 100 });
      for (const subscription of subscriptions.data) {
        if (ENDED_STATUSES.has(subscription.status)) continue;

        const scheduleId =
          typeof subscription.schedule === "string"
            ? subscription.schedule
            : (subscription.schedule?.id ?? null);
        if (scheduleId !== null) {
          // Already released or completed is not a failure of what the person
          // asked for; the cancel below is the real test.
          await stripe.subscriptionSchedules.release(scheduleId).catch(() => undefined);
        }

        await stripe.subscriptions.cancel(subscription.id);
        cancelled += 1;
      }

      const methods = await stripe.paymentMethods.list({ customer, limit: 100 });
      for (const method of methods.data) {
        await stripe.paymentMethods.detach(method.id);
      }
    }
  } catch (err) {
    throw new ApiError(
      "CONFLICT",
      "We could not end your subscription, so nothing was deleted. Try again in a moment, or write to connect@agentdisk.io.",
      { internalReason: `billing teardown failed: ${err instanceof Error ? err.message : String(err)}` }
    );
  }

  return cancelled > 0 ? "cancelled" : "nothing_to_cancel";
}
