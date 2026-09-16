/**
 * CORS, through the real Worker - 06 PART 16.9.
 *
 * This is the gate that made the dashboard unable to reach the API at all, and
 * it is worth being blunt about why it went unnoticed: every curl and every
 * other test in this suite passes without a single CORS header. Only a real
 * browser, on a real second origin, sends a preflight. So these tests send one.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseAllowedOrigins, resolveAllowedOrigin } from "../src/lib/cors";

const URL_BASE = "https://api-dev.agentdisk.io";
const DASHBOARD = "https://app-dev.agentdisk.io";

function preflight(path: string, origin: string, method = "POST"): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": "authorization, content-type",
    },
  });
}

describe("preflight", () => {
  it("permits the dashboard origin, without authentication", async () => {
    // No Authorization header anywhere in this request - a browser has not sent
    // the real call yet. If the chain ran first, every cross-origin request in
    // existence would be rejected here.
    const res = await preflight("/v1/workspaces", DASHBOARD);

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("answers for a route that needs a credential, too", async () => {
    const res = await preflight("/v1/files", DASHBOARD, "GET");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
  });

  it("gives an unlisted origin no permission, and no information", async () => {
    const res = await preflight("/v1/workspaces", "https://evil.example");
    // A 204 either way: refusing with a 403 would tell a probing script which
    // origins are configured, and the browser blocks the call regardless.
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never answers with a wildcard", async () => {
    const res = await preflight("/v1/files", DASHBOARD);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});

describe("actual responses", () => {
  it("carries the header on a successful public route", async () => {
    const res = await SELF.fetch(`${URL_BASE}/v1/healthz`, { headers: { origin: DASHBOARD } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("carries the header on an error, so the browser lets script read it", async () => {
    // A 401 a browser refuses to expose is indistinguishable from the network
    // being down, and "that credential isn't valid" is the whole message.
    const res = await SELF.fetch(`${URL_BASE}/v1/whoami`, {
      headers: { origin: DASHBOARD, authorization: "Bearer ask_live_nonsense" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
  });

  it("carries it on a 404 as well", async () => {
    const res = await SELF.fetch(`${URL_BASE}/v1/nope`, { headers: { origin: DASHBOARD } });
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe(DASHBOARD);
  });

  it("omits it entirely for an unlisted origin", async () => {
    const res = await SELF.fetch(`${URL_BASE}/v1/healthz`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("stays silent when there is no Origin at all", async () => {
    // curl, an SDK, an agent. Same-origin and non-browser callers are not a
    // CORS concern and should not be handed headers implying they are.
    const res = await SELF.fetch(`${URL_BASE}/v1/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("origin matching", () => {
  const env = { CORS_ALLOWED_ORIGINS: "https://app-dev.agentdisk.io,http://localhost:5173" };

  const withOrigin = (origin: string) =>
    resolveAllowedOrigin(new Request("https://api.test/", { headers: { origin } }), env);

  it("matches the configured origins exactly", () => {
    expect(withOrigin("https://app-dev.agentdisk.io")).toBe("https://app-dev.agentdisk.io");
    expect(withOrigin("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("refuses a lookalike domain", () => {
    // The classic failure: a suffix check on "agentdisk.io" accepts all of these.
    expect(withOrigin("https://evil-agentdisk.io")).toBeNull();
    expect(withOrigin("https://app-dev.agentdisk.io.evil.example")).toBeNull();
    expect(withOrigin("https://notapp-dev.agentdisk.io")).toBeNull();
  });

  it("refuses the right host on the wrong scheme or port", () => {
    expect(withOrigin("http://app-dev.agentdisk.io")).toBeNull();
    expect(withOrigin("https://app-dev.agentdisk.io:8443")).toBeNull();
    expect(withOrigin("http://localhost:3000")).toBeNull();
  });

  it("allows nothing when nothing is configured", () => {
    expect(resolveAllowedOrigin(
      new Request("https://api.test/", { headers: { origin: "https://app-dev.agentdisk.io" } }),
      {}
    )).toBeNull();
  });

  it("tolerates whitespace and empty entries in the config", () => {
    expect(parseAllowedOrigins(" https://a.example , ,https://b.example ")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
  });
});
