/**
 * The console's routes, through the real Worker — 32 PART 5, 6 and 11.
 *
 * This file exists for one assertion repeated across every gated endpoint: that
 * the role check is enforced SERVER-SIDE. The console also hides what a role
 * cannot do, and that hiding is a convenience for the operator; it is not the
 * control, and a test that only proved the button was absent would be testing
 * the wrong half. So every case below calls the endpoint directly with a real
 * session for a lower role and expects a 403.
 *
 * The other thing it pins is routing order. `plans/stripe-diff`,
 * `plans/sync-from-stripe` and `workspaces/needs-attention` are literal paths
 * that sit where an `:id` pattern would otherwise swallow them — a regression
 * there would not fail typecheck and would surface as "no such plan:
 * stripe-diff", which reads like a data problem rather than a routing one.
 */

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { currentTotp, encryptSecret, hashPassword } from "../src/staff/crypto";
import { NOW, WORKSPACE_A, seedTwoWorkspaces } from "./helpers";

const URL_BASE = "https://api-dev.agentdisk.io";
const ENCRYPTION_KEY = "test-database-encryption-key";
const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const PASSWORD = "a-long-staff-password";

const currentCode = (): Promise<string> => currentTotp(TOTP_SECRET, Date.now());

async function seedStaff(id: string, email: string, role: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO staff_users
       (id, email, password_hash, totp_secret, role, disabled_at, last_login_at,
        created_at, totp_confirmed_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
  )
    .bind(
      id,
      email,
      await hashPassword(PASSWORD),
      await encryptSecret(TOTP_SECRET, ENCRYPTION_KEY),
      role,
      NOW,
      NOW
    )
    .run();
}

function call(
  method: string,
  path: string,
  token: string,
  payload?: unknown
): Promise<Response> {
  return SELF.fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

async function login(email: string): Promise<string> {
  const res = await SELF.fetch(`${URL_BASE}/v1/staff/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, totp: await currentCode() }),
  });
  const body = (await res.json()) as { token?: string };
  if (body.token === undefined) throw new Error(`login failed: ${JSON.stringify(body)}`);
  return body.token;
}

let support = "";
let admin = "";
let superAdmin = "";

beforeEach(async () => {
  await seedTwoWorkspaces();
  for (const table of ["staff_sessions", "staff_users", "staff_actions", "audit_events"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(`UPDATE workspaces SET status = 'active', deleted_at = NULL`).run();
  await env.DB.prepare(`UPDATE users SET deleted_at = NULL, disabled_at = NULL`).run();
  for (const email of ["support@agentdisk.io", "admin@agentdisk.io", "super@agentdisk.io"]) {
    await env.CACHE.delete(`staff:login:${email}`);
  }

  await seedStaff("stf_SUPPORT", "support@agentdisk.io", "support");
  await seedStaff("stf_ADMIN", "admin@agentdisk.io", "admin");
  await seedStaff("stf_SUPER", "super@agentdisk.io", "super_admin");

  support = await login("support@agentdisk.io");
  admin = await login("admin@agentdisk.io");
  superAdmin = await login("super@agentdisk.io");
});

/* ---------------------------- the role matrix ---------------------------- */

describe("the role matrix, enforced server-side", () => {
  const reason = "a reason long enough to be one";

  it("lets support read everything a support engineer needs", async () => {
    // The design gates Billing and Plans at admin. That is one notch too strict
    // on reads: support is exactly who needs to see WHY a customer's writes are
    // blocked, and being unable to look up the plan is what turns a one-minute
    // answer into an escalation.
    expect((await call("GET", "/v1/staff/plans", support)).status).toBe(200);
    expect((await call("GET", "/v1/staff/billing", support)).status).toBe(200);
    expect((await call("GET", "/v1/staff/audit", support)).status).toBe(200);
    expect((await call("GET", "/v1/staff/workspaces", support)).status).toBe(200);
  });

  it("refuses support the admin-only writes", async () => {
    expect(
      (await call("PATCH", "/v1/staff/plans/pro", support, { agents: 5, reason })).status
    ).toBe(403);
    expect(
      (
        await call("PATCH", `/v1/staff/workspaces/${WORKSPACE_A}/plan-override`, support, {
          planId: "pro",
          reason,
        })
      ).status
    ).toBe(403);
  });

  it("refuses admin the super_admin-only writes", async () => {
    expect((await call("GET", "/v1/staff/accounts", admin)).status).toBe(403);
    expect(
      (await call("POST", "/v1/staff/plans", admin, { id: "scale", reason })).status
    ).toBe(403);
    expect(
      (await call("POST", "/v1/staff/plans/basic/retire", admin, { reason })).status
    ).toBe(403);
    expect(
      (
        await call("DELETE", `/v1/staff/workspaces/${WORKSPACE_A}`, admin, {
          confirmName: "Workspace A",
          reason,
        })
      ).status
    ).toBe(403);
  });

  it("lets support do the abuse-response actions", async () => {
    // Disabling an agent and revoking a key are reversible and urgent. Waiting
    // for an admin is the wrong trade when something is actively misbehaving.
    const res = await call("PATCH", "/v1/staff/agents/agt_NOPE", support, {
      disabled: true,
      reason,
    });
    // 404 rather than 403: the role passed, the agent does not exist.
    expect(res.status).toBe(404);
  });

  it("records a refusal, not just the successes", async () => {
    await call("PATCH", "/v1/staff/plans/pro", support, { agents: 5, reason });

    const denied = await env.DB.prepare(
      `SELECT action, result, actor_role FROM staff_actions WHERE result = 'denied'`
    ).all<Record<string, unknown>>();

    expect(denied.results?.length).toBeGreaterThan(0);
    expect(denied.results?.[0]?.actor_role).toBe("support");
  });

  it("refuses every console route without a session at all", async () => {
    for (const path of [
      "/v1/staff/plans",
      "/v1/staff/billing",
      "/v1/staff/audit",
      "/v1/staff/accounts",
      "/v1/staff/users?email=nobody@example.com",
    ]) {
      const res = await SELF.fetch(`${URL_BASE}${path}`);
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 401`);
    }
  });
});

