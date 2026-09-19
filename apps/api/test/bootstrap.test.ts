import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, CREATE_WORKSPACE_RATE_LIMIT } from "../src/routes/create-workspace";
import { hashApiKey } from "../src/lib/keys";
import { ApiError } from "../src/lib/errors";
import { resetBootstrapData, resetRateLimits } from "./helpers";

const NOW = 1_780_000_000_000;
const URL_BASE = "https://api-test.agentdisk.io";

function stubSiteverify(body: unknown = { success: true, hostname: "agentdisk.io" }) {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
  );
}

function post(body: unknown, ip = "1.2.3.4"): Request {
  return new Request(`${URL_BASE}/v1/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function deps(overrides: Partial<Parameters<typeof createWorkspace>[1]> = {}) {
  return {
    db: env.DB,
    kv: env.CACHE,
    turnstileSecret: "test-secret" as string | undefined,
    allowedHostnames: undefined as string | undefined,
    now: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetRateLimits();
  await resetBootstrapData();
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /v1/workspaces - the gates", () => {
  it("refuses to run at all when the Turnstile secret is missing", async () => {
    stubSiteverify();
    // A deploy that lost its secret must not fall back to an ungated endpoint.
    await expect(
      createWorkspace(post({ turnstileToken: "t" }), deps({ turnstileSecret: undefined }))
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("rate-limits per IP at the 05 PART 13 figure", async () => {
    stubSiteverify();
    expect(CREATE_WORKSPACE_RATE_LIMIT.limit).toBe(10);
    expect(CREATE_WORKSPACE_RATE_LIMIT.windowSeconds).toBe(3600);

    for (let i = 0; i < 10; i++) {
      const res = await createWorkspace(post({ turnstileToken: "t" }, "9.9.9.9"), deps());
      expect(res.status, `call ${i}`).toBe(201);
    }
    await expect(
      createWorkspace(post({ turnstileToken: "t" }, "9.9.9.9"), deps())
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });

    // A different IP is unaffected.
    expect((await createWorkspace(post({ turnstileToken: "t" }, "8.8.8.8"), deps())).status).toBe(
      201
    );
  });

  it("counts the rate limit before spending a Turnstile round trip", async () => {
    let siteverifyCalls = 0;
    vi.stubGlobal("fetch", async () => {
      siteverifyCalls++;
      return new Response(JSON.stringify({ success: true }));
    });

    for (let i = 0; i < 10; i++) {
      await createWorkspace(post({ turnstileToken: "t" }, "7.7.7.7"), deps());
    }
    const before = siteverifyCalls;
    await expect(
      createWorkspace(post({ turnstileToken: "t" }, "7.7.7.7"), deps())
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(siteverifyCalls).toBe(before);
  });

  it("rejects a failed challenge without creating anything", async () => {
    stubSiteverify({ success: false, "error-codes": ["invalid-input-response"] });

    await expect(createWorkspace(post({ turnstileToken: "bad" }), deps())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM workspaces WHERE claimed_at IS NULL`
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("rejects a body missing the challenge token", async () => {
    stubSiteverify();
    await expect(createWorkspace(post({ name: "Mine" }), deps())).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects a body that is not JSON", async () => {
    stubSiteverify();
    await expect(createWorkspace(post("not json"), deps())).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects an agent name with characters that do not belong in a path or a log", async () => {
    stubSiteverify();
    const newline = String.fromCharCode(10);
    for (const agentName of ["../etc", `a${newline}b`, "<script>", "a;rm -rf", "x".repeat(65)]) {
      await expect(
        createWorkspace(post({ turnstileToken: "t", agentName }), deps()),
        JSON.stringify(agentName)
      ).rejects.toBeInstanceOf(ApiError);
      await resetRateLimits();
    }
  });

  it("trims surrounding whitespace rather than rejecting it", async () => {
    stubSiteverify();
    // zod applies .trim() before the pattern check, so "  bot  " is a valid
    // name that gets stored tidy - not a rejection. Asserted because the
    // ordering of those two checks is the difference between the two
    // behaviours, and it is not obvious from reading the schema.
    const res = await createWorkspace(
      post({ turnstileToken: "t", agentName: "  tidy-bot  ", name: "  My Space  " }),
      deps()
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.agent.name).toBe("tidy-bot");
    expect(body.workspace.name).toBe("My Space");
  });

  it("names no field values when it reports a validation failure", async () => {
    stubSiteverify();
    try {
      await createWorkspace(post({ turnstileToken: "", agentName: "<bad>" }), deps());
      throw new Error("expected a throw");
    } catch (err) {
      // The body carries a Turnstile token. Echoing the offending values back
      // would put it into a log line on the way out.
      const serialized = JSON.stringify((err as ApiError).details);
      expect(serialized).not.toContain("<bad>");
      expect((err as ApiError).details?.fields).toBeDefined();
    }
  });
});

