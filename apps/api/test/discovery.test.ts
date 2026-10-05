/**
 * What an agent finds when it lands on the API host with nothing but a URL.
 *
 * Skill 12, F19: `GET /` was a JSON 404 and `openapi.json` did not exist on
 * this host, so a first-time agent had no way to learn the request shapes
 * except by guessing. The description itself is published by the site build
 * (apps/web/scripts/agent-discovery.js); this host indexes it and redirects
 * to it rather than carrying a second copy that could drift.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const URL_BASE = "https://api-test.agentdisk.io";

describe("GET / on the API host", () => {
  it("is a public JSON index naming the documentation, the OpenAPI description, MCP and the sandbox call", async () => {
    const res = await SELF.fetch(`${URL_BASE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as Record<string, any>;

    // Every site link comes from SITE_URL in wrangler.toml, never from code.
    expect(body.openapi).toBe("https://dev.agentdisk.io/openapi.json");
    expect(body.docs.llms).toBe("https://dev.agentdisk.io/llms.txt");
    expect(body.docs.auth).toBe("https://dev.agentdisk.io/auth.md");
    expect(body.docs.html).toBe("https://dev.agentdisk.io/docs");
    expect(body.apiCatalog).toBe("https://dev.agentdisk.io/.well-known/api-catalog");
    // Its own routes are relative to the host it was asked on.
    expect(body.mcp).toBe(`${URL_BASE}/mcp`);
    expect(body.health).toBe(`${URL_BASE}/v1/healthz`);
    expect(body.sandbox.url).toBe(`${URL_BASE}/v1/workspaces`);
    expect(body.sandbox.method).toBe("POST");
    expect(body.sandbox.authentication).toBe("none");
  });

  it("redirects openapi.json and the API catalog to the site's copies, with the location in the body too", async () => {
    for (const [path, target] of [
      ["/openapi.json", "https://dev.agentdisk.io/openapi.json"],
      ["/.well-known/api-catalog", "https://dev.agentdisk.io/.well-known/api-catalog"],
    ]) {
      const res = await SELF.fetch(`${URL_BASE}${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location")).toBe(target);
      // A client that prints the body without following still learns where to go.
      const body = (await res.json()) as { location: string };
      expect(body.location).toBe(target);
    }
  });

  it("leaves every other unknown path a JSON 404", async () => {
    const res = await SELF.fetch(`${URL_BASE}/nothing-here`);
    expect(res.status).toBe(404);
  });
});
