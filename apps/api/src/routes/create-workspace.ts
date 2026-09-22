/**
 * POST /v1/workspaces - 05 PART 13: "None (Turnstile-gated)", 10/hour/IP.
 *
 * The only endpoint in the product that creates resources without a credential,
 * which makes its two gates the entire defence:
 *
 *   1. A per-IP rate limit, checked first because it costs one KV read and
 *      stops a flood before we spend a network round trip on Turnstile.
 *   2. Turnstile, verified server-side. Failing closed on every error path,
 *      including Turnstile being unreachable.
 *
 * Both must run before any write. Nothing here is behind withAuth, so nothing
 * here may assume an identity exists.
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

const BodySchema = z.object({
  turnstileToken: z.string().min(1, "turnstileToken is required"),
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

export async function createWorkspace(
  request: Request,
  deps: CreateWorkspaceDeps
): Promise<Response> {
  const now = deps.now ?? Date.now();

  // Fail closed on a misconfigured deploy rather than quietly serving an
  // ungated endpoint. Loud, because a missing bot gate is not a small thing.
  if (!deps.turnstileSecret) {
    throw new ApiError("INTERNAL_ERROR", "Something went wrong on our end.", {
      internalReason: "TURNSTILE_SECRET_KEY is not set; refusing to provision without the gate",
    });
  }

  await enforce(deps.kv, CREATE_WORKSPACE_RATE_LIMIT, clientIdentifier(request), now);

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
      // Field paths only. The values are the caller's, and one of them is a
      // Turnstile token we have no business echoing.
      { fields: parsed.error.issues.map((issue) => issue.path.join(".")) }
    );
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

  const result = await provisionSandboxWorkspace(deps.db, {
    workspaceName: parsed.data.name ?? "Sandbox",
    agentName: parsed.data.agentName ?? "sandbox-agent",
    now,
    encryptionKey: deps.encryptionKey ?? null,
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
      limits: {
        storageBytes: SANDBOX_LIMITS.storageBytes,
        files: SANDBOX_LIMITS.fileCount,
        maxFileBytes: SANDBOX_LIMITS.maxFileBytes,
      },
    },
    agent: {
      id: result.agentId,
      name: parsed.data.agentName ?? "sandbox-agent",
    },
    apiKey: {
      id: result.keyId,
      // Shown once. It is not stored anywhere in a form this response could be
      // rebuilt from - only SHA-256 of it reached the database.
      token: result.token,
      prefix: result.keyPrefix,
      lastFour: result.keyLastFour,
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
    notice:
      "Store this key now. It is shown once and cannot be recovered - only a hash of it is kept. " +
      "The claim URL is shown once too: it is how a person takes ownership of this workspace, " +
      "and an unclaimed workspace is eventually deleted.",
  };

  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
