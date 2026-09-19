/**
 * GET /v1/activity — the workspace's audit trail (03 §8.20, 05 PART 11.1).
 *
 * The point of this screen, and the reason the product bothers to record any of
 * this, is that a human can see exactly what an agent did to their files. So
 * the response leads with the actor and whether the attempt succeeded — a
 * denied call is more interesting than a successful one, and a log that only
 * showed successes would hide the thing most worth seeing.
 *
 * Read-only, and there is deliberately no write endpoint. Audit rows are
 * written by the code paths they describe, never by a client, because an audit
 * trail a caller can post to is not an audit trail.
 */

import { ApiError } from "../lib/errors";
import type { AuthContext } from "../middleware/auth";
import type { AuditEventRow } from "../db/types";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function toResource(row: AuditEventRow) {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata !== null) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      // A row that will not parse is a bug on the write side, not a reason to
      // fail a read of the other forty-nine.
      metadata = null;
    }
  }
  return {
    id: row.id,
    action: row.action,
    actor: { type: row.actor_type, id: row.actor_id },
    resource: { type: row.resource_type, id: row.resource_id },
    result: row.result,
    ip: row.ip,
    client: row.client,
    requestId: row.request_id,
    metadata,
    at: new Date(row.created_at).toISOString(),
  };
}

export async function listActivity(ctx: AuthContext, request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (raw !== null) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new ApiError("VALIDATION_ERROR", "limit must be a positive whole number.");
    }
    // Clamped rather than refused. A caller asking for a thousand rows wants as
    // many as they can have, and erroring would be pedantry.
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const events = await ctx.db.auditEvents.list(limit);
  return json({ events: events.map(toResource), limit });
}
