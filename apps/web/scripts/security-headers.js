/**
 * The security headers every dashboard response carries.
 *
 * One module, three consumers, on purpose: `vite.config.js` writes it into
 * `dist/_headers` at build time, `test/security-headers.test.js` asserts what
 * the policy allows, and `scripts/smoke-test.mjs` checks the deployed response
 * actually carries it. A policy defined in one place and verified against a
 * hand-copied list in another is a policy that drifts silently.
 *
 * **Why `_headers` and not a Worker.** `wrangler.toml` is deliberately
 * assets-only — no `main`, so no Worker invocation on the request path and no
 * request-path code that can fail. Cloudflare's asset server applies `_headers`
 * itself, which keeps that property. The file is generated rather than checked
 * in because two directives name environment-specific origins.
 *
 * **What is deliberately NOT set.** `Cross-Origin-Opener-Policy: same-origin`
 * is the usual companion to these five and would break sign-in: Firebase's
 * `signInWithPopup` needs the popup to reach `window.opener`, and COOP severs
 * exactly that reference. Google's own guidance is to leave it unset (or use
 * `same-origin-allow-popups`) on pages that use popup auth. It is absent by
 * decision, not by oversight.
 */

/** The API this build talks to. Matches `lib/api.js`'s own default. */
const DEFAULT_API_BASE = "https://api-dev.agentdisk.io";

/** Turnstile serves both its script and its challenge iframe from here. */
const TURNSTILE = "https://challenges.cloudflare.com";

/**
 * Firebase Auth's REST endpoints. The SDK assembles these at runtime from
 * parts, so they appear nowhere in the built bundle as literal strings — which
 * is precisely why they have to be listed deliberately here. Omitting them
 * does not fail a build or a test; it fails sign-in, in a browser, for a real
 * person.
 */
const FIREBASE_ENDPOINTS = [
  "https://identitytoolkit.googleapis.com",
  "https://securetoken.googleapis.com",
];

/**
 * Presigned uploads PUT straight to R2's S3 endpoint, bypassing the Worker
 * entirely (`lib/upload.js`). The host is `<account-id>.r2.cloudflarestorage.com`
 * and the account ID is a Terraform output that never reaches a web build, so
 * this is a subdomain wildcard rather than an exact origin. Without it, every
 * upload over 1 MB fails at the PUT.
 */
const R2_S3 = "https://*.r2.cloudflarestorage.com";

/** `styles.css` line 1 imports Public Sans and JetBrains Mono from here. */
const GOOGLE_FONTS_CSS = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILES = "https://fonts.gstatic.com";

/** Firebase's popup/redirect flow loads a helper iframe from here. */
const GOOGLE_APIS = "https://apis.google.com";

function origin(url, fallback) {
  try {
    return new URL(url).origin;
  } catch {
    return fallback;
  }
}

/**
 * Build the Content-Security-Policy.
 *
 * `apiBase` and `firebaseAuthDomain` come from the same build-time variables
 * the app itself is compiled with, so the policy can never name a different
 * backend than the bundle talks to.
 */
