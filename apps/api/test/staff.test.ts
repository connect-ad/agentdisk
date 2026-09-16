/**
 * Staff console — 14 PART 27.
 *
 * A staff credential is the only one in this system with cross-tenant reach, so
 * the cases that matter are the ones where getting it wrong is both severe and
 * invisible: a login that accepts a correct password without a correct code, a
 * staff token that works on a customer route, a support engineer who can
 * suspend a workspace, or a cross-tenant read that leaves no trace.
 *
 * The audit assertions carry the most weight. `StaffScopedAccess` exists to
 * break the isolation every other path enforces, and the only thing that makes
 * that acceptable is that every use of it is recorded — including reads, which
 * is exactly the access somebody would most like to be unrecorded.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { currentTotp, encryptSecret, hashPassword } from "../src/staff/crypto";
import { NOW, WORKSPACE_A, WORKSPACE_B, bearer, seedApiKey, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";

/** Matches the binding vitest.config.ts supplies. */
const ENCRYPTION_KEY = "test-database-encryption-key";
/** RFC 6238's secret, so a valid code can be produced deterministically. */
const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const PASSWORD = "a-long-staff-password";

/** A code that is valid right now, produced the same way an app would. */
const currentCode = (): Promise<string> => currentTotp(TOTP_SECRET, Date.now());

async function seedStaff(id: string, email: string, role: string, disabled = false): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO staff_users
       (id, email, password_hash, totp_secret, role, disabled_at, last_login_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
  )
    .bind(
      id,
      email,
      await hashPassword(PASSWORD),
      await encryptSecret(TOTP_SECRET, ENCRYPTION_KEY),
      role,
      disabled ? NOW : null,
      NOW
    )
    .run();
}

function post(path: string, body?: unknown, token?: string): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method: "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function get(path: string, token?: string): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

async function login(email: string): Promise<string> {
  const res = await post("/v1/staff/login", {
    email,
    password: PASSWORD,
    totp: await currentCode(),
  });
  const body = (await res.json()) as { token?: string };
  if (body.token === undefined) throw new Error(`login failed: ${JSON.stringify(body)}`);
  return body.token;
}

