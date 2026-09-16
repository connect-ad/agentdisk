import { SELF, env } from "cloudflare:test";
import { withAuth } from "../src/middleware/auth";
import { beforeEach, describe, expect, it } from "vitest";
import {
  NOW,
  WORKSPACE_A,
  WORKSPACE_B,
  bearer,
  resetTenantData,
  seedAgent,
  seedApiKey,
  seedTwoWorkspaces,
  setWorkspaceStatus,
} from "./helpers";

const URL_BASE = "https://api-test.agentdisk.io";

async function get(path: string, headers?: HeadersInit) {
  return SELF.fetch(`${URL_BASE}${path}`, headers ? { headers } : undefined);
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  await resetTenantData();
  await setWorkspaceStatus(WORKSPACE_A, "active");
  await setWorkspaceStatus(WORKSPACE_B, "active");
});

describe("GET /v1/healthz", () => {
  it("needs no credential", async () => {
    const res = await get("/v1/healthz");
    expect(res.status).toBe(200);
  });
});

describe("authentication", () => {
  it("accepts a valid key and resolves the workspace from it", async () => {
    const { token, keyId } = await seedApiKey({ workspaceId: WORKSPACE_A });

    const res = await get("/v1/whoami", bearer(token));
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.workspace.id).toBe(WORKSPACE_A);
    expect(body.key.id).toBe(keyId);
    expect(body.key.mode).toBe("live");
  });

  it("never echoes the credential back", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const secret = token.slice("ask_live_".length);

    const raw = await (await get("/v1/whoami", bearer(token))).text();

    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("key_hash");
    // The display fragments 15.3 designed for the UI are fine, and are all
    // that may appear.
    expect(raw).toContain(secret.slice(0, 8));
    expect(raw).toContain(secret.slice(-4));
  });

  it("rejects a missing credential", async () => {
    const res = await get("/v1/whoami");
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error.code).toBe("UNAUTHORIZED");
  });

  it("gives the same answer for unknown, revoked, expired and forged keys", async () => {
    const unknown = "ask_live_" + "z".repeat(32);

    const revoked = await seedApiKey({ workspaceId: WORKSPACE_A, revokedAt: NOW });
    const expired = await seedApiKey({ workspaceId: WORKSPACE_A, expiresAt: 1 });
    const real = await seedApiKey({ workspaceId: WORKSPACE_A });
    // Same prefix, same length, one character different: a near-miss guess.
    const forged = real.token.slice(0, -1) + (real.token.endsWith("a") ? "b" : "a");

    const bodies: ErrorBody[] = [];
    for (const token of [unknown, revoked.token, expired.token, forged]) {
      const res = await get("/v1/whoami", bearer(token));
      expect(res.status, token.slice(0, 16)).toBe(401);
      bodies.push((await res.json()) as ErrorBody);
    }

    // Everything except the request ID must be byte-identical. A caller that
    // can tell "revoked" from "unknown" has an oracle for which guesses are
    // real keys.
    const shapes = bodies.map((b) => JSON.stringify({ ...b.error, requestId: "" }));
    expect(new Set(shapes).size).toBe(1);
    for (const body of bodies) {
      expect(body.error.details).toBeUndefined();
      expect(body.error.requestId).toMatch(/^req_/);
    }
  });

  it("rejects a key belonging to a disabled agent", async () => {
    const agentId = await seedAgent({ id: "agt_DISABLED", status: "disabled" });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, agentId });

    expect((await get("/v1/whoami", bearer(token))).status).toBe(401);
  });

  it("accepts a key belonging to an active agent, as that agent", async () => {
    const agentId = await seedAgent({ id: "agt_ACTIVE", status: "active" });
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, agentId });

    const res = await get("/v1/whoami", bearer(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.actor).toEqual({ type: "agent", id: agentId });
  });

  it("refuses a credential sent in the query string", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });

    const res = await get(`/v1/whoami?api_key=${token}`);
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("Authorization header");
    // The burned key must not be repeated back into another log line.
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it("refuses it even when the header is also correct", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    const res = await get(`/v1/whoami?access_token=${token}`, bearer(token));
    expect(res.status).toBe(400);
  });

  it("records that the key was used", async () => {
    const { token, keyId } = await seedApiKey({ workspaceId: WORKSPACE_A });

    const before = await env.DB.prepare(`SELECT last_used_at FROM api_keys WHERE id = ?`)
      .bind(keyId)
      .first<{ last_used_at: number | null }>();
    expect(before?.last_used_at).toBe(null);

    expect((await get("/v1/whoami", bearer(token))).status).toBe(200);

    const after = await env.DB.prepare(`SELECT last_used_at FROM api_keys WHERE id = ?`)
      .bind(keyId)
      .first<{ last_used_at: number | null }>();
    expect(after?.last_used_at).toBeGreaterThan(0);
  });
});

