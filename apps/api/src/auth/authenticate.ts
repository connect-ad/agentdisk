/**
 * Step 1 of the chain in 06 PART 16.1: resolve a request to an identity.
 *
 * Every failure in here returns the same UNAUTHORIZED body. An unknown key, a
 * revoked key, an expired key, a key whose agent was disabled and a key with a
 * corrupt scopes blob are indistinguishable to the caller. That is deliberate:
 * distinguishable failures turn this endpoint into an oracle that tells an
 * attacker which of their guesses is a real key that merely expired.
 */

import { forbidden, unauthorized, validationError } from "../lib/errors";
import {
  extractBearerToken,
  hasCredentialInQuery,
  hashApiKey,
  isApiKeyToken,
  keyMode,
  timingSafeEqual,
} from "../lib/keys";
import { findApiKeyByHash } from "../db/api-key-lookup";
import {
  findMembershipForWorkspace,
  findUserByFirebaseUid,
  linkFirebaseUidToEmail,
  provisionUser,
  adoptVerifiedEmail,
  type UserRow,
} from "../db/user-lookup";
import { parseScopes, ScopeParseError } from "./scopes";
import { verifyFirebaseToken, type FirebaseClaims, type JwksCache } from "./firebase";
import { isMemberRole, scopeForRole } from "./roles";
import type { ApiKeyIdentity, FirebaseUserIdentity } from "./identity";

/**
 * Reject a credential that arrived in the URL.
 *
 * 06 PART 16.4 says keys are never accepted in a query string. Ignoring it
 * would satisfy that to the letter, but the key is already in Cloudflare's
 * access logs and the caller's shell history by the time we see it - it is
 * burned either way, and only a loud failure gets it rotated.
 */
export function rejectQueryCredential(url: URL): void {
  if (hasCredentialInQuery(url)) {
    throw validationError(
      "Credentials must be sent in the Authorization header, never in the URL. " +
        "Treat the key you just sent as compromised and rotate it."
    );
  }
}

