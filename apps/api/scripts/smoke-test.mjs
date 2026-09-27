/**
 * Post-deploy smoke test.
 *
 * Exits non-zero on any failure so the deploy job fails loudly. Retries with
 * backoff, because a fresh Worker deploy and its custom-domain routing can take
 * a few seconds to propagate globally — a bare single request would produce
 * flaky red builds and train people to ignore them.
 */
const baseUrl = process.argv[2];
const expectedEnvironment = process.argv[3];

if (!baseUrl || !expectedEnvironment) {
  console.error("usage: smoke-test.mjs <base-url> <expected-environment>");
  process.exit(1);
}

const ATTEMPTS = 6;
const target = `${baseUrl.replace(/\/$/, "")}/v1/healthz`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastFailure = "no attempt made";

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    const response = await fetch(target, { headers: { accept: "application/json" } });

    if (!response.ok) {
      lastFailure = `HTTP ${response.status}`;
    } else {
      const body = await response.json();

      if (body.status !== "ok") {
        lastFailure = `status was ${JSON.stringify(body.status)}, expected "ok"`;
      } else if (body.environment !== expectedEnvironment) {
        // A wrong environment here means the deploy hit the wrong Worker — the
        // single most dangerous outcome this pipeline can produce. Never retry
        // past it, never treat it as transient.
        console.error(
          `FATAL: ${target} reports environment "${body.environment}" but this ` +
            `job deployed "${expectedEnvironment}". Refusing to pass — the deploy ` +
            `may have targeted the wrong environment.`
        );
        process.exit(1);
      } else {
        // Indexing is refused on every response and by robots.txt, in every
        // environment (src/lib/robots.ts). Checked on the deployed Worker
        // because the header is attached at the exit, and an exit added later
        // that skips the wrapper would pass every unit test.
        const robotsTag = response.headers.get("x-robots-tag") ?? "";
        if (!/\bnoindex\b/.test(robotsTag)) {
          console.error(`FATAL: ${target} carries X-Robots-Tag "${robotsTag}", expected noindex.`);
          process.exit(1);
        }
        const robotsUrl = `${baseUrl.replace(/\/$/, "")}/robots.txt`;
        const robots = await fetch(robotsUrl);
        const robotsBody = await robots.text();
        if (!robots.ok || !/^Disallow: \/\s*$/m.test(robotsBody)) {
          console.error(`FATAL: ${robotsUrl} answered HTTP ${robots.status} without "Disallow: /".`);
          process.exit(1);
        }

        console.log(`Smoke test passed: ${target}`);
        console.log(`  environment: ${body.environment}`);
        console.log(`  commit:      ${body.commit}`);
        console.log(`  indexing:    refused (X-Robots-Tag: ${robotsTag}; robots.txt disallows /)`);
        process.exit(0);
      }
    }
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
  }

  if (attempt < ATTEMPTS) {
    const delayMs = attempt * 5000;
    console.log(`Attempt ${attempt}/${ATTEMPTS} failed (${lastFailure}); retrying in ${delayMs / 1000}s`);
    await sleep(delayMs);
  }
}

console.error(`Smoke test FAILED after ${ATTEMPTS} attempts against ${target}: ${lastFailure}`);
process.exit(1);
