/**
 * The per-address failure throttles (lib/auth-throttle.ts).
 *
 * What is pinned: only failures count, the threshold locks the address for
 * the window, a locked address is refused before the lookup whatever it
 * presents, another address is untouched, the 401 body a guess receives is
 * unchanged, and MCP, which runs behind the same middleware, is covered too.
 * The claim preview gets the same treatment on unknown tokens.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AUTH_FAILURE_RATE_LIMIT, CLAIM_GUESS_RATE_LIMIT } from "../src/lib/auth-throttle";
import {
  WORKSPACE_A,
  resetRateLimits,
  resetTenantData,
  seedApiKey,
  seedTwoWorkspaces,
  setWorkspaceStatus,
} from "./helpers";

const URL_BASE = "https://api-test.agentdisk.io";
const MCP_URL = "https://mcp-dev.agentdisk.io/mcp";
const BAD_KEY = "ask_live_" + "z".repeat(32);

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}

function whoami(token: string | null, ip: string): Promise<Response> {
  return SELF.fetch(`${URL_BASE}/v1/whoami`, {
    headers: {
      "cf-connecting-ip": ip,
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
  });
}

async function failTimes(ip: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    expect((await whoami(BAD_KEY, ip)).status, `failure ${i + 1}`).toBe(401);
  }
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await resetTenantData();
  await resetRateLimits();
  await setWorkspaceStatus(WORKSPACE_A, "active");
});

describe("failed credentials, per address", () => {
  it("is thirty per fifteen minutes", () => {
    expect(AUTH_FAILURE_RATE_LIMIT.limit).toBe(30);
    expect(AUTH_FAILURE_RATE_LIMIT.windowSeconds).toBe(15 * 60);
  });

  it("answers every failure up to the limit with the same 401, then locks the address", async () => {
    await failTimes("203.0.113.1", AUTH_FAILURE_RATE_LIMIT.limit);

    const locked = await whoami(BAD_KEY, "203.0.113.1");
    expect(locked.status).toBe(429);
    const body = (await locked.json()) as ErrorBody;
    expect(body.error.code).toBe("LIMIT_EXCEEDED");
    expect(body.error.message).toMatch(/authentication attempts/);
    expect(body.error.details?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps the 401 body byte-identical whether or not the address is being counted", async () => {
    const first = (await (await whoami(BAD_KEY, "203.0.113.2")).json()) as ErrorBody;
    await failTimes("203.0.113.2", 5);
    const later = (await (await whoami(BAD_KEY, "203.0.113.2")).json()) as ErrorBody;
    const shape = (b: ErrorBody) => JSON.stringify({ ...b.error, requestId: "" });
    expect(shape(later)).toBe(shape(first));
  });

  it("refuses a locked address outright, even with a valid key, and only that address", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    await failTimes("203.0.113.3", AUTH_FAILURE_RATE_LIMIT.limit);

    // The whole point is to stop paying for the flood, so the lookup is not
    // made - fail2ban shape, documented in lib/auth-throttle.ts.
    expect((await whoami(token, "203.0.113.3")).status).toBe(429);
    // A neighbour is untouched.
    expect((await whoami(token, "203.0.113.4")).status).toBe(200);
    expect((await whoami(BAD_KEY, "203.0.113.4")).status).toBe(401);
  });

  it("never charges a valid key, however busy", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    for (let i = 0; i < AUTH_FAILURE_RATE_LIMIT.limit + 5; i++) {
      expect((await whoami(token, "203.0.113.5")).status).toBe(200);
    }
    // The full allowance of failures is still available afterwards.
    await failTimes("203.0.113.5", AUTH_FAILURE_RATE_LIMIT.limit);
    expect((await whoami(BAD_KEY, "203.0.113.5")).status).toBe(429);
  });

  it("counts an absent credential as a failure too", async () => {
    for (let i = 0; i < AUTH_FAILURE_RATE_LIMIT.limit; i++) {
      expect((await whoami(null, "203.0.113.6")).status).toBe(401);
    }
    expect((await whoami(null, "203.0.113.6")).status).toBe(429);
  });

  it("does not count a caller who authenticated and was then refused for another reason", async () => {
    // A key asking for the wrong workspace is a 403 from somebody who proved
    // who they are. Thirty of those must not lock the address.
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    for (let i = 0; i < AUTH_FAILURE_RATE_LIMIT.limit; i++) {
      const res = await SELF.fetch(`${URL_BASE}/v1/whoami?workspaceId=ws_SOMEBODYELSE`, {
        headers: { "cf-connecting-ip": "203.0.113.7", authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    }
    expect((await whoami(token, "203.0.113.7")).status).toBe(200);
  });

  it("covers MCP, which runs behind the same middleware", async () => {
    const rpc = (token: string, ip: string) =>
      SELF.fetch(MCP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip, authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });

    for (let i = 0; i < AUTH_FAILURE_RATE_LIMIT.limit; i++) {
      const body = (await (await rpc(BAD_KEY, "203.0.113.8")).json()) as { error?: { data?: { code: string } } };
      expect(body.error?.data?.code).toBe("UNAUTHORIZED");
    }
    const locked = (await (await rpc(BAD_KEY, "203.0.113.8")).json()) as { error?: { data?: { code: string } } };
    expect(locked.error?.data?.code).toBe("LIMIT_EXCEEDED");

    // REST and MCP share one counter per address: the same flood, the same lock.
    expect((await whoami(BAD_KEY, "203.0.113.8")).status).toBe(429);
  });
});

describe("unknown claim tokens, per address", () => {
  const preview = (token: string, ip: string) =>
    SELF.fetch(`${URL_BASE}/v1/workspaces/claim/${token}`, { headers: { "cf-connecting-ip": ip } });

  it("answers wrong guesses identically up to the limit, then locks the address", async () => {
    for (let i = 0; i < CLAIM_GUESS_RATE_LIMIT.limit; i++) {
      const res = await preview(`guess${i}`.padEnd(40, "x"), "198.51.100.1");
      expect(res.status, `guess ${i + 1}`).toBe(404);
    }
    const locked = await preview("y".repeat(40), "198.51.100.1");
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as ErrorBody).error.message).toMatch(/claim attempts/);

    // A neighbour still gets the ordinary answer.
    expect((await preview("y".repeat(40), "198.51.100.2")).status).toBe(404);
  });

  it("records every guess in claim_attempts as before, so support can still see who tried", async () => {
    for (let i = 0; i < 3; i++) await preview(`g${i}`.padEnd(40, "q"), "198.51.100.3");
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM claim_attempts WHERE ip = ?`
    ).bind("198.51.100.3").first<{ n: number }>();
    expect(row?.n).toBe(3);
  });
});
