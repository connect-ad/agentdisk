/**
 * POST /v1/workspaces - 05 PART 13, amended 28 Sept 2026.
 *
 * The only endpoint in the product that creates resources without a credential.
 *
 * It used to require a Turnstile token, which made the route unusable by the
 * audience it exists for: a headless agent has no browser to solve a challenge
 * in, so the "no account, one minute" sandbox was a dashboard feature wearing
 * an API's URL. The token is now optional. When a browser offers one it is
 * verified exactly as before, failing closed on every error path; when an
 * agent offers none the request goes through on the gates below alone.
 *
 * The gates, in the order they run, cheapest first:
 *
 *   1. A per-IP rate limit on creation: one KV read, ten an hour.
 *   2. A per-IP cap on *unclaimed* sandboxes: one indexed D1 count, five at
 *      once. The rate limit bounds how fast; this bounds how much one address
 *      can occupy however long it keeps trying. It counts rows rather than
 *      incrementing a counter, so a claim frees the slot the moment
 *      `claimed_at` is set and the sweep frees the rest - an honest agent that
 *      creates, claims and moves on is never locked out by its own history.
 *   3. Turnstile, if and only if a token was offered.
 *
 * Why the captcha was never the fence: a solver service clears it for about a
 * dollar a thousand. What makes a flood of sandboxes harmless is what a sandbox
 * cannot do - SANDBOX_LIMITS caps its storage and egress and gives it zero
 * share links, and the sweep deletes it after UNCLAIMED_TTL_MS. A thousand
 * private, expiring, unshareable rows are a few cents of D1, not a hosting
 * platform.
 *
 * Only the anonymous branch is charged against any of this. A signed-in
 * person's POST to the same path is routed to createWorkspaceForUser before
 * this file is reached (index.ts), so an abuser on a shared address cannot
 * spend a customer's budget, and the customer's workspaces - owned at birth,
 * never unclaimed - are never in the count.
 *
 * Nothing here is behind withAuth, so nothing here may assume an identity exists.
 */

import { z } from "zod";
import { ApiError, validationError } from "../lib/errors";
import { clientIdentifier, enforce, type RateLimitRule } from "../lib/rate-limit";
import { parseAllowedHostnames, verifyTurnstile } from "../lib/turnstile";
import { provisionSandboxWorkspace, SANDBOX_KEY_SCOPE } from "../db/bootstrap";
import { SANDBOX_LIMITS } from "../lib/plans";
import { claimUrl } from "../lib/claim";

/** 05 PART 13's stated limit for this route. */
export const CREATE_WORKSPACE_RATE_LIMIT: RateLimitRule = {
  bucket: "workspace-create",
  limit: 10,
  windowSeconds: 3600,
};

/**
 * How many unclaimed sandboxes one address may hold at once.
 *
 * Five is enough for an agent running a handful of jobs in parallel and small
 * enough that an address holds at most five sandbox allowances of storage. It
 * is a per-address figure and datacenter agents share addresses, so the
 * refusal names the two ways out: claim one, or create from the dashboard,
 * which is not counted.
 */
export const SANDBOX_UNCLAIMED_PER_IP = 5;

const BodySchema = z.object({
  /**
   * Optional since 28 Sept 2026. Present means a browser solved a challenge
   * and it is verified; absent means an agent, and the other gates carry it.
   * An empty string is neither and is refused, so a client that lost its token
   * finds out rather than silently taking the agent path.
   */
  turnstileToken: z.string().min(1, "turnstileToken, when sent, must not be empty").optional(),
  name: z.string().trim().min(1).max(64).optional(),
  agentName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    // Agent names end up in paths and log lines. Keep them boring.
    .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, "agentName may use letters, digits, spaces, - and _")
    .optional(),
});

