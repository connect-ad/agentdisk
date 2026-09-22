/**
 * Claiming an unclaimed sandbox workspace.
 *
 *   GET  /v1/workspaces/claim/:token   unauthenticated preview
 *   POST /v1/workspaces/claim/:token   the claim itself, Firebase-authenticated
 *
 * These sit outside `withAuth` for the same structural reason the other
 * workspace-collection routes do: `withAuth` resolves a workspace *from the
 * credential* and binds every repository to it, which is exactly wrong for a
 * route whose subject is which workspace the caller is about to acquire. What
 * they do not skip is authentication - POST goes through the same Firebase
 * verifier as every other human route, and ownership is derived only from that
 * verified session, never from anything in the request body.
 *
 * **The token is the only thing that can name the workspace.** There is no
 * workspace ID in either path. That is what makes the GET safe to serve
 * anonymously: it is the same trust model as a signed download link, and a
 * caller who does not hold the token cannot enumerate, guess, or ask for
 * anything here. It is also why only the token's SHA-256 is stored - a claim
 * link is a bearer secret meaning "become the owner of this workspace", which
 * is at least as strong as an API key, so it is kept the way one is.
 *
 * **Two modes, and the choice is never defaulted.** `new` keeps the sandbox as
 * its own workspace and moves it under the caller's billing account. `attach`
 * merges its contents into a workspace the caller already administers and then
 * destroys the sandbox. They have very different consequences - one adds a
 * workspace, the other spends an existing workspace's quota - so the client
 * must say which, and the landing page presents them with no pre-selection.
 */

import { z } from "zod";
import { ApiError, forbidden, validationError } from "../lib/errors";
import { newId } from "../lib/ids";
import { sha256Hex } from "../lib/keys";
import { SANDBOX_LIMITS, limitsFor } from "../lib/plans";
import { assertWithinQuota } from "../lib/quota";
import { normalizePath, PathValidationError } from "../lib/paths";
import { isSlugConflict, uniqueWorkspaceSlug } from "../lib/slug";
import { UNCLAIMED_TTL_MS, sandboxQuotaWarning } from "../lib/claim";
import { findMembershipForWorkspace, type UserRow } from "../db/user-lookup";
import { findWorkspaceById } from "../db/api-key-lookup";
import { findOrgForWorkspace } from "../billing/organizations";
import { deleteProvisionalOwner, deleteWorkspaceCascade } from "../db/workspace-cascade";
import { parseScopes, serializeScopes } from "../auth/scopes";
import {
  WorkspaceScopedStorage,
  transferObject,
  type SigningSource,
} from "../storage/workspace-scoped";
import type { FileRow } from "../db/types";

/** Matches createWorkspaceForUser's retry budget, for the same race. */
const SLUG_ATTEMPTS = 3;

/**
 * A hard ceiling on how many files one merge will move.
 *
 * Every file is an R2 read plus an R2 write plus two D1 statements, and a
 * Worker has both a wall-clock and a subrequest budget. SANDBOX_LIMITS caps a
 * sandbox at 500 files, so this is at the ceiling a legitimate sandbox can
 * reach - it exists to bound a merge from one of the older, pre-sandbox-limits
 * workspaces (see `isSandboxWorkspace`), not to refuse anything normal.
 */
const MAX_MERGE_FILES = 500;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

interface ClaimableWorkspace {
  id: string;
  org_id: string;
  name: string;
  slug: string | null;
  status: string;
  claimed_at: number | null;
  claim_token_expires_at: number | null;
  storage_bytes_used: number;
  file_count: number;
  created_at: number;
}

/**
 * The workspace a claim token names, or null.
 *
 * By hash, against the unique partial index from 0010 - a single index probe,
 * and structurally incapable of returning two rows.
 */
