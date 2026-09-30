import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ROBOTS_TXT, X_ROBOTS_TAG } from "../src/lib/robots";

const URL_BASE = "https://api-test.agentdisk.io";

/**
 * The Worker is never indexable, on any route, in any environment. Pinned on
 * the exits rather than on one handler: the property is "every response",
 * and the routes below are chosen because each leaves through a different
 * path — a public handler, the error envelope for an unknown route, and the
 * refusal `withAuth` writes for a missing credential.
 */
describe("search-engine indexing is refused", () => {
  it("serves a robots.txt that disallows everything", async () => {
    const response = await SELF.fetch(`${URL_BASE}/robots.txt`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(ROBOTS_TXT);
    expect(ROBOTS_TXT).toMatch(/^User-agent: \*\nDisallow: \/\n$/);
  });

  it.each([
    ["a public route", "/v1/healthz", 200],
    ["an unknown route", "/nothing/here", 404],
    ["an authenticated route with no credential", "/v1/whoami", 401],
  ])("sets X-Robots-Tag on %s", async (_label, path, status) => {
    const response = await SELF.fetch(`${URL_BASE}${path}`);
    expect(response.status).toBe(status);
    expect(response.headers.get("x-robots-tag")).toBe(X_ROBOTS_TAG);
  });

  it("does not depend on ENVIRONMENT, so prod cannot opt in by mistake", () => {
    // The value is a constant, not a function of env. If this ever becomes
    // configurable, the test above must run once per environment value.
    expect(X_ROBOTS_TAG).toBe("noindex, nofollow");
  });
});