export function contentSecurityPolicy({ apiBase, firebaseAuthDomain } = {}) {
  const api = origin(apiBase || DEFAULT_API_BASE, DEFAULT_API_BASE);

  // A dev build for the marketing pages alone has no Firebase project. Emitting
  // "https://undefined" would be worse than omitting the source: it is a
  // directive that looks configured and matches nothing.
  const authDomain = firebaseAuthDomain ? `https://${firebaseAuthDomain}` : null;

  const directives = [
    ["default-src", ["'self'"]],
    // No <base> injection, and nothing may be plugged in or embedded.
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    // The modern spelling of X-Frame-Options: DENY, which is still sent below
    // for browsers and scanners that only read the old header.
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'"]],
    // The directive that actually stops XSS, and the one kept tightest: no
    // 'unsafe-inline', no 'unsafe-eval', no wildcard. Vite emits a single
    // hashed module script and no inline script, so 'self' is sufficient.
    ["script-src", ["'self'", TURNSTILE, GOOGLE_APIS]],
    // 'unsafe-inline' is required and is not laziness: 41 source files style
    // elements with React's `style={{…}}`, which the browser applies as an
    // inline style attribute. There is no hash or nonce that covers those, and
    // removing them is a refactor of the whole UI, not a header change. Inline
    // style cannot execute script, so the XSS cost is bounded.
    ["style-src", ["'self'", "'unsafe-inline'", GOOGLE_FONTS_CSS]],
    ["font-src", ["'self'", "data:", GOOGLE_FONTS_FILES]],
    // Avatars come from whichever provider the person signed in with, and the
    // upload preview path produces blob: URLs. An image cannot execute, so the
    // https: source here is a much smaller concession than it would be above.
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    [
      "connect-src",
      ["'self'", api, ...FIREBASE_ENDPOINTS, R2_S3, TURNSTILE],
    ],
    ["frame-src", [TURNSTILE, GOOGLE_APIS, ...(authDomain ? [authDomain] : [])]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["upgrade-insecure-requests", []],
  ];

  return directives
    .map(([name, sources]) => (sources.length === 0 ? name : `${name} ${sources.join(" ")}`))
    .join("; ");
}

/**
 * Every header, as an ordered list of `[name, value]`.
 *
 * Ordered rather than an object so the generated `_headers` file is
 * byte-stable across builds — a diff that reorders itself is a diff nobody
 * reads.
 */
export function securityHeaders(options = {}) {
  return [
    ["Content-Security-Policy", contentSecurityPolicy(options)],
    // Two years is the submission requirement for HSTS preload; one year is the
    // figure asked for here and is the common floor. No `preload` token: that
    // is a one-way commitment for the whole apex domain and every subdomain
    // under it, and it is not this file's call to make.
    ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
    ["X-Frame-Options", "DENY"],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ];
}

/** The names the smoke test and the tests both assert on. */
export const REQUIRED_HEADERS = securityHeaders().map(([name]) => name);

/**
 * Everything under `/assets/` carries a content hash in its filename, so a
 * given URL's bytes can never change — a new build produces a new name. A year
 * and `immutable` is the honest lifetime for that, and `immutable` is the half
 * that matters: without it a browser still sends a conditional request on every
 * reload, which is the round trip this is here to remove.
 *
 * Deliberately NOT set on `/*`. `index.html` is the one file whose URL stays
 * the same while its contents change every deploy, and caching it is how a
 * person ends up holding a document that points at a bundle we already deleted.
 * It keeps the asset server’s `max-age=0, must-revalidate` default, which is
 * correct for it and wrong for everything it references.
 *
 * Set here and nowhere else for the reason the rest of this file exists: this
 * app is assets-only, so there is no request-path code that could attach it.
 */
const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * The `_headers` file body.
 *
 * `/*` covers documents, hashed assets and — because the rule matches the
 * request path rather than the file eventually served — every SPA deep link
 * that `not_found_handling` resolves to `index.html`.
 *
 * The `/assets/*` rule that follows adds one header to a subset of those
 * paths. Cloudflare applies every rule that matches, so a hashed asset gets
 * the five security headers from `/*` *and* this `Cache-Control` — and
 * because `/*` sets no `Cache-Control` of its own, the two rules never name
 * the same header and there is no precedence question to get wrong.
 */
export function renderHeadersFile(options = {}) {
  const lines = ["# Generated by vite.config.js from scripts/security-headers.js — do not edit.", "/*"];
  for (const [name, value] of securityHeaders(options)) {
    lines.push(`  ${name}: ${value}`);
  }
  lines.push("", "/assets/*", `  Cache-Control: ${ASSET_CACHE_CONTROL}`);
  return `${lines.join("\n")}\n`;
}