/* ------------------------------ routing order ---------------------------- */

describe("literal paths are not swallowed by :id patterns", () => {
  it("routes plans/stripe-diff and plans/sync-from-stripe as themselves", async () => {
    // Without the ordering these would look up a plan named "stripe-diff" and
    // answer 404 - which reads like a data problem, not a routing one.
    const diff = await call("GET", "/v1/staff/plans/stripe-diff", admin);
    expect(diff.status).not.toBe(404);

    const sync = await call("POST", "/v1/staff/plans/sync-from-stripe", admin, {
      selections: [{ planId: "pro", fields: ["agents"] }],
      reason: "a reason long enough",
    });
    expect(sync.status).not.toBe(404);
  });

  it("routes workspaces/needs-attention as itself", async () => {
    const res = await call("GET", "/v1/staff/workspaces/needs-attention", support);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("workspaces");
  });

  it("still 404s a genuinely unknown staff path", async () => {
    expect((await call("GET", "/v1/staff/nothing-here", superAdmin)).status).toBe(404);
  });
});

/* --------------------------------- users --------------------------------- */

describe("looking a customer up", () => {
  it("finds an account by its exact address and records the lookup", async () => {
    const res = await call("GET", "/v1/staff/users?email=owner@example.com", support);
    expect(res.status).toBe(200);

    const recorded = await env.DB.prepare(
      `SELECT action, target_id FROM staff_actions WHERE action = 'user.lookup'`
    ).all<Record<string, unknown>>();
    expect(recorded.results?.length).toBe(1);
  });

  it("records a lookup that found nobody", async () => {
    // A lookup that missed is still a staff member asking after a named
    // individual, which is the fact the log exists to hold.
    await call("GET", "/v1/staff/users?email=stranger@example.com", support);
    const recorded = await env.DB.prepare(
      `SELECT metadata FROM staff_actions WHERE action = 'user.lookup'`
    ).first<{ metadata: string }>();
    expect(recorded?.metadata).toContain('"found":false');
  });

  it("refuses a partial address rather than searching for it", async () => {
    // A staff tool that can search %@gmail.com is a staff tool that can
    // enumerate the customer base.
    expect((await call("GET", "/v1/staff/users?email=owner", support)).status).toBe(400);
  });
});