async function findByClaimToken(
  db: D1Database,
  tokenHash: string
): Promise<ClaimableWorkspace | null> {
  return db
    .prepare(
      `SELECT id, org_id, name, slug, status, claimed_at, claim_token_expires_at,
              storage_bytes_used, file_count, created_at
         FROM workspaces
        WHERE claim_token_hash = ?`
    )
    .bind(tokenHash)
    .first<ClaimableWorkspace>();
}

/**
 * One identical answer for every unusable token.
 *
 * Unknown, malformed and belonging-to-a-deleted-workspace must stay
 * indistinguishable, for the reason the authentication chain gives: a
 * distinguishable failure is an oracle telling whoever is guessing which of
 * their guesses was real. "Already claimed" and "expired" are deliberately
 * *not* folded in here - both are states a legitimate holder of a real token
 * needs explained, and neither tells a guesser anything, because they had to
 * present a valid 40-character token to reach them at all.
 */
function noSuchClaim(): ApiError {
  return new ApiError("NOT_FOUND", "That claim link is not valid.");
}

/** The sandbox's own agent, for the preview and for the merge's naming. */
async function sandboxAgent(
  db: D1Database,
  workspaceId: string
): Promise<{ id: string; name: string } | null> {
  return db
    .prepare(`SELECT id, name FROM agents WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1`)
    .bind(workspaceId)
    .first<{ id: string; name: string }>();
}

/** The provisional user who owned a sandbox, so the cleanup can name them. */
async function provisionalOwnerId(db: D1Database, orgId: string): Promise<string> {
  const row = await db
    .prepare(`SELECT owner_user_id FROM organizations WHERE id = ?`)
    .bind(orgId)
    .first<{ owner_user_id: string }>();
  return row?.owner_user_id ?? "";
}

/**
 * GET /v1/workspaces/claim/:token - what this link is worth, before signing in.
 *
 * A person following a claim link has usually never seen this product before.
 * Asking them to authenticate before telling them what they would be claiming
 * inverts the order of trust: they would be creating an account to find out
 * whether the thing is worth creating an account for.
 */
export async function previewClaim(
  db: D1Database,
  token: string,
  now: number,
  dashboardUrl: string | undefined
): Promise<Response> {
  const workspace = await findByClaimToken(db, await sha256Hex(token));
  if (workspace === null || workspace.status !== "active") throw noSuchClaim();

  // A claimed link is answered exactly as an unknown one is.
  //
  // This used to return ALREADY_CLAIMED, so that somebody re-opening a link
  // from their own agent's log got an explanation rather than a dead 404. The
  // trouble is that this route takes no credential, which makes it the one
  // place in the product where guessing tokens is free - and a distinguishable
  // answer tells a guesser which of their guesses named a real workspace. The
  // authentication chain has answered every failure identically since the
  // beginning; this route was the gap.
  //
  // What replaces the explanation is `claim_attempts`: support can say what
  // happened to a link without the answer being available to everyone.
  if (workspace.claimed_at !== null) throw noSuchClaim();

  const expired =
    workspace.claim_token_expires_at !== null && workspace.claim_token_expires_at <= now;

  const agent = await sandboxAgent(db, workspace.id);
  const deletesAt = workspace.created_at + UNCLAIMED_TTL_MS;

  return json({
    claimed: false,
    claimable: !expired,
    ...(expired ? { reason: "EXPIRED" } : {}),
    workspace: {
      id: workspace.id,
      name: workspace.name,
      fileCount: workspace.file_count,
      storageBytes: workspace.storage_bytes_used,
      createdAt: workspace.created_at,
    },
    agent: agent === null ? null : { name: agent.name },
    limits: {
      storageBytes: SANDBOX_LIMITS.storageBytes,
      files: SANDBOX_LIMITS.fileCount,
      maxFileBytes: SANDBOX_LIMITS.maxFileBytes,
    },
    expiresAt: workspace.claim_token_expires_at,
    deletesAt,
    // The same function the write path calls, given the workspace's *current*
    // usage. One computation of "how full is this, and when does it die",
    // rendered in two places, rather than the page doing its own arithmetic and
    // drifting - which is exactly what backlog/017 records happening before.
    warning: sandboxQuotaWarning({
      workspaceId: workspace.id,
      projected: { bytes: workspace.storage_bytes_used, files: workspace.file_count },
      limits: { storageBytes: SANDBOX_LIMITS.storageBytes, fileCount: SANDBOX_LIMITS.fileCount },
      dashboardUrl,
      deletesAt,
      now,
    }),
  });
}

const claimSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("new") }),
  z.object({
    mode: z.literal("attach"),
    targetWorkspaceId: z.string().min(1, "targetWorkspaceId is required."),
    pathPrefix: z.string().optional(),
  }),
]);

export interface ClaimDeps {
  db: D1Database;
  files: R2Bucket;
  signing: SigningSource;
  requestId: string;
  now: number;
}

/**
 * Take the claim, atomically.
 *
 * The `claimed_at IS NULL` guard lives *inside* the UPDATE rather than in a
 * read before it, and that is what makes a double-click or two racing tabs
 * safe: both statements run, the database serialises them, and the loser
 * matches zero rows. A read-then-write would have both reads see NULL and both
 * writes succeed, which for `attach` would mean merging the same files twice.
 *
 * Returns false when this caller lost the race or the link expired between the
 * advisory checks and here; the caller turns that into the right status.
 */
async function takeClaim(
  db: D1Database,
  workspaceId: string,
  tokenHash: string,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE workspaces
          SET claimed_at = ?, updated_at = ?
        WHERE id = ?
          AND claim_token_hash = ?
          AND claimed_at IS NULL
          AND claim_token_expires_at > ?`
    )
    .bind(now, now, workspaceId, tokenHash, now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Put the claim back, after the work that followed it failed.
 *
 * D1 has no transaction that can span the R2 calls a merge makes, so the claim
 * flag and the merge cannot be atomic with each other. Winning the race first
 * and releasing on failure is the right way round of the two: it means two
 * simultaneous claims can never both proceed, and a failed claim leaves a link
 * that still works. The alternative - merge first, flag second - would let both
 * racers merge.
 *
 * Guarded on `claimed_at = ?` so this can only ever undo *this* caller's claim,
 * never a concurrent one that has since succeeded.
 */
async function releaseClaim(db: D1Database, workspaceId: string, stamp: number): Promise<void> {
  await db
    .prepare(`UPDATE workspaces SET claimed_at = NULL WHERE id = ? AND claimed_at = ?`)
    .bind(workspaceId, stamp)
    .run();
}

/**
 * Record a claim in the audit trail.
 *
 * Written directly rather than through `lib/audit.ts`, because that module
 * takes an `AuthContext` and this route deliberately has none, for the reasons
 * in the file header. The discipline is the same: named, non-sensitive fields
 * only, and never the token.
 */
async function recordClaim(
  db: D1Database,
  workspaceId: string,
  userId: string,
  action: string,
  now: number,
  requestId: string,
  metadata: Record<string, string | number | boolean | null>
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_events
         (id, workspace_id, actor_type, actor_id, action, resource_type, resource_id,
          result, ip, client, request_id, metadata, created_at)
       VALUES (?, ?, 'user', ?, ?, 'workspace', ?, 'success', NULL, NULL, ?, ?, ?)`
    )
    .bind(
      newId("auditEvent", now),
      workspaceId,
      userId,
      action,
      workspaceId,
      requestId,
      JSON.stringify(metadata),
      now
    )
    .run();
}

