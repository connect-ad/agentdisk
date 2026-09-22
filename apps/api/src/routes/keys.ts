/**
 * API keys — 05 PART 13, 06 PART 15.3.
 *
 * The credential an agent actually holds. Three rules shape this file, and each
 * one is a decision rather than a detail:
 *
 * **The secret is kept, sealed, and opened only for its owner.** This rule
 * used to read "returned exactly once" — only the SHA-256 was stored, so a
 * database disclosure yielded hashes. Since migration 0022 the token is also
 * stored under DATABASE_ENCRYPTION_KEY (lib/secretbox.ts), so the owner can
 * view it again from the keys table; `revealKey` at the bottom of this file
 * is the one reader and its header lists what it refuses. Authentication is
 * still by hash alone — the ciphertext is never on the request path.
 *
 * **A key can never be minted with more than the minter holds.** A scoped key
 * that could create an unscoped one would make scoping decorative: hand an
 * agent a read-only key and it mints itself a writer. `isSubsetScope` enforces
 * that, and it is why `keys:create` is a scope op in its own right.
 *
 * **A key is switched off and on, and enabling rotates it.** This rule used to
 * read "revocation is immediate and irreversible", and the reasoning behind it
 * survives the change: bringing a credential back *unchanged* is never the
 * safe answer to having switched it off. So `PATCH` to `disabled` stops the
 * token at the next request, and `PATCH` back to `active` issues a **new**
 * secret under the same row — same id, name, scope, agent and history, a
 * different credential. The token that was live at the moment of disable never
 * works again. `DELETE` removes the row outright; the admin console keeps a
 * separate permanent revoke that a customer cannot clear.
 */

import { z } from "zod";
import { ApiError, forbidden, validationError } from "../lib/errors";
import { newId } from "../lib/ids";
import { generateApiKey, TEST_PREFIX, type KeyMode } from "../lib/keys";
import { isSubsetScope, SCOPE_OPS, type KeyScope, type ScopeOp } from "../auth/scopes";
import { normalizePrefix } from "../auth/scopes";
import type { AuthContext } from "../middleware/auth";
import type { ApiKeyRow } from "../db/types";
import { audit } from "../lib/audit";
import { openSecret, sealSecret } from "../lib/secretbox";

const createSchema = z.object({
  name: z.string().trim().min(1, "A key needs a name.").max(64),
  /** Which agent this key acts as. Omitted means a workspace-level key. */
  agentId: z.string().trim().min(1).optional(),
  ops: z
    .array(z.enum(SCOPE_OPS as unknown as [ScopeOp, ...ScopeOp[]]))
    .min(1, "A key with no operations could not do anything."),
  pathPrefix: z.string().trim().max(256).optional(),
  /** Test keys exist so a staging agent cannot touch live data by accident. */
  mode: z.enum(["live", "test"]).optional(),
  /** Unix ms. Absent means no expiry. */
  expiresAt: z.number().int().positive().optional(),
});

/**
 * The only thing a customer may change about an existing key.
 *
 * Not the name, scope or agent: those are what the audit trail means when it
 * names this key, and letting them move would make an old event describe a
 * credential that no longer matches it.
 */
const patchSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * What a key looks like once the secret is gone.
 *
 * `keyPrefix` and `keyLastFour` are all that a person gets to recognise a key
 * by, which is the whole reason 15.3 stores them separately — enough to tell
 * two keys apart in a list, not enough to reconstruct either.
 */
/**
 * Whether this key will authenticate, not merely whether its own row is intact.
 *
 * `blocked` exists because the two questions came apart. A key whose agent is
 * disabled has `revoked_at` NULL and no expiry, so on the row alone it looks
 * perfectly alive — while `assertAgentEnabled` refuses it on every request. The
 * dashboard showed such a key as Active, which is the worst possible answer:
 * somebody disables an agent to stop it, sees its credentials still listed as
 * live, and cannot tell whether the disable worked.
 *
 * Order matters. Revoked and expired are permanent and belong to the key
 * itself, so they outrank a `blocked` that lifts the moment the agent is
 * re-enabled — a revoked key must never soften to "blocked" and read as
 * recoverable.
 *
 * `agentStatus` is undefined when the workspace's agent list did not contain
 * this key's agent. That is treated as blocked rather than active, matching
 * authentication, which rejects a key referencing an agent it cannot find.
 */
function keyStatus(
  row: ApiKeyRow,
  now: number,
  agentStatus: string | undefined
): "revoked" | "expired" | "disabled" | "active" {
  if (row.revoked_at !== null) return "revoked";
  if (row.expires_at !== null && row.expires_at <= now) return "expired";
  // Both ways of being off report `disabled`, because to the person holding
  // the token they are the same fact: it does not work. `disabledBy` below
  // says which, since only one of them is theirs to undo here.
  if (row.disabled_at !== null) return "disabled";
  // The agent's switch cascades onto the rows (migration 0025), so this is
  // belt and braces rather than the mechanism. It still earns its place: if a
  // cascade ever half-finished, authentication would refuse the key while
  // this said "active", which is the disagreement between the list and the
  // authenticator that `blocked` was introduced to end.
  if (row.agent_id !== null && agentStatus !== "active") return "disabled";
  return "active";
}

