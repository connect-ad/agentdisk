/**
 * Post-deploy smoke test for the dashboard SPA.
 *
 * Deliberately stricter than "the workflow went green". A static-asset deploy
 * can succeed at the Wrangler level and still be broken in three ways that only
 * a real request reveals:
 *
 *   1. The custom domain resolves but serves the Terraform placeholder Worker,
 *      because `wrangler deploy` targeted a different script name.
 *   2. The root loads but every deep link 404s, because not_found_handling was
 *      not set — the single most likely SPA misconfiguration.
 *   3. The site is correct AND ALSO published on a *.workers.dev hostname that
 *      bypasses the custom domain entirely. This repo has already shipped that
 *      fault once on the API Worker, so it is checked, not assumed.
 *
 * Exits non-zero on any failure so the deploy job fails loudly.
 *
 * usage: smoke-test.mjs <base-url> <worker-name>
 * env:   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (for the workers.dev check)
 */
import { REQUIRED_HEADERS } from "./security-headers.js";

const baseUrl = process.argv[2]?.replace(/\/$/, "");
const workerName = process.argv[3];

if (!baseUrl || !workerName) {
  console.error("usage: smoke-test.mjs <base-url> <worker-name>");
  process.exit(1);
}

const ATTEMPTS = 6;
/** Header rules propagate after asset content; see fetchUntilHeaders. ~60s total. */
const HEADER_ATTEMPTS = 12;
const HEADER_RETRY_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
function fail(message) {
  failures.push(message);
  console.error(`  FAIL: ${message}`);
}
function pass(message) {
  console.log(`  ok: ${message}`);
}

/**
 * A fresh deploy plus custom-domain routing can take a few seconds to
 * propagate. Retry only the FIRST fetch — once the origin answers at all,
 * later assertions are about *content*, which arrives with the response, and
 * retrying those would just mask a real bug behind a slower red build.
 *
 * Header rules are the one exception, and `fetchUntilHeaders` below handles
 * them separately. See the note there before widening this retry.
 */