export async function claimWorkspace(
  request: Request,
  deps: ClaimDeps,
  user: UserRow,
  token: string
): Promise<Response> {
  const { db, now } = deps;

  let parsed;
  try {
    parsed = claimSchema.parse(await request.json());
  } catch (err) {
    throw validationError(
      err instanceof z.ZodError
        ? (err.issues[0]?.message ??
            'Send {"mode":"new"} or {"mode":"attach","targetWorkspaceId":"ws_..."}.')
        : 'Send a JSON body: {"mode":"new"} or {"mode":"attach","targetWorkspaceId":"ws_..."}.'
    );
  }

  const tokenHash = await sha256Hex(token);
  const workspace = await findByClaimToken(db, tokenHash);
  if (workspace === null || workspace.status !== "active") throw noSuchClaim();

  // These two produce the message a person actually needs. They are advisory:
  // the statement below is what decides, and it re-checks both conditions.
  if (workspace.claimed_at !== null) {
    throw new ApiError("CONFLICT", "This workspace has already been claimed.");
  }
  if (workspace.claim_token_expires_at !== null && workspace.claim_token_expires_at <= now) {
    throw new ApiError("CONFLICT", "This claim link has expired.", {
      details: { expiredAt: workspace.claim_token_expires_at },
    });
  }

  if (!(await takeClaim(db, workspace.id, tokenHash, now))) {
    throw new ApiError("CONFLICT", "This workspace has already been claimed.");
  }

  try {
    return parsed.mode === "new"
      ? await claimAsNewWorkspace(deps, user, workspace)
      : await claimByAttaching(deps, user, workspace, parsed.targetWorkspaceId, parsed.pathPrefix);
  } catch (err) {
    await releaseClaim(db, workspace.id, now);
    throw err;
  }
}

/**
 * mode "new" - keep the workspace, move it under the caller's account.
 *
 * No file ever moves. The workspace keeps its own ID, and an R2 key is
 * `tenant/{workspaceId}/{fileId}`, so every object is already in the right
 * place by construction - this is a change of ownership, not of location.
 *
 * Reparenting onto the caller's *existing* organization, rather than leaving
 * the freshly-minted provisional one in place, is what keeps "one real user,
 * one owned org" true. `createWorkspaceForUser` reads `SELECT id FROM
 * organizations WHERE owner_user_id = ?` and takes the single row; leaving a
 * claimer owning two orgs would make that query's answer arbitrary, and a
 * workspace they created afterwards could land under either.
 */
async function claimAsNewWorkspace(
  deps: ClaimDeps,
  user: UserRow,
  workspace: ClaimableWorkspace
): Promise<Response> {
  const { db, now, requestId } = deps;

  const org = await db
    .prepare(`SELECT id FROM organizations WHERE owner_user_id = ?`)
    .bind(user.id)
    .first<{ id: string }>();

  if (org === null) {
    // Somebody invited into other people's workspaces, who owns no billing
    // account of their own. There is nothing to reparent onto, and leaving them
    // on the provisional org would hand them a second, invisible account.
    throw forbidden(
      "Only an account owner can claim a workspace into a new one. Ask your account owner " +
        "to claim it, or use \"attach\" to merge it into a workspace you administer."
    );
  }

  const provisionalOrgId = workspace.org_id;
  const provisionalUserId = await provisionalOwnerId(db, provisionalOrgId);

  // The slug was unique inside a one-workspace org that is about to disappear.
  // In the caller's org it may collide, so it is re-picked exactly the way
  // createWorkspaceForUser picks one, including the retry the index forces.
  for (let attempt = 1; ; attempt++) {
    const slug = await uniqueWorkspaceSlug(db, org.id, workspace.name);
    try {
      await db
        .prepare(`UPDATE workspaces SET org_id = ?, slug = ?, updated_at = ? WHERE id = ?`)
        .bind(org.id, slug, now, workspace.id)
        .run();
      break;
    } catch (err) {
      if (attempt >= SLUG_ATTEMPTS || !isSlugConflict(err)) throw err;
    }
  }

  // The agent and its key stay exactly as they are - same key ID, same hash,
  // same raw token the agent is already holding - so the agent's next call
  // works with no re-authentication. Only the `created_by_user_id` pointers
  // move, because the provisional user they name is about to be deleted.
  await db
    .prepare(`UPDATE agents SET created_by_user_id = ? WHERE workspace_id = ?`)
    .bind(user.id, workspace.id)
    .run();
  await db
    .prepare(`UPDATE api_keys SET created_by_user_id = ? WHERE workspace_id = ?`)
    .bind(user.id, workspace.id)
    .run();

  // Only now that nothing points at them. Both deletes are conditional in SQL,
  // so if anything still references either row, they simply stay.
  await deleteProvisionalOwner(db, provisionalOrgId, provisionalUserId);

  await recordClaim(db, workspace.id, user.id, "workspace.claimed", now, requestId, {
    mode: "new",
    files: workspace.file_count,
    bytes: workspace.storage_bytes_used,
  });

  const claimed = await db
    .prepare(`SELECT slug FROM workspaces WHERE id = ?`)
    .bind(workspace.id)
    .first<{ slug: string | null }>();

  return json({
    claimed: true,
    mode: "new",
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: claimed?.slug ?? null,
      role: "owner",
      fileCount: workspace.file_count,
      storageBytes: workspace.storage_bytes_used,
    },
  });
}

