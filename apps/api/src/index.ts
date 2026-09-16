/**
 * AgentDisk API Worker.
 *
 * Routing is hand-written rather than a framework: the surface is small, every
 * path is one of two shapes, and a router library would be more code than the
 * thing it routes. What it does NOT do is pattern-match on strings - the path
 * is split into segments once and matched structurally, so a route can never
 * be reached by a URL that merely looks similar.
 */

import { toErrorResponse, ApiError } from "./lib/errors";
import { newId } from "./lib/ids";
import { withAuth, type Requirement, type Handler } from "./middleware/auth";
import { whoami } from "./routes/whoami";
import { logoutAll } from "./routes/logout-all";
import { createWorkspace } from "./routes/create-workspace";
import {
  createWorkspaceForUser,
  deleteWorkspaceForUser,
  listWorkspaces,
} from "./routes/workspaces";
import { createAgent, deleteAgent, getAgent, listAgents, patchAgent } from "./routes/agents";
import { createKey, listKeys, revokeKey } from "./routes/keys";
import { handleMcp } from "./mcp/server";
import { purgeExpiredFiles, reconcileCounters } from "./jobs/purge";
import { handleDelivery, isWebhookEvent } from "./jobs/webhook-delivery";
import { listActivity } from "./routes/activity";
import {
  staffCreate,
  staffForceLogout,
  staffGetWorkspace,
  staffListWorkspaces,
  staffLogin,
  staffLogout,
  staffOverview,
  staffRevokeKeys,
  staffSetWorkspaceStatus,
  staffWhoami,
  staffWorkspaceActivity,
} from "./routes/staff";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  patchWebhook,
} from "./routes/webhooks";
import { createPortalSession, getBilling } from "./routes/billing";
import { handleStripeWebhook } from "./routes/stripe-webhook";
import {
  changeMemberRole,
  inviteMember,
  listWorkspaceMembers,
  removeWorkspaceMember,
} from "./routes/members";
import { resolveVerifiedUser } from "./auth/authenticate";
import { extractBearerToken, isApiKeyToken } from "./lib/keys";
import { unauthorized } from "./lib/errors";
import {
  completeFile,
  createFile,
  deleteFile,
  downloadFile,
  getFile,
  listFiles,
  patchFile,
  restoreFile,
  searchFiles,
} from "./routes/files";
import {
  copyFile,
  createFolder,
  deleteFolder,
  listFolders,
  moveFile,
} from "./routes/folders";
import { readSigningConfig, type R2SigningConfig } from "./storage/presign";
import { preflightResponse, withCorsHeaders } from "./lib/cors";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  CACHE: KVNamespace;
  JOBS: Queue;
  ENVIRONMENT: string;
  /**
   * Turnstile's server-side secret, pushed by CI via `wrangler secret put`.
   * Absent means POST /v1/workspaces refuses to run rather than running ungated.
   */
  TURNSTILE_SECRET_KEY?: string;
  /** Optional comma-separated hostname pinning for the Turnstile response. */
  TURNSTILE_ALLOWED_HOSTNAMES?: string;

  /**
   * R2 S3-endpoint identifiers, injected from `terraform output -json`. Not
   * secrets: they name the endpoint presigned URLs are signed against.
   */
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  /**
   * The S3 key pair that actually signs those URLs, pushed by CI via
   * `wrangler secret put`. The FILES binding cannot presign - R2Bucket has no
   * such method - so presigning needs a credential the binding does not carry.
   */
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  /**
   * The Firebase project whose ID tokens this deployment accepts (16 PART 30.2).
   * Public configuration, not a secret - verification uses Google's public
   * JWKS - but environment-scoped, because dev and prod are two separate
   * Firebase projects and a token from one must not authenticate against the
   * other. Absent means user tokens are refused; API keys are unaffected.
   */
  FIREBASE_PROJECT_ID?: string;

  /**
   * Origins allowed to call this API from a browser, comma-separated and
   * including the scheme. Public configuration, per environment, so the dev API
   * cannot be driven from the prod dashboard or the other way round.
   */
  CORS_ALLOWED_ORIGINS?: string;

  /**
   * Stripe, pushed by CI via `wrangler secret put`. Absent means billing
   * refuses rather than running half-configured - the same fail-closed shape as
   * a missing Turnstile secret.
   */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Where Stripe's hosted portal returns the customer. Public configuration. */
  DASHBOARD_URL?: string;

  /**
   * Encrypts staff TOTP secrets at rest (06 PART 16.16a). Staff login refuses
   * to run without it, because an unverifiable second factor is not one.
   */
  DATABASE_ENCRYPTION_KEY?: string;
}

