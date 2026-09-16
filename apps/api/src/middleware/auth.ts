/**
 * The authorization chain from 06 PART 15.2 / 16.1 - the one path every
 * authenticated request takes, in this exact order:
 *
 *   1. authenticate            who is this?
 *   2. resolveScope            what may they do?
 *   3. resolveTargetWorkspace  which workspace?  (from the key, never the client)
 *   4. authorize               is this operation, on this path, within scope?
 *   5. checkQuota              is the workspace within its limits?
 *   6. handler                 business logic, already scoped
 *
 * The handler signature is the point of the whole file: a handler receives an
 * AuthContext and never an Env. It has no way to reach a raw D1 binding, so it
 * cannot construct an unscoped query even by mistake - the structural
 * guarantee 16.1 asks for, rather than a rule people have to remember.
 */

import { ApiError, forbidden, unauthorized, validationError } from "../lib/errors";
import { limitsFor, type PlanLimits } from "../lib/plans";
import { assertWithinQuota, type QuotaDemand } from "../lib/quota";
import { createWorkspaceContext, type WorkspaceContext } from "../db/workspace-scoped";
import { WorkspaceScopedStorage, type SigningSource } from "../storage/workspace-scoped";
import {
  findWorkspaceById,
  shouldTouchLastUsed,
  touchLastUsed,
  type WorkspaceWithPlan,
} from "../db/api-key-lookup";
import {
  authenticateApiKey,
  assertAgentEnabled,
  authenticateFirebaseUser,
  rejectQueryCredential,
} from "../auth/authenticate";
import { assertScope, type KeyScope, type ScopeOp } from "../auth/scopes";
import { revokeSessionsBefore } from "../db/user-lookup";
import { findOrgForWorkspace } from "../billing/organizations";
import { WorkspaceMembers } from "../db/members";
import type { JwksCache } from "../auth/firebase";
import { extractBearerToken, isApiKeyToken } from "../lib/keys";
import type { Identity } from "../auth/identity";

export interface AuthContext {
  requestId: string;
  now: number;
  identity: Identity;
  scope: KeyScope;
  workspaceId: string;
  workspace: WorkspaceWithPlan;
  limits: PlanLimits;
  /** Repositories bound to this workspace. The only database access a handler gets. */
  db: WorkspaceContext;
  /**
   * Object storage bound to this workspace, for the same reason as `db`: a raw
   * R2 binding reaches every tenant's bytes, so handlers never see one.
   */
  storage: WorkspaceScopedStorage;
  /**
   * Who may act in this workspace. Bound the same way as `db` and `storage`,
   * because membership spans the workspace and the billing account above it and
   * so cannot come from the workspace-scoped repositories.
   */
  members: WorkspaceMembers;
  /**
   * Somewhere to put work that must outlive the response — the audit write and
   * webhook fan-out. Optional because the middleware is also driven directly
   * from tests, where there is no ExecutionContext to hand.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * The jobs queue, for work a customer's slow endpoint must not be able to
   * hold up. Optional for the same reason as `waitUntil`.
   */
  queue?: Queue;
  /**
   * The few actions that are about the signed-in person rather than the
   * workspace. Same discipline as `db` and `storage`: the user ID is bound
   * here, not passed as an argument, so a handler has no way to name somebody
   * else's account. Null for an API key - an agent has no "self" to act on.
   */
  self: SelfActions | null;
}

export interface SelfActions {
  userId: string;
  /** Invalidate every ID token issued to this user before now (30.4). */
  revokeSessions(): Promise<void>;
}

export interface Requirement {
  /**
   * The scope op this route needs, or null for routes that need a valid
   * credential but no particular capability (GET /v1/whoami).
   */
  op: ScopeOp | null;
  /** A client-supplied path this route acts on, already normalized. */
  path?: string;
  /** What this route is about to consume, if it is quota-relevant. */
  demand?: QuotaDemand;
}

/**
 * Handlers take the request as well as the context because most of them need a
 * body or a query string. They still never take an Env - the context is the
 * only route to data, and everything on it is already workspace-bound.
 */
export type Handler = (ctx: AuthContext, request: Request) => Promise<Response>;

/**
 * Step 3. For an API key the workspace comes off the key row, full stop.
 *
 * A client may still *name* a workspace - some SDKs put it in the URL for
 * readability. If they do, it must match; a mismatch is a 403 rather than a
 * silent substitution, because a caller that believes it is writing to another
 * workspace needs to be told it is not.
 */
export function assertRequestedWorkspaceMatches(url: URL, workspaceId: string): void {
  const requested = url.searchParams.get("workspaceId");
  if (requested !== null && requested !== workspaceId) {
    throw forbidden("This credential is not scoped to that workspace.");
  }
}

async function resolveWorkspace(
  db: D1Database,
  workspaceId: string
): Promise<WorkspaceWithPlan> {
  const workspace = await findWorkspaceById(db, workspaceId);
  if (workspace === null) {
    // The key row survived its workspace. Not a client error - fail closed and
    // make it visible rather than serving a request against a dangling ID.
    throw new ApiError("FORBIDDEN", "This workspace is unavailable.", {
      internalReason: `key resolved to missing workspace ${workspaceId}`,
    });
  }
  if (workspace.status !== "active") {
    // Distinguishable from an auth failure on purpose: the caller holds a valid
    // credential, so telling them their workspace is suspended is information
    // they are entitled to and can act on.
    throw forbidden(`This workspace is ${workspace.status}.`);
  }
  return workspace;
}