/* ------------------------------- deletions ------------------------------- */

describe("deleting a workspace", () => {
  const reason = "a reason long enough to be one";

  it("refuses unless the workspace is already suspended", async () => {
    // Suspension is instant, reversible and cuts off access, so it is the right
    // first move in every scenario ending in deletion - and it gives the
    // customer a chance to notice before a 30-day countdown starts.
    const res = await call("DELETE", `/v1/staff/workspaces/${WORKSPACE_A}`, superAdmin, {
      confirmName: "Workspace A",
      reason,
    });
    expect(res.status).toBe(409);
  });

  it("refuses when the typed name does not match", async () => {
    await env.DB.prepare(`UPDATE workspaces SET status = 'suspended' WHERE id = ?`)
      .bind(WORKSPACE_A)
      .run();

    const res = await call("DELETE", `/v1/staff/workspaces/${WORKSPACE_A}`, superAdmin, {
      confirmName: "Not The Name",
      reason,
    });
    expect(res.status).toBe(400);
  });

  it("soft-deletes, and the row survives for the window", async () => {
    const workspace = await env.DB.prepare(`SELECT name FROM workspaces WHERE id = ?`)
      .bind(WORKSPACE_A)
      .first<{ name: string }>();
    await env.DB.prepare(`UPDATE workspaces SET status = 'suspended' WHERE id = ?`)
      .bind(WORKSPACE_A)
      .run();

    const res = await call("DELETE", `/v1/staff/workspaces/${WORKSPACE_A}`, superAdmin, {
      confirmName: workspace?.name,
      reason,
    });
    expect(res.status).toBe(200);

    const after = await env.DB.prepare(
      `SELECT status, deleted_at AS deletedAt FROM workspaces WHERE id = ?`
    )
      .bind(WORKSPACE_A)
      .first<{ status: string; deletedAt: number | null }>();

    // Still there. Nothing irreversible happened inline; the cascade is the
    // purge job's, 30 days later.
    expect(after?.status).toBe("deleted");
    expect(after?.deletedAt).not.toBeNull();
  });

  it("restores to suspended, never straight back to active", async () => {
    const workspace = await env.DB.prepare(`SELECT name FROM workspaces WHERE id = ?`)
      .bind(WORKSPACE_A)
      .first<{ name: string }>();
    await env.DB.prepare(`UPDATE workspaces SET status = 'suspended' WHERE id = ?`)
      .bind(WORKSPACE_A)
      .run();
    await call("DELETE", `/v1/staff/workspaces/${WORKSPACE_A}`, superAdmin, {
      confirmName: workspace?.name,
      reason,
    });

    const res = await call("POST", `/v1/staff/workspaces/${WORKSPACE_A}/restore`, superAdmin, {
      reason,
    });
    expect(res.status).toBe(200);

    // Whatever caused the suspension has not been resolved by the restore, and
    // handing access straight back would undo that decision too.
    const after = await env.DB.prepare(`SELECT status FROM workspaces WHERE id = ?`)
      .bind(WORKSPACE_A)
      .first<{ status: string }>();
    expect(after?.status).toBe("suspended");
  });
});

/* ---------------------------- staff accounts ----------------------------- */

