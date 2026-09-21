/**
 * Staff console — 14 PART 27, as amended by migration 0014.
 *
 * A staff credential is the only one in this system with cross-tenant reach, so
 * the cases that matter are the ones where getting it wrong is both severe and
 * invisible: a signed-in customer reaching a staff route, a support engineer
 * able to suspend a workspace, or a cross-tenant read that leaves no trace.
 *
 * The audit assertions carry the most weight. `StaffScopedAccess` exists to
 * break the isolation every other path enforces, and the only thing that makes
 * that acceptable is that every use of it is recorded — including reads, which
 * is exactly the access somebody would most like to be unrecorded.
 *
 * Authentication itself is tested in `staff-console.test.ts`, beside the rest
 * of the Firebase-era boundary.
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asStaff, firebaseToken, installStaffJwks } from "./staff-auth";
import { NOW, WORKSPACE_A, WORKSPACE_B, bearer, seedApiKey, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";

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


let supportToken = "";
let adminToken = "";
let superToken = "";

beforeAll(installStaffJwks);

beforeEach(async () => {
  await seedTwoWorkspaces();
  for (const table of ["staff_users", "staff_actions", "audit_events", "api_keys"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(`UPDATE workspaces SET status = 'active'`).run();

  supportToken = await asStaff("support@agentdisk.io", "support", { id: "stf_SUPPORT" });
  adminToken = await asStaff("admin@agentdisk.io", "admin", { id: "stf_ADMIN" });
  superToken = await asStaff("super@agentdisk.io", "super_admin", { id: "stf_SUPER" });
});



describe("one identity, two roles", () => {
  it("refuses an API key on a staff route", async () => {
    // Unchanged and still absolute. An agent credential has no human behind it
    // and can never be staff, whatever rows exist.
    const key = await seedApiKey({ ops: ["read", "write"] });
    const res = await get("/v1/staff/workspaces", key.token);
    expect(res.status).toBe(401);
  });

  it("accepts a staff member's own token on customer routes too", async () => {
    // **This is the property migration 0014 traded away, asserted rather than
    // lamented.** Before it, a staff credential was structurally incapable of
    // reaching a customer route. Now one Firebase token reaches both surfaces
    // and only the `staff_users` lookup tells them apart.
    //
    // If this test ever starts failing, somebody has reintroduced a separation
    // the product deliberately gave up - which may be right, but is a decision
    // and not a bug fix.
    const token = await firebaseToken({ email: "super@agentdisk.io" });

    const staffRoute = await get("/v1/staff/workspaces", token);
    expect(staffRoute.status).toBe(200);

    // The same token on a customer route resolves them as an ordinary user.
    // 401/403/200 are all plausible depending on their memberships; what must
    // NOT happen is the request being rejected as a malformed credential.
    const customerRoute = await SELF.fetch(`${URL_BASE}/v1/workspaces`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect([200, 403]).toContain(customerRoute.status);
  });
});

describe("the role matrix", () => {
  it("lets support read the fleet", async () => {
    const token = supportToken;
    const res = await get("/v1/staff/workspaces", token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: { id: string }[] };
    // Cross-tenant by design: both workspaces, belonging to nobody they own.
    expect(body.workspaces.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses support the ability to suspend a workspace", async () => {
    const token = supportToken;
    const res = await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, {
      status: "suspended",
      reason: "testing",
    }, token);
    expect(res.status).toBe(403);
  });

  it("lets admin suspend and reinstate", async () => {
    const token = adminToken;
    expect(
      (await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, { status: "suspended", reason: "abuse report" }, token)).status
    ).toBe(200);
    expect(
      (await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, { status: "active", reason: "resolved" }, token)).status
    ).toBe(200);
  });

  it("requires a reason", async () => {
    // A suspension nobody can explain later is worse than none.
    const token = adminToken;
    const res = await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, { status: "suspended" }, token);
    expect(res.status).toBe(400);
  });

  it("has no staff-provisioning route left in the customer-user area", async () => {
    // `POST /v1/staff/users` was how staff were provisioned when staff had
    // passwords of their own. Migration 0014 moved staff onto Firebase SSO, so
    // there is no credential to mint and nothing for the endpoint to do; it
    // survived as a 501 whose message instructed the caller to write a
    // `password_hash` and a `totp_secret` into columns that migration dropped.
    // Creating staff is `POST /v1/staff/accounts`, tested in
    // `staff-console.test.ts` — including that an admin cannot do it, which is
    // the guarantee this test used to carry.
    //
    // The rest of `/v1/staff/users` is untouched: it is how the console
    // administers *customer* users, which is a different thing sharing a prefix.
    const res = await post("/v1/staff/users", { email: "new@agentdisk.io", role: "support" }, adminToken);
    expect(res.status).toBe(404);
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

    const staff = adminToken;
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
    const token = supportToken;
    await get(`/v1/staff/workspaces/${WORKSPACE_A}`, token);

    const events = await staffEvents(WORKSPACE_A);
    expect(events.map(e => e.action)).toContain("staff.workspace.viewed");
  });

  it("records who did it and in what role", async () => {
    const token = adminToken;
    await post(`/v1/staff/workspaces/${WORKSPACE_A}/status`, { status: "suspended", reason: "spam" }, token);

    const suspend = (await staffEvents(WORKSPACE_A)).find(e => e.action === "staff.workspace.suspended");
    const metadata = JSON.parse(suspend?.metadata ?? "{}") as Record<string, string>;
    expect(metadata.staffEmail).toBe("admin@agentdisk.io");
    expect(metadata.staffRole).toBe("admin");
    expect(metadata.reason).toBe("spam");
  });

  it("records viewing a workspace's activity", async () => {
    const token = supportToken;
    await get(`/v1/staff/workspaces/${WORKSPACE_A}/activity`, token);
    expect((await staffEvents(WORKSPACE_A)).map(e => e.action)).toContain("staff.activity.viewed");
  });

  it("writes key revocation into the customer's own log, not only ours", async () => {
    // A workspace owner reading their audit log should see that their keys were
    // revoked and by whom - not have it recorded somewhere only we can see.
    await seedApiKey({ workspaceId: WORKSPACE_A, ops: ["read"] });
    const token = adminToken;
    await post("/v1/staff/users/usr_TESTUSER/revoke-keys", undefined, token);

    expect((await staffEvents(WORKSPACE_A)).map(e => e.action)).toContain("staff.keys.revoked");
  });
});
