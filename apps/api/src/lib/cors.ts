/**
 * CORS, per 06 PART 16.9 as corrected in Sept 2026.
 *
 * This was the gap that made the dashboard unable to talk to the API at all:
 * the Worker sent no `Access-Control-*` headers and had no `OPTIONS` branch, so
 * a preflight 404'd. It is easy to miss because every curl and every test
 * passes without it - only a real browser, on a real second origin, ever sends
 * a preflight. `app-dev.agentdisk.io` posting JSON to `api-dev.agentdisk.io` is
 * exactly that case.
 *
 * Two rules do the work:
 *
 * 1. **The allowed origin is echoed, never wildcarded, and never guessed.** It
 *    comes from configuration per environment, so the dev API cannot be driven
 *    from the prod dashboard or vice versa. An unlisted origin gets a response
 *    with no CORS headers at all - the browser then refuses it, which is the
 *    correct outcome and needs no error of our own.
 * 2. **`Vary: Origin` on everything.** Without it a cache can serve one origin's
 *    `Access-Control-Allow-Origin` to a different origin, which quietly turns a
 *    per-origin allowlist into a wildcard.
 */

/** Sent on the preflight. `authorization` is the one that actually matters. */
const ALLOWED_HEADERS = "authorization, content-type, idempotency-key";

const ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";

/** 24 hours. Chrome caps preflight caching at this anyway. */
const MAX_AGE_SECONDS = "86400";

export interface CorsEnv {
  /**
   * Comma-separated origins allowed to call this API from a browser. Includes
   * the scheme, because an origin without one is not an origin - matching
   * `app-dev.agentdisk.io` against `https://app-dev.agentdisk.io` never
   * succeeds, and the failure looks like a CORS bug rather than a config typo.
   */
  CORS_ALLOWED_ORIGINS?: string;
}

export function parseAllowedOrigins(configured: string | undefined): string[] {
  if (configured === undefined) return [];
  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
}

/**
 * The origin to echo back, or null.
 *
 * Exact string equality against the allowlist. Not a suffix check: `endsWith`
 * on "agentdisk.io" also accepts `https://evil-agentdisk.io`, which is the
 * classic way this goes wrong.
 */
export function resolveAllowedOrigin(request: Request, env: CorsEnv): string | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  return parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS).includes(origin) ? origin : null;
}

/**
 * Answer a preflight.
 *
 * Called before authentication, and that is required rather than a shortcut: a
 * preflight carries no `Authorization` header - the browser has not sent the
 * real request yet - so authenticating it would reject every cross-origin
 * request in existence.
 *
 * An unlisted origin still gets a 204, deliberately, just without the headers
 * that would permit the call. Refusing with a 403 would tell a probing script
 * which origins are configured, and the browser blocks the request either way.
 */
export function preflightResponse(request: Request, env: CorsEnv): Response {
  const origin = resolveAllowedOrigin(request, env);
  const headers = new Headers({ vary: "Origin" });

  if (origin !== null) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", ALLOWED_METHODS);
    headers.set("access-control-allow-headers", ALLOWED_HEADERS);
    headers.set("access-control-max-age", MAX_AGE_SECONDS);
  }

  return new Response(null, { status: 204, headers });
}

/**
 * Add the response headers to an already-built response.
 *
 * Applied to every response including errors, because a 401 a browser cannot
 * read is indistinguishable from a network failure - and "your key is wrong" is
 * precisely the message a developer needs to see in their console.
 */
export function withCorsHeaders(response: Response, request: Request, env: CorsEnv): Response {
  const origin = resolveAllowedOrigin(request, env);

  // Headers on a constructed Response are immutable in some paths, so this
  // rebuilds rather than mutating in place.
  const headers = new Headers(response.headers);
  headers.append("vary", "Origin");
  if (origin !== null) {
    headers.set("access-control-allow-origin", origin);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