/**
 * Which switch is off, or null when none is.
 *
 * `blocked` used to be its own status for the agent case and the dashboard
 * showed "Agent disabled". Collapsing the two into one status keeps the answer
 * to "does this key work" in one field, and this keeps the answer to "what do
 * I do about it" in another - enabling a key whose *agent* is off would appear
 * to succeed and change nothing.
 *
 * The key's own switch wins when both are set: it is the one the customer
 * turned, and re-enabling the agent must not quietly switch a key back on that
 * they deliberately turned off.
 */
function disabledBy(
  row: ApiKeyRow,
  agentStatus: string | undefined
): "key" | "agent" | null {
  if (row.disabled_at !== null) return row.disabled_reason ?? "key";
  if (row.agent_id !== null && agentStatus !== "active") return "agent";
  return null;
}

function toResource(row: ApiKeyRow, now: number, agentStatus?: string) {
  let scope: KeyScope | null = null;
  try {
    scope = JSON.parse(row.scopes) as KeyScope;
  } catch {
    scope = null;
  }
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    prefix: row.key_prefix,
    lastFour: row.key_last_four,
    scopes: scope,
    status: keyStatus(row, now, agentStatus),
    /** "key" or "agent" when off, null when not. See `disabledBy`. */
    disabledBy: disabledBy(row, agentStatus),
    // Whether GET /v1/keys/:id/secret can answer at all. False for every key
    // minted before keys were kept (migration 0022); the dashboard disables
    // the eye for those rather than letting somebody click into a 409.
    retrievable: row.key_ciphertext !== null,
    createdBy: row.created_by_user_id,
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function listKeys(ctx: AuthContext): Promise<Response> {
  const [keys, agents] = await Promise.all([ctx.db.apiKeys.list(), ctx.db.agents.list()]);

  // One extra workspace-scoped read rather than a join, because `status` is the
  // only column wanted and the agent count per workspace is small. Building the
  // map once keeps this O(keys + agents) instead of a lookup per key.
  const agentStatus = new Map(agents.map(a => [a.id, a.status]));

  return json({
    keys: keys.map(row =>
      toResource(row, ctx.now, row.agent_id === null ? undefined : agentStatus.get(row.agent_id))
    ),
  });
}

export async function createKey(ctx: AuthContext, request: Request): Promise<Response> {
  let body;
  try {
    body = createSchema.parse(await request.json());
  } catch (err) {
    throw validationError(
      err instanceof z.ZodError
        ? (err.issues[0]?.message ?? "That request body is not valid.")
        : "Send a JSON body."
    );
  }

  const requested: KeyScope = {
    ops: body.ops,
    pathPrefix: normalizePrefix(body.pathPrefix ?? ""),
  };

  // The rule that makes scoping mean anything. Without it, a read-only key
  // holding keys:create could mint itself a writer and the ceiling would be
  // decorative.
  if (!isSubsetScope(requested, ctx.scope)) {
    throw forbidden("A key cannot be given more access than the credential creating it holds.");
  }

  if (body.agentId !== undefined) {
    const agent = await ctx.db.agents.getById(body.agentId);
    if (agent === null) throw new ApiError("NOT_FOUND", "No such agent.");
    if (agent.status !== "active") {
      // The key would be born unusable - authentication rejects a disabled
      // agent's keys - so refuse rather than hand over a credential that
      // silently never works.
      throw validationError("That agent is disabled. Enable it before minting a key for it.");
    }
  }

  if (body.expiresAt !== undefined && body.expiresAt <= ctx.now) {
    throw validationError("That expiry is already in the past.");
  }

  const mode: KeyMode = body.mode === "test" ? "test" : "live";
  const generated = await generateApiKey(mode);
  const id = newId("apiKey", ctx.now);

  const row: ApiKeyRow = {
    id,
    workspace_id: ctx.workspaceId,
    agent_id: body.agentId ?? null,
    name: body.name,
    key_prefix: generated.keyPrefix,
    key_last_four: generated.keyLastFour,
    key_hash: generated.keyHash,
    disabled_at: null,
    disabled_reason: null,
    // Kept, sealed, bound to this row's id, so the owner can view it again
    // (migration 0022). Null when the deployment has no secret to seal under -
    // then this key is shown once below and never again, as every key was.
    key_ciphertext:
      ctx.encryptionKey === null ? null : await sealSecret(ctx.encryptionKey, generated.token, id),
    scopes: JSON.stringify(requested),
    created_by_user_id:
      ctx.identity.kind === "firebase_user"
        ? ctx.identity.userId
        : ctx.identity.createdByUserId,
    // A key minted by another key records its parent, so a compromised
    // credential's descendants can be found rather than guessed at.
    parent_key_id: ctx.identity.kind === "api_key" ? ctx.identity.keyId : null,
    expires_at: body.expiresAt ?? null,
    last_used_at: null,
    revoked_at: null,
    created_at: ctx.now,
  };

  await ctx.db.apiKeys.insert(row);

  // Minting a credential is the single most consequential thing anybody does
  // in this product, so it is recorded with the scope it was given - the
  // prefix identifies which key, and never the secret.
  audit(ctx, request, "key.created", {
    resourceType: "api_key",
    resourceId: row.id,
    metadata: {
      name: row.name,
      prefix: row.key_prefix,
      ops: requested.ops.join(","),
      pathPrefix: requested.pathPrefix,
      agentId: row.agent_id,
    },
  });

  return json(
    {
      // "active" rather than a lookup: minting against a disabled agent was
      // refused above, so by here the agent is known to be active. Omitting it
      // would make every agent-bound key report `blocked` in the one response
      // that also carries its secret.
      key: toResource(row, ctx.now, row.agent_id === null ? undefined : "active"),
      secret: generated.token,
      // Whether the owner can ask for it again (GET /v1/keys/:id/secret).
      // This used to be `secretShownOnce: true`; a client that stored the
      // object wholesale was meant to notice what it wrote to disk. Now it
      // says the opposite thing about the same value.
      secretRetrievable: row.key_ciphertext !== null,
    },
    201
  );
}

/**
 * PATCH /v1/keys/:id — switch a key off, or back on with a new secret.
 *
 * Disabling stops the token on the very next request. Enabling **rotates**:
 * the row keeps its id, name, scope, agent and history, and gets a new
 * credential. That is the whole reason this is safe to offer where revoke used
 * to be the only answer — a key switched off because its token leaked does not
 * come back with the leaked token.
 *
 * The rotation means this is a minting act, not an edit, so it needs
 * `keys:create` like `createKey`, and the new secret is returned exactly the
 * way a new key's is.
 */
export async function patchKey(
  ctx: AuthContext,
  request: Request,
  id: string
): Promise<Response> {
  let body;
  try {
    body = patchSchema.parse(await request.json());
  } catch (err) {
    throw validationError(
      err instanceof z.ZodError
        ? (err.issues[0]?.message ?? "That request body is not valid.")
        : "Send a JSON body."
    );
  }

  const existing = await ctx.db.apiKeys.getById(id);
  if (existing === null) throw new ApiError("NOT_FOUND", "No such key.");

  // An operator's revoke is not the customer's to clear, and an expired key
  // cannot be un-expired. Refusing both here keeps `enableWithRotation` from
  // minting a credential onto a row that still would not authenticate.
  if (existing.revoked_at !== null) {
    throw new ApiError("CONFLICT", "That key was revoked by support and cannot be switched back on.");
  }

  if (body.status === "disabled") {
    const changed = await ctx.db.apiKeys.disable(id, ctx.now);
    if (changed) {
      audit(ctx, request, "key.disabled", {
        resourceType: "api_key",
        resourceId: id,
        metadata: { name: existing.name, prefix: existing.key_prefix },
      });
    }
    // Idempotent: a retry after a dropped response is the caller's intent
    // already satisfied, not a problem to report.
    const row = await ctx.db.apiKeys.getById(id);
    return json({ key: toResource(row ?? existing, ctx.now, await agentStatusOf(ctx, existing)) });
  }

  if (existing.expires_at !== null && existing.expires_at <= ctx.now) {
    throw new ApiError("CONFLICT", "That key has expired. Create a new one rather than enabling this.");
  }
  // A key whose agent is off cannot be switched on from here. Rotating it
  // would hand back a new secret that authentication refuses on sight, which
  // is a success message for something that did not work.
  const agentStatus = await agentStatusOf(ctx, existing);
  if (existing.agent_id !== null && agentStatus !== "active") {
    throw new ApiError(
      "CONFLICT",
      "That key's agent is disabled. Enable the agent, which switches its keys back on."
    );
  }
  if (existing.disabled_at === null) {
    // Already on. Nothing to rotate - and rotating anyway would silently break
    // whatever is using the key right now, on a request that asked for no
    // change at all.
    return json({ key: toResource(existing, ctx.now, await agentStatusOf(ctx, existing)) });
  }

  const mode: KeyMode = existing.key_prefix.startsWith(TEST_PREFIX) ? "test" : "live";
  const generated = await generateApiKey(mode);
  const ciphertext =
    ctx.encryptionKey === null ? null : await sealSecret(ctx.encryptionKey, generated.token, id);

  const enabled = await ctx.db.apiKeys.enableWithRotation(id, generated, ciphertext);
  if (!enabled) throw new ApiError("CONFLICT", "That key was changed by somebody else. Reload and try again.");

  audit(ctx, request, "key.rotated", {
    resourceType: "api_key",
    resourceId: id,
    metadata: { name: existing.name, prefix: generated.keyPrefix, previousPrefix: existing.key_prefix },
  });

  const row = await ctx.db.apiKeys.getById(id);
  return json({
    key: toResource(row ?? existing, ctx.now, agentStatus),
    secret: generated.token,
    secretRetrievable: ciphertext !== null,
    // Said plainly, because the caller's old token is now dead and anything
    // still holding it will start failing authentication.
    rotated: true,
  });
}

/** The key's agent's status, or undefined for a workspace-level key. */
async function agentStatusOf(ctx: AuthContext, row: ApiKeyRow): Promise<string | undefined> {
  if (row.agent_id === null) return undefined;
  const agent = await ctx.db.agents.getById(row.agent_id);
  return agent?.status;
}

/**
 * DELETE /v1/keys/:id — remove the key.
 *
 * This used to revoke, leaving the row in the list forever as a credential
 * nobody could use or clear. Delete means gone, the same as an agent and a
 * workspace; switching a key off is what `PATCH` is for now, and it is the
 * reversible option this one deliberately is not.
 */
export async function deleteKey(
  ctx: AuthContext,
  request: Request,
  id: string
): Promise<Response> {
  const existing = await ctx.db.apiKeys.getById(id);
  if (existing === null) throw new ApiError("NOT_FOUND", "No such key.");

  const deleted = await ctx.db.apiKeys.hardDelete(id);
  if (deleted) {
    audit(ctx, request, "key.deleted", {
      resourceType: "api_key",
      resourceId: id,
      metadata: { name: existing.name, prefix: existing.key_prefix },
    });
  }
  return json({ deleted });
}

/**
 * GET /v1/keys/:id/secret — the key itself, for its owner.
 *
 * Until migration 0022 this route could not exist: a key was stored only as
 * a hash, and "you won't see it again" was the whole of the protection. Keys
 * are kept now, sealed under DATABASE_ENCRYPTION_KEY, so the owner can view
 * one from the keys table and drop it into the MCP config. What replaces the
 * old protection is the set of refusals below, and each is there for a
 * reason:
 *
 *  - **Not an API key.** A key that can read other keys is a key that can
 *    escalate: a read-only credential would mint nothing, but it could copy
 *    the writer sitting beside it.
 *  - **Owner only.** A reader sees the workspace's files already; a reader
 *    who can read a write-scoped key can write. The middleware refuses first
 *    (a reader's scope lacks keys:create); this check is the one that holds if
 *    that requirement is ever loosened.
 *  - **Not revoked.** A revoked key does not work, and a route that hands out
 *    dead credentials teaches people to try them.
 *  - **Never kept, never shown.** Keys minted before 0022 have no ciphertext.
 *    409 rather than 404: the key exists, it is the secret that does not.
 *  - **Audited, every time.** `key.revealed` with who and which. Viewing a
 *    credential is an act, and the log is where an owner finds out that
 *    somebody else on the account has been doing it.
 *
 * A ciphertext that will not open is a 500, not a 4xx: it means the secret the
 * Worker runs with is not the one the row was sealed under, and nothing the
 * caller does can change that.
 */
export async function revealKey(
  ctx: AuthContext,
  request: Request,
  keyId: string
): Promise<Response> {
  if (ctx.identity.kind !== "firebase_user") {
    throw forbidden("Only a signed-in workspace owner can view a key.");
  }
  if (ctx.identity.role !== "owner") {
    throw forbidden("Only the workspace owner can view a key.");
  }

  const row = await ctx.db.apiKeys.getById(keyId);
  if (row === null) throw new ApiError("NOT_FOUND", "No such key.");
  if (row.revoked_at !== null) {
    throw new ApiError(
      "CONFLICT",
      "That key is revoked. A revoked key cannot be shown or reactivated; mint a new one."
    );
  }
  if (row.key_ciphertext === null || ctx.encryptionKey === null) {
    throw new ApiError(
      "CONFLICT",
      "This key was minted before keys were kept, so it cannot be shown. Mint a new one."
    );
  }

  const secret = await openSecret(ctx.encryptionKey, row.key_ciphertext, row.id);
  if (secret === null) {
    throw new Error(`api key ${row.id} is sealed under a different secret, or its ciphertext changed`);
  }

  audit(ctx, request, "key.revealed", {
    resourceType: "api_key",
    resourceId: row.id,
    metadata: { name: row.name, prefix: row.key_prefix },
  });

  return json({ secret });
}
