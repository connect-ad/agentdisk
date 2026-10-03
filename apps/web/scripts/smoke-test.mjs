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
 *        ENVIRONMENT_NAME (which side of the indexing check applies; unset is
 *        treated as not prod, matching the build)
 *        SITE_URL  the marketing hostname the same Worker answers on; when
 *                  set, section 7 checks the split and the indexing check
 *                  applies to the site rather than the app
 *        WWW_URL   the www. alias, when the environment has one
 */
import { REQUIRED_HEADERS, ROBOTS_NOINDEX, isIndexable } from "./security-headers.js";

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

/**
 * Fetch `/robots.txt` until it is the robots file, or give up.
 *
 * The same race as `fetchUntilHeaders`, one deploy later and from the other
 * side: a path that is *new* to the asset store answers through the SPA
 * fallback — `index.html`, 200 — until the new asset list has propagated,
 * and the document root was already confirmed live 0.02s earlier. Measured on
 * the deploy that first shipped the file (Fixing_feedback_07, 27 Sept 2026):
 * the smoke test got `<!doctype html>` and the same URL served the file
 * correctly, unchanged, when checked by hand afterwards. Retried on the body,
 * because the status is 200 either way.
 */
async function fetchRobotsUntilLive(url) {
  let body = "";
  for (let attempt = 1; attempt <= HEADER_ATTEMPTS; attempt++) {
    const response = await fetch(url, { redirect: "manual" });
    body = await response.text();
    if (body.startsWith("User-agent:")) return body;
    if (attempt === HEADER_ATTEMPTS) break;
    console.log(
      `  robots.txt: not live yet, SPA fallback answered ` +
        `(attempt ${attempt}/${HEADER_ATTEMPTS}); retrying in ${HEADER_RETRY_MS / 1000}s`
    );
    await sleep(HEADER_RETRY_MS);
  }
  return body;
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

// --- 3b. The marketing routes are prerendered ----------------------------
// Each of these is written as a static page at build time (scripts/prerender.mjs)
// and carries a marker naming the route it holds. The empty SPA shell here
// means the prerender step did not run, or the asset server is not serving
// pricing.html / docs.html for the extensionless path.
//
// Retried on the body, like robots.txt: on the deploy that first shipped
// these pages (Fixing_feedback_12, 28 Sept 2026) all three answered with the
// previous build's empty shell for a few seconds after the root had already
// passed, and were correct by the time anyone looked by hand.
console.log("\n[3b] Prerendered marketing routes");
/** The root body as served once the new asset list has propagated. */
let propagatedRoot = rootBody;
for (const path of ["/", "/pricing", "/docs"]) {
  const marker = `<meta name="agentdisk:prerendered" content="${path}"`;
  let response;
  let body = "";
  for (let attempt = 1; attempt <= HEADER_ATTEMPTS; attempt++) {
    response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
    body = await response.text();
    if (body.includes(marker) || attempt === HEADER_ATTEMPTS) break;
    console.log(
      `  ${path}: prerendered page not live yet ` +
        `(attempt ${attempt}/${HEADER_ATTEMPTS}); retrying in ${HEADER_RETRY_MS / 1000}s`
    );
    await sleep(HEADER_RETRY_MS);
  }
  if (path === "/") propagatedRoot = body;

  if (response.status !== 200) {
    fail(`GET ${path} returned HTTP ${response.status}, expected 200`);
  } else if (!body.includes(marker) || !body.includes("data-prerendered=")) {
    fail(`GET ${path} is the empty SPA shell, not the prerendered page`);
  } else if (!body.includes('<link rel="canonical"') || body.includes("<title>AgentDisk</title>")) {
    fail(`GET ${path} is prerendered but carries no per-page metadata (lib/seo.js)`);
  } else {
    pass(`${path} -> prerendered (${body.length} bytes)`);
  }
}

// --- 3c. No source map beside the bundle ---------------------------------
// `sourcemap: false` in vite.config.js. A map is the original source with its
// comments, served to anyone who asks; this is the check that the setting is
// still off and that nothing else put a map in dist.
//
// After 3b on purpose, and against the bundle the *propagated* root names:
// the first run of this check read the root before the new asset list had
// landed, found the previous build's bundle, and correctly reported that
// build's map — which was real, and already gone.
//
// The status alone says nothing here: not_found_handling answers every unknown
// path with index.html and 200, so an absent map looks like a served one until
// the content type is read. A real map is application/json; the fallback is
// text/html.
console.log("\n[3c] Source map");
const liveScript = propagatedRoot.match(/src="(\/assets\/index-[^"]+\.js)"/);
if (!liveScript) {
  fail("propagated root HTML references no hashed /assets/index-*.js bundle");
} else {
  const mapResponse = await fetch(`${baseUrl}${liveScript[1]}.map`, { redirect: "manual" });
  const mapType = mapResponse.headers.get("content-type") ?? "";
  if (mapResponse.status === 200 && !mapType.startsWith("text/html")) {
    fail(`${liveScript[1]}.map is served (HTTP 200, ${mapType}) — the bundle's source map is public`);
  } else {
    pass(`${liveScript[1]}.map -> HTTP ${mapResponse.status} ${mapType || "no content-type"} (not a map)`);
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

// --- 6. Indexing ----------------------------------------------------------
// Only prod may be indexed, and only the marketing site. Three mechanisms are
// built (header, robots.txt, meta tag) and the two a crawler meets first are
// checked here, in the direction the environment demands: dev missing its
// noindex is the defect this section was written for, and prod *carrying*
// one would be worse. When the deploy is split across two hostnames the
// indexable surface is the site, and the app host must say noindex in every
// environment - the Worker adds that itself (worker.js), so a build that
// lost it would look fine in dist/ and be wrong on the wire.
const siteUrl = process.env.SITE_URL?.replace(/\/$/, "") || null;
const wwwUrl = process.env.WWW_URL?.replace(/\/$/, "") || null;
console.log("\n[6] Indexing");
{
  const environment = process.env.ENVIRONMENT_NAME;
  const indexable = isIndexable(environment);
  const surface = siteUrl ?? baseUrl;
  const rootResponse = await fetchWithRetry(`${surface}/`, "indexing");
  const robotsTag = rootResponse ? rootResponse.headers.get("X-Robots-Tag") : null;
  if (!rootResponse) {
    fail(`GET ${surface}/ did not answer, so the indexing header could not be checked`);
  } else if (indexable && robotsTag) {
    fail(`${environment} is indexable but GET ${surface}/ carries X-Robots-Tag: ${robotsTag}`);
  } else if (!indexable && robotsTag !== ROBOTS_NOINDEX) {
    fail(`GET ${surface}/ should carry X-Robots-Tag: ${ROBOTS_NOINDEX} outside prod, got ${robotsTag ?? "nothing"}`);
  } else {
    pass(`X-Robots-Tag is ${robotsTag ?? "absent"} on ${surface}, correct for ${environment ?? "an unnamed environment"}`);
  }

  // The body, not the status: with no file in dist/, the SPA fallback answers
  // this path with index.html and 200, which a crawler reads as "no rules" —
  // and so does a file that has not propagated yet, hence the retry.
  const robotsBody = await fetchRobotsUntilLive(`${surface}/robots.txt`);
  const expectedRule = indexable ? "Allow: /" : "Disallow: /";
  if (!robotsBody.startsWith("User-agent: *") || !robotsBody.includes(expectedRule)) {
    fail(`GET ${surface}/robots.txt should say "${expectedRule}"; got: ${robotsBody.slice(0, 80).replace(/\n/g, "\\n")}`);
  } else {
    pass(`robots.txt on ${surface} says ${expectedRule}`);
  }

  if (siteUrl) {
    const appRoot = await fetchWithRetry(`${baseUrl}/`, "app indexing");
    const appTag = appRoot ? appRoot.headers.get("X-Robots-Tag") : null;
    if (appTag !== ROBOTS_NOINDEX) {
      fail(`the app host must never be indexed: GET ${baseUrl}/ should carry X-Robots-Tag: ${ROBOTS_NOINDEX}, got ${appTag ?? "nothing"}`);
    } else {
      pass(`X-Robots-Tag is ${appTag} on the app host`);
    }
    const appRobots = await fetchRobotsUntilLive(`${baseUrl}/robots.txt`);
    if (!appRobots.startsWith("User-agent: *") || !appRobots.includes("Disallow: /")) {
      fail(`GET ${baseUrl}/robots.txt should say "Disallow: /" on the app host; got: ${appRobots.slice(0, 80).replace(/\n/g, "\\n")}`);
    } else {
      pass("robots.txt on the app host says Disallow: /");
    }
  }
}

// --- 7. The marketing host ------------------------------------------------
// The same Worker answers on the site hostname (agentdisk.io, dev.agentdisk.io)
// and serves the marketing routes there, redirecting every app path to the app
// host. worker.js decides; this proves the decision reached the wire, with the
// security headers intact through the ASSETS binding.
if (siteUrl) {
  console.log("\n[7] Marketing host");
  const siteRoot = await fetchWithRetry(`${siteUrl}/`, "site root");
  if (!siteRoot) {
    fail(`GET ${siteUrl}/ did not answer`);
  } else {
    const html = await siteRoot.text();
    if (siteRoot.status !== 200) fail(`GET ${siteUrl}/ returned HTTP ${siteRoot.status}, expected 200`);
    if (!html.includes('name="agentdisk:prerendered" content="/"')) fail(`${siteUrl}/ is not the prerendered landing page`);
    else pass(`${siteUrl}/ is the prerendered landing page`);
    const missing = REQUIRED_HEADERS.filter((name) => !siteRoot.headers.get(name));
    if (missing.length > 0) fail(`${siteUrl}/ is missing: ${missing.join(", ")}`);
    else pass("site root carries all five security headers");
  }

  const pricing = await fetchWithRetry(`${siteUrl}/pricing`, "site pricing");
  if (pricing && pricing.status === 200 && (await pricing.text()).includes('name="agentdisk:prerendered" content="/pricing"')) {
    pass(`${siteUrl}/pricing is the prerendered pricing page`);
  } else {
    fail(`${siteUrl}/pricing should be the prerendered pricing page`);
  }

  for (const path of ["/login", "/w/acme-research/files"]) {
    const res = await fetch(`${siteUrl}${path}`, { redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status === 302 && location === `${baseUrl}${path}`) {
      pass(`${siteUrl}${path} -> 302 ${location}`);
    } else {
      fail(`${siteUrl}${path} should redirect (302) to ${baseUrl}${path}; got HTTP ${res.status} ${location ?? ""}`);
    }
  }

  // Agent readiness, 3 Oct 2026. Before this, every file path on the site
  // answered the homepage with 200, so a scanner saw a sitemap, a
  // security.txt and an MCP card that did not exist.
  {
    // Retried on the body: a file new to the asset store answers through the
    // SPA fallback until it propagates, the same race as robots.txt.
    let sitemap = "";
    for (let attempt = 1; attempt <= HEADER_ATTEMPTS; attempt++) {
      sitemap = await (await fetch(`${siteUrl}/sitemap.xml`, { redirect: "manual" })).text();
      if (sitemap.startsWith("<?xml") || attempt === HEADER_ATTEMPTS) break;
      console.log(`  sitemap.xml: not live yet (attempt ${attempt}/${HEADER_ATTEMPTS}); retrying in ${HEADER_RETRY_MS / 1000}s`);
      await sleep(HEADER_RETRY_MS);
    }
    if (sitemap.startsWith("<?xml") && sitemap.includes("<urlset")) pass(`${siteUrl}/sitemap.xml is a sitemap`);
    else fail(`${siteUrl}/sitemap.xml should be XML; got: ${sitemap.slice(0, 60).replace(/\n/g, "\\n")}`);

    const missing = await fetch(`${siteUrl}/.well-known/smoke-test-${Date.now()}.json`, { redirect: "manual" });
    if (missing.status === 404) pass("a missing file on the site answers 404");
    else fail(`a missing file on the site should answer 404, got HTTP ${missing.status}`);

    const home = await fetch(`${siteUrl}/`, { redirect: "manual" });
    const link = home.headers.get("link") ?? "";
    if (link.includes('</llms.txt>; rel="describedby"')) pass("the site root carries the Link header");
    else fail(`GET ${siteUrl}/ should carry a Link header naming /llms.txt, got ${link || "nothing"}`);
  }

  if (wwwUrl) {
    const res = await fetch(`${wwwUrl}/pricing`, { redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status === 301 && location === `${siteUrl}/pricing`) {
      pass(`${wwwUrl}/pricing -> 301 ${location}`);
    } else {
      fail(`${wwwUrl}/pricing should redirect (301) to ${siteUrl}/pricing; got HTTP ${res.status} ${location ?? ""}`);
    }
  }
}

// --- Result ---------------------------------------------------------------
console.log("");
if (failures.length > 0) {
  console.error(`Smoke test FAILED with ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Smoke test passed: ${baseUrl} is serving the dashboard${siteUrl ? ` and ${siteUrl} the site` : ""}, deep links fall back to the SPA, no bypass hostname is open, and every response carries its security headers.`);