/**
 * A name for the merged agent that the target workspace does not already use.
 *
 * `agents` is UNIQUE(workspace_id, name), so a collision is a hard failure
 * rather than a cosmetic one. Suffixing matches what `uniqueWorkspaceSlug` does
 * for the same problem, and what people expect from every other product that
 * renames on conflict.
 */
async function uniqueAgentName(
  db: D1Database,
  workspaceId: string,
  desired: string
): Promise<string> {
  const rows = await db
    .prepare(`SELECT name FROM agents WHERE workspace_id = ?`)
    .bind(workspaceId)
    .all<{ name: string }>();
  const taken = new Set((rows.results ?? []).map(row => row.name));
  if (!taken.has(desired)) return desired;
  for (let n = 2; n <= taken.size + 2; n++) {
    const candidate = `${desired}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${desired}-${taken.size + 3}`;
}

/**
 * mode "attach" - merge the sandbox into a workspace the caller administers,
 * then destroy it.
 *
 * The genuinely hard mode, and the one place in this codebase where two tenants
 * are open at once. Both sides are constructed as ordinary workspace-bound
 * contexts and the crossing happens only inside `transferObject`, whose
 * signature takes two already-bound instances and no workspace ID at all.
 */
async function claimByAttaching(
  deps: ClaimDeps,
  user: UserRow,
  sandbox: ClaimableWorkspace,
  targetWorkspaceId: string,
  pathPrefixOverride: string | undefined
): Promise<Response> {
  const { db, files, signing, now, requestId } = deps;

  if (targetWorkspaceId === sandbox.id) {
    throw validationError("A workspace cannot be merged into itself.");
  }

  // Authorization, before anything about the target is read. Owner or admin
  // only: the merge spends the target's storage quota, and a reader must not be
  // able to fill up a workspace somebody else pays for.
  const membership = await findMembershipForWorkspace(db, user.id, targetWorkspaceId);
  if (membership === null || (membership.role !== "owner" && membership.role !== "admin")) {
    // One answer for "no such workspace" and "not yours", matching
    // deleteWorkspaceForUser: distinguishing them confirms that another
    // account's workspace ID is real.
    throw new ApiError("NOT_FOUND", "No such workspace.");
  }

  const target = await findWorkspaceById(db, targetWorkspaceId);
  if (target === null || target.status !== "active") {
    throw new ApiError("NOT_FOUND", "No such workspace.");
  }

  const sourceFiles = await db
    .prepare(
      `SELECT * FROM files
        WHERE workspace_id = ? AND status = 'active'
        ORDER BY created_at ASC
        LIMIT ?`
    )
    .bind(sandbox.id, MAX_MERGE_FILES + 1)
    .all<FileRow>();

  const rows = sourceFiles.results ?? [];
  if (rows.length > MAX_MERGE_FILES) {
    throw new ApiError("LIMIT_EXCEEDED", "This workspace holds too many files to merge at once.", {
      details: { limit: "files", max: MAX_MERGE_FILES },
    });
  }

  const totalBytes = rows.reduce((sum, row) => sum + row.size_bytes, 0);
  const billing = await findOrgForWorkspace(db, targetWorkspaceId);

  // **All or nothing.** The whole merge is checked against the target's quota
  // before a single byte moves, using the same function every upload uses. A
  // merge that took whatever happened to fit and reported success would be a
  // false success of exactly the kind backlog/023 catalogues - and unlike a
  // refused upload, the files it silently dropped would already have been
  // deleted from the only other place they existed.
  assertWithinQuota(
    target,
    limitsFor(target.org_plan_override, target.org_plan),
    { bytes: totalBytes, files: rows.length },
    now,
    billing?.billingStatus ?? "active"
  );

  const agent = await sandboxAgent(db, sandbox.id);
  const desiredAgentName = agent?.name ?? "sandbox-agent";
  const finalAgentName = await uniqueAgentName(db, targetWorkspaceId, desiredAgentName);

  // The merged files land under a folder named for the agent, which is this
  // product's own folder-as-namespace convention - so a merge cannot collide
  // with the target's existing paths (files is UNIQUE(workspace_id, path)) and
  // a person can see at a glance which files arrived this way.
  let namespace: string;
  try {
    namespace = normalizePath(pathPrefixOverride ?? `/agents/${finalAgentName}`);
  } catch (err) {
    if (err instanceof PathValidationError) throw validationError(err.message);
    throw err;
  }
  const prefix = namespace === "/" ? "" : namespace.replace(/\/+$/, "");

  // A fresh agent row in the target. The sandbox's own row cannot survive - it
  // is bound to a workspace that is about to be deleted, and both
  // api_keys.agent_id and files.created_by point at it.
  const newAgentId = newId("agent", now);
  await db
    .prepare(
      `INSERT INTO agents (id, workspace_id, name, description, status, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`
    )
    .bind(
      newAgentId,
      targetWorkspaceId,
      finalAgentName,
      `Merged from sandbox workspace ${sandbox.id}`,
      user.id,
      now
    )
    .run();

  // Two bound contexts, opened explicitly. Neither can name the other's tenant.
  const sourceStorage = new WorkspaceScopedStorage(files, signing, sandbox.id);
  const targetStorage = new WorkspaceScopedStorage(files, signing, targetWorkspaceId);

  const moved: { id: string; path: string; sizeBytes: number }[] = [];

  for (const row of rows) {
    const newFileId = newId("file", now);
    const newPath = `${prefix}${row.path}`;

    // Copy, then row, then delete. The destination object exists before the
    // source stops existing, and the destination row before the source row is
    // removed - so at every instant in between, the file is findable from at
    // least one of the two workspaces.
    await transferObject(sourceStorage, row.id, targetStorage, newFileId);

    await db
      .prepare(
        `INSERT INTO files
           (id, workspace_id, folder_id, name, path, r2_object_key, size_bytes, mime_type,
            checksum_sha256, caption, custom_metadata, status, created_by, created_at,
            updated_at, deleted_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`
      )
      .bind(
        newFileId,
        targetWorkspaceId,
        row.name,
        newPath,
        targetStorage.objectKeyFor(newFileId),
        row.size_bytes,
        row.mime_type,
        row.checksum_sha256,
        row.caption,
        row.custom_metadata,
        // The *agent* stays the author, not the person who clicked claim. This
        // product's FileCell component exists specifically to keep "an agent put
        // this here" visible, and rewriting provenance at merge time would erase
        // the one fact it is there to show.
        newAgentId,
        row.created_at,
        now
      )
      .run();

    await db.prepare(`DELETE FROM file_tags WHERE file_id = ?`).bind(row.id).run();
    await db.prepare(`DELETE FROM files WHERE id = ?`).bind(row.id).run();
    await sourceStorage.delete(row.id);

    moved.push({ id: newFileId, path: newPath, sizeBytes: row.size_bytes });
  }

  // Inline, in this operation - not left for the next reconcileCounters sweep.
  // An hour of a target under-reporting its own usage is an hour in which it
  // can be pushed past its real limit by writes the quota check waves through
  // on numbers it believes.
  //
  // Both levels, batched, for the reason WorkspaceScopedCounters gives: the
  // account row is the one the quota is decided from, so leaving it behind
  // would mean the merge's bytes were invisible to every subsequent write.
  // The source workspace's own counters are not decremented here because its
  // rows were deleted outright above and the whole sandbox - workspace, org
  // and all - is destroyed by the caller moments later.
  await db.batch([
    db
      .prepare(
        `UPDATE workspaces
            SET storage_bytes_used = storage_bytes_used + ?,
                file_count = file_count + ?,
                updated_at = ?
          WHERE id = ?`
      )
      .bind(totalBytes, moved.length, now, targetWorkspaceId),

    db
      .prepare(
        `UPDATE organizations
            SET storage_bytes_used = storage_bytes_used + ?,
                file_count = file_count + ?,
                updated_at = ?
          WHERE id = (SELECT org_id FROM workspaces WHERE id = ?)`
      )
      .bind(totalBytes, moved.length, now, targetWorkspaceId),
  ]);

  // **The same key row, repointed.** Same id, same key_hash, same raw token the
  // agent already holds - so its very next call lands in the target workspace
  // with no re-authentication and nothing to invalidate, because there is no
  // cache in front of key resolution (middleware/auth.ts reads D1 fresh on
  // every request). Revoking and reissuing would have worked too, and would
  // have broken every running agent at the moment its owner claimed it.
  const keyRows = await db
    .prepare(`SELECT id, scopes FROM api_keys WHERE workspace_id = ? ORDER BY created_at ASC`)
    .bind(sandbox.id)
    .all<{ id: string; scopes: string }>();

  let keysRepointed = 0;
  for (const key of keyRows.results ?? []) {
    const scope = parseScopes(key.scopes);
    // The key's authority is narrowed to the namespace its files landed in. It
    // arrived scoped to a whole sandbox; it must not inherit a whole real
    // workspace, where other agents' files live.
    const rescoped = serializeScopes({ ...scope, pathPrefix: namespace });
    await db
      .prepare(
        `UPDATE api_keys SET workspace_id = ?, agent_id = ?, scopes = ?, created_by_user_id = ?
          WHERE id = ?`
      )
      .bind(targetWorkspaceId, newAgentId, rescoped, user.id, key.id)
      .run();
    keysRepointed += 1;
  }

  // The sandbox is empty now: its files are rows in the target and its keys
  // point elsewhere. What is left is the shell, its provisional org and its
  // placeholder user.
  const provisionalOrgId = sandbox.org_id;
  const provisionalUserId = await provisionalOwnerId(db, provisionalOrgId);
  await deleteWorkspaceCascade(db, files, sandbox.id);
  await deleteProvisionalOwner(db, provisionalOrgId, provisionalUserId);

  await recordClaim(db, targetWorkspaceId, user.id, "agent.claimed_and_merged", now, requestId, {
    sourceWorkspaceId: sandbox.id,
    agentName: finalAgentName,
    filesMoved: moved.length,
    bytesMoved: totalBytes,
  });

  return json({
    claimed: true,
    mode: "attach",
    workspace: {
      id: targetWorkspaceId,
      name: target.name,
      slug: target.slug,
      role: membership.role,
      storageBytes: target.storage_bytes_used + totalBytes,
      fileCount: target.file_count + moved.length,
    },
    agent: {
      id: newAgentId,
      name: finalAgentName,
      // Named explicitly because it is what the agent's existing key is now
      // scoped to, and the agent needs to know where its files went.
      pathPrefix: namespace,
      renamed: finalAgentName !== desiredAgentName,
      keysRepointed,
    },
    files: {
      moved: moved.length,
      bytes: totalBytes,
      items: moved,
    },
    sourceWorkspaceId: sandbox.id,
  });
}