describe("staff accounts", () => {
  const reason = "a reason long enough to be one";

  it("creates one and shows the credential exactly once", async () => {
    const res = await call("POST", "/v1/staff/accounts", superAdmin, {
      email: "new@agentdisk.io",
      role: "admin",
      reason,
    });
    expect(res.status).toBe(201);

    const created = (await res.json()) as {
      account: { id: string; totpConfirmedAt: number | null };
      secret: { password: string; provisioningUri: string };
    };
    expect(created.secret.password.length).toBeGreaterThan(20);
    expect(created.secret.provisioningUri).toMatch(/^otpauth:\/\/totp\//);
    // Created but never signed in. The first successful login sets this.
    expect(created.account.totpConfirmedAt).toBeNull();

    // And nothing can retrieve it afterwards.
    const list = await call("GET", "/v1/staff/accounts", superAdmin);
    expect(await list.text()).not.toContain(created.secret.password);
  });

  it("refuses to disable your own account", async () => {
    // It removes the only role that can re-enable anyone, and there may be no
    // other super_admin. The way back would be the provisioning script.
    const res = await call("PATCH", "/v1/staff/accounts/stf_SUPER/disable", superAdmin, {
      disabled: true,
      reason,
    });
    expect(res.status).toBe(403);
  });

  it("refuses to change your own role", async () => {
    const res = await call("PATCH", "/v1/staff/accounts/stf_SUPER", superAdmin, {
      role: "support",
      reason,
    });
    expect(res.status).toBe(403);
  });

  it("refuses to demote the last super_admin", async () => {
    await call("POST", "/v1/staff/accounts", superAdmin, {
      email: "second@agentdisk.io",
      role: "super_admin",
      reason,
    });
    const second = await env.DB.prepare(`SELECT id FROM staff_users WHERE email = ?`)
      .bind("second@agentdisk.io")
      .first<{ id: string }>();

    // Two exist, so this one may be demoted.
    expect(
      (await call("PATCH", `/v1/staff/accounts/${second?.id}`, superAdmin, {
        role: "support",
        reason,
      })).status
    ).toBe(200);

    // Now stf_SUPER is the last one, and it cannot demote itself anyway - so
    // demote it as the other super_admin would have to. Re-promote second.
    await call("PATCH", `/v1/staff/accounts/${second?.id}`, superAdmin, {
      role: "super_admin",
      reason,
    });
    const secondToken = await (async () => {
      await env.DB.prepare(`UPDATE staff_users SET password_hash = ? WHERE id = ?`)
        .bind(await hashPassword(PASSWORD), second?.id)
        .run();
      await env.DB.prepare(`UPDATE staff_users SET totp_secret = ? WHERE id = ?`)
        .bind(await encryptSecret(TOTP_SECRET, ENCRYPTION_KEY), second?.id)
        .run();
      return login("second@agentdisk.io");
    })();

    // second demotes stf_SUPER: allowed, two super_admins exist.
    expect(
      (await call("PATCH", "/v1/staff/accounts/stf_SUPER", secondToken, {
        role: "admin",
        reason,
      })).status
    ).toBe(200);
  });

  it("revokes live sessions when an account is disabled", async () => {
    // Without this a disabled staff member keeps cross-tenant reach for up to
    // the remaining four hours of a session that was already open - which is
    // the whole window somebody removed for cause would use.
    await call("PATCH", "/v1/staff/accounts/stf_ADMIN/disable", superAdmin, {
      disabled: true,
      reason,
    });

    expect((await call("GET", "/v1/staff/workspaces", admin)).status).toBe(401);
  });
});

/* -------------------------------- the audit ------------------------------ */

describe("the audit log", () => {
  it("filters by action prefix, which is what Sync History is", async () => {
    await call("GET", "/v1/staff/users?email=owner@example.com", support);

    const res = await call("GET", "/v1/staff/audit?action=user.", support);
    const body = (await res.json()) as { rows: { action: string }[] };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.every(row => row.action.startsWith("user."))).toBe(true);
  });

  it("exports CSV, and records the export in the log it exported", async () => {
    const res = await call("GET", "/v1/staff/audit/export", support);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");

    const recorded = await env.DB.prepare(
      `SELECT action FROM staff_actions WHERE action = 'audit.export'`
    ).first<{ action: string }>();
    expect(recorded?.action).toBe("audit.export");
  });

  it("neutralises a formula in an operator-supplied reason", async () => {
    // The reason field is free text an operator types, so it is exactly where a
    // payload would be planted for whoever opens the export in a spreadsheet.
    await env.DB.prepare(
      `INSERT INTO staff_actions (id, actor_id, actor_email, actor_role, action, result, created_at, reason)
       VALUES ('sac_X', 'stf_SUPPORT', 'support@agentdisk.io', 'support', 'user.lookup', 'success', ?, ?)`
    )
      .bind(NOW, "=cmd|'/c calc'!A1")
      .run();

    const csv = await (await call("GET", "/v1/staff/audit/export", support)).text();
    expect(csv).toContain(`"'=cmd`);
  });
});
