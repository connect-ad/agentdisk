/**
 * Agents — 05 PART 13.
 *
 * An agent is the thing a key belongs to, which is why this exists before key
 * minting does. It is also the unit of revocation that matters operationally:
 * disabling one agent stops every key it holds, immediately and without hunting
 * them down, because authentication reads the agent's status on every request.
 *
 * Deleting an agent is a soft delete, and that is forced rather than chosen:
 * `api_keys.agent_id` references the row, so a hard DELETE fails the foreign
 * key as soon as the agent has ever held a key. Both ways around that are worse
 * than keeping the row — deleting the keys destroys the record of what the
 * agent did, and nulling their `agent_id` converts agent credentials into
 * workspace-level ones. Its keys are revoked either way, so nothing it held
 * survives the delete.
 */

import { z } from "zod";
import { ApiError, validationError } from "../lib/errors";
import { newId } from "../lib/ids";
import type { AuthContext } from "../middleware/auth";
import type { AgentRow } from "../db/types";
import { audit } from "../lib/audit";

const NAME = z
  .string()
  .trim()
  .min(1, "An agent needs a name.")
  .max(64)
  // Names appear in scope path prefixes (`/agents/<name>/*`), so a name with a
  // slash in it could describe a prefix its owner never intended to grant.
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, numbers, dots, dashes or underscores.");

const createSchema = z.object({
  name: NAME,
  description: z.string().trim().max(280).optional(),
});

const updateSchema = z
  .object({
    name: NAME.optional(),
    description: z.string().trim().max(280).nullable().optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine(body => Object.keys(body).length > 0, { message: "Nothing to change." });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function toResource(row: AgentRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdBy: row.created_by_user_id,
    lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function parse<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  try {
    return schema.parse(await request.json());
  } catch (err) {
    throw validationError(
      err instanceof z.ZodError
        ? (err.issues[0]?.message ?? "That request body is not valid.")
        : "Send a JSON body."
    );
  }
}

export async function listAgents(ctx: AuthContext): Promise<Response> {
  const agents = await ctx.db.agents.list();
  return json({ agents: agents.map(toResource) });
}

export async function createAgent(ctx: AuthContext, request: Request): Promise<Response> {
  const body = await parse(request, createSchema);

  const row: AgentRow = {
    id: newId("agent", ctx.now),
    workspace_id: ctx.workspaceId,
    name: body.name,
    description: body.description ?? null,
    status: "active",
    // An agent created by an API key is attributed to whoever minted that key,
    // not to the agent using it - the audit trail should name a person.
    created_by_user_id:
      ctx.identity.kind === "firebase_user"
        ? ctx.identity.userId
        : ctx.identity.createdByUserId,
    last_seen_at: null,
    created_at: ctx.now,
  };

  try {
    await ctx.db.agents.insert(row);
  } catch (err) {
    // UNIQUE(workspace_id, name). Reported rather than swallowed: two agents
    // with one name makes every scope prefix mentioning it ambiguous.
    if (String(err).includes("UNIQUE")) {
      throw new ApiError("CONFLICT", `An agent named "${body.name}" already exists.`);
    }
    throw err;
  }

  audit(ctx, request, "agent.created", {
    resourceType: "agent",
    resourceId: row.id,
    metadata: { name: row.name },
  });
  return json({ agent: toResource(row) }, 201);
}

export async function getAgent(ctx: AuthContext, _request: Request, id: string): Promise<Response> {
  const agent = await ctx.db.agents.getById(id);
  if (agent === null) throw new ApiError("NOT_FOUND", "No such agent.");
  return json({ agent: toResource(agent) });
}

export async function patchAgent(
  ctx: AuthContext,
  request: Request,
  id: string
): Promise<Response> {
  const body = await parse(request, updateSchema);

  const existing = await ctx.db.agents.getById(id);
  if (existing === null) throw new ApiError("NOT_FOUND", "No such agent.");

  try {
    await ctx.db.agents.update(id, body);
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new ApiError("CONFLICT", `An agent named "${body.name}" already exists.`);
    }
    throw err;
  }

  const updated = await ctx.db.agents.getById(id);
  audit(ctx, request, "agent.updated", {
    resourceType: "agent",
    resourceId: id,
    // The fields that changed, never the whole row - a diff is what somebody
    // reading this later actually wants.
    metadata: {
      name: body.name ?? null,
      status: body.status ?? null,
    },
  });
  return json({ agent: toResource(updated ?? existing) });
}

export async function deleteAgent(
  ctx: AuthContext,
  _request: Request,
  id: string
): Promise<Response> {
  const existing = await ctx.db.agents.getById(id);
  if (existing === null) throw new ApiError("NOT_FOUND", "No such agent.");

  // Revoke first, then mark deleted. The other order leaves a window - however
  // short - in which the agent is no longer active but its keys are not yet
  // revoked. The status check would cover it, but relying on that ordering to
  // be safe is a worse guarantee than not needing it.
  const revoked = await ctx.db.apiKeys.revokeForAgent(id, ctx.now);
  await ctx.db.agents.delete(id);

  audit(ctx, _request, "agent.deleted", {
    resourceType: "agent",
    resourceId: id,
    metadata: { name: existing.name, keysRevoked: revoked },
  });
  return json({ deleted: true, keysRevoked: revoked });
}