export interface CreateWorkspaceDeps {
  db: D1Database;
  kv: KVNamespace;
  turnstileSecret: string | undefined;
  allowedHostnames: string | undefined;
  /**
   * Where the dashboard lives, so the response can carry a claim link the
   * agent's human can actually open. Reuses the variable Stripe's portal
   * already returns to rather than introducing a second one that could be
   * unset in one environment - a claim link is the only route from an agent's
   * sandbox to a real account, so it must not go missing on a deploy.
   */
  dashboardUrl?: string | undefined;
  /** DATABASE_ENCRYPTION_KEY, passed through to provisioning so the sandbox key is kept. */
  encryptionKey?: string | undefined;
  now?: number;
}

/**
 * Gate 2. Reads the real state of the rows rather than a counter, so the
 * number is always "how many unclaimed sandboxes does this address hold right
 * now" - never "how many did it ever create".
 */
async function assertUnclaimedCap(db: D1Database, identifier: string): Promise<void> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM workspaces
        WHERE creator_ip = ?
          AND claimed_at IS NULL
          AND deleted_at IS NULL`
    )
    .bind(identifier)
    .first<{ n: number }>();
  const held = row?.n ?? 0;

  if (held >= SANDBOX_UNCLAIMED_PER_IP) {
    throw new ApiError(
      "LIMIT_EXCEEDED",
      `This address already holds ${SANDBOX_UNCLAIMED_PER_IP} unclaimed sandbox workspaces. ` +
        "Claim one from its claim link, wait for an unclaimed one to expire, or sign in and " +
        "create the workspace from the dashboard, which is not counted.",
      {
        details: { limit: "unclaimedWorkspaces", used: held, allowed: SANDBOX_UNCLAIMED_PER_IP },
        internalReason: `unclaimed sandbox cap: ${identifier} holds ${held}`,
      }
    );
  }
}

export async function createWorkspace(
  request: Request,
  deps: CreateWorkspaceDeps
): Promise<Response> {
  const now = deps.now ?? Date.now();
  const identifier = clientIdentifier(request);

  await enforce(deps.kv, CREATE_WORKSPACE_RATE_LIMIT, identifier, now);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw validationError("Request body must be JSON.");
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues[0]?.message ?? "Invalid request body.",
      // Field paths only. The values are the caller's, and one of them may be
      // a Turnstile token we have no business echoing.
      { fields: parsed.error.issues.map((issue) => issue.path.join(".")) }
    );
  }

  await assertUnclaimedCap(deps.db, identifier);

  if (parsed.data.turnstileToken !== undefined) {
    // A token was offered, so it is checked. A deploy that lost its secret
    // must refuse the token rather than quietly accept it unverified: the
    // caller said "I passed a challenge" and we cannot know that.
    if (!deps.turnstileSecret) {
      throw new ApiError("INTERNAL_ERROR", "Something went wrong on our end.", {
        internalReason: "TURNSTILE_SECRET_KEY is not set; refusing to accept a challenge token unverified",
      });
    }

    const verification = await verifyTurnstile(deps.turnstileSecret, parsed.data.turnstileToken, {
      remoteIp: request.headers.get("cf-connecting-ip"),
      allowedHostnames: parseAllowedHostnames(deps.allowedHostnames),
    });

    if (!verification.success) {
      throw new ApiError("FORBIDDEN", "That challenge could not be verified. Please try again.", {
        internalReason: `turnstile rejected: ${verification.errorCodes.join(",")}`,
      });
    }
  }

  const result = await provisionSandboxWorkspace(deps.db, {
    workspaceName: parsed.data.name ?? "Sandbox",
    agentName: parsed.data.agentName ?? "sandbox-agent",
    now,
    encryptionKey: deps.encryptionKey ?? null,
    creatorIp: identifier,
  });

  const body = {
    workspace: {
      id: result.workspaceId,
      name: parsed.data.name ?? "Sandbox",
      // Not "free". An unclaimed workspace is on the sandbox allowance, and
      // reporting the free plan's 2 GB here would have the API promising room
      // the very next upload would refuse - the "false success" shape this
      // product's own audit (backlog/023) already found elsewhere.
      plan: "sandbox",
      claimed: false,
      /**
       * When the unclaimed sweep may remove this workspace and everything in
       * it. Same instant the claim link stops working, because the two are
       * one clock: claiming is the only thing that stops it.
       */
      deleteAfter: new Date(result.claimTokenExpiresAt).toISOString(),
      limits: {
        storageBytes: SANDBOX_LIMITS.storageBytes,
        files: SANDBOX_LIMITS.fileCount,
        maxFileBytes: SANDBOX_LIMITS.maxFileBytes,
        egressBytesPerPeriod: SANDBOX_LIMITS.egressBytesPerPeriod,
        requestsPerPeriod: SANDBOX_LIMITS.requestsPerPeriod,
        shareLinks: SANDBOX_LIMITS.shareLinks,
      },
      /**
       * What claiming changes, said here because the agent reading this is
       * the one who will be asked "what happens if I claim it": the key keeps
       * working, the workspace moves onto the account's plan, and the clock
       * above stops.
       */
      afterClaim: {
        keyKeepsWorking: true,
        limitsBecome: "the claiming account's plan",
        deleteAfter: null,
      },
    },
    agent: {
      id: result.agentId,
      name: parsed.data.agentName ?? "sandbox-agent",
    },
    apiKey: {
      id: result.keyId,
      // Shown once here. Sealed in the database (migration 0022) so that the
      // person who claims the workspace can read it again from the Keys page;
      // nobody else can, and nothing rebuilds it from this response.
      token: result.token,
      prefix: result.keyPrefix,
      lastFour: result.keyLastFour,
      /**
       * No expiry and no use count: the key lives as long as the workspace
       * does. Stated explicitly so a caller does not assume a sandbox key is
       * a short-lived one and stop using it early.
       */
      expiresAt: null,
      validWhile: "the workspace exists; it is not revoked by claiming",
      scopes: {
        ops: SANDBOX_KEY_SCOPE.ops,
        pathPrefix: "/*",
      },
    },
    /**
     * The one moment the raw claim token exists. Only its SHA-256 was written,
     * so this link cannot be reissued or looked up later by anybody, support
     * included - which is the same bargain the API key above makes, and for the
     * same reason: whoever holds this link can take ownership of this workspace.
     */
    claim: {
      url: claimUrl(deps.dashboardUrl, result.claimToken),
      expiresAt: result.claimTokenExpiresAt,
    },
    /**
     * Written for the model reading it, in the order it should act. The two
     * secrets go to two different places: the key to the agent's own config,
     * the link to its person. Never into the workspace - a claimed workspace's
     * readers see every file in it, and the store a credential protects is the
     * one place the credential must not sit.
     */
    nextSteps: [
      "Store apiKey.token now in a config file on the machine you run on (for example " +
        "~/.agentdisk/config.json or your MCP client's config) - never in a file inside this " +
        "workspace. It is shown once here; after the workspace is claimed, its owner can read " +
        "it again from the dashboard's Keys page.",
      "Give claim.url to the person you work for, verbatim, and tell them it is a secret: " +
        "whoever opens it signed in becomes the owner. It cannot be reissued.",
      `Tell them what this is: a sandbox workspace holding up to ${Math.round(
        SANDBOX_LIMITS.storageBytes / (1024 * 1024)
      )} MB, deleted with everything in it at workspace.deleteAfter unless claimed. ` +
        "Claiming keeps every file and keeps this key working.",
    ],
    notice:
      "Store this key now, in your own config and never inside this workspace. It is shown once " +
      "here; the workspace's owner can read it again from the Keys page after claiming. It has " +
      "no expiry and no use limit; it works for as long as this workspace exists. The claim URL " +
      "is shown once too: give it to the person you work for, because it is how they take " +
      "ownership of this workspace. Until then the workspace is held to the sandbox limits " +
      "above, and if nobody claims it by workspace.deleteAfter it is deleted with everything in it.",
  };

  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