describe("workspace resolution", () => {
  it("resolves the caller's own workspace, not one they name", async () => {
    const b = await seedApiKey({ workspaceId: WORKSPACE_B });

    const res = await get("/v1/whoami", bearer(b.token));
    const body = (await res.json()) as Record<string, any>;
    expect(body.workspace.id).toBe(WORKSPACE_B);
  });

  it("rejects a request naming a workspace the key is not scoped to", async () => {
    const b = await seedApiKey({ workspaceId: WORKSPACE_B });

    const res = await get(`/v1/whoami?workspaceId=${WORKSPACE_A}`, bearer(b.token));
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe("FORBIDDEN");
  });

  it("accepts a request naming its own workspace", async () => {
    const a = await seedApiKey({ workspaceId: WORKSPACE_A });

    const res = await get(`/v1/whoami?workspaceId=${WORKSPACE_A}`, bearer(a.token));
    expect(res.status).toBe(200);
  });

  it("refuses to serve a suspended workspace", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    await setWorkspaceStatus(WORKSPACE_A, "suspended");

    const res = await get("/v1/whoami", bearer(token));
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.message).toContain("suspended");
  });
});

describe("error envelope", () => {
  it("uses the 05 PART 13 shape on an unknown route", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });

    const res = await get("/v1/nope", bearer(token));
    expect(res.status).toBe(404);

    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.requestId).toMatch(/^req_/);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("gives every response a distinct request ID", async () => {
    const a = (await (await get("/v1/whoami")).json()) as ErrorBody;
    const b = (await (await get("/v1/whoami")).json()) as ErrorBody;
    expect(a.error.requestId).not.toBe(b.error.requestId);
  });
});

describe("the chain's authorize step", () => {
  // whoami requires a credential but no capability, so it cannot exercise step 4.
  // These drive withAuth directly until Phase 3 adds routes that declare an op.
  const request = (path = "/v1/files", token?: string) =>
    new Request(`${URL_BASE}${path}`, {
      headers: token ? bearer(token) : undefined,
    });

  const ok = async () => new Response("ok");

  async function run(
    token: string,
    requirement: Parameters<typeof withAuth>[2],
    path = "/v1/files"
  ) {
    return withAuth(request(path, token), { db: env.DB, files: env.FILES, signing: null, requestId: "req_TEST", firebase: null }, requirement, ok);
  }

  it("runs the handler when the op is granted", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "write"] });
    const res = await run(token, { op: "write", path: "/notes/a.md" });
    expect(res.status).toBe(200);
  });

  it("stops before the handler when the op is not granted", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read"] });
    await expect(run(token, { op: "write", path: "/notes/a.md" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("stops before the handler when the path is outside the key's prefix", async () => {
    const { token } = await seedApiKey({
      workspaceId: WORKSPACE_A,
      ops: ["read", "write"],
      pathPrefix: "/agents/bot/*",
    });

    await expect(run(token, { op: "write", path: "/agents/bot-evil/x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(run(token, { op: "write", path: "/agents/bot/x" })).resolves.toMatchObject({
      status: 200,
    });
  });

  it("hands the handler repositories bound to the key's workspace", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_B });

    const seen: string[] = [];
    const res = await withAuth(
      request("/v1/files", token),
      { db: env.DB, files: env.FILES, signing: null, requestId: "req_TEST", firebase: null },
      { op: null },
      async (ctx) => {
        seen.push(ctx.workspaceId);
        // The context carries repositories, not a raw binding: there is no
        // ctx.env and no way for a handler to reach an unscoped D1 client.
        expect(Object.keys(ctx.db)).toContain("files");
        expect(ctx).not.toHaveProperty("env");
        return new Response("ok");
      }
    );

    expect(res.status).toBe(200);
    expect(seen).toEqual([WORKSPACE_B]);
  });

  it("refuses a quota-relevant request that would exceed the plan's storage", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A });
    // Free plan is 2 GB (07 PART 19.0).
    await env.DB.prepare(`UPDATE workspaces SET storage_bytes_used = ? WHERE id = ?`)
      .bind(2 * 1024 ** 3 - 10, WORKSPACE_A)
      .run();

    await expect(
      run(token, { op: "write", path: "/big.bin", demand: { bytes: 1000 } })
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });

    await expect(
      run(token, { op: "write", path: "/small.bin", demand: { bytes: 5 } })
    ).resolves.toMatchObject({ status: 200 });

    await env.DB.prepare(`UPDATE workspaces SET storage_bytes_used = 0 WHERE id = ?`)
      .bind(WORKSPACE_A)
      .run();
  });
});