beforeEach(async () => {
  await seedTwoWorkspaces();
  for (const table of ["staff_sessions", "staff_users", "audit_events", "api_keys"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(`UPDATE workspaces SET status = 'active'`).run();
  // The login limiter counts in KV and would otherwise leak between tests.
  for (const email of ["support@agentdisk.io", "admin@agentdisk.io", "super@agentdisk.io"]) {
    await env.CACHE.delete(`staff:login:${email}`);
  }

  await seedStaff("stf_SUPPORT", "support@agentdisk.io", "support");
  await seedStaff("stf_ADMIN", "admin@agentdisk.io", "admin");
  await seedStaff("stf_SUPER", "super@agentdisk.io", "super_admin");
});

describe("login", () => {
  it("succeeds with password and a correct code", async () => {
    const res = await post("/v1/staff/login", {
      email: "admin@agentdisk.io",
      password: PASSWORD,
      totp: await currentCode(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; staff: { role: string } };
    expect(body.token).toHaveLength(64);
    expect(body.staff.role).toBe("admin");
  });

  it("refuses a correct password with a wrong code", async () => {
    // The whole point of the second factor. If this ever passes, TOTP is
    // decorative and nobody would notice from the outside.
    const res = await post("/v1/staff/login", {
      email: "admin@agentdisk.io",
      password: PASSWORD,
      totp: "000000",
    });
    expect(res.status).toBe(401);
  });

  it("refuses a correct code with a wrong password", async () => {
    const res = await post("/v1/staff/login", {
      email: "admin@agentdisk.io",
      password: "not the password",
      totp: await currentCode(),
    });
    expect(res.status).toBe(401);
  });

  it("has no way to log in without a code at all", async () => {
    const res = await post("/v1/staff/login", {
      email: "admin@agentdisk.io",
      password: PASSWORD,
    });
    expect(res.status).toBe(400);
  });

  it("answers identically for an unknown account and a wrong password", async () => {
    // Otherwise this enumerates staff accounts, and an attacker can then spend
    // their effort on one they know exists.
    const unknown = await post("/v1/staff/login", {
      email: "nobody@agentdisk.io",
      password: PASSWORD,
      totp: await currentCode(),
    });
    const wrong = await post("/v1/staff/login", {
      email: "admin@agentdisk.io",
      password: "wrong",
      totp: await currentCode(),
    });
    expect(unknown.status).toBe(wrong.status);

    // Everything except the request ID, which is unique per request by design
    // and is the one field that is *supposed* to differ.
    const strip = async (res: Response) => {
      const body = (await res.json()) as { error: Record<string, unknown> };
      const { requestId: _ignored, ...rest } = body.error;
      return rest;
    };
    expect(await strip(unknown)).toEqual(await strip(wrong));
  });

  it("refuses a disabled account", async () => {
    await seedStaff("stf_OFF", "off@agentdisk.io", "admin", true);
    const res = await post("/v1/staff/login", {
      email: "off@agentdisk.io",
      password: PASSWORD,
      totp: await currentCode(),
    });
    expect(res.status).toBe(401);
  });

  it("locks out after repeated failures", async () => {
    for (let i = 0; i < 5; i += 1) {
      await post("/v1/staff/login", {
        email: "admin@agentdisk.io",
        password: "wrong",
        totp: "000000",
      });
    }
    // Even the correct credentials are refused now - which is the point.
    const res = await post("/v1/staff/login", {
      email: "admin@agentdisk.io",
      password: PASSWORD,
      totp: await currentCode(),
    });
    expect(res.status).toBe(429);
  });
});

describe("sessions", () => {
  it("resolves a valid session", async () => {
    const token = await login("admin@agentdisk.io");
    const res = await get("/v1/staff/whoami", token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { staff: { email: string } }).staff.email).toBe("admin@agentdisk.io");
  });

  it("stops working after logout", async () => {
    const token = await login("admin@agentdisk.io");
    expect((await post("/v1/staff/logout", undefined, token)).status).toBe(200);
    expect((await get("/v1/staff/whoami", token)).status).toBe(401);
  });

  it("stops working the moment the account is disabled", async () => {
    // Not "when the session expires". Disabling somebody is usually urgent.
    const token = await login("admin@agentdisk.io");
    await env.DB.prepare(`UPDATE staff_users SET disabled_at = ? WHERE id = 'stf_ADMIN'`)
      .bind(Date.now()).run();
    expect((await get("/v1/staff/whoami", token)).status).toBe(401);
  });

  it("refuses a made-up token", async () => {
    expect((await get("/v1/staff/whoami", "f".repeat(64))).status).toBe(401);
    expect((await get("/v1/staff/whoami")).status).toBe(401);
  });

  it("stores only a hash of the session token", async () => {
    const token = await login("admin@agentdisk.io");
    const rows = await env.DB.prepare(`SELECT token_hash FROM staff_sessions`).all<{ token_hash: string }>();
    expect(rows.results?.[0]?.token_hash).not.toBe(token);
    expect(JSON.stringify(rows.results)).not.toContain(token);
  });
});

describe("staff and customer credentials never cross", () => {
  it("a staff token is not accepted on a customer route", async () => {
    const token = await login("admin@agentdisk.io");
    const res = await get(`/v1/whoami?workspaceId=${WORKSPACE_A}`, token);
    expect(res.status).toBe(401);
  });

  it("an API key is not accepted on a staff route", async () => {
    const { token } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "list"] });
    expect((await get("/v1/staff/whoami", token)).status).toBe(401);
    expect((await get("/v1/staff/workspaces", token)).status).toBe(401);
  });
});

describe("the role matrix", () => {
  it("lets support read the fleet", async () => {
    const token = await login("support@agentdisk.io");
    const res = await get("/v1/staff/workspaces", token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: { id: string }[] };
    // Cross-tenant by design: both workspaces, belonging to nobody they own.
    expect(body.workspaces.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses support the ability to suspend a workspace", async () => {
    const token = await login("support@agentdisk.io");
    const res = await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, {
      status: "suspended",
      reason: "testing",
    }, token);
    expect(res.status).toBe(403);
  });

  it("lets admin suspend and reinstate", async () => {
    const token = await login("admin@agentdisk.io");
    expect(
      (await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, { status: "suspended", reason: "abuse report" }, token)).status
    ).toBe(200);
    expect(
      (await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, { status: "active", reason: "resolved" }, token)).status
    ).toBe(200);
  });

  it("requires a reason", async () => {
    // A suspension nobody can explain later is worse than none.
    const token = await login("admin@agentdisk.io");
    const res = await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, { status: "suspended" }, token);
    expect(res.status).toBe(400);
  });

  it("refuses admin the ability to create staff", async () => {
    const token = await login("admin@agentdisk.io");
    const res = await post("/v1/staff/users", { email: "new@agentdisk.io", role: "support" }, token);
    expect(res.status).toBe(403);
  });
});

