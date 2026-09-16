/**
 * Sandbox workspace provisioning - the write half of POST /v1/workspaces.
 *
 * 06 PART 15.1 adopts the self-provisioning pattern for exactly one credential:
 * the *initial* sandbox key an agent gets when it creates a trial workspace.
 * Every other agent credential requires an authenticated human action to mint,
 * so this file must not become a general key factory.
 *
 * All five rows go in one D1 batch. D1 wraps a batch in an implicit
 * transaction, so a half-provisioned workspace - an org with no workspace, a
 * key pointing at nothing - cannot exist.
 */

import { generateApiKey } from "../lib/keys";
import { newId } from "../lib/ids";
import { FALLBACK_SLUG, slugify } from "../lib/slug";
import { serializeScopes, type KeyScope } from "../auth/scopes";

/** How long a sandbox workspace's usage period runs before it rolls over. */
const PERIOD_LENGTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What the first key can do: everything inside its own workspace, and nothing
 * about keys.
 *
 * `keys:create` is deliberately absent. Sub-key minting from an unclaimed
 * sandbox key would be privilege delegation with no human anywhere in the loop;
 * once a real user claims the workspace they can mint whatever they want.
 */
export const SANDBOX_KEY_SCOPE: KeyScope = {
  ops: ["read", "write", "delete", "list"],
  pathPrefix: "",
};

export interface ProvisionRequest {
  workspaceName: string;
  agentName: string;
  now: number;
}

export interface ProvisionResult {
  orgId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  keyId: string;
  /** Returned to the caller once, then unrecoverable. Never persisted. */
  token: string;
  keyPrefix: string;
  keyLastFour: string;
}

export async function provisionSandboxWorkspace(
  db: D1Database,
  request: ProvisionRequest
): Promise<ProvisionResult> {
  const { workspaceName, agentName, now } = request;

  const userId = newId("user", now);
  const orgId = newId("organization", now);
  const workspaceId = newId("workspace", now);
  const agentId = newId("agent", now);
  const keyId = newId("apiKey", now);

  const key = await generateApiKey("live");

  // users.email is NOT NULL UNIQUE, so the placeholder owner needs one. The
  // .invalid TLD is reserved by RFC 2606 precisely so it can never resolve or
  // receive mail - nothing here can accidentally become a deliverable address.
  const placeholderEmail = `unclaimed-${userId}@agentdisk.invalid`;

  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, email, is_provisional, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`
      )
      .bind(userId, placeholderEmail, now, now),

    db
      .prepare(
        `INSERT INTO organizations (id, name, owner_user_id, plan, created_at, updated_at)
         VALUES (?, ?, ?, 'free', ?, ?)`
      )
      .bind(orgId, workspaceName, userId, now, now),

    db
      .prepare(
        `INSERT INTO workspaces
           (id, org_id, name, slug, status, period_reset_at, claimed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?)`
      )
      // The organization two statements above is brand new, so this workspace
      // is alone in it and no uniqueness query is needed. The fallback covers a
      // sandbox name that slugifies to nothing at all.
      .bind(
        workspaceId,
        orgId,
        workspaceName,
        slugify(workspaceName) || FALLBACK_SLUG,
        now + PERIOD_LENGTH_MS,
        now,
        now
      ),

    db
      .prepare(
        `INSERT INTO agents (id, workspace_id, name, status, created_by_user_id, created_at)
         VALUES (?, ?, ?, 'active', ?, ?)`
      )
      .bind(agentId, workspaceId, agentName, userId, now),

    db
      .prepare(
        `INSERT INTO api_keys
           (id, workspace_id, agent_id, name, key_prefix, key_last_four, key_hash,
            scopes, created_by_user_id, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
      )
      .bind(
        keyId,
        workspaceId,
        agentId,
        "Initial sandbox key",
        key.keyPrefix,
        key.keyLastFour,
        key.keyHash,
        serializeScopes(SANDBOX_KEY_SCOPE),
        userId,
        now
      ),
  ]);

  return {
    orgId,
    userId,
    workspaceId,
    agentId,
    keyId,
    token: key.token,
    keyPrefix: key.keyPrefix,
    keyLastFour: key.keyLastFour,
  };
}