export async function authenticateApiKey(
  request: Request,
  db: D1Database,
  now: number
): Promise<ApiKeyIdentity> {
  const url = new URL(request.url);
  rejectQueryCredential(url);

  const token = extractBearerToken(request);
  if (token === null) {
    throw unauthorized("no bearer token in the Authorization header");
  }
  if (!isApiKeyToken(token)) {
    throw unauthorized("bearer token is not an API key");
  }

  const presentedHash = await hashApiKey(token);
  const row = await findApiKeyByHash(db, presentedHash);
  if (row === null) {
    throw unauthorized("no key matches that hash");
  }

  // Defense in depth: the lookup was an equality match on a unique index, so
  // this can only fail if D1 returned a row we did not ask for. Cheap to keep.
  if (!timingSafeEqual(row.key_hash, presentedHash)) {
    throw unauthorized("hash mismatch after lookup");
  }

  if (row.revoked_at !== null) {
    throw unauthorized(`key ${row.id} is revoked`);
  }
  if (row.expires_at !== null && row.expires_at <= now) {
    throw unauthorized(`key ${row.id} expired`);
  }

  let scope;
  try {
    scope = parseScopes(row.scopes);
  } catch (err) {
    if (err instanceof ScopeParseError) {
      // Fail closed. A key whose scopes we cannot read grants nothing at all,
      // rather than falling back to some default that would be a silent grant.
      throw unauthorized(`key ${row.id} has unreadable scopes: ${err.message}`);
    }
    throw err;
  }

  const mode = keyMode(token);
  if (mode === null) {
    throw unauthorized("key prefix is neither live nor test");
  }

  return {
    kind: "api_key",
    keyId: row.id,
    mode,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    createdByUserId: row.created_by_user_id,
    keyPrefix: row.key_prefix,
    keyLastFour: row.key_last_four,
    scope,
    actorType: row.agent_id === null ? "user" : "agent",
    actorId: row.agent_id ?? row.created_by_user_id,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * A key belonging to a disabled agent must stop working.
 *
 * This is checked at authentication rather than relying on the future
 * "disable agent" handler to also revoke every one of that agent's keys. Both
 * would work; only this one is still correct if that handler is ever written
 * with the revoke step missing. It costs one indexed read on a workspace-scoped
 * table, and only for agent-issued keys.
 */
export async function assertAgentEnabled(
  db: D1Database,
  identity: ApiKeyIdentity
): Promise<void> {
  if (identity.agentId === null) return;

  const agent = await db
    .prepare(`SELECT status FROM agents WHERE id = ? AND workspace_id = ?`)
    .bind(identity.agentId, identity.workspaceId)
    .first<{ status: string }>();

  if (agent === null) {
    throw unauthorized(`key ${identity.keyId} references a missing agent`);
  }
  if (agent.status !== "active") {
    throw unauthorized(`agent ${identity.agentId} is ${agent.status}`);
  }
}

/**
 * The human half of step 1: a Firebase ID token resolved to an AgentDisk user.
 *
 * Unlike an API key, this credential carries no workspace - a person belongs to
 * an organization and may act in any of its workspaces - so the caller names
 * one and we check membership. That check is what makes step 3 of the chain
 * safe for humans: `workspaceId` still ends up on the identity, and a handler
 * still cannot reach past it.
 */
export interface FirebaseDeps {
  db: D1Database;
  cache: JwksCache;
  projectId: string;
  now: number;
}

/**
 * Verify a token and resolve it to a user, with no workspace involved.
 *
 * Split out because two routes genuinely have no workspace to be scoped to:
 * creating the caller's first (or next) workspace, and listing the ones they
 * can reach. Everything else goes through `authenticateFirebaseUser`, which
 * adds the membership check - so this is deliberately not exported as a
 * shortcut past that, and the two callers below are the whole set.
 */
export async function resolveVerifiedUser(
  token: string,
  deps: FirebaseDeps
): Promise<{ user: UserRow; claims: FirebaseClaims }> {
  const claims = await verifyFirebaseToken(token, {
    cache: deps.cache,
    projectId: deps.projectId,
    now: deps.now,
  });

  const user = await resolveUser(deps.db, claims, deps.now);

  // "Log out everywhere" (30.4). Checked here rather than inside the verifier
  // because it is the one claim check that needs the database, and because a
  // token can be cryptographically perfect and still be one we refuse.
  if (claims.issuedAtMs <= user.session_revoked_after) {
    throw unauthorized(`token predates session_revoked_after for user ${user.id}`);
  }

  return { user, claims };
}

export async function authenticateFirebaseUser(
  token: string,
  deps: FirebaseDeps,
  workspaceId: string
): Promise<FirebaseUserIdentity> {
  const { user, claims } = await resolveVerifiedUser(token, deps);

  const membership = await findMembershipForWorkspace(deps.db, user.id, workspaceId);
  if (membership === null) {
    // Deliberately the same answer whether the workspace does not exist or
    // exists and belongs to somebody else. Distinguishing them turns this into
    // a way to enumerate other tenants' workspace IDs.
    throw forbidden("This workspace is unavailable.");
  }
  if (!isMemberRole(membership.role)) {
    // A role we do not recognise grants nothing, rather than defaulting to the
    // most permissive one we do recognise.
    throw unauthorized(`membership carries unknown role ${membership.role}`);
  }

  return {
    kind: "firebase_user",
    userId: user.id,
    firebaseUid: claims.uid,
    email: user.email,
    emailVerified: user.email_verified_at !== null,
    workspaceId,
    orgId: membership.org_id,
    role: membership.role,
    scope: scopeForRole(membership.role),
    actorType: "user",
    actorId: user.id,
    signInProvider: claims.signInProvider,
  };
}

/**
 * Find the user behind a verified token, or bring them into existence.
 *
 * Three cases, in order of how much they are trusted:
 *   1. We have seen this `firebase_uid` before - the ordinary path.
 *   2. We have not, but a row exists for this email with no uid attached: an
 *      invited colleague signing in for the first time. Claim that row so they
 *      arrive already holding the membership somebody granted them.
 *   3. Neither - a brand new signup.
 *
 * Case 2 only ever matches an *unclaimed* row, and only on an email Firebase
 * has verified. Matching an unverified email would let anyone who can type a
 * colleague's address into a signup form inherit that colleague's memberships.
 */
async function resolveUser(
  db: D1Database,
  claims: Awaited<ReturnType<typeof verifyFirebaseToken>>,
  now: number
): Promise<UserRow> {
  const existing = await findUserByFirebaseUid(db, claims.uid);
  // Adopt the real address the moment Firebase verifies it, so a row
  // provisioned before then stops displaying as a placeholder.
  if (existing !== null) return adoptVerifiedEmail(db, existing, claims, now);

  if (claims.email !== null && claims.emailVerified) {
    const linked = await linkFirebaseUidToEmail(db, claims.email, claims.uid, now);
    if (linked !== null) return linked;
  }

  return provisionUser(db, claims, now);
}