describe("POST /v1/workspaces - provisioning", () => {
  it("creates the whole sandbox and returns the key exactly once", async () => {
    stubSiteverify();

    const res = await createWorkspace(
      post({ turnstileToken: "t", name: "My Sandbox", agentName: "research-bot" }),
      deps()
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    expect(body.workspace.id).toMatch(/^ws_/);
    expect(body.workspace.claimed).toBe(false);
    expect(body.agent.name).toBe("research-bot");
    expect(body.apiKey.token).toMatch(/^ask_live_[0-9A-Za-z]{32}$/);

    const ws = await env.DB.prepare(`SELECT * FROM workspaces WHERE id = ?`)
      .bind(body.workspace.id)
      .first<any>();
    expect(ws.claimed_at).toBe(null);
    expect(ws.status).toBe("active");

    const owner = await env.DB.prepare(
      `SELECT u.* FROM users u JOIN organizations o ON o.owner_user_id = u.id WHERE o.id = ?`
    )
      .bind(ws.org_id)
      .first<any>();
    expect(owner.is_provisional).toBe(1);
    // No Firebase account stands behind this row yet - that is what makes the
    // workspace claimable. `is_provisional` carries the meaning on its own now
    // that there is no password column to be null (0005).
    expect(owner.firebase_uid).toBe(null);
    expect(owner.session_revoked_after).toBe(0);
    // RFC 2606 reserves .invalid, so the placeholder can never be deliverable.
    expect(owner.email.endsWith("@agentdisk.invalid")).toBe(true);
  });

  it("stores only the hash of the key it just handed out", async () => {
    stubSiteverify();
    const body = (await (await createWorkspace(post({ turnstileToken: "t" }), deps())).json()) as any;

    const row = await env.DB.prepare(`SELECT * FROM api_keys WHERE id = ?`)
      .bind(body.apiKey.id)
      .first<any>();

    expect(row.key_hash).toBe(await hashApiKey(body.apiKey.token));
    // Neither the token nor its secret half may appear in any column.
    expect(JSON.stringify(row)).not.toContain(body.apiKey.token);
    expect(JSON.stringify(row)).not.toContain(body.apiKey.token.slice(9));
  });

  it("does not grant the sandbox key the ability to mint more keys", async () => {
    stubSiteverify();
    const body = (await (await createWorkspace(post({ turnstileToken: "t" }), deps())).json()) as any;
    // Delegation with no human in the loop is the one thing an unclaimed
    // workspace's key must not be able to do.
    expect(body.apiKey.scopes.ops).not.toContain("keys:create");
  });

  it("writes the sandbox atomically, so a failed batch leaves nothing behind", async () => {
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();

    // provisionSandboxWorkspace puts all five rows in one D1 batch, relying on
    // D1 wrapping a batch in an implicit transaction. This proves that holds
    // against this schema rather than assuming it: the second statement
    // violates workspaces.org_id's foreign key, and the first must roll back.
    //
    // (The constraint has to be one the schema actually declares. An earlier
    // version of this test used organizations.owner_user_id, which 05 PART
    // 11.1 deliberately leaves unconstrained - so it proved nothing.)
    await expect(
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO users (id, email, is_provisional, created_at, updated_at)
           VALUES ('usr_ATOMIC', 'atomic@agentdisk.invalid', 1, ?, ?)`
        ).bind(NOW, NOW),
        env.DB.prepare(
          `INSERT INTO workspaces (id, org_id, name, period_reset_at, created_at, updated_at)
           VALUES ('ws_ATOMIC', 'org_DOES_NOT_EXIST', 'x', ?, ?, ?)`
        ).bind(NOW, NOW, NOW),
      ])
    ).rejects.toThrow(/FOREIGN KEY/);

    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);

    const orphan = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = 'usr_ATOMIC'`)
      .first<{ n: number }>();
    expect(orphan?.n).toBe(0);
  });
});

describe("the full loop", () => {
  it("provisions a workspace whose key then authenticates a real request", async () => {
    stubSiteverify();

    const created = (await (
      await createWorkspace(
        post({ turnstileToken: "t", name: "Loop", agentName: "loop-bot" }),
        deps()
      )
    ).json()) as any;

    // Stop stubbing before going through the Worker: nothing below should make
    // an outbound request, and leaving the stub up would hide it if it did.
    vi.unstubAllGlobals();

    const res = await SELF.fetch(`${URL_BASE}/v1/whoami`, {
      headers: { authorization: `Bearer ${created.apiKey.token}` },
    });
    expect(res.status).toBe(200);

    const me = (await res.json()) as any;
    expect(me.workspace.id).toBe(created.workspace.id);
    expect(me.workspace.name).toBe("Loop");
    expect(me.actor).toEqual({ type: "agent", id: created.agent.id });
    expect(me.key.id).toBe(created.apiKey.id);
    expect(me.usage.storageBytes.used).toBe(0);
  });

  it("routes POST /v1/workspaces through the Worker", async () => {
    // Through the Worker, TURNSTILE_ALLOWED_HOSTNAMES comes from wrangler.toml,
    // so the challenge has to look like it was solved on the dashboard - which
    // is where the widget actually lives.
    stubSiteverify({ success: true, hostname: "app-dev.agentdisk.io" });
    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "5.5.5.5" },
      body: JSON.stringify({ turnstileToken: "t", name: "Routed" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).workspace.name).toBe("Routed");
  });

  it("enforces the configured hostname pinning end to end", async () => {
    // The same request, with a challenge solved somewhere else, is refused -
    // and this runs through the Worker, so it proves the wrangler.toml var is
    // actually reaching verifyTurnstile rather than being silently unset.
    stubSiteverify({ success: true, hostname: "somewhere-else.example" });
    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "6.6.6.6" },
      body: JSON.stringify({ turnstileToken: "t", name: "Rejected" }),
    });
    expect(res.status).toBe(403);

    const leaked = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM workspaces WHERE name = 'Rejected'`
    ).first<{ n: number }>();
    expect(leaked?.n).toBe(0);
  });

  it("does not accept the bootstrap on GET", async () => {
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspaces`).first<{ n: number }>();

    // 401, not the 404 this asserted before: an unauthenticated GET here is a
    // caller who did not authenticate, and every other route in the API says so
    // with a 401. The status was always incidental to what this test is for —
    // what matters is that a GET provisions nothing, which is asserted below.
    const res = await SELF.fetch(`${URL_BASE}/v1/workspaces`);
    expect(res.status).toBe(401);

    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspaces`).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});