export interface HealthReport {
  status: "ok";
  environment: string;
  commit: string;
  timestamp: string;
}

/** Build the health payload. Pure, so it is unit-testable without a Worker runtime. */
export function buildHealth(env: Pick<Env, "ENVIRONMENT">, now: Date): HealthReport {
  return {
    status: "ok",
    environment: env.ENVIRONMENT ?? "unknown",
    commit: (globalThis as { __COMMIT_SHA__?: string }).__COMMIT_SHA__ ?? "dev",
    timestamp: now.toISOString(),
  };
}

/** A handler for a route that names one file in its URL. */
type FileHandler = (
  ctx: Parameters<Handler>[0],
  request: Request,
  fileId: string
) => Promise<Response>;

/**
 * Read the R2 signing credentials, or explain why there are none.
 *
 * Null (nothing configured) is a supported state - dev runs that way until the
 * signing token exists, and the presign path refuses cleanly. A HALF-configured
 * deployment is not: that is a mistake, and it becomes a 500 naming the missing
 * variables in the log rather than a confusing signature failure later.
 */
function signingConfig(env: Env): R2SigningConfig | null {
  try {
    return readSigningConfig(env);
  } catch (err) {
    throw new ApiError("INTERNAL_ERROR", "Something went wrong on our end.", {
      internalReason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The Firebase half of the same idea, and simpler because there is only one
 * value: either this deployment knows which project's tokens it accepts, or it
 * refuses user tokens outright. There is no half-configured state to detect.
 */
function firebaseConfig(env: Env): { cache: KVNamespace; projectId: string } | null {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (projectId === undefined || projectId === "") return null;
  return { cache: env.CACHE, projectId };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * One ID per request, echoed in every error body and every log line, so a user
 * reporting "I got a 403" hands us the string that finds the exact request.
 */
function requestId(): string {
  return newId("request");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const id = requestId();

    // Before everything, including authentication. A preflight carries no
    // Authorization header - the browser has not sent the real request yet - so
    // any credential check here would reject every cross-origin call there is.
    if (request.method === "OPTIONS") {
      return preflightResponse(request, env);
    }

    // The routing body, lifted so that every exit - a handler's response and
    // an error envelope alike - leaves through the same CORS wrapper below.
    const respond = async (): Promise<Response> => {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;

      // Public. No credential is read, so nothing here can leak one.
      if (route === "GET /v1/healthz") {
        return json(buildHealth(env, new Date()));
      }

      const authed = (requirement: Requirement, handler: Handler): Promise<Response> =>
        withAuth(
          request,
          {
            db: env.DB,
            files: env.FILES,
            signing: () => signingConfig(env),
            requestId: id,
            waitUntil: (promise) => ctx.waitUntil(promise),
            queue: env.JOBS,
            firebase: firebaseConfig(env),
          },
          requirement,
          handler
        );

      // One path, two callers, told apart by whether a credential was offered.
      //
      // Unauthenticated it is the Turnstile-gated sandbox: an agent
      // provisioning itself a trial workspace, which is the product's own
      // agent-first onboarding (05 PART 4.3) and is why the route accepts no
      // credential at all. Its gates - a per-IP rate limit and Turnstile - live
      // inside that handler.
      //
      // Authenticated it is a person adding a workspace to the billing account
      // they already own. Keeping both on one path rather than inventing a
      // second means a client that later gains a credential does not have to
      // learn a different URL for the same noun.
      if (url.pathname === "/v1/workspaces" && (request.method === "POST" || request.method === "GET")) {
        const token = extractBearerToken(request);

        if (token === null || isApiKeyToken(token)) {
          // POST with no credential at all is the one genuinely public shape on
          // this path — the sandbox above. Everything else here needs a person.
          if (request.method === "POST" && token === null) {
            return await createWorkspace(request, {
              db: env.DB,
              kv: env.CACHE,
              turnstileSecret: env.TURNSTILE_SECRET_KEY,
              allowedHostnames: env.TURNSTILE_ALLOWED_HOSTNAMES,
            });
          }
          // An API key is deliberately not accepted here: an agent key is
          // scoped to one workspace and must not be able to mint siblings or
          // enumerate the account's others.
          if (token !== null) throw unauthorized("api keys cannot act on the workspace collection");
          // GET with no credential. A 401, not the 404 this used to return:
          // the route exists, and "you did not authenticate" is the same
          // condition an unusable token reports, so it gets the same status.
          // A 404 here sent people hunting for a typo in the URL, and made
          // this the one authenticated route in the API that disagreed with
          // every other about what an absent credential means.
          throw unauthorized("no bearer token in the Authorization header");
        }

        const firebase = firebaseConfig(env);
        if (firebase === null) {
          throw unauthorized("no FIREBASE_PROJECT_ID configured; user tokens cannot be verified");
        }
        const now = Date.now();
        const { user } = await resolveVerifiedUser(token, {
          db: env.DB,
          cache: firebase.cache,
          projectId: firebase.projectId,
          now,
        });

        return request.method === "GET"
          ? await listWorkspaces(env.DB, user)
          : await createWorkspaceForUser(request, env.DB, user, now);
      }

      // DELETE /v1/workspaces/:id. Its own block rather than a branch of the
      // one above, because it is the only workspace route with a path segment -
      // and because an API key must not reach it at all. Falling through to the
      // shared `authed()` chain would be wrong twice over: that chain resolves
      // the workspace from the credential, which is circular for a route whose
      // subject is the workspace itself, and it accepts API keys.
      {
        const match = /^\/v1\/workspaces\/([^/]+)$/.exec(url.pathname);
        if (match !== null && request.method === "DELETE") {
          const token = extractBearerToken(request);
          if (token === null) throw unauthorized("no bearer token in the Authorization header");
          if (isApiKeyToken(token)) {
            // An agent key must never be able to destroy the workspace it was
            // issued to work inside.
            throw unauthorized("api keys cannot delete workspaces");
          }
          const firebase = firebaseConfig(env);
          if (firebase === null) {
            throw unauthorized("no FIREBASE_PROJECT_ID configured; user tokens cannot be verified");
          }
          const now = Date.now();
          const { user } = await resolveVerifiedUser(token, {
            db: env.DB,
            cache: firebase.cache,
            projectId: firebase.projectId,
            now,
          });
          return await deleteWorkspaceForUser(
            request,
            env.DB,
            env.FILES,
            user,
            decodeURIComponent(match[1] as string),
            now
          );
        }
      }

      // 30.4. A user ending their own sessions; refused for an API key, which
      // must never acquire authority over the person who issued it.
      if (route === "POST /v1/me/logout-all") {
        return await authed({ op: null }, logoutAll);
      }

      // Search. `list` rather than `read`: a key that may not enumerate must
      // not be able to enumerate one query at a time.
      if (route === "GET /v1/search") {
        return await authed({ op: "list" }, searchFiles);
      }

      if (route === "GET /v1/whoami") {
        // Any valid credential; no particular capability. 13's table says "Self".
        return await authed({ op: null }, whoami);
      }

      const segments = url.pathname.split("/").filter((segment) => segment !== "");

      // Staff. A separate table, a separate token shape and a separate code
      // path from every customer route above - so there is no path along which
      // a customer credential could be evaluated against staff logic, or the
      // reverse. This is the one place StaffScopedAccess is reachable.
      if (segments[0] === "v1" && segments[1] === "staff") {
        const staffDeps = {
          db: env.DB,
          kv: env.CACHE,
          encryptionKey: env.DATABASE_ENCRYPTION_KEY,
          requestId: id,
          now: Date.now(),
        };

        const [, , area, resourceId, action] = segments;

        if (area === "login" && request.method === "POST") {
          return await staffLogin(request, staffDeps);
        }
        if (area === "logout" && request.method === "POST") {
          return await staffLogout(request, staffDeps);
        }
        if (area === "whoami" && request.method === "GET") {
          return await staffWhoami(request, staffDeps);
        }
        if (area === "overview" && request.method === "GET") {
          return await staffOverview(request, staffDeps);
        }
        if (area === "users" && request.method === "POST" && resourceId === undefined) {
          return await staffCreate(request, staffDeps);
        }

        if (area === "workspaces") {
          if (resourceId === undefined && request.method === "GET") {
            return await staffListWorkspaces(request, staffDeps);
          }
          if (resourceId !== undefined && action === undefined && request.method === "GET") {
            return await staffGetWorkspace(request, staffDeps, resourceId);
          }
          if (resourceId !== undefined && action === "activity" && request.method === "GET") {
            return await staffWorkspaceActivity(request, staffDeps, resourceId);
          }
          if (resourceId !== undefined && action === "status" && request.method === "POST") {
            return await staffSetWorkspaceStatus(request, staffDeps, resourceId);
          }
        }

        if (area === "users" && resourceId !== undefined) {
          if (action === "force-logout" && request.method === "POST") {
            return await staffForceLogout(request, staffDeps, resourceId);
          }
          if (action === "revoke-keys" && request.method === "POST") {
            return await staffRevokeKeys(request, staffDeps, resourceId);
          }
        }

        throw new ApiError("NOT_FOUND", "No such route.");
      }


      // The customer's own webhook endpoints. `/v1/webhooks/stripe` is checked
      // first, below, because it is the one path under this prefix that is
      // Stripe calling us rather than us listing their endpoints.
      if (
        segments[0] === "v1" &&
        segments[1] === "webhooks" &&
        segments[2] !== "stripe"
      ) {
        const webhookId = segments[2];
        if (webhookId === undefined) {
          if (request.method === "GET") return await authed({ op: "list" }, listWebhooks);
          if (request.method === "POST") return await authed({ op: "write" }, createWebhook);
          throw new ApiError("NOT_FOUND", "No such route.");
        }
        if (segments[3] !== undefined) throw new ApiError("NOT_FOUND", "No such route.");

        if (request.method === "PATCH") {
          return await authed({ op: "write" }, (authCtx, req) =>
            patchWebhook(authCtx, req, webhookId)
          );
        }
        if (request.method === "DELETE") {
          return await authed({ op: "write" }, (authCtx, req) =>
            deleteWebhook(authCtx, req, webhookId)
          );
        }
        throw new ApiError("NOT_FOUND", "No such route.");
      }

      // Stripe's webhook. Public by necessity - Stripe holds no credential of
      // ours - and authenticated instead by the signature over the raw body,
      // which is checked before a single field is read.
      if (route === "POST /v1/webhooks/stripe") {
        return await handleStripeWebhook(request, {
          db: env.DB,
          secretKey: env.STRIPE_SECRET_KEY,
          webhookSecret: env.STRIPE_WEBHOOK_SECRET,
          now: Date.now(),
        });
      }

      // MCP, on the same Worker as REST (14.2). Agents connect here with the
      // same API key they would use for REST, and every tool runs behind the
      // same authorization chain - which is the point: two surfaces that share
      // one implementation cannot disagree about what they allow.
      if (url.pathname === "/mcp" || url.pathname === "/v1/mcp") {
        return await handleMcp(request, {
          db: env.DB,
          files: env.FILES,
          signing: () => signingConfig(env),
          requestId: id,
          waitUntil: (promise) => ctx.waitUntil(promise),
          firebase: null,
        });
      }

      // The audit trail. Read-only by design - a log a client can post to is
      // not a log. `list` because reading the workspace's history is the same
      // capability as enumerating its contents.
      if (route === "GET /v1/activity") {
        return await authed({ op: "list" }, listActivity);
      }

      if (segments[0] === "v1" && segments[1] === "billing") {
        const billingDeps = {
          db: env.DB,
          secretKey: env.STRIPE_SECRET_KEY,
          returnUrl: `${env.DASHBOARD_URL ?? "https://app-dev.agentdisk.io"}/app`,
        };
        if (segments[2] === undefined && request.method === "GET") {
          return await authed({ op: null }, (authCtx) => getBilling(authCtx, billingDeps));
        }
        if (segments[2] === "portal-session" && request.method === "POST") {
          return await authed({ op: null }, (authCtx) =>
            createPortalSession(authCtx, billingDeps)
          );
        }
        throw new ApiError("NOT_FOUND", "No such route.");
      }

      // Members. Every one of these is owner-only, enforced inside the handlers
      // rather than by a scope op: an agent key holds no role at all, so there
      // is nothing for a scope to express. The chain still runs in full - a
      // member of another workspace cannot reach this one's roster.
      if (segments[0] === "v1" && segments[1] === "members") {
        const membershipId = segments[2];
        if (membershipId === undefined) {
          if (request.method === "GET") return await authed({ op: null }, listWorkspaceMembers);
          if (request.method === "POST") return await authed({ op: null }, inviteMember);
          throw new ApiError("NOT_FOUND", "No such route.");
        }
        if (segments[3] !== undefined) throw new ApiError("NOT_FOUND", "No such route.");

        if (request.method === "PATCH") {
          return await authed({ op: null }, (authCtx, req) =>
            changeMemberRole(authCtx, req, membershipId)
          );
        }
        if (request.method === "DELETE") {
          return await authed({ op: null }, (authCtx, req) =>
            removeWorkspaceMember(authCtx, req, membershipId)
          );
        }
        throw new ApiError("NOT_FOUND", "No such route.");
      }

      // Agents. Listing and reading need `read`; anything that changes one
      // needs `write`, because an agent is the thing a credential acts as and
      // renaming or disabling it changes what other credentials can do.
      if (segments[0] === "v1" && segments[1] === "agents") {
        const agentId = segments[2];
        if (agentId === undefined) {
          if (request.method === "GET") return await authed({ op: "list" }, listAgents);
          if (request.method === "POST") return await authed({ op: "write" }, createAgent);
          throw new ApiError("NOT_FOUND", "No such route.");
        }
        if (segments[3] !== undefined) throw new ApiError("NOT_FOUND", "No such route.");

        const onAgent = (requirement: Requirement, handler: FileHandler): Promise<Response> =>
          authed(requirement, (authCtx, req) => handler(authCtx, req, agentId));

        if (request.method === "GET") return await onAgent({ op: "read" }, getAgent);
        if (request.method === "PATCH") return await onAgent({ op: "write" }, patchAgent);
        if (request.method === "DELETE") return await onAgent({ op: "delete" }, deleteAgent);
        throw new ApiError("NOT_FOUND", "No such route.");
      }

      // Keys. Minting has its own scope op rather than reusing `write`: the
      // authority to create a credential is categorically different from the
      // authority to write a file, and a key that can do the latter must not
      // silently be able to do the former.
      if (segments[0] === "v1" && segments[1] === "keys") {
        const keyId = segments[2];
        if (keyId === undefined) {
          if (request.method === "GET") return await authed({ op: "list" }, listKeys);
          if (request.method === "POST") return await authed({ op: "keys:create" }, createKey);
          throw new ApiError("NOT_FOUND", "No such route.");
        }
        if (segments[3] !== undefined) throw new ApiError("NOT_FOUND", "No such route.");
        if (request.method === "DELETE") {
          return await authed({ op: "keys:create" }, (authCtx, req) =>
            revokeKey(authCtx, req, keyId)
          );
        }
        throw new ApiError("NOT_FOUND", "No such route.");
      }

      // Everything below is /v1/files. Segments, not string prefixes: matching
      // on `pathname.startsWith("/v1/files")` would also match "/v1/filesX".
      if (segments[0] === "v1" && segments[1] === "files") {
        const fileId = segments[2];
        const action = segments[3];

        if (fileId === undefined) {
          if (request.method === "POST") return await authed({ op: "write" }, createFile);
          if (request.method === "GET") return await authed({ op: "list" }, listFiles);
          throw new ApiError("NOT_FOUND", "No such route.");
        }

        // A handler bound to the ID from the URL, so no handler parses the path
        // itself and none can disagree with the router about which file it is.
        const onFile = (requirement: Requirement, handler: FileHandler): Promise<Response> =>
          authed(requirement, (authCtx, req) => handler(authCtx, req, fileId));

        if (action === undefined) {
          if (request.method === "GET") return await onFile({ op: "read" }, getFile);
          if (request.method === "PATCH") return await onFile({ op: "write" }, patchFile);
          if (request.method === "DELETE") return await onFile({ op: "delete" }, deleteFile);
          throw new ApiError("NOT_FOUND", "No such route.");
        }

        if (segments.length === 4 && request.method === "POST" && action === "complete") {
          return await onFile({ op: "write" }, completeFile);
        }
        if (segments.length === 4 && request.method === "GET" && action === "download") {
          return await onFile({ op: "read" }, downloadFile);
        }
        // Restore takes `delete` scope, not `write`: it is the inverse of a
        // delete, so it is the same capability (13's table).
        if (segments.length === 4 && request.method === "POST" && action === "restore") {
          return await onFile({ op: "delete" }, restoreFile);
        }
        // Move needs write on BOTH ends and copy needs read on the source plus
        // write on the destination (13's table); both second checks are inside
        // the handlers, which are the only place the destination is known.
        if (segments.length === 4 && request.method === "POST" && action === "move") {
          return await onFile({ op: "write" }, moveFile);
        }
        if (segments.length === 4 && request.method === "POST" && action === "copy") {
          return await onFile({ op: "read" }, copyFile);
        }
      }

      if (segments[0] === "v1" && segments[1] === "folders") {
        const folderId = segments[2];

        if (folderId === undefined) {
          if (request.method === "POST") return await authed({ op: "write" }, createFolder);
          if (request.method === "GET") return await authed({ op: "list" }, listFolders);
          throw new ApiError("NOT_FOUND", "No such route.");
        }

        if (segments.length === 3 && request.method === "DELETE") {
          return await authed({ op: "delete" }, (authCtx, req) =>
            deleteFolder(authCtx, req, folderId)
          );
        }
      }

      throw new ApiError("NOT_FOUND", "No such route.");
    };

    // Errors get the headers too. A 401 the browser refuses to let script read
    // is indistinguishable from a network failure, and "that credential isn't
    // valid" is exactly what a developer needs to see in their console.
    try {
      return withCorsHeaders(await respond(), request, env);
    } catch (thrown) {
      return withCorsHeaders(toErrorResponse(thrown, id), request, env);
    }
  },

  /**
   * The scheduled half of keeping D1 and R2 in agreement (10.8).
   *
   * Both jobs run here rather than through the queue because neither is
   * triggered by an event - they are periodic sweeps over state that drifts on
   * its own. The queue exists for work that follows from a specific request.
   *
   * Failures are logged and swallowed. A cron that throws is retried by
   * Cloudflare on its own schedule anyway, and there is nobody waiting on this
   * to return.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    ctx.waitUntil(
      (async () => {
        try {
          const purged = await purgeExpiredFiles(env.DB, env.FILES, now);
          console.log(JSON.stringify({ level: "info", message: "purge run", ...purged }));
        } catch (err) {
          console.log(
            JSON.stringify({
              level: "error",
              message: "purge run failed",
              reason: err instanceof Error ? err.message : String(err),
            })
          );
        }

        try {
          const reconciled = await reconcileCounters(env.DB, now);
          console.log(JSON.stringify({ level: "info", message: "reconcile run", ...reconciled }));
        } catch (err) {
          console.log(
            JSON.stringify({
              level: "error",
              message: "reconcile run failed",
              reason: err instanceof Error ? err.message : String(err),
            })
          );
        }
      })()
    );
  },

  /**
   * Queue consumer — webhook delivery.
   *
   * Deliveries run here rather than inline on the request that caused them, and
   * that is the entire reason the queue exists. A customer's endpoint being
   * slow, down, or hostile must not slow down or fail the upload that triggered
   * the event: the person uploading has no relationship with whoever runs that
   * endpoint, and making them wait on it borrows somebody else's reliability
   * problem.
   *
   * Each message is acked or retried individually rather than with
   * `retryAll()`. One unreachable endpoint in a batch of ten must not cause the
   * other nine to be delivered a second time - at-least-once is a promise we
   * keep, but repeating it needlessly is just noise in somebody's log.
   */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const now = Date.now();

    for (const message of batch.messages) {
      if (!isWebhookEvent(message.body)) {
        // Nothing else produces messages today. Acked rather than retried: a
        // message we cannot parse will not become parseable on the third try,
        // and letting it cycle to the dead-letter queue hides real failures
        // behind noise.
        console.log(
          JSON.stringify({
            level: "warn",
            message: "unrecognised queue message, discarded",
            queue: batch.queue,
          })
        );
        message.ack();
        continue;
      }

      try {
        const { ack, outcome } = await handleDelivery(env.DB, message.body, now);
        console.log(
          JSON.stringify({
            level: outcome?.delivered === false ? "warn" : "info",
            message: "webhook delivery",
            webhookId: message.body.webhookId,
            event: message.body.event,
            status: outcome?.status ?? null,
            delivered: outcome?.delivered ?? true,
            // The URL is not logged: it is the customer's, and their internal
            // hostnames are their business.
            reason: outcome?.reason ?? null,
          })
        );
        if (ack) message.ack();
        else message.retry();
      } catch (err) {
        console.log(
          JSON.stringify({
            level: "error",
            message: "webhook delivery threw",
            webhookId: message.body.webhookId,
            reason: err instanceof Error ? err.message : String(err),
          })
        );
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