async function fetchWithRetry(url, label) {
  let lastFailure = "no attempt made";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      return response;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < ATTEMPTS) {
      const delayMs = attempt * 5000;
      console.log(`  ${label}: attempt ${attempt}/${ATTEMPTS} failed (${lastFailure}); retrying in ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }
  console.error(`FATAL: ${label} never responded after ${ATTEMPTS} attempts: ${lastFailure}`);
  process.exit(1);
}

/**
 * Fetch until the response carries the security headers, or give up.
 *
 * These need their own retry because a deployment's asset *content* and its
 * `_headers` rules go live independently, and the content wins the race. This
 * is measured, not assumed: on the deploy that first shipped these headers,
 * section 1 confirmed the new hashed bundle was already being served at
 * 00:13:36.61Z, and section 5 found no headers at all 0.65s later — while the
 * same URL carried all five, unchanged and never redeployed, when checked
 * afterwards.
 *
 * So "the origin answered" does not imply "the header config is live", and a
 * single un-retried request here fails a deploy that is in fact correct. The
 * assertion is unchanged — if they never arrive within the window, that is
 * still a hard failure.
 */
async function fetchUntilHeaders(url, label) {
  let response = await fetch(url, { redirect: "manual" });
  for (let attempt = 1; attempt <= HEADER_ATTEMPTS; attempt++) {
    const missing = REQUIRED_HEADERS.filter((name) => !response.headers.get(name));
    if (missing.length === 0) return response;
    if (attempt === HEADER_ATTEMPTS) break;
    console.log(
      `  ${label}: ${missing.length} of ${REQUIRED_HEADERS.length} header(s) not live yet ` +
        `(attempt ${attempt}/${HEADER_ATTEMPTS}); retrying in ${HEADER_RETRY_MS / 1000}s`
    );
    await sleep(HEADER_RETRY_MS);
    response = await fetch(url, { redirect: "manual" });
  }
  return response;
}

console.log(`Smoke-testing ${baseUrl} (worker: ${workerName})`);

// --- 1. The document root serves the built SPA shell ----------------------
console.log("\n[1] Document root");
const rootResponse = await fetchWithRetry(`${baseUrl}/`, "root");
const rootBody = await rootResponse.text();

if (rootResponse.status !== 200) {
  fail(`GET / returned HTTP ${rootResponse.status}, expected 200`);
} else {
  pass("GET / returned 200");
}

// The placeholder Worker answers 503 with JSON. If we see it, Terraform's
// bootstrap script is still live and the Wrangler deploy did not land.
if (rootBody.includes('"status": "provisioned"') || rootBody.includes('"provisioned"')) {
  fail("root is still serving the Terraform placeholder Worker — the Wrangler deploy did not take effect");
}

if (!rootBody.includes('<div id="root">')) {
  fail("root HTML has no <div id=\"root\"> mount point — this is not the built SPA shell");
} else {
  pass("root HTML contains the SPA mount point");
}

// Vite emits hashed asset filenames; their presence proves this is a real
// production build rather than an index.html served from somewhere else.
const scriptMatch = rootBody.match(/src="(\/assets\/index-[^"]+\.js)"/);
if (!scriptMatch) {
  fail("root HTML references no hashed /assets/index-*.js bundle");
} else {
  pass(`root HTML references ${scriptMatch[1]}`);
}

// --- 2. Hashed assets actually resolve -----------------------------------
console.log("\n[2] Static asset");
if (scriptMatch) {
  const assetResponse = await fetch(`${baseUrl}${scriptMatch[1]}`);
  if (assetResponse.status !== 200) {
    fail(`GET ${scriptMatch[1]} returned HTTP ${assetResponse.status}, expected 200`);
  } else {
    const contentType = assetResponse.headers.get("content-type") ?? "";
    if (!contentType.includes("javascript")) {
      fail(`asset served with content-type "${contentType}", expected JavaScript`);
    } else {
      pass(`bundle served as ${contentType}`);
    }
  }
}

// --- 3. SPA fallback: deep links return the app, not a 404 ---------------
// These paths exist ONLY in the React Router table (App.jsx), never as files on
// disk, so each one is a direct test of not_found_handling.
console.log("\n[3] SPA deep-link fallback");
for (const path of ["/login", "/signup", "/w/acme-research/files"]) {
  const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
  const body = await response.text();

  if (response.status !== 200) {
    fail(`GET ${path} returned HTTP ${response.status}, expected 200 (SPA fallback not configured?)`);
  } else if (!body.includes('<div id="root">')) {
    fail(`GET ${path} returned 200 but not the SPA shell`);
  } else {
    pass(`${path} -> 200, SPA shell`);
  }
}

// --- 4. No second public hostname ----------------------------------------
// The custom domain must be the ONLY way in. workers.dev is enabled by default
// and publishes an unversioned public hostname that bypasses it.
console.log("\n[4] workers.dev bypass hostname");
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!apiToken || !accountId) {
  fail("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set — cannot verify workers.dev is disabled");
} else {
  const cf = (path) =>
    fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { authorization: `Bearer ${apiToken}` },
    });

  // Authoritative check: ask Cloudflare directly whether the script is exposed.
  const subdomainResponse = await cf(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`
  );
  const subdomainBody = await subdomainResponse.json().catch(() => null);

  if (!subdomainResponse.ok || !subdomainBody?.success) {
    // A 404 here means no subdomain association exists at all, which is the
    // desired state — Cloudflare returns errors for scripts never exposed.
    if (subdomainResponse.status === 404) {
      pass("script has no workers.dev subdomain association");
    } else {
      fail(
        `could not read workers.dev state for ${workerName}: HTTP ${subdomainResponse.status} ` +
          `${JSON.stringify(subdomainBody?.errors ?? null)}`
      );
    }
  } else {
    const { enabled, previews_enabled: previewsEnabled } = subdomainBody.result ?? {};
    if (enabled === true) {
      fail(`workers.dev is ENABLED for ${workerName} — a second public hostname bypasses the custom domain`);
    } else {
      pass("workers.dev disabled");
    }
    if (previewsEnabled === true) {
      fail(`preview URLs are ENABLED for ${workerName} — each version gets its own public hostname`);
    } else {
      pass("preview URLs disabled");
    }
  }

  // Belt and braces: construct the hostname and prove nothing answers on it.
  const accountSubdomain = await cf(`/accounts/${accountId}/workers/subdomain`)
    .then((r) => r.json())
    .catch(() => null);
  const subdomain = accountSubdomain?.result?.subdomain;

  if (!subdomain) {
    console.log("  note: account has no workers.dev subdomain registered; nothing to probe");
  } else {
    const bypassUrl = `https://${workerName}.${subdomain}.workers.dev/`;
    try {
      const response = await fetch(bypassUrl, { redirect: "manual" });
      const body = await response.text();
      if (response.status === 200 && body.includes('<div id="root">')) {
        fail(`${bypassUrl} is serving the dashboard — the custom domain is not the only entry point`);
      } else {
        pass(`${bypassUrl} does not serve the app (HTTP ${response.status})`);
      }
    } catch {
      // DNS failure is the expected, desired outcome.
      pass(`${bypassUrl} does not resolve`);
    }
  }
}

