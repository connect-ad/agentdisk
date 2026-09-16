import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAllowedHostnames, verifyTurnstile } from "../src/lib/turnstile";

/**
 * `fetchMock` from cloudflare:test is gone in vitest-pool-workers 0.22, and
 * stubbing the global is better here anyway: it lets these tests assert what we
 * actually sent, which is how the "secret is never in the URL" check below is
 * possible at all.
 */
interface Captured {
  url: string;
  method: string | undefined;
  form: Record<string, string>;
}

function stubFetch(handler: () => Response | Promise<Response>): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const form: Record<string, string> = {};
    if (init?.body instanceof FormData) {
      for (const [k, v] of init.body) form[k] = String(v);
    }
    captured.push({ url: String(input), method: init?.method, form });
    return handler();
  });
  return captured;
}

const jsonReply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("verifyTurnstile", () => {
  it("posts the secret in the body, never in the URL", async () => {
    const calls = stubFetch(() => jsonReply({ success: true, hostname: "agentdisk.io" }));

    await verifyTurnstile("the-secret", "the-token", { remoteIp: "1.2.3.4" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    // A secret in a query string is the exact leak 16.4 closes off elsewhere.
    expect(calls[0]!.url).not.toContain("the-secret");
    expect(calls[0]!.form).toEqual({
      secret: "the-secret",
      response: "the-token",
      remoteip: "1.2.3.4",
    });
  });

  it("accepts a successful verification", async () => {
    stubFetch(() => jsonReply({ success: true, hostname: "agentdisk.io" }));
    const result = await verifyTurnstile("secret", "token");
    expect(result.success).toBe(true);
    expect(result.hostname).toBe("agentdisk.io");
  });

  it("rejects an explicit failure and keeps Cloudflare's codes for the log", async () => {
    stubFetch(() => jsonReply({ success: false, "error-codes": ["invalid-input-response"] }));
    const result = await verifyTurnstile("secret", "token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(["invalid-input-response"]);
  });

  it("rejects anything that is not a literal true", async () => {
    // A proxy that stringified the body would turn `false` into "false", which
    // is truthy. Strict equality is why that cannot become a pass.
    for (const success of ["true", 1, {}, null, "yes"]) {
      stubFetch(() => jsonReply({ success }));
      expect((await verifyTurnstile("secret", "token")).success, String(success)).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("fails closed on a non-200, even if the body claims success", async () => {
    stubFetch(() => jsonReply({ success: true }, 500));
    const result = await verifyTurnstile("secret", "token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(["siteverify-http-500"]);
  });

  it("fails closed on an unparseable body", async () => {
    stubFetch(() => new Response("<html>nope</html>", { status: 200 }));
    const result = await verifyTurnstile("secret", "token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(["siteverify-unparseable"]);
  });

  it("fails closed when siteverify cannot be reached", async () => {
    // Turnstile being down must stop us issuing sandbox workspaces. Any other
    // behaviour turns an outage into an open gate.
    stubFetch(() => {
      throw new Error("connection refused");
    });
    const result = await verifyTurnstile("secret", "token");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(["siteverify-unreachable"]);
  });

  it("pins the hostname when one is configured", async () => {
    stubFetch(() => jsonReply({ success: true, hostname: "evil.example" }));
    const result = await verifyTurnstile("secret", "token", {
      allowedHostnames: ["agentdisk.io", "api-dev.agentdisk.io"],
    });
    expect(result.success).toBe(false);
    expect(result.errorCodes).toEqual(["hostname-mismatch"]);
  });

  it("accepts a pinned hostname that matches", async () => {
    stubFetch(() => jsonReply({ success: true, hostname: "api-dev.agentdisk.io" }));
    const result = await verifyTurnstile("secret", "token", {
      allowedHostnames: ["agentdisk.io", "api-dev.agentdisk.io"],
    });
    expect(result.success).toBe(true);
  });

  it("skips the hostname check when nothing is configured", async () => {
    stubFetch(() => jsonReply({ success: true, hostname: "whatever.example" }));
    expect((await verifyTurnstile("secret", "token", { allowedHostnames: [] })).success).toBe(true);
  });
});

describe("parseAllowedHostnames", () => {
  it("splits, trims and drops empties", () => {
    expect(parseAllowedHostnames(" a.io , b.io ,, ")).toEqual(["a.io", "b.io"]);
    expect(parseAllowedHostnames(undefined)).toEqual([]);
    expect(parseAllowedHostnames("")).toEqual([]);
  });
});