describe("suspending a workspace stops its keys without touching them", () => {
  it("refuses the key on its very next call, and leaves revoked_at alone", async () => {
    // 06 PART 16.1 step 5 is what makes this work: the chain reads
    // workspaces.status on every request, so there is no key-hunting to do and
    // reinstating needs no re-minting.
    const { token: key, keyId } = await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read", "list"] });
    const other = await seedApiKey({ workspaceId: WORKSPACE_B, ops: ["read", "list"] });

    expect((await SELF.fetch(`${URL_BASE}/v1/whoami`, { headers: bearer(key) })).status).toBe(200);

    const staff = await login("admin@agentdisk.io");
    await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, { status: "suspended", reason: "abuse" }, staff);

    expect((await SELF.fetch(`${URL_BASE}/v1/whoami`, { headers: bearer(key) })).status).toBe(403);
    // The other workspace is untouched.
    expect((await SELF.fetch(`${URL_BASE}/v1/whoami`, { headers: bearer(other.token) })).status).toBe(200);

    const row = await env.DB.prepare(`SELECT revoked_at FROM api_keys WHERE id = ?`)
      .bind(keyId).first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).toBeNull();

    // And reinstating brings it back with no re-mint.
    await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, { status: "active", reason: "resolved" }, staff);
    expect((await SELF.fetch(`${URL_BASE}/v1/whoami`, { headers: bearer(key) })).status).toBe(200);
  });
});

describe("everything staff do is recorded", () => {
  async function staffEvents(workspaceId: string): Promise<{ action: string; metadata: string | null }[]> {
    const rows = await env.DB.prepare(
      `SELECT action, metadata FROM audit_events
        WHERE workspace_id = ? AND actor_type = 'staff' ORDER BY created_at ASC, rowid ASC`
    ).bind(workspaceId).all<{ action: string; metadata: string | null }>();
    return rows.results ?? [];
  }

  it("records a read, not only a change", async () => {
    // The access somebody would most like to be unrecorded.
    const token = await login("support@agentdisk.io");
    await get(`/v1/staff/workspaces/${WORKSPACE_A}`, token);

    const events = await staffEvents(WORKSPACE_A);
    expect(events.map(e => e.action)).toContain("staff.workspace.viewed");
  });

  it("records who did it and in what role", async () => {
    const token = await login("admin@agentdisk.io");
    await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, { status: "suspended", reason: "spam" }, token);

    const suspend = (await staffEvents(WORKSPACE_A)).find(e => e.action === "staff.workspace.suspended");
    const metadata = JSON.parse(suspend?.metadata ?? "{}") as Record<string, string>;
    expect(metadata.staffEmail).toBe("admin@agentdisk.io");
    expect(metadata.staffRole).toBe("admin");
    expect(metadata.reason).toBe("spam");
  });

  it("records viewing a workspace's activity", async () => {
    const token = await login("support@agentdisk.io");
    await get(`/v1/staff/workspaces/${WORKSPACE_A}/activity`, token);
    expect((await staffEvents(WORKSPACE_A)).map(e => e.action)).toContain("staff.activity.viewed");
  });

  it("writes key revocation into the customer's own log, not only ours", async () => {
    // A workspace owner reading their audit log should see that their keys were
    // revoked and by whom - not have it recorded somewhere only we can see.
    await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read"] });
    const token = await login("admin@agentdisk.io");
    await post("/v1/staff/users/usr_TESTUSER/revoke-keys", undefined, token);

    expect((await staffEvents(WORKSPACE_A)).map(e => e.action)).toContain("staff.keys.revoked");
  });
});
