/**
 * Post-deploy smoke test for the staff console.
 *
 * A near-sibling of apps/web/scripts/smoke-test.mjs, and deliberately not a
 * shared module: the two check different things. The dashboard's version
 * enumerates React Router paths, which this app does not have — the console is
 * state-driven, so its only routing requirement is that *any* path returns the
 * shell. In exchange it makes two assertions the dashboard has no reason to:
 * that the console is still marked noindex, and that the API origin baked into
 * the bundle is the one this stack built.
 *
 * Exits non-zero on any failure so the deploy job fails loudly.
 *
 * usage: smoke-test.mjs <base-url> <worker-name>
 * env:   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (for the workers.dev check)
 *        VITE_API_BASE (for the baked-in origin check)
 */
const baseUrl = process.argv[2]?.replace(/\/$/, "");
const workerName = process.argv[3];

if (!baseUrl || !workerName) {
  console.error("usage: smoke-test.mjs <base-url> <worker-name>");
  process.exit(1);
}

const ATTEMPTS = 6;
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
 * Retry only the FIRST fetch. Once the origin answers at all, later assertions
 * are about content rather than propagation, and retrying those would mask a
 * real bug behind a slower red build.
 */
async function fetchWithRetry(url, label) {
  let lastFailure = "no attempt made";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await fetch(url, { redirect: "manual" });
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

console.log(`Smoke-testing ${baseUrl} (worker: ${workerName})`);

// --- 1. The document root serves the built console ------------------------
console.log("\n[1] Document root");
const rootResponse = await fetchWithRetry(`${baseUrl}/`, "root");
const rootBody = await rootResponse.text();

if (rootResponse.status !== 200) {
  fail(`GET / returned HTTP ${rootResponse.status}, expected 200`);
} else {
  pass("GET / returned 200");
}

// The Terraform bootstrap Worker answers with JSON. Seeing it here means the
// Wrangler deploy never landed and the hostname is still on the placeholder.
if (rootBody.includes('"provisioned"')) {
  fail("root is still serving the Terraform placeholder Worker — the Wrangler deploy did not take effect");
}

if (!rootBody.includes('<div id="root">')) {
  fail('root HTML has no <div id="root"> mount point — this is not the built console');
} else {
  pass("root HTML contains the SPA mount point");
}

// Staff tooling must stay out of search results. The meta tag lives in
// index.html, so a careless edit there is the way this silently regresses —
// and a console that has been indexed cannot be un-indexed retroactively.
if (!/name="robots"[^>]*noindex/i.test(rootBody)) {
  fail("root HTML has no noindex robots meta — the staff console would be indexable");
} else {
  pass("robots noindex present");
}

const scriptMatch = rootBody.match(/src="(\/assets\/index-[^"]+\.js)"/);
if (!scriptMatch) {
  fail("root HTML references no hashed /assets/index-*.js bundle");
} else {
  pass(`root HTML references ${scriptMatch[1]}`);
}

// --- 2. The bundle resolves, and talks to the right API -------------------
console.log("\n[2] Static asset and baked-in API origin");
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

    // VITE_API_BASE is substituted at build time, so the origin is a literal in
    // the shipped bundle. Checking it here closes the gap between "the workflow
    // read the right value from terraform output" and "the deployed bytes
    // actually contain it" — a stale dist/ would pass every other assertion.
    const expectedApi = process.env.VITE_API_BASE?.replace(/\/$/, "");
    if (!expectedApi) {
      console.log("  note: VITE_API_BASE not set in this environment; skipping the origin check");
    } else {
      const bundle = await assetResponse.text();
      if (!bundle.includes(expectedApi)) {
        fail(`bundle does not reference ${expectedApi} — the console was built against a different API`);
      } else {
        pass(`bundle targets ${expectedApi}`);
      }
    }
  }
}

// --- 3. SPA fallback ------------------------------------------------------
// The console has no router: it switches screens in component state, so every
// URL below the root must return the shell rather than a 404. One arbitrary
// path proves not_found_handling is set; enumerating names would only assert
// something this app does not have.
console.log("\n[3] SPA fallback");
for (const path of ["/plans", "/some/path/that/is/not/a/file"]) {
  const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
  const body = await response.text();

  if (response.status !== 200) {
    fail(`GET ${path} returned HTTP ${response.status}, expected 200 (not_found_handling not set?)`);
  } else if (!body.includes('<div id="root">')) {
    fail(`GET ${path} returned 200 but not the console shell`);
  } else {
    pass(`${path} -> 200, console shell`);
  }
}

// --- 4. No second public hostname ----------------------------------------
// More consequential here than on the dashboard: a workers.dev hostname on the
// staff console is an internal tool published on a name nobody is watching.
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

  const subdomainResponse = await cf(
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`
  );
  const subdomainBody = await subdomainResponse.json().catch(() => null);

  if (!subdomainResponse.ok || !subdomainBody?.success) {
    // 404 means no subdomain association exists at all — the desired state.
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
      fail(`workers.dev is ENABLED for ${workerName} — the staff console has a second public hostname`);
    } else {
      pass("workers.dev disabled");
    }
    if (previewsEnabled === true) {
      fail(`preview URLs are ENABLED for ${workerName} — each version gets its own public hostname`);
    } else {
      pass("preview URLs disabled");
    }
  }

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
        fail(`${bypassUrl} is serving the console — the custom domain is not the only entry point`);
      } else {
        pass(`${bypassUrl} does not serve the console (HTTP ${response.status})`);
      }
    } catch {
      // DNS failure is the expected, desired outcome.
      pass(`${bypassUrl} does not resolve`);
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

console.log(`Smoke test passed: ${baseUrl} serves the staff console, stays noindex, targets the right API, and opens no bypass hostname.`);