/**
 * Every authenticated route answers a missing credential the same way it
 * answers an unusable one.
 *
 * This is a sweep rather than a handful of examples because the fault it exists
 * to catch was a single route disagreeing with the other forty. `GET
 * /v1/workspaces` returned 404 "No such route." when no Authorization header
 * was present — it was hand-routed rather than going through `withAuth`, and
 * the hand-written branch treated "no token" as "no route". From a caller's
 * side that is indistinguishable from a typo'd URL, so the actual problem (you
 * forgot to authenticate) was the one thing the response ruled out.
 *
 * Enumerating the table by hand is the point: a route added outside `withAuth`
 * has to be added here too, and a route that reports 404 for an absent
 * credential fails.
 */
describe("an absent credential is 401 on every authenticated route", () => {
  const AUTHENTICATED: [string, string][] = [
    ["GET", "/v1/whoami"],
    ["POST", "/v1/me/logout-all"],
    ["GET", "/v1/search?q=x"],
    ["GET", "/v1/activity"],
    ["GET", "/v1/workspaces"],
    ["DELETE", `/v1/workspaces/${WORKSPACE_A}`],
    ["GET", "/v1/billing"],
    ["POST", "/v1/billing/portal-session"],
    ["GET", "/v1/members"],
    ["POST", "/v1/members"],
    ["PATCH", "/v1/members/mem_x"],
    ["DELETE", "/v1/members/mem_x"],
    ["GET", "/v1/agents"],
    ["POST", "/v1/agents"],
    ["GET", "/v1/agents/agt_x"],
    ["PATCH", "/v1/agents/agt_x"],
    ["DELETE", "/v1/agents/agt_x"],
    ["GET", "/v1/keys"],
    ["POST", "/v1/keys"],
    ["DELETE", "/v1/keys/key_x"],
    ["GET", "/v1/files"],
    ["POST", "/v1/files"],
    ["GET", "/v1/files/fil_x"],
    ["PATCH", "/v1/files/fil_x"],
    ["DELETE", "/v1/files/fil_x"],
    ["GET", "/v1/files/fil_x/download"],
    ["POST", "/v1/files/fil_x/complete"],
    ["POST", "/v1/files/fil_x/restore"],
    ["POST", "/v1/files/fil_x/move"],
    ["POST", "/v1/files/fil_x/copy"],
    ["GET", "/v1/folders"],
    ["POST", "/v1/folders"],
    ["DELETE", "/v1/folders/fld_x"],
    ["GET", "/v1/webhooks"],
    ["POST", "/v1/webhooks"],
    ["PATCH", "/v1/webhooks/wh_x"],
    ["DELETE", "/v1/webhooks/wh_x"],
    ["GET", "/v1/staff/whoami"],
    ["GET", "/v1/staff/overview"],
    ["GET", "/v1/staff/workspaces"],
    ["GET", `/v1/staff/workspaces/${WORKSPACE_A}`],
    ["POST", `/v1/staff/users/usr_x/force-logout`],
  ];

  it.each(AUTHENTICATED)("%s %s", async (method, path) => {
    const res = await SELF.fetch(`${URL_BASE}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json<ErrorBody>()).error.code).toBe("UNAUTHORIZED");
  });

  /**
   * The other half of the ask: nothing that was legitimately public became
   * authenticated. Asserted as "not 401" rather than a specific status because
   * what each of these returns next is that handler's own business — the
   * sandbox still has Turnstile to answer to, and Stripe still has a signature.
   */
  it("leaves the genuinely public routes public", async () => {
    const health = await SELF.fetch(`${URL_BASE}/v1/healthz`);
    expect(health.status).toBe(200);

    // The Turnstile-gated sandbox: an agent provisioning its own workspace with
    // no credential at all is the product's onboarding, not an auth failure.
    const sandbox = await SELF.fetch(`${URL_BASE}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sandbox" }),
    });
    expect(sandbox.status).not.toBe(401);

    // Stripe holds no credential of ours; it authenticates by signing the body.
    // So it is reachable without a bearer token — and then refuses this one on
    // its own terms, because there is no signature over it. That refusal is
    // also a 401, which is correct and is NOT the router's credential gate: the
    // distinguishing fact is that the request reached the handler at all.
    const stripe = await SELF.fetch(`${URL_BASE}/v1/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(stripe.status).not.toBe(404);
  });

  /**
   * A URL that names no route is still a 404. The fix above must not have
   * turned "I cannot find that" into "you are not logged in" — that would hand
   * back the same confusion pointing the other way.
   */
  it("still reports an unknown route as 404, credential or not", async () => {
    const res = await SELF.fetch(`${URL_BASE}/v1/nonsense`);
    expect(res.status).toBe(404);
  });
});