// --- 5. Security headers on the document response ------------------------
// Checked against the deployed response, not the generated file, because the
// two can disagree in a way nothing else notices: `_headers` is emitted by a
// Vite plugin into `dist/`, and if that plugin ever stops running the build
// still succeeds, the deploy still succeeds, and every header silently
// vanishes. This is the assertion that turns that into a red pipeline.
console.log("\n[5] Security headers");
{
  const headerResponse = await fetchUntilHeaders(`${baseUrl}/`, "headers");
  for (const name of REQUIRED_HEADERS) {
    const value = headerResponse.headers.get(name);
    if (!value) {
      fail(`GET / is missing ${name}`);
    } else {
      pass(`${name}: ${value.length > 60 ? `${value.slice(0, 60)}…` : value}`);
    }
  }

  // The policy is only worth having if script-src is tight. A wildcard or an
  // 'unsafe-inline' here would pass the "header is present" check above while
  // granting exactly what CSP exists to withhold.
  const csp = headerResponse.headers.get("Content-Security-Policy") ?? "";
  const scriptSrc = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("script-src "));

  if (!scriptSrc) {
    fail("CSP has no script-src directive");
  } else if (scriptSrc.includes("'unsafe-inline'") || scriptSrc.includes("'unsafe-eval'") || scriptSrc.includes("*")) {
    fail(`CSP script-src is not restrictive: ${scriptSrc}`);
  } else {
    pass(`CSP script-src is restrictive: ${scriptSrc}`);
  }

  // A deep link is served by the SPA fallback rather than as a file on disk,
  // so it is the path most likely to miss a header rule. Retried for the same
  // propagation reason, and cheaply: once the root above is live this returns
  // on its first attempt.
  const deepResponse = await fetchUntilHeaders(
    `${baseUrl}/w/acme-research/files`,
    "headers (deep link)"
  );
  const missingOnDeepLink = REQUIRED_HEADERS.filter((name) => !deepResponse.headers.get(name));
  if (missingOnDeepLink.length > 0) {
    fail(`SPA fallback response is missing: ${missingOnDeepLink.join(", ")}`);
  } else {
    pass("SPA fallback carries all five headers");
  }
}

// --- Result ---------------------------------------------------------------
console.log("");
if (failures.length > 0) {
  console.error(`Smoke test FAILED with ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Smoke test passed: ${baseUrl} is serving the dashboard, deep links fall back to the SPA, no bypass hostname is open, and every response carries its security headers.`);
