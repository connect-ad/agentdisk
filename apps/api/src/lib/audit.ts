/**
 * Writing the audit trail — 05 PART 11.1, 06 PART 16.
 *
 * The table and its repository have existed since Phase 1 and nothing ever
 * called them, so the Activity screen has been empty for a reason that had
 * nothing to do with the screen. This is the missing half.
 *
 * Three rules, and each is the kind of thing that is obvious in hindsight and
 * expensive to retrofit:
 *
 * **An audit write must never fail the request it describes.** The action
 * already happened; refusing to acknowledge it because a second INSERT failed
 * would turn a logging problem into a data-loss report from a confused user.
 * Every write here is best-effort and reports its own failure to the log.
 *
 * **It rides on `waitUntil`, not the response path.** A file upload should not
 * wait on a second D1 round trip to learn something the caller already knows.
 *
 * **Nothing sensitive goes in `metadata`.** 06 PART 16 is explicit: never file
 * contents, never a raw key, never an Authorization header. The helpers below
 * take structured, named fields precisely so a caller cannot casually splat a
 * whole request object in.
 */

import { newId } from "./ids";
import { enqueueWebhookEvents } from "../jobs/webhook-delivery";
import type { AuthContext } from "../middleware/auth";

/** Dotted, resource-first, past tense: `file.created`, `key.revoked`. */
export type AuditAction = string;

export interface AuditDetails {
  resourceType?: string;
  resourceId?: string | null;
  /** Denied attempts matter more than successes; both are recorded. */
  result?: "success" | "denied" | "error";
  /** Small, named, non-sensitive facts. Never a request body. */
  metadata?: Record<string, string | number | boolean | null>;
}

function clientOf(request: Request): string | null {
  const agent = request.headers.get("user-agent");
  // Truncated: a user-agent is attacker-controlled and unbounded, and a row
  // that grows without limit is a denial-of-service on the audit log itself.
  return agent === null ? null : agent.slice(0, 200);
}

function ipOf(request: Request): string | null {
  // Cloudflare sets this and it cannot be spoofed by the client, unlike
  // X-Forwarded-For which anybody can send.
  return request.headers.get("cf-connecting-ip");
}

/**
 * Record something that happened, without making the caller wait for it.
 *
 * The context's repositories are already workspace-bound, so this cannot write
 * an event into somebody else's workspace even if asked to.
 */
export function audit(
  ctx: AuthContext,
  request: Request,
  action: AuditAction,
  details: AuditDetails = {}
): void {
  const write = ctx.db.auditEvents
    .append({
      id: newId("auditEvent", ctx.now),
      workspace_id: ctx.workspaceId,
      actor_type: ctx.identity.actorType,
      actor_id: ctx.identity.actorId,
      action,
      resource_type: details.resourceType ?? null,
      resource_id: details.resourceId ?? null,
      result: details.result ?? "success",
      ip: ipOf(request),
      client: clientOf(request),
      request_id: ctx.requestId,
      metadata: details.metadata === undefined ? null : JSON.stringify(details.metadata),
      created_at: ctx.now,
    })
    .catch((err: unknown) => {
      // Loud in the log, invisible to the caller. The thing being described has
      // already happened; failing the response now would be a lie about it.
      console.log(
        JSON.stringify({
          level: "error",
          requestId: ctx.requestId,
          message: "audit write failed",
          action,
          workspaceId: ctx.workspaceId,
          reason: err instanceof Error ? err.message : String(err),
        })
      );
    });

  if (ctx.waitUntil) ctx.waitUntil(write);
  // Without a waitUntil the promise is still created and still runs; it simply
  // is not kept alive past the response. Deliberately not awaited either way.
}

/**
 * Record an event *and* fan it out to the customer's webhooks.
 *
 * The two travel together because they answer the same question — "what just
 * happened here" — and separating them is how one gets updated and the other
 * quietly does not. Both are best-effort and both stay off the response path:
 * a customer's endpoint being unreachable must not fail somebody's upload.
 */
export function auditAndNotify(
  ctx: AuthContext,
  request: Request,
  action: AuditAction,
  details: AuditDetails & { webhookData?: Record<string, unknown> } = {}
): void {
  audit(ctx, request, action, details);

  if (ctx.queue === undefined || details.webhookData === undefined) return;

  const fanOut = enqueueWebhookEvents(
    ctx.db.webhooks,
    ctx.queue,
    ctx.workspaceId,
    action,
    details.webhookData,
    ctx.now
  ).catch((err: unknown) => {
    console.log(
      JSON.stringify({
        level: "warn",
        requestId: ctx.requestId,
        message: "webhook fan-out failed",
        action,
        reason: err instanceof Error ? err.message : String(err),
      })
    );
  });

  if (ctx.waitUntil) ctx.waitUntil(fanOut);
}