export interface WithAuthDeps {
  db: D1Database;
  files: R2Bucket;
  /**
   * Null when this deployment has no R2 signing credentials; presigning then
   * refuses. A thunk defers reading them to the routes that presign, so a
   * misconfiguration cannot fail routes that never touch R2.
   */
  signing: SigningSource;
  requestId: string;
  now?: number;
  /** Somewhere to put the last_used_at write so it stays off the response path. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** The jobs queue, passed through to handlers that fan out webhooks. */
  queue?: Queue;
  /**
   * What the human path needs: somewhere to cache Google's JWKS, and the
   * Firebase project whose tokens this deployment accepts. Null when
   * FIREBASE_PROJECT_ID is unset, and then a non-key bearer token is refused
   * rather than verified against nothing - the same fail-closed shape as a
   * missing Turnstile secret.
   */
  firebase: { cache: JwksCache; projectId: string } | null;
}

/**
 * Step 1 + 3 for a human. A person's credential names no workspace - they
 * belong to an organization and may act in any of its workspaces - so the
 * caller has to say which, and membership decides whether they may.
 */
async function authenticateHuman(
  token: string,
  url: URL,
  deps: WithAuthDeps,
  now: number
): Promise<Identity> {
  if (deps.firebase === null) {
    throw unauthorized("no FIREBASE_PROJECT_ID configured; user tokens cannot be verified");
  }
  const workspaceId = url.searchParams.get("workspaceId");
  if (workspaceId === null || workspaceId === "") {
    // A validation error rather than a 401: the credential is fine, the request
    // is incomplete, and saying so is not an oracle about anyone's data.
    throw validationError(
      "workspaceId is required when authenticating as a user. An API key carries " +
        "its own workspace; a user session does not."
    );
  }
  return authenticateFirebaseUser(
    token,
    { db: deps.db, cache: deps.firebase.cache, projectId: deps.firebase.projectId, now },
    workspaceId
  );
}

export async function withAuth(
  request: Request,
  deps: WithAuthDeps,
  requirement: Requirement,
  handler: Handler
): Promise<Response> {
  const now = deps.now ?? Date.now();
  const url = new URL(request.url);

  // Before anything else, including reading the header. A credential in the URL
  // is already burned - in Cloudflare's access logs and the caller's shell
  // history - and only a loud, specific failure gets it rotated. Answering the
  // generic 401 first would bury that.
  rejectQueryCredential(url);

  // 1 + 2. Identity and its scope arrive together, whichever credential it is:
  // an API key's capabilities are on the key row, a person's follow from their
  // role. Neither needs a separate scope lookup that could be got wrong.
  //
  // The two are told apart by shape, not by which header they arrived in. An
  // AgentDisk key has a fixed prefix; anything else is offered to the Firebase
  // verifier, which rejects it unless it is a genuine ID token for this exact
  // project.
  const presented = extractBearerToken(request);
  if (presented === null) {
    throw unauthorized("no bearer token in the Authorization header");
  }

  let identity: Identity;
  if (isApiKeyToken(presented)) {
    const keyIdentity = await authenticateApiKey(request, deps.db, now);
    await assertAgentEnabled(deps.db, keyIdentity);
    // 3. For a key the workspace comes off the key row, full stop.
    assertRequestedWorkspaceMatches(url, keyIdentity.workspaceId);
    identity = keyIdentity;
  } else {
    // 3 happens inside, because for a person the workspace and the membership
    // check that authorizes it are one question.
    identity = await authenticateHuman(presented, url, deps, now);
  }

  const scope = identity.scope;
  const workspace = await resolveWorkspace(deps.db, identity.workspaceId);

  // 4.
  if (requirement.op !== null) {
    assertScope(scope, requirement.op, requirement.path);
  }

  // 5. Quota, and the account's standing with us (14 PART 29.4). The billing
  // row is only read for a request that intends to write - a read-only call
  // must not pay for a join it cannot be refused by.
  const limits = limitsFor(workspace.plan_override, workspace.org_plan);
  const demand = requirement.demand ?? {};
  const intendsWrite =
    (demand.bytes !== undefined && demand.bytes > 0) ||
    (demand.files !== undefined && demand.files > 0);
  const billingStatus = intendsWrite
    ? ((await findOrgForWorkspace(deps.db, identity.workspaceId))?.billingStatus ?? "active")
    : "active";
  assertWithinQuota(workspace, limits, demand, now, billingStatus);

  // Record that the key worked - after authorization, so a rejected request
  // does not update it, and off the response path, because this is a D1 write
  // and the caller has no reason to wait for it.
  if (
    identity.kind === "api_key" &&
    shouldTouchLastUsed({ last_used_at: identity.lastUsedAt }, now)
  ) {
    const write = touchLastUsed(deps.db, identity.keyId, now).catch((err: unknown) => {
      console.log(
        JSON.stringify({
          level: "warn",
          requestId: deps.requestId,
          message: "last_used_at refresh failed",
          reason: err instanceof Error ? err.message : String(err),
        })
      );
    });
    if (deps.waitUntil) deps.waitUntil(write);
    else await write;
  }

  const ctx: AuthContext = {
    requestId: deps.requestId,
    now,
    identity,
    scope,
    workspaceId: identity.workspaceId,
    workspace,
    limits,
    db: createWorkspaceContext(deps.db, identity.workspaceId),
    storage: new WorkspaceScopedStorage(deps.files, deps.signing, identity.workspaceId),
    members: new WorkspaceMembers(deps.db, identity.workspaceId),
    waitUntil: deps.waitUntil,
    queue: deps.queue,
    self:
      identity.kind === "firebase_user"
        ? {
            userId: identity.userId,
            revokeSessions: () => revokeSessionsBefore(deps.db, identity.userId, now),
          }
        : null,
  };

  // 6.
  return handler(ctx, request);
}

export { shouldTouchLastUsed, touchLastUsed };
