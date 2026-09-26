/**
 * Cloudflare Turnstile server-side verification.
 *
 * 05 PART 13 gates POST /v1/workspaces on Turnstile: it is the only endpoint
 * that creates resources without a credential, so the bot gate is the whole
 * defence against someone scripting workspace creation.
 *
 * This fails closed on everything. A network error, a timeout, a non-200, a
 * malformed body and an explicit failure all reject. If Turnstile is down we
 * stop issuing sandbox workspaces - that is the correct trade for a gate whose
 * only job is to keep automation out.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Turnstile is on Cloudflare's own edge, so a slow response means something is
 * wrong rather than far away. Five seconds is generous; without a timeout a
 * hung siteverify would hold the Worker for its whole request budget.
 */
const VERIFY_TIMEOUT_MS = 5_000;

export interface TurnstileResult {
  success: boolean;
  /** Present on failure. Cloudflare's own codes, safe to log - they name no secret. */
  errorCodes: string[];
  /** The hostname the challenge was solved on, when Cloudflare reports one. */
  hostname: string | null;
}

interface SiteverifyBody {
  success?: unknown;
  "error-codes"?: unknown;
  hostname?: unknown;
}

export interface VerifyOptions {
  /**
   * If set, the challenge must have been solved on one of these hostnames.
   * Defense in depth against a token minted elsewhere being replayed here.
   * Left unset the check is skipped, which is what the documented test keys
   * need - they report a hostname that is not ours.
   */
  allowedHostnames?: string[];
  remoteIp?: string | null;
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  options: VerifyOptions = {}
): Promise<TurnstileResult> {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (options.remoteIp) form.append("remoteip", options.remoteIp);

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    // Unreachable, timed out, or DNS failed. All of them mean we could not
    // verify, and could-not-verify is a rejection.
    return { success: false, errorCodes: ["siteverify-unreachable"], hostname: null };
  }

  if (!response.ok) {
    return { success: false, errorCodes: [`siteverify-http-${response.status}`], hostname: null };
  }

  let body: SiteverifyBody;
  try {
    body = (await response.json()) as SiteverifyBody;
  } catch {
    return { success: false, errorCodes: ["siteverify-unparseable"], hostname: null };
  }

  const hostname = typeof body.hostname === "string" ? body.hostname : null;
  const errorCodes = Array.isArray(body["error-codes"])
    ? body["error-codes"].filter((c): c is string => typeof c === "string")
    : [];

  // Strict equality, not truthiness: anything other than a literal true is a
  // failure, including a string "true" from a proxy that reshaped the body.
  if (body.success !== true) {
    return { success: false, errorCodes: errorCodes.length ? errorCodes : ["not-successful"], hostname };
  }

  if (options.allowedHostnames && options.allowedHostnames.length > 0) {
    if (hostname === null || !options.allowedHostnames.includes(hostname)) {
      return { success: false, errorCodes: ["hostname-mismatch"], hostname };
    }
  }

  return { success: true, errorCodes: [], hostname };
}

/** Parse the comma-separated TURNSTILE_ALLOWED_HOSTNAMES var into a list. */
export function parseAllowedHostnames(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}
